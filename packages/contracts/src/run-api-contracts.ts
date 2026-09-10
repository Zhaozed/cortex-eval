import { z } from "zod";

import {
  ArtifactManifestV1Schema,
  EvalCaseV1Schema,
  MetricSummaryV1Schema,
  ReportCaseV1Schema,
  ReportContextV1Schema,
  ReportSummaryV1Schema
} from "./artifact-contracts.ts";
import { CaseDefinitionV1Schema } from "./case-contracts.ts";
import {
  BusinessKeySchema,
  Sha256Schema,
  UtcDateTimeSchema,
  UuidV7Schema
} from "./contracts-primitives.ts";
import { ERROR_CODES } from "./error-contracts.ts";
import { RunExecutionLimitsV1Schema } from "./execution-limit-contracts.ts";
import {
  EndpointConfigV1Schema,
  LlmConfigV1Schema,
  ProviderOutputV1Schema
} from "./provider-contracts.ts";

/** Platform Run execution mode. */
export const RunModeV1Schema = z.enum(["STAGED", "PIPELINE"]);

/** Persisted Run lifecycle status. */
export const RunStatusV1Schema = z.enum([
  "READY",
  "RUNNING",
  "COMPLETED",
  "COMPLETED_WITH_ERRORS",
  "FAILED",
  "CANCELLED",
  "INTERRUPTED"
]);

/** Persisted Run pipeline stage. */
export const RunStageV1Schema = z.enum(["REST", "EVALUATION", "REPORT", "DONE"]);

/** Shared resource selection used by preflight and creation. */
export const PlatformRunSelectionV1Schema = z.strictObject({
  suiteId: UuidV7Schema,
  endpointConfigId: UuidV7Schema,
  evaluatorConfigId: UuidV7Schema
});

/** Run preflight request. */
export const RunPreflightRequestV1Schema = PlatformRunSelectionV1Schema;

/** Human-readable labels are not part of the execution snapshot or semantic hashes. */
export const RunMetadataInputV1Schema = z.strictObject({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2000).optional()
});
const RunMetadataShape = {
  name: z.string().trim().min(1).max(120).nullable().optional(),
  description: z.string().max(2000).nullable().optional()
};

/** Platform Run creation request with optional server-derived defaults. */
export const CreatePlatformRunRequestV1Schema = PlatformRunSelectionV1Schema.extend({
  ...RunMetadataInputV1Schema.shape,
  runMode: RunModeV1Schema,
  runExecutionLimits: RunExecutionLimitsV1Schema.optional()
});

/** Create a new immutable Retry/Force Run from one terminal source Run. */
export const CreatePlatformRerunRequestV1Schema = z
  .strictObject({
    ...RunMetadataInputV1Schema.shape,
    mode: z.enum(["RETRY_FAILED", "FORCE"]),
    caseKey: BusinessKeySchema.optional(),
    reevaluateOnly: z.boolean().optional()
  })
  .superRefine((value, context) => {
    if ((value.caseKey !== undefined || value.reevaluateOnly) && value.mode !== "FORCE")
      context.addIssue({ code: "custom", message: "CASE_RERUN_REQUIRES_FORCE" });
    if (value.reevaluateOnly && !value.caseKey)
      context.addIssue({ code: "custom", message: "CASE_RERUN_REQUIRES_CASE" });
  });

const PlatformRerunCountsV1Schema = z
  .strictObject({
    reuseRest: z.number().int().nonnegative(),
    executeRest: z.number().int().nonnegative(),
    reuseEval: z.number().int().nonnegative(),
    executeEval: z.number().int().nonnegative()
  })
  .superRefine((value, context) => {
    if (value.reuseRest + value.executeRest !== value.reuseEval + value.executeEval) {
      context.addIssue({ code: "custom", message: "RERUN_COUNTS_INVALID" });
    }
  });

