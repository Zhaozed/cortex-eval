import { z } from "zod";

import { AnalysisProposalV1Schema } from "./analysis-contracts.ts";
import {
  BusinessKeySchema,
  JsonObjectSchema,
  JsonValueSchema,
  RelativePosixPathSchema,
  Sha256Schema,
  UtcDateTimeSchema,
  UuidV7Schema
} from "./contracts-primitives.ts";
import { ProviderOutputV1Schema } from "./provider-contracts.ts";

/** Identity shared by all stage Artifacts. */
export const ArtifactIdentityV1Schema = z.strictObject({
  packageId: UuidV7Schema,
  executionId: UuidV7Schema
});

// Enforce one ordered result per Case within a stage Artifact.
function validateCaseSequence(
  cases: readonly { caseKey: string; ordinal: number }[],
  context: z.RefinementCtx
): void {
  const caseKeys = new Set<string>();
  for (const [index, item] of cases.entries()) {
    if (caseKeys.has(item.caseKey) || item.ordinal !== index) {
      context.addIssue({ code: "custom", path: ["cases", index], message: "CASE_ALIGNMENT" });
    }
    caseKeys.add(item.caseKey);
  }
}

/** Hash and size of one controlled file. */
export const FileIntegrityV1Schema = z.strictObject({
  path: RelativePosixPathSchema,
  sha256: Sha256Schema,
  sizeBytes: z.number().int().nonnegative()
});

const ArtifactKindV1Schema = z.enum([
  "REST_RESULTS",
  "RAW_PROMPTFOO_EVIDENCE",
  "NORMALIZED_EVAL_RESULTS",
  "REPORT_JSON",
  "REPORT_MARKDOWN",
  "ANALYSIS_RESULTS"
]);

/** Expected Artifact metadata stored on a Run or Execution. */
export const ArtifactManifestV1Schema = z
  .strictObject({
    contractVersion: z.literal("cortex.artifact-manifest.v1"),
    owner: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("RUN"), id: UuidV7Schema }),
      z.strictObject({ kind: z.literal("EXECUTION"), id: UuidV7Schema })
    ]),
    artifacts: z.array(
      z.strictObject({
        kind: ArtifactKindV1Schema,
        path: RelativePosixPathSchema,
        expectedSha256: Sha256Schema,
        expectedSizeBytes: z.number().int().nonnegative(),
        contractVersion: z.string().regex(/^[a-z0-9.-]+$/)
      })
    )
  })
  .superRefine((manifest, context) => {
    const kinds = new Set<string>();
    const paths = new Set<string>();
    for (const [index, artifact] of manifest.artifacts.entries()) {
      if (kinds.has(artifact.kind) || paths.has(artifact.path)) {
        context.addIssue({
          code: "custom",
          path: ["artifacts", index],
          message: "ARTIFACT_DUPLICATE"
        });
      }
      kinds.add(artifact.kind);
      paths.add(artifact.path);
    }
  });

/** Reuse provenance for retry executions. */
export const ReuseProvenanceV1Schema = z.strictObject({
  sourceKind: z.enum(["RUN", "EXECUTION"]),
  sourceId: UuidV7Schema,
  sourceResultHash: Sha256Schema
});

const RestErrorV1Schema = z.strictObject({
  type: z.enum([
    "TIMEOUT",
    "NETWORK",
    "HTTP_STATUS",
    "RESPONSE_PARSE",
    "PROVIDER_OUTPUT_INVALID",
    "TEMPLATE_INPUT",
    "CANCELLED"
  ]),
  message: z.string().trim().min(1)
});

const RestSuccessV1Schema = z.strictObject({
  caseKey: BusinessKeySchema,
  ordinal: z.number().int().nonnegative(),
  caseDefinitionHash: Sha256Schema,
  status: z.literal("SUCCEEDED"),
  httpStatus: z.number().int().min(200).max(299),
  providerOutput: ProviderOutputV1Schema,
  durationMs: z.number().nonnegative(),
  completedAt: UtcDateTimeSchema,
  resultHash: Sha256Schema,
  provenance: ReuseProvenanceV1Schema.nullable()
});

