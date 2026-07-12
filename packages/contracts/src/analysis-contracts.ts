import { z } from "zod";

import { AssertionDefinitionV1Schema, CaseDefinitionV1Schema } from "./case-contracts.ts";
import { BusinessKeySchema, HashSha256Schema, JsonObjectSchema } from "./contracts-primitives.ts";
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
  evidence: z.array(z.string().trim().min(1)).min(1),
  explanation: z.string().trim().min(1),
  recommendedAction: z.string().trim().min(1),
  proposal: AnalysisProposalV1Schema.nullable()
});

/** Analysis Input DTO. */
export type AnalysisInputV1 = z.infer<typeof AnalysisInputV1Schema>;

/** Analysis Output DTO. */
export type AnalysisOutputV1 = z.infer<typeof AnalysisOutputV1Schema>;