/** Newly created rerun link and exact planned reuse/execute totals. */
export const PlatformRerunCreatedV1Schema = z.strictObject({
  runId: UuidV7Schema,
  sourceRunId: UuidV7Schema,
  rerunMode: z.enum(["RETRY_FAILED", "FORCE"]),
  status: z.literal("READY"),
  stage: z.literal("REST"),
  lockRevision: z.literal(0),
  counts: PlatformRerunCountsV1Schema
});

/** Frozen preflight dependencies and current execution defaults. */
export const RunPreflightV1Schema = PlatformRunSelectionV1Schema.extend({
  caseCount: z.number().int().positive(),
  rubricPromptKeys: z.array(BusinessKeySchema),
  requiredEnvKeys: z.strictObject({
    REST: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)),
    EVALUATION: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/))
  }),
  endpointTimeoutMs: z.number().int().min(100).max(600_000),
  defaultRunExecutionLimits: RunExecutionLimitsV1Schema
});

const RestCountersV1Schema = z
  .strictObject({
    total: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    succeeded: z.number().int().nonnegative(),
    error: z.number().int().nonnegative()
  })
  .superRefine((value, context) => {
    if (value.completed !== value.succeeded + value.error || value.completed > value.total) {
      context.addIssue({ code: "custom", message: "RUN_COUNTERS_INVALID" });
    }
  });

const EvaluationCountersV1Schema = z
  .strictObject({
    total: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    error: z.number().int().nonnegative(),
    notEvaluated: z.number().int().nonnegative()
  })
  .superRefine((value, context) => {
    const classified = value.passed + value.failed + value.error + value.notEvaluated;
    if (value.completed !== classified || value.completed > value.total) {
      context.addIssue({ code: "custom", message: "RUN_EVALUATION_COUNTERS_INVALID" });
    }
  });

const RunProgressShape = {
  status: RunStatusV1Schema,
  stage: RunStageV1Schema,
  lockRevision: z.number().int().nonnegative(),
  cancelRequestedAt: UtcDateTimeSchema.nullable(),
  rest: RestCountersV1Schema,
  evaluation: EvaluationCountersV1Schema,
  updatedAt: UtcDateTimeSchema
} as const;

/** Small current Run progress used by polling and SSE. */
export const RunProgressV1Schema = z.strictObject({
  runId: UuidV7Schema,
  ...RunProgressShape
});

/** Small recent platform Run list projection. */
export const PlatformRunSummaryV1Schema = z.strictObject({
  ...RunMetadataShape,
  id: UuidV7Schema,
  sourceType: z.enum(["PLATFORM", "OFFLINE_IMPORT"]),
  suiteId: UuidV7Schema,
  suiteName: z.string().trim().min(1),
  runMode: RunModeV1Schema,
  ...RunProgressShape,
  createdAt: UtcDateTimeSchema
});

/** Cursor-paged recent platform Runs. */
export const PlatformRunPageV1Schema = z.strictObject({
  items: z.array(PlatformRunSummaryV1Schema),
  nextCursor: z.string().min(1).nullable()
});

/** Bounded recent platform Run query. */
export const PlatformRunListQueryV1Schema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional()
});

const PlatformRunCursorV1Schema = z.strictObject({
  version: z.literal(1),
  createdAt: UtcDateTimeSchema,
  id: UuidV7Schema
});

const RunCaseCursorV1Schema = z.strictObject({
  version: z.literal(1),
  ordinal: z.number().int().nonnegative()
});

// Encode UTF-8 text into unpadded URL-safe Base64.
function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