const RestFailureV1Schema = z
  .strictObject({
    caseKey: BusinessKeySchema,
    ordinal: z.number().int().nonnegative(),
    caseDefinitionHash: Sha256Schema,
    status: z.literal("ERROR"),
    httpStatus: z.number().int().min(100).max(599).nullable(),
    providerOutput: z.null(),
    error: RestErrorV1Schema,
    durationMs: z.number().nonnegative(),
    completedAt: UtcDateTimeSchema,
    resultHash: Sha256Schema,
    provenance: ReuseProvenanceV1Schema.nullable()
  })
  .superRefine((result, context) => {
    const isHttpStatus = result.error.type === "HTTP_STATUS";
    const isResponseContentError =
      result.error.type === "RESPONSE_PARSE" || result.error.type === "PROVIDER_OUTPUT_INVALID";
    const isHttp2xx =
      result.httpStatus !== null && result.httpStatus >= 200 && result.httpStatus <= 299;
    if (isHttpStatus && (result.httpStatus === null || isHttp2xx)) {
      context.addIssue({ code: "custom", path: ["httpStatus"], message: "REST_ERROR_SHAPE" });
    }
    if (isResponseContentError && !isHttp2xx) {
      context.addIssue({ code: "custom", path: ["httpStatus"], message: "REST_ERROR_SHAPE" });
    }
    if (!isHttpStatus && !isResponseContentError && result.httpStatus !== null) {
      context.addIssue({ code: "custom", path: ["httpStatus"], message: "REST_ERROR_SHAPE" });
    }
  });

/** One validated REST Artifact Case projection shared by bounded streaming writers. */
export const RestArtifactCaseV1Schema = z.discriminatedUnion("status", [
  RestSuccessV1Schema,
  RestFailureV1Schema
]);

/** Immutable REST stage results. */
export const RestResultsArtifactV1Schema = z
  .strictObject({
    contractVersion: z.literal("cortex.rest-results.v1"),
    ...ArtifactIdentityV1Schema.shape,
    completedAt: UtcDateTimeSchema,
    cases: z.array(RestArtifactCaseV1Schema).min(1),
    resultSetHash: Sha256Schema
  })
  .superRefine((artifact, context) => validateCaseSequence(artifact.cases, context));

/** Immutable platform REST results bound to one Run rather than an offline Execution. */
export const PlatformRestResultsArtifactV1Schema = z
  .strictObject({
    contractVersion: z.literal("cortex.platform-rest-results.v1"),
    runId: UuidV7Schema,
    runContextHash: Sha256Schema,
    completedAt: UtcDateTimeSchema,
    cases: z.array(RestArtifactCaseV1Schema).min(1),
    resultSetHash: Sha256Schema
  })
  .superRefine((artifact, context) => validateCaseSequence(artifact.cases, context));

const AssertionStatusSchema = z.enum(["PASS", "FAIL", "ERROR", "SKIPPED"]);
const MetricStatusSchema = z.enum(["PASS", "FAIL", "ERROR", "SKIPPED", "NOT_EVALUATED"]);

const AssertionResultV1Schema = z.strictObject({
  index: z.number().int().nonnegative(),
  definitionHash: Sha256Schema,
  type: z.string().trim().min(1),
  metric: z.string().trim().min(1),
  weight: z.number().nonnegative(),
  status: AssertionStatusSchema,
  score: z.number().nullable(),
  reason: z.string().trim().min(1).nullable()
});

const AssertionDiffV1Schema = z.strictObject({
  assertionIndex: z.number().int().nonnegative(),
  instancePath: z.string(),
  schemaPath: z.string().min(1),
  keyword: z.string().min(1),
  expectedConstraint: JsonValueSchema,
  actual: JsonValueSchema,
  reason: z.string().trim().min(1),
  validatorVersion: z.string().trim().min(1),
  schemaDialect: z.string().trim().min(1),
  diffContractVersion: z.literal("cortex.assertion-diff.v1")
});

const MetricResultV1Schema = z.strictObject({
  metric: z.string().trim().min(1),
  status: MetricStatusSchema
});

const TokenUsageV1Schema = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative()
});

const EvidenceReferenceV1Schema = z.strictObject({
  present: z.boolean(),
  path: RelativePosixPathSchema,
  expectedSha256: Sha256Schema,
  expectedSizeBytes: z.number().int().nonnegative()
});

