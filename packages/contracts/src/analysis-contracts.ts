import { z } from "zod";

import { AssertionDefinitionV1Schema, CaseDefinitionV1Schema } from "./case-contracts.ts";
import {
  BusinessKeySchema,
  HashSha256Schema,
  JsonObjectSchema,
  JsonPointerSchema,
  UtcDateTimeSchema,
  UuidV7Schema
} from "./contracts-primitives.ts";
import { AnalysisExecutionLimitsV1Schema } from "./execution-limit-contracts.ts";

/** Complete unrendered variables accepted by the Case Analysis Prompt. */
export const AnalysisVariablesV1Schema = z.strictObject({
  case_definition: JsonObjectSchema,
  provider_output: JsonObjectSchema,
  failed_assertions: z.array(JsonObjectSchema),
  expected_actual_diffs: z.array(JsonObjectSchema),
  llm_rubric_results: z.array(JsonObjectSchema),
  run_context: JsonObjectSchema
});

/** Closed Analysis Input source referenced by one evidence conclusion. */
export const AnalysisEvidenceSourceV1Schema = z.enum([
  "case_definition",
  "provider_output",
  "failed_assertions",
  "expected_actual_diffs",
  "llm_rubric_results",
  "run_context"
]);

/** One machine-locatable and human-readable Analysis evidence fact. */
export const AnalysisEvidenceV1Schema = z.strictObject({
  source: AnalysisEvidenceSourceV1Schema,
  fieldPath: JsonPointerSchema.nullable(),
  conclusion: z.string().trim().min(1)
});

/** Closed safe Case-level failures emitted by the direct Analyzer boundary. */
export const AnalyzerCaseErrorCodeV1Schema = z.enum([
  "ANALYZER_CONFIG_INVALID",
  "ANALYZER_SECRET_MISSING",
  "ANALYZER_PROVIDER_CAPABILITY_UNSUPPORTED",
  "ANALYZER_PROVIDER_REQUEST_FAILED",
  "ANALYZER_INPUT_TOO_LARGE",
  "ANALYZER_OUTPUT_TOO_LARGE",
  "ANALYZER_OUTPUT_INVALID"
]);

/** Versioned Analysis identity before Prompt rendering. */
export const AnalysisInputV1Schema = z.strictObject({
  contractVersion: z.literal("cortex.analysis-input.v1"),
  caseKey: BusinessKeySchema,
  variables: AnalysisVariablesV1Schema,
  finalCaseResultHash: HashSha256Schema,
  runContextHash: HashSha256Schema,
  diffContractVersion: z.literal("cortex.assertion-diff.v1"),
  analysisPromptHash: HashSha256Schema,
  analyzerConfigHash: HashSha256Schema,
  analysisOutputContractVersion: z.literal("cortex.analysis-output.v1"),
  analysisExecutionLimits: AnalysisExecutionLimitsV1Schema
});

/** Single action-dependent Case modification Proposal. */
export const AnalysisProposalV1Schema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("REPLACE_CASE"),
    baseDefinitionHash: HashSha256Schema,
    casePayload: CaseDefinitionV1Schema
  }),
  z.strictObject({
    action: z.literal("ADD_ASSERTION"),
    baseDefinitionHash: HashSha256Schema,
    targetAssertionIndex: z.number().int().nonnegative(),
    assertion: AssertionDefinitionV1Schema
  }),
  z.strictObject({
    action: z.literal("REPLACE_ASSERTION"),
    baseDefinitionHash: HashSha256Schema,
    targetAssertionIndex: z.number().int().nonnegative(),
    targetAssertionDefinitionHash: HashSha256Schema,
    assertion: AssertionDefinitionV1Schema
  }),
  z.strictObject({
    action: z.literal("REMOVE_ASSERTION"),
    baseDefinitionHash: HashSha256Schema,
    targetAssertionIndex: z.number().int().nonnegative(),
    targetAssertionDefinitionHash: HashSha256Schema
  })
]);

/** Strict structured model output. */
export const AnalysisOutputV1Schema = z.strictObject({
  contractVersion: z.literal("cortex.analysis-output.v1"),
  classification: z.enum([
    "LABEL_ERROR",
    "ADDITIONAL_VALID_RESULT",
    "NORMAL_FAILURE",
    "PARAMETER_VARIANCE"
  ]),
  confidence: z.number().min(0).max(1),
  evidence: z.array(AnalysisEvidenceV1Schema).min(1),
  explanation: z.string().trim().min(1),
  recommendedAction: z.string().trim().min(1),
  proposal: AnalysisProposalV1Schema.nullable()
});

const analysisOutputJsonSchemaWithDialect = z.toJSONSchema(AnalysisOutputV1Schema, {
  target: "draft-7",
  unrepresentable: "throw"
});
const { $schema: _analysisOutputDialect, ...analysisOutputJsonSchema } =
  analysisOutputJsonSchemaWithDialect;
void _analysisOutputDialect;

