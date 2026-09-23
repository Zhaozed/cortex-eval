import { z } from "zod";
import { BriefEvaluationProfileSchema } from "./brief-evaluation-contracts.ts";

import { JsonObjectSchema } from "./contracts-primitives.ts";

/** Semantic evaluation contract used to describe a Case without prescribing one exact Trace. */
export const SEMANTIC_EVALUATION_CONTRACT_V1 = "cortex.semantic-evaluation-contract.v1" as const;

export const EvaluationDimensionSchema = z.enum([
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
export type EvaluationDimension = z.infer<typeof EvaluationDimensionSchema>;

const ToolPolicySchema = z.strictObject({
  allowedTools: z.array(z.string().trim().min(1)).optional(),
  requiredTools: z.array(z.string().trim().min(1)).optional(),
  /** Tool names that must occur in this order; other allowed calls may occur around them. */
  requiredOrder: z.array(z.string().trim().min(1)).min(1).optional(),
  forbiddenTools: z.array(z.string().trim().min(1)).optional(),
  maxRetries: z.number().int().nonnegative().optional()
});

const A2uiExpectationSchema = z.strictObject({
  /** Components that are acceptable/expected candidates; not all must appear. */
  expectedComponents: z.array(z.string().trim().min(1)).optional(),
  /** Components that must appear when the A2UI dimension is applicable. */
  requiredComponents: z.array(z.string().trim().min(1)).optional(),
  forbiddenComponents: z.array(z.string().trim().min(1)).optional(),
  confirmationRequired: z.boolean().optional(),
  timingNote: z.string().trim().min(1).optional()
});

/** Product-facing task contract. It states what matters, not how the Agent must execute. */
export const SemanticEvaluationContractV1Schema = z.strictObject({
  contractVersion: z.literal(SEMANTIC_EVALUATION_CONTRACT_V1),
  goal: z.string().trim().min(1),
  /** Optional evaluator instruction appended to the generated decision plan. */
  evaluatorPrompt: z.string().trim().min(1).optional(),
  /** Optional per-Case model override; endpoint and secret stay server-side. */
  model: z.string().trim().min(1).optional(),
  successCriteria: z.array(z.string().trim().min(1)).min(1),
  forbiddenBehaviors: z.array(z.string().trim().min(1)).optional(),
  /** Facts the final answer must cover; used to make response failures auditable. */
  responseRequiredFacts: z.array(z.string().trim().min(1)).optional(),
  /** Claims or answer content that must not appear in the final answer. */
  responseForbiddenClaims: z.array(z.string().trim().min(1)).optional(),
  enabledDimensions: z
    .array(EvaluationDimensionSchema)
    .min(1)
    .refine((items) => new Set(items).size === items.length, "EVALUATION_DIMENSIONS_DUPLICATED"),
  riskLevel: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
  scorePassThreshold: z.number().min(0).max(1).optional(),
  latencySlaMs: z.number().int().positive().optional(),
  toolPolicy: ToolPolicySchema.optional(),
  a2ui: A2uiExpectationSchema.optional(),
  brief: BriefEvaluationProfileSchema.optional(),
  context: JsonObjectSchema.optional()
});
export type SemanticEvaluationContractV1 = z.infer<typeof SemanticEvaluationContractV1Schema>;

export const JevDecisionKindSchema = z.enum(["BOOLEAN", "CHOICE", "SCORE"]);
export type JevDecisionKind = z.infer<typeof JevDecisionKindSchema>;

const JevScoreScaleSchema = z.strictObject({
  min: z.number(),
  max: z.number(),
  step: z.number().positive(),
  labels: z.record(z.string(), z.string()).optional()
});

/** One typed question that JEV answers from the normalized Agent Trace. */
export const JevDecisionQuestionV1Schema = z
  .strictObject({
    id: z.string().trim().min(1),
    dimension: EvaluationDimensionSchema,
    kind: JevDecisionKindSchema,
    question: z.string().trim().min(1),
    choices: z.array(z.string().trim().min(1)).min(2).optional(),
    scale: JevScoreScaleSchema.optional(),
    blocking: z.boolean().default(true)
  })
  .superRefine((question, context) => {
    if (question.kind === "CHOICE" && question.choices === undefined) {
      context.addIssue({ code: "custom", message: "JEV_CHOICE_OPTIONS_REQUIRED" });
    }
    if (question.kind === "SCORE" && question.scale === undefined) {
      context.addIssue({ code: "custom", message: "JEV_SCORE_SCALE_REQUIRED" });
    }
    if (question.kind !== "CHOICE" && question.choices !== undefined) {
      context.addIssue({ code: "custom", message: "JEV_CHOICE_OPTIONS_UNEXPECTED" });
    }
    if (question.kind !== "SCORE" && question.scale !== undefined) {
      context.addIssue({ code: "custom", message: "JEV_SCORE_SCALE_UNEXPECTED" });
    }
  });
export type JevDecisionQuestionV1 = z.infer<typeof JevDecisionQuestionV1Schema>;

/** Compiled plan sent to the JEV adapter; it is independent from a concrete Trace shape. */
export const JevDecisionPlanV1Schema = z
  .strictObject({
    contractVersion: z.literal(SEMANTIC_EVALUATION_CONTRACT_V1),
    questions: z.array(JevDecisionQuestionV1Schema).min(1)
  })
  .refine(
    (plan) => new Set(plan.questions.map((question) => question.id)).size === plan.questions.length,
    "JEV_DECISION_IDS_DUPLICATED"
  );
export type JevDecisionPlanV1 = z.infer<typeof JevDecisionPlanV1Schema>;

export const AGENT_TRACE_V1 = "cortex.agent-trace.v1" as const;

const TraceToolCallSchema = z.strictObject({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  args: JsonObjectSchema,
  outcome: z.enum(["success", "failure", "timeout", "cancelled", "unknown"]),
  result: z.unknown().optional(),
  error: z.string().trim().min(1).optional(),
  retryOf: z.string().trim().min(1).optional(),
  startedAtMs: z.number().nonnegative().optional(),
  endedAtMs: z.number().nonnegative().optional(),
  durationMs: z.number().nonnegative().optional()
});

const TraceA2uiEventSchema = z.strictObject({
  id: z.string().trim().min(1),
  component: z.string().trim().min(1),
  event: z.enum(["emitted", "rendered", "updated", "dismissed", "action"]),
  timestampMs: z.number().nonnegative().optional(),
  payload: z.unknown().optional()
});

const TraceFactsSchema = z.strictObject({
  calledTools: z.array(z.string().trim().min(1)).default([]),
  toolCallCount: z.number().int().nonnegative().default(0),
  failedToolCallCount: z.number().int().nonnegative().default(0),
  retryCount: z.number().int().nonnegative().default(0),
  a2uiComponents: z.array(z.string().trim().min(1)).default([]),
  a2uiEventCount: z.number().int().nonnegative().default(0),
  hasToolTimestamps: z.boolean().default(false),
  hasA2uiTimestamps: z.boolean().default(false)
});

const TraceMessageSchema = z.strictObject({
  role: z.enum(["system", "user", "assistant", "tool"]),
  text: z.string(),
  visibleToUser: z.boolean().default(true)
});

/** Normalized, evaluator-facing Agent Trace. Raw evidence is retained for future adapters. */
export const AgentTraceV1Schema = z.strictObject({
  contractVersion: z.literal(AGENT_TRACE_V1),
  task: z.string().trim().min(1),
  messages: z.array(TraceMessageSchema).default([]),
  router: z
    .strictObject({
      selected: z.string().trim().min(1).optional(),
      candidates: z.array(z.string().trim().min(1)).default([])
    })
    .default({ candidates: [] }),
  planner: z
    .strictObject({
      steps: z.array(z.string().trim().min(1)).default([]),
      status: z.enum(["completed", "failed", "partial", "unknown"]).default("unknown")
    })
    .default({ steps: [], status: "unknown" }),
  toolCalls: z.array(TraceToolCallSchema).default([]),
  a2ui: z.array(TraceA2uiEventSchema).default([]),
  /** Small derived facts make the evaluator read the important evidence without raw-trace guessing. */
  facts: TraceFactsSchema.optional(),
  finalAnswer: z.string().default(""),
  timing: z
    .strictObject({
      durationMs: z.number().nonnegative().optional(),
      firstResponseMs: z.number().nonnegative().optional()
    })
    .default({}),
  raw: JsonObjectSchema.default({}),
  normalizationWarnings: z.array(z.string().trim().min(1)).default([])
});
export type AgentTraceV1 = z.infer<typeof AgentTraceV1Schema>;

const JevDecisionValueSchema = z.union([z.boolean(), z.number(), z.string()]);

/** Provider-neutral normalized answer returned by JEV. */
export const JevDecisionResultV1Schema = z.strictObject({
  questionId: z.string().trim().min(1),
  question: z.string().trim().min(1).optional(),
  blocking: z.boolean().optional(),
  verdict: z.enum(["PASS", "FAIL", "NA"]).optional(),
  passThreshold: z.number().min(0).max(1).optional(),

  kind: JevDecisionKindSchema,
  value: JevDecisionValueSchema,
  probability: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  /** False means the question was not applicable to this Trace, e.g. no failure existed to recover from. */
  applicable: z.boolean().default(true),
  reason: z.string().trim().min(1).optional(),
  evidence: z.array(z.string().trim().min(1)).default([]),
  /** Platform-generated pointers to the exact contract/Trace facts used for the readable explanation. */
  evidenceRefs: z.array(z.string().trim().min(1)).default([]),
  /** The reason returned by JEV itself, when the provider supplied one. */
  providerReason: z.string().trim().min(1).optional(),
  /** The bounded provider answer shown for auditability; never contains the API key. */
  providerResponse: JsonObjectSchema.optional(),
  /** The platform's independent explanation derived from the Case contract and Trace. */
  platformReason: z.string().trim().min(1).optional()
});
export type JevDecisionResultV1 = z.infer<typeof JevDecisionResultV1Schema>;

export const JevEvaluationRequestV1Schema = z.strictObject({
  contract: SemanticEvaluationContractV1Schema,
  plan: JevDecisionPlanV1Schema,
  trace: AgentTraceV1Schema
});
export type JevEvaluationRequestV1 = z.infer<typeof JevEvaluationRequestV1Schema>;

export const JevEvaluationResultV1Schema = z.strictObject({
  contractVersion: z.literal(SEMANTIC_EVALUATION_CONTRACT_V1),
  passed: z.boolean(),
  score: z.number().min(0).max(1),
  decisions: z.array(JevDecisionResultV1Schema),
  blockingFailures: z.array(z.string().trim().min(1)).default([]),
  warnings: z.array(z.string().trim().min(1)).default([])
});
export type JevEvaluationResultV1 = z.infer<typeof JevEvaluationResultV1Schema>;

/** Persisted per-Case JEV evidence with evaluator and plan identity. */
export const JevCaseEvaluationV1Schema = z.strictObject({
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

  result: JevEvaluationResultV1Schema
});
export type JevCaseEvaluationV1 = z.infer<typeof JevCaseEvaluationV1Schema>;

export const JevProviderConfigV1Schema = z.strictObject({
  providerType: z.literal("HTTP"),
  endpoint: z.url().default("https://api.typesafe.ai/v1/systemone"),
  model: z.string().trim().min(1).default("jev-latest"),
  timeoutMs: z.number().int().positive().max(600_000).default(60_000),
  apiKeyEnv: z.string().trim().min(1).optional()
});
export type JevProviderConfigV1 = z.infer<typeof JevProviderConfigV1Schema>;