const EvalObservedV1Schema = z
  .strictObject({
    caseKey: BusinessKeySchema,
    ordinal: z.number().int().nonnegative(),
    status: z.enum(["PASS", "FAIL"]),
    promptfooSuccess: z.boolean(),
    score: z.number(),
    reason: z.string().trim().min(1).nullable(),
    evaluationError: z.null(),
    assertions: z.array(AssertionResultV1Schema),
    diffs: z.array(AssertionDiffV1Schema),
    metrics: z.array(MetricResultV1Schema),
    latencyMs: z.number().nonnegative().nullable(),
    tokenUsage: TokenUsageV1Schema.nullable(),
    cost: z.number().nonnegative().nullable(),
    rawEvidence: EvidenceReferenceV1Schema.nullable(),
    evalResultHash: Sha256Schema,
    finalCaseResultHash: Sha256Schema,
    provenance: ReuseProvenanceV1Schema.nullable()
  })
  .superRefine((result, context) => {
    if ((result.status === "PASS") !== result.promptfooSuccess) {
      context.addIssue({
        code: "custom",
        path: ["promptfooSuccess"],
        message: "EVAL_STATUS_SHAPE"
      });
    }
  });

const EvalErrorV1Schema = z.strictObject({
  caseKey: BusinessKeySchema,
  ordinal: z.number().int().nonnegative(),
  status: z.literal("EVALUATION_ERROR"),
  promptfooSuccess: z.null(),
  score: z.null(),
  reason: z.null(),
  evaluationError: z.strictObject({
    code: z.string().trim().min(1)
  }),
  assertions: z.array(AssertionResultV1Schema),
  diffs: z.array(AssertionDiffV1Schema),
  metrics: z.array(MetricResultV1Schema),
  latencyMs: z.number().nonnegative().nullable(),
  tokenUsage: TokenUsageV1Schema.nullable(),
  cost: z.number().nonnegative().nullable(),
  rawEvidence: EvidenceReferenceV1Schema.nullable(),
  evalResultHash: Sha256Schema,
  finalCaseResultHash: Sha256Schema,
  provenance: ReuseProvenanceV1Schema.nullable()
});

const NotEvaluatedV1Schema = z.strictObject({
  caseKey: BusinessKeySchema,
  ordinal: z.number().int().nonnegative(),
  status: z.literal("NOT_EVALUATED"),
  promptfooSuccess: z.null(),
  score: z.null(),
  reason: z.null(),
  evaluationError: z.null(),
  assertions: z.array(AssertionResultV1Schema).length(0),
  diffs: z.array(AssertionDiffV1Schema).length(0),
  metrics: z.array(MetricResultV1Schema),
  latencyMs: z.null(),
  tokenUsage: z.null(),
  cost: z.null(),
  rawEvidence: z.null(),
  evalResultHash: Sha256Schema,
  finalCaseResultHash: Sha256Schema,
  provenance: ReuseProvenanceV1Schema.nullable()
});

export const EvalCaseV1Schema = z.discriminatedUnion("status", [
  EvalObservedV1Schema,
  EvalErrorV1Schema,
  NotEvaluatedV1Schema
]);

/** Normalized Promptfoo facts used by Reporting and import. */
export const NormalizedEvalArtifactV1Schema = z
  .strictObject({
    contractVersion: z.literal("cortex.normalized-eval.v1"),
    ...ArtifactIdentityV1Schema.shape,
    evaluationContextHash: Sha256Schema,
    completedAt: UtcDateTimeSchema,
    cases: z.array(EvalCaseV1Schema).min(1),
    resultSetHash: Sha256Schema
  })
  .superRefine((artifact, context) => validateCaseSequence(artifact.cases, context));

/** Immutable normalized Evaluation facts bound to one platform Run. */
export const PlatformNormalizedEvalArtifactV1Schema = z
  .strictObject({
    contractVersion: z.literal("cortex.platform-normalized-eval.v1"),
    runId: UuidV7Schema,
    runContextHash: Sha256Schema,
    evaluationContextHash: Sha256Schema,
    completedAt: UtcDateTimeSchema,
    cases: z.array(EvalCaseV1Schema).min(1),
    resultSetHash: Sha256Schema
  })
  .superRefine((artifact, context) => validateCaseSequence(artifact.cases, context));

/** Stable report summary. */
export const ReportSummaryV1Schema = z.strictObject({
  total: z.number().int().nonnegative(),
  restSucceeded: z.number().int().nonnegative(),
  restError: z.number().int().nonnegative(),
  evalPass: z.number().int().nonnegative(),
  evalFail: z.number().int().nonnegative(),
  evalError: z.number().int().nonnegative(),
  notEvaluated: z.number().int().nonnegative(),
  effectivePassRate: z.number().min(0).max(1).nullable(),
  evaluatedPassRate: z.number().min(0).max(1).nullable(),
  coverageRate: z.number().min(0).max(1).nullable()
});