/** Draft-07 projection supplied to official structured-output SDKs. */
export const AnalysisOutputV1JsonSchema: Readonly<Record<string, unknown>> =
  Object.freeze(analysisOutputJsonSchema);

/** Analysis Input DTO. */
export type AnalysisInputV1 = z.infer<typeof AnalysisInputV1Schema>;

/** Analysis Output DTO. */
export type AnalysisOutputV1 = z.infer<typeof AnalysisOutputV1Schema>;

/** Structured Analysis evidence DTO. */
export type AnalysisEvidenceV1 = z.infer<typeof AnalysisEvidenceV1Schema>;

/** Closed safe Analyzer Case error code. */
export type AnalyzerCaseErrorCodeV1 = z.infer<typeof AnalyzerCaseErrorCodeV1Schema>;

/** Start or replace current analyses for one complete Report Run. */
export const StartCaseAnalysisRequestV1Schema = z.strictObject({
  analyzerConfigId: UuidV7Schema,
  analysisPromptId: UuidV7Schema,
  selector: z.enum(["failed", "errors", "all"]),
  analysisExecutionLimits: AnalysisExecutionLimitsV1Schema.optional()
});

/** Completed platform Analysis batch summary. */
export const StartCaseAnalysisResultV1Schema = z.strictObject({
  contractVersion: z.literal("cortex.case-analysis-start-result.v1"),
  runId: UuidV7Schema,
  selector: z.enum(["failed", "errors", "all"]),
  selectedCount: z.number().int().nonnegative(),
  succeededCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  finalCaseResultSetHash: HashSha256Schema
});

const StoredAnalysisPromptIdentityV1Schema = z.strictObject({
  sourceId: UuidV7Schema.nullable(),
  promptKey: BusinessKeySchema,
  promptHash: HashSha256Schema
});

const StoredAnalyzerIdentityV1Schema = z.strictObject({
  sourceId: UuidV7Schema.nullable(),
  configHash: HashSha256Schema,
  provider: z.enum(["GOOGLE_GEMINI", "OPENAI_COMPATIBLE"]),
  model: z.string().trim().min(1)
});

/** Current Run/Case Analysis projection without full frozen prompt or secret-bearing config. */
export const CurrentCaseAnalysisV1Schema = z.strictObject({
  contractVersion: z.literal("cortex.current-case-analysis.v1"),
  id: UuidV7Schema,
  runId: UuidV7Schema,
  caseKey: BusinessKeySchema,
  finalCaseResultHash: HashSha256Schema,
  revision: z.number().int().positive(),
  prompt: StoredAnalysisPromptIdentityV1Schema,
  analyzer: StoredAnalyzerIdentityV1Schema,
  analysisInputHash: HashSha256Schema,
  analysisExecutionLimits: AnalysisExecutionLimitsV1Schema,
  status: z.enum(["PENDING", "RUNNING", "SUCCEEDED", "ERROR"]),
  output: AnalysisOutputV1Schema.nullable(),
  analysisResultHash: HashSha256Schema.nullable(),
  decision: z.enum(["NO_PROPOSAL", "PENDING", "ACCEPTED", "REJECTED", "EDITED_AND_ACCEPTED"]),
  applyStatus: z.enum(["NOT_APPLICABLE", "NOT_APPLIED", "APPLIED", "CONFLICT"]),
  baseDefinitionHash: HashSha256Schema.nullable(),
  appliedDefinitionHash: HashSha256Schema.nullable(),
  errorCode: z.string().trim().min(1).nullable(),
  errorMessage: z.string().trim().min(1).nullable(),
  createdAt: UtcDateTimeSchema,
  updatedAt: UtcDateTimeSchema
});

/** Optimistic target shared by all current Proposal decisions. */
export const AnalysisProposalDecisionTargetV1Schema = z.strictObject({
  analysisId: UuidV7Schema,
  expectedAnalysisRevision: z.number().int().positive()
});

/** Complete visible identities required to accept one current Proposal. */
export const AcceptAnalysisProposalRequestV1Schema = z.strictObject({
  ...AnalysisProposalDecisionTargetV1Schema.shape,
  expectedFinalCaseResultHash: HashSha256Schema,
  expectedAnalysisInputHash: HashSha256Schema,
  expectedPromptHash: HashSha256Schema,
  expectedAnalyzerConfigHash: HashSha256Schema,
  suiteId: UuidV7Schema,
  expectedSuiteRevision: z.number().int().nonnegative(),
  expectedCaseId: UuidV7Schema,
  expectedCaseRevision: z.number().int().nonnegative(),
  editedProposal: AnalysisProposalV1Schema.optional()
});

/** Platform Analysis start request DTO. */
export type StartCaseAnalysisRequestV1 = z.infer<typeof StartCaseAnalysisRequestV1Schema>;

/** Current Analysis response DTO. */
export type CurrentCaseAnalysisV1 = z.infer<typeof CurrentCaseAnalysisV1Schema>;