// Decode strict URL-safe Base64 text as fatal UTF-8.
function decodeBase64Url(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("CURSOR_INVALID");
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(`${base64}${padding}`);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** Encode one descending recent-Run cursor. */
export function encodePlatformRunCursorV1(
  value: z.infer<typeof PlatformRunCursorV1Schema>
): string {
  const parsed = PlatformRunCursorV1Schema.parse(value);
  return `run_v1_${encodeBase64Url(JSON.stringify(parsed))}`;
}

/** Decode one descending recent-Run cursor. */
export function decodePlatformRunCursorV1(
  cursor: string
): z.infer<typeof PlatformRunCursorV1Schema> {
  if (!cursor.startsWith("run_v1_")) throw new Error("CURSOR_VERSION_UNSUPPORTED");
  try {
    const dirty: unknown = JSON.parse(decodeBase64Url(cursor.slice("run_v1_".length)));
    return PlatformRunCursorV1Schema.parse(dirty);
  } catch {
    throw new Error("CURSOR_INVALID");
  }
}

/** Encode one Run Case Ordinal cursor. */
export function encodeRunCaseCursorV1(value: z.infer<typeof RunCaseCursorV1Schema>): string {
  const parsed = RunCaseCursorV1Schema.parse(value);
  return `run_case_v1_${encodeBase64Url(JSON.stringify(parsed))}`;
}

/** Decode one Run Case Ordinal cursor. */
export function decodeRunCaseCursorV1(cursor: string): z.infer<typeof RunCaseCursorV1Schema> {
  if (!cursor.startsWith("run_case_v1_")) throw new Error("CURSOR_VERSION_UNSUPPORTED");
  try {
    const dirty: unknown = JSON.parse(decodeBase64Url(cursor.slice("run_case_v1_".length)));
    return RunCaseCursorV1Schema.parse(dirty);
  } catch {
    throw new Error("CURSOR_INVALID");
  }
}

const FrozenSuiteSummaryV1Schema = z.strictObject({
  id: UuidV7Schema,
  name: z.string().trim().min(1),
  hash: Sha256Schema,
  caseCount: z.number().int().positive()
});

const FrozenEndpointSummaryV1Schema = z.strictObject({
  sourceId: UuidV7Schema.nullable(),
  name: z.string().trim().min(1),
  configHash: Sha256Schema,
  config: EndpointConfigV1Schema
});

const FrozenEvaluatorSummaryV1Schema = z.strictObject({
  sourceId: UuidV7Schema.nullable(),
  name: z.string().trim().min(1),
  configHash: Sha256Schema,
  config: LlmConfigV1Schema
});

const FrozenRubricPromptSummaryV1Schema = z.strictObject({
  promptKey: BusinessKeySchema,
  name: z.string().trim().min(1),
  promptHash: Sha256Schema
});

/** Current file availability relative to one immutable Manifest descriptor. */
export const ArtifactAvailabilityV1Schema = z.strictObject({
  kind: z.enum([
    "REST_RESULTS",
    "RAW_PROMPTFOO_EVIDENCE",
    "NORMALIZED_EVAL_RESULTS",
    "REPORT_JSON",
    "REPORT_MARKDOWN",
    "ANALYSIS_RESULTS"
  ]),
  path: z.string().min(1),
  status: z.enum(["PRESENT", "MISSING", "CORRUPTED"])
});

/** Complete committed Report overview without Case arrays. */
export const RunReportOverviewV1Schema = z.strictObject({
  runId: UuidV7Schema,
  sourceType: z.enum(["PLATFORM", "OFFLINE_IMPORT"]),
  sourceRunId: UuidV7Schema.nullable(),
  rerunMode: z.enum(["NONE", "RETRY_FAILED", "FORCE"]),
  completedAt: UtcDateTimeSchema,
  context: ReportContextV1Schema,
  evaluationContextHash: Sha256Schema,
  evaluationResultSetHash: Sha256Schema,
  reportResultSetHash: Sha256Schema,
  summary: ReportSummaryV1Schema,
  byMetric: z.array(MetricSummaryV1Schema),
  artifactAvailability: z.array(ArtifactAvailabilityV1Schema)
});

/** Complete normalized Report Case plus current Evidence availability. */
export const RunReportCaseV1Schema = ReportCaseV1Schema.safeExtend({
  rawEvidenceStatus: z.enum(["ABSENT", "PRESENT", "MISSING", "CORRUPTED"])
});

/** Cursor-paged filtered complete Report Cases. */
export const RunReportCasePageV1Schema = z.strictObject({
  items: z.array(RunReportCaseV1Schema),
  nextCursor: z.string().min(1).nullable()
});

// Normalize Fastify's single query value and repeated values into one exact list.
function reportQueryValues(value: unknown): unknown {
  return value === undefined ? undefined : Array.isArray(value) ? value : [value];
}

const ReportRestStatusQueryV1Schema = z.preprocess(
  reportQueryValues,
  z
    .array(z.enum(["SUCCEEDED", "ERROR"]))
    .min(1)
    .max(50)
    .optional()
);
const ReportEvalStatusQueryV1Schema = z.preprocess(
  reportQueryValues,
  z
    .array(z.enum(["PASS", "FAIL", "EVALUATION_ERROR", "NOT_EVALUATED"]))
    .min(1)
    .max(50)
    .optional()
);
const ReportBusinessKeyQueryV1Schema = z.preprocess(
  reportQueryValues,
  z.array(BusinessKeySchema).min(1).max(50).optional()
);
const ReportTextQueryV1Schema = z.preprocess(
  reportQueryValues,
  z.array(z.string().trim().min(1)).min(1).max(50).optional()
);

/** Bounded Report Case query with AND across fields and OR within one field. */
export const RunReportCaseListQueryV1Schema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional(),
  restStatus: ReportRestStatusQueryV1Schema,
  evalStatus: ReportEvalStatusQueryV1Schema,
  metric: ReportBusinessKeyQueryV1Schema,
  businessModule: ReportTextQueryV1Schema,
  scenarioTag: ReportTextQueryV1Schema
});