const MetricSummaryV1Schema = z.strictObject({
  metric: z.string().trim().min(1),
  pass: z.number().int().nonnegative(),
  fail: z.number().int().nonnegative(),
  error: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  notEvaluated: z.number().int().nonnegative(),
  passRate: z.number().min(0).max(1).nullable()
});

/** Report JSON Artifact. */
export const ReportArtifactV1Schema = z
  .strictObject({
    contractVersion: z.literal("cortex.report.v1"),
    ...ArtifactIdentityV1Schema.shape,
    completedAt: UtcDateTimeSchema,
    summary: ReportSummaryV1Schema,
    byMetric: z.array(MetricSummaryV1Schema),
    cases: z
      .array(
        z.strictObject({
          caseKey: BusinessKeySchema,
          ordinal: z.number().int().nonnegative(),
          restResultHash: Sha256Schema,
          evalResultHash: Sha256Schema,
          finalCaseResultHash: Sha256Schema
        })
      )
      .min(1),
    resultSetHash: Sha256Schema
  })
  .superRefine((artifact, context) => validateCaseSequence(artifact.cases, context));

const AnalysisSuccessV1Schema = z.strictObject({
  caseKey: BusinessKeySchema,
  ordinal: z.number().int().nonnegative(),
  finalCaseResultHash: Sha256Schema,
  analysisInputHash: Sha256Schema,
  status: z.literal("SUCCEEDED"),
  classification: z.enum([
    "LABEL_ERROR",
    "ADDITIONAL_VALID_RESULT",
    "NORMAL_FAILURE",
    "PARAMETER_VARIANCE"
  ]),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string().trim().min(1)).min(1),
  explanation: z.string().trim().min(1),
  recommendedAction: z.string().trim().min(1),
  proposal: AnalysisProposalV1Schema.nullable(),
  error: z.null()
});

const AnalysisErrorV1Schema = z.strictObject({
  caseKey: BusinessKeySchema,
  ordinal: z.number().int().nonnegative(),
  finalCaseResultHash: Sha256Schema,
  analysisInputHash: Sha256Schema,
  status: z.literal("ERROR"),
  classification: z.null(),
  confidence: z.null(),
  evidence: z.array(z.string()).length(0),
  explanation: z.null(),
  recommendedAction: z.null(),
  proposal: z.null(),
  error: z.strictObject({ code: z.string().trim().min(1), message: z.string().trim().min(1) })
});

/** Analysis stage Artifact. */
export const AnalysisResultsArtifactV1Schema = z
  .strictObject({
    contractVersion: z.literal("cortex.analysis-results.v1"),
    ...ArtifactIdentityV1Schema.shape,
    completedAt: UtcDateTimeSchema,
    cases: z.array(
      z.discriminatedUnion("status", [AnalysisSuccessV1Schema, AnalysisErrorV1Schema])
    ),
    analysisResultSetHash: Sha256Schema
  })
  .superRefine((artifact, context) => validateCaseSequence(artifact.cases, context));

const PromptfooNativeExitCodeSchema = z.union([z.literal(0), z.literal(100)]);

/** Raw Promptfoo evidence preserved under the exact frozen third-party version. */
export const RawPromptfooEvidenceArtifactV1Schema = z.strictObject({
  contractVersion: z.literal("promptfoo.0.121.18"),
  ...ArtifactIdentityV1Schema.shape,
  evaluationContextHash: Sha256Schema,
  exitCode: PromptfooNativeExitCodeSchema,
  durationMs: z.number().nonnegative(),
  raw: JsonObjectSchema
});

/** Raw Promptfoo evidence bound to one platform Run without offline identity fields. */
export const PlatformRawPromptfooEvidenceArtifactV1Schema = z.strictObject({
  contractVersion: z.literal("cortex.platform-raw-promptfoo-evidence.v1"),
  runId: UuidV7Schema,
  runContextHash: Sha256Schema,
  evaluationContextHash: Sha256Schema,
  promptfooVersion: z.literal("0.121.18"),
  exitCode: PromptfooNativeExitCodeSchema,
  durationMs: z.number().nonnegative(),
  raw: JsonObjectSchema
});
