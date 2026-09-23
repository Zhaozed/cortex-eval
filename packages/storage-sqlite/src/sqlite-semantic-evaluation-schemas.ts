import type { DomainJsonValue } from "@cortex-eval/domain/src/domain-canonical-hash.ts";
import { z } from "zod";
import { BriefEvaluationProfileSchema } from "./sqlite-brief-evaluation-schema.ts";

const JsonValueSchema: z.ZodType<DomainJsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema)
  ])
);

const EvaluationDimensionSchema = z.enum([
  "task-outcome",
  "routing",
  "tool-use",
  "timeliness",
  "a2ui",
  "response",
  "safety",
  "state-consistency",
  "recovery"
]);

export const SemanticEvaluationContractV1Schema = z.strictObject({
  contractVersion: z.literal("cortex.semantic-evaluation-contract.v1"),
  goal: z.string().trim().min(1),
  evaluatorPrompt: z.string().trim().min(1).optional(),
  /** Optional per-Case model override; endpoint and secret stay server-side. */
  model: z.string().trim().min(1).optional(),
  successCriteria: z.array(z.string().trim().min(1)).min(1),
  forbiddenBehaviors: z.array(z.string().trim().min(1)).optional(),
  responseRequiredFacts: z.array(z.string().trim().min(1)).optional(),
  responseForbiddenClaims: z.array(z.string().trim().min(1)).optional(),
  enabledDimensions: z
    .array(EvaluationDimensionSchema)
    .min(1)
    .refine((items) => new Set(items).size === items.length, "EVALUATION_DIMENSIONS_DUPLICATED"),
  riskLevel: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
  scorePassThreshold: z.number().min(0).max(1).optional(),
  latencySlaMs: z.number().int().positive().optional(),
  toolPolicy: z
    .strictObject({
      allowedTools: z.array(z.string().trim().min(1)).optional(),
      requiredTools: z.array(z.string().trim().min(1)).optional(),
      requiredOrder: z.array(z.string().trim().min(1)).min(1).optional(),
      forbiddenTools: z.array(z.string().trim().min(1)).optional(),
      maxRetries: z.number().int().nonnegative().optional()
    })
    .optional(),
  a2ui: z
    .strictObject({
      expectedComponents: z.array(z.string().trim().min(1)).optional(),
      requiredComponents: z.array(z.string().trim().min(1)).optional(),
      forbiddenComponents: z.array(z.string().trim().min(1)).optional(),
      confirmationRequired: z.boolean().optional(),
      timingNote: z.string().trim().min(1).optional()
    })
    .optional(),
  brief: BriefEvaluationProfileSchema.optional(),
  context: z.record(z.string(), JsonValueSchema).optional()
});

const SemanticDecisionSchema = z.strictObject({
  questionId: z.string().trim().min(1),
  question: z.string().trim().min(1).optional(),
  blocking: z.boolean().optional(),
  verdict: z.enum(["PASS", "FAIL", "NA"]).optional(),
  passThreshold: z.number().min(0).max(1).optional(),

  kind: z.enum(["BOOLEAN", "CHOICE", "SCORE"]),
  value: z.union([z.boolean(), z.number(), z.string()]),
  probability: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  applicable: z.boolean().default(true),
  reason: z.string().trim().min(1).optional(),
  evidence: z.array(z.string().trim().min(1)).default([]),
  evidenceRefs: z.array(z.string().trim().min(1)).default([]),
  providerReason: z.string().trim().min(1).optional(),
  providerResponse: z.record(z.string(), JsonValueSchema).optional(),
  platformReason: z.string().trim().min(1).optional()
});

export const SemanticEvaluationSchema = z.strictObject({
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1),
  planVersion: z.string().trim().min(1),
  metrics: z
    .strictObject({
      durationMs: z.number().nonnegative(),
      requestCount: z.number().int().nonnegative(),
      inputTokens: z.number().int().nonnegative().optional(),
      outputTokens: z.number().int().nonnegative().optional(),
      usageComplete: z.boolean()
    })
    .optional(),

  result: z.strictObject({
    contractVersion: z.string().trim().min(1),
    passed: z.boolean(),
    score: z.number().min(0).max(1),
    decisions: z.array(SemanticDecisionSchema),
    blockingFailures: z.array(z.string().trim().min(1)).default([]),
    warnings: z.array(z.string().trim().min(1)).default([])
  })
});