/** Bounded platform Run detail without the frozen Case array or Prompt bodies. */
export const PlatformRunDetailV1Schema = z.strictObject({
  ...RunMetadataShape,
  id: UuidV7Schema,
  sourceType: z.literal("PLATFORM"),
  sourceRunId: UuidV7Schema.nullable(),
  rerunMode: z.enum(["NONE", "RETRY_FAILED", "FORCE"]),
  suite: FrozenSuiteSummaryV1Schema,
  endpoint: FrozenEndpointSummaryV1Schema,
  evaluator: FrozenEvaluatorSummaryV1Schema,
  rubricPrompts: z.array(FrozenRubricPromptSummaryV1Schema),
  promptfooVersion: z.literal("0.121.18"),
  contractVersions: z.strictObject({
    runSnapshot: z.literal("cortex.run-snapshot.v1"),
    caseDefinition: z.literal("cortex.case-definition.v1"),
    platformRestResults: z.literal("cortex.platform-rest-results.v1")
  }),
  runContextHash: Sha256Schema,
  runExecutionLimits: RunExecutionLimitsV1Schema,
  runMode: RunModeV1Schema,
  status: RunStatusV1Schema,
  stage: RunStageV1Schema,
  lockRevision: z.number().int().nonnegative(),
  cancelRequestedAt: UtcDateTimeSchema.nullable(),
  rest: RestCountersV1Schema,
  evaluation: EvaluationCountersV1Schema,
  artifactManifest: ArtifactManifestV1Schema,
  artifactAvailability: z.array(ArtifactAvailabilityV1Schema),
  errorCode: z.enum(ERROR_CODES).nullable(),
  startedAt: UtcDateTimeSchema.nullable(),
  completedAt: UtcDateTimeSchema.nullable(),
  createdAt: UtcDateTimeSchema,
  updatedAt: UtcDateTimeSchema
});

const RestErrorTypeV1Schema = z.enum([
  "TIMEOUT",
  "NETWORK",
  "HTTP_STATUS",
  "RESPONSE_PARSE",
  "PROVIDER_OUTPUT_INVALID",
  "TEMPLATE_INPUT",
  "CANCELLED"
]);

