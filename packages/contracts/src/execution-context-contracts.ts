import { z } from "zod";

import { CaseDefinitionV1Schema } from "./case-contracts.ts";
import { BusinessKeySchema, HashSha256Schema, UuidV7Schema } from "./contracts-primitives.ts";
import {
  AnalysisExecutionLimitsV1Schema,
  RunExecutionLimitsV1Schema
} from "./execution-limit-contracts.ts";
import { EndpointConfigV1Schema, LlmConfigV1Schema } from "./provider-contracts.ts";

/** Prompt message stored in a frozen prompt Snapshot. */
export const PromptMessageV1Schema = z.strictObject({
  role: z.enum(["SYSTEM", "USER", "ASSISTANT"]),
  content: z.string().min(1)
});

const FrozenPromptV1Schema = z.strictObject({
  promptKey: BusinessKeySchema,
  name: z.string().trim().min(1),
  messages: z.array(PromptMessageV1Schema).min(1),
  promptHash: HashSha256Schema
});

const FrozenLlmV1Schema = z.strictObject({
  configHash: HashSha256Schema,
  config: LlmConfigV1Schema
});

/** Complete REST/Evaluation input frozen when a platform Run is created. */
export const RunSnapshotV1Schema = z
  .strictObject({
    contractVersion: z.literal("cortex.run-snapshot.v1"),
    suiteId: UuidV7Schema,
    suiteHash: HashSha256Schema,
    cases: z.array(
      z.strictObject({
        caseKey: BusinessKeySchema,
        ordinal: z.number().int().nonnegative(),
        definitionHash: HashSha256Schema,
        definition: CaseDefinitionV1Schema
      })
    ),
    endpoint: z.strictObject({
      configHash: HashSha256Schema,
      config: EndpointConfigV1Schema
    }),
    evaluator: FrozenLlmV1Schema,
    rubricPrompts: z.array(FrozenPromptV1Schema),
    promptfooVersion: z.literal("0.121.18"),
    runExecutionLimits: RunExecutionLimitsV1Schema,
    runContextHash: HashSha256Schema
  })
  .superRefine((snapshot, context) => {
    const caseKeys = new Set<string>();
    for (const [index, item] of snapshot.cases.entries()) {
      if (item.ordinal !== index || item.caseKey !== item.definition.metadata.case_id) {
        context.addIssue({ code: "custom", path: ["cases", index], message: "CASE_ALIGNMENT" });
      }
      if (caseKeys.has(item.caseKey)) {
        context.addIssue({ code: "custom", path: ["cases", index], message: "CASE_ID_DUPLICATE" });
      }
      caseKeys.add(item.caseKey);
    }
  });

/** Analyzer and Analysis Prompt frozen independently after a Report exists. */
export const AnalysisSnapshotV1Schema = z.strictObject({
  contractVersion: z.literal("cortex.analysis-snapshot.v1"),
  caseKey: BusinessKeySchema,
  finalCaseResultHash: HashSha256Schema,
  analyzer: FrozenLlmV1Schema,
  analysisPrompt: FrozenPromptV1Schema,
  analysisExecutionLimits: AnalysisExecutionLimitsV1Schema,
  analysisInputContractVersion: z.literal("cortex.analysis-input.v1"),
  analysisOutputContractVersion: z.literal("cortex.analysis-output.v1"),
  analysisInputHash: HashSha256Schema
});
