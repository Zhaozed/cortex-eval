import {
  AnalysisEvidenceSourceV1Schema,
  AnalysisOutputV1Schema
} from "@cortex-eval/contracts/src/analysis-contracts.ts";

/**
 * Gemini-supported top-level Analysis structure.
 *
 * Proposal remains object-or-null here because its recursive Case/Assertion Schema exceeds the
 * provider's reliable structured-output subset. The shared strict Zod contract still validates
 * every returned Proposal field before the result can enter Domain.
 */
export const AnalysisOutputV1GeminiJsonSchema: Readonly<Record<string, unknown>> = Object.freeze({
  type: "object",
  properties: {
    contractVersion: { type: "string", enum: ["cortex.analysis-output.v1"] },
    classification: {
      type: "string",
      enum: AnalysisOutputV1Schema.shape.classification.options
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    evidence: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          source: { type: "string", enum: AnalysisEvidenceSourceV1Schema.options },
          fieldPath: { anyOf: [{ type: "string" }, { type: "null" }] },
          conclusion: { type: "string" }
        },
        required: ["source", "fieldPath", "conclusion"],
        additionalProperties: false
      }
    },
    explanation: { type: "string" },
    recommendedAction: { type: "string" },
    proposal: { anyOf: [{ type: "object", additionalProperties: true }, { type: "null" }] }
  },
  required: [
    "contractVersion",
    "classification",
    "confidence",
    "evidence",
    "explanation",
    "recommendedAction",
    "proposal"
  ],
  additionalProperties: false
});