const RunCaseSummaryBaseShape = {
  runId: UuidV7Schema,
  caseKey: BusinessKeySchema,
  ordinal: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  completedAt: UtcDateTimeSchema,
  resultHash: Sha256Schema
} as const;

/** Small real Case result; absent Cases are not represented as pending rows. */
export const RunCaseSummaryV1Schema = z.discriminatedUnion("status", [
  z.strictObject({
    ...RunCaseSummaryBaseShape,
    status: z.literal("SUCCEEDED"),
    httpStatus: z.number().int().min(200).max(299),
    errorType: z.null()
  }),
  z.strictObject({
    ...RunCaseSummaryBaseShape,
    status: z.literal("ERROR"),
    httpStatus: z.number().int().min(100).max(599).nullable(),
    errorType: RestErrorTypeV1Schema
  })
]);

/** Cursor-paged real REST Case results. */
export const RunCasePageV1Schema = z.strictObject({
  items: z.array(RunCaseSummaryV1Schema),
  nextCursor: z.string().min(1).nullable()
});

/** Bounded REST Case result query. */
export const RunCaseListQueryV1Schema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).optional()
});

/** One complete normalized Evaluation result with durable platform metadata. */
export const RunEvalItemV1Schema = z.strictObject({
  runId: UuidV7Schema,
  createdAt: UtcDateTimeSchema,
  updatedAt: UtcDateTimeSchema,
  result: EvalCaseV1Schema
});

/** Cursor-paged complete normalized Evaluation results. */
export const RunEvalPageV1Schema = z.strictObject({
  items: z.array(RunEvalItemV1Schema),
  nextCursor: z.string().min(1).nullable()
});

/** Bounded Evaluation result query reusing the frozen Case ordinal cursor. */
export const RunEvalListQueryV1Schema = RunCaseListQueryV1Schema;

/** Complete real REST Case result detail. */
export const RunCaseDetailV1Schema = z.discriminatedUnion("status", [
  z.strictObject({
    ...RunCaseSummaryBaseShape,
    caseDefinitionHash: Sha256Schema,
    definition: CaseDefinitionV1Schema,
    status: z.literal("SUCCEEDED"),
    httpStatus: z.number().int().min(200).max(299),
    providerOutput: ProviderOutputV1Schema,
    error: z.null()
  }),
  z.strictObject({
    ...RunCaseSummaryBaseShape,
    caseDefinitionHash: Sha256Schema,
    definition: CaseDefinitionV1Schema,
    status: z.literal("ERROR"),
    httpStatus: z.number().int().min(100).max(599).nullable(),
    providerOutput: z.null(),
    error: z.strictObject({ type: RestErrorTypeV1Schema, message: z.string().min(1) })
  })
]);

/** Revision token required by Run start and cancellation writes. */
export const RunRevisionRequestV1Schema = z.strictObject({
  expectedRevision: z.number().int().nonnegative()
});

/** SSE event types emitted by the closed Run REST and Evaluation capabilities. */
export const RunStreamEventTypeV1Schema = z.enum([
  "RUN_CREATED",
  "REST_STARTED",
  "REST_PROGRESS",
  "CANCEL_REQUESTED",
  "REST_COMPLETED",
  "EVALUATION_STARTED",
  "EVALUATION_COMPLETED",
  "RUN_CANCELLED",
  "RUN_FAILED",
  "RUN_INTERRUPTED"
]);

/** Snapshot-first strict Run progress SSE envelope. */
export const RunStreamEnvelopeV1Schema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("SNAPSHOT"),
    sequence: z.number().int().nonnegative(),
    progress: RunProgressV1Schema
  }),
  z.strictObject({
    type: z.literal("EVENT"),
    sequence: z.number().int().positive(),
    event: RunStreamEventTypeV1Schema,
    progress: RunProgressV1Schema
  })
]);
