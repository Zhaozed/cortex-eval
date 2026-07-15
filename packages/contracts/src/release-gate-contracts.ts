import { z } from "zod";

import { GeminiLlmConfigV1Schema } from "./provider-contracts.ts";
import {
  AnalysisPromptDefinitionV1Schema,
  PromptDefinitionV1Schema
} from "./resource-api-contracts.ts";

/** Explicit Secret-free configuration for the two mandatory P10 live Gemini smokes. */
export const ReleaseLiveConfigV1Schema = z
  .strictObject({
    contractVersion: z.literal("cortex.release-live-config.v1"),
    evaluator: GeminiLlmConfigV1Schema,
    analyzer: GeminiLlmConfigV1Schema,
    rubricPrompt: PromptDefinitionV1Schema,
    analysisPrompt: AnalysisPromptDefinitionV1Schema
  })
  .superRefine((value, context) => {
    if (value.analyzer.structuredOutput !== "JSON_SCHEMA") {
      context.addIssue({
        code: "custom",
        path: ["analyzer", "structuredOutput"],
        message: "RELEASE_ANALYZER_JSON_SCHEMA_REQUIRED"
      });
    }
  });

/** Parsed Secret-free P10 live Gemini configuration. */
export type ReleaseLiveConfigV1 = z.infer<typeof ReleaseLiveConfigV1Schema>;
