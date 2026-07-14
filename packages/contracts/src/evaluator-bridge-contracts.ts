import { z } from "zod";

import {
  BusinessKeySchema,
  JsonValueSchema,
  Sha256Schema,
  UtcDateTimeSchema,
  UuidV7Schema
} from "./contracts-primitives.ts";

const EvaluatorBindingV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("RUN"), runId: UuidV7Schema }),
  z.strictObject({ kind: z.literal("EXECUTION"), executionId: UuidV7Schema })
]);

/** Server-side one-use grant; the raw token is never persisted. */
export const EvaluatorBridgeCapabilityV1Schema = z.strictObject({
  contractVersion: z.literal("cortex.evaluator-bridge-capability.v1"),
  capabilityHash: Sha256Schema,
  binding: EvaluatorBindingV1Schema,
  evaluatorConfigHash: Sha256Schema,
  maxCalls: z.literal(1),
  maxConcurrency: z.number().int().min(1).max(16),
  timeoutMs: z.number().int().min(100).max(600_000),
  expiresAt: UtcDateTimeSchema
});

/** Server-side Evaluation-call-lifetime grant; the raw token is never persisted. */
export const EvaluatorBridgeCapabilityV2Schema = z.strictObject({
  contractVersion: z.literal("cortex.evaluator-bridge-capability.v2"),
  capabilityHash: Sha256Schema,
  binding: EvaluatorBindingV1Schema,
  evaluationContextHash: Sha256Schema,
  evaluatorConfigHash: Sha256Schema,
  maxCalls: z.number().int().nonnegative(),
  maxConcurrency: z.number().int().min(1).max(16),
  timeoutMs: z.number().int().min(100).max(600_000),
  expiresAt: UtcDateTimeSchema
});

/** Evaluator Bridge v2 capability DTO. */
export type EvaluatorBridgeCapabilityV2 = z.infer<typeof EvaluatorBridgeCapabilityV2Schema>;

/** Narrow Promptfoo-to-Evaluator Bridge request. */
export const EvaluatorBridgeRequestV1Schema = z.strictObject({
  contractVersion: z.literal("cortex.evaluator-bridge-request.v1"),
  callId: UuidV7Schema,
  capability: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
  binding: EvaluatorBindingV1Schema,
  caseKey: BusinessKeySchema,
  assertionIndex: z.number().int().nonnegative(),
  prompt: z.string().trim().min(1)
});

/** Narrow Promptfoo-to-Evaluator Bridge v2 request without Assertion identity. */
export const EvaluatorBridgeRequestV2Schema = z.strictObject({
  contractVersion: z.literal("cortex.evaluator-bridge-request.v2"),
  capability: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
  binding: EvaluatorBindingV1Schema,
  evaluationContextHash: Sha256Schema,
  prompt: JsonValueSchema
});

/** Evaluator Bridge v2 request DTO. */
export type EvaluatorBridgeRequestV2 = z.infer<typeof EvaluatorBridgeRequestV2Schema>;

const TokenUsageV1Schema = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative()
});

const EvaluatorBridgeSuccessV1Schema = z.strictObject({
  contractVersion: z.literal("cortex.evaluator-bridge-response.v1"),
  callId: UuidV7Schema,
  status: z.literal("SUCCESS"),
  output: z.strictObject({
    text: z.string(),
    structured: JsonValueSchema.nullable(),
    tokenUsage: TokenUsageV1Schema.nullable()
  })
});

const EvaluatorBridgeErrorCodeSchema = z.enum([
  "EVALUATOR_CAPABILITY_INVALID",
  "EVALUATOR_BINDING_MISMATCH",
  "EVALUATOR_BUDGET_EXCEEDED",
  "EVALUATOR_TIMEOUT",
  "EVALUATOR_CANCELLED",
  "PROVIDER_CAPABILITY_UNSUPPORTED",
  "PROVIDER_REQUEST_FAILED"
]);

const EvaluatorBridgeFailureV1Schema = z.strictObject({
  contractVersion: z.literal("cortex.evaluator-bridge-response.v1"),
  callId: UuidV7Schema,
  status: z.literal("ERROR"),
  error: z.strictObject({
    code: EvaluatorBridgeErrorCodeSchema,
    retryable: z.literal(false),
    message: z.string().trim().min(1)
  })
});

/** Bridge response with no automatic retry semantics. */
export const EvaluatorBridgeResponseV1Schema = z.discriminatedUnion("status", [
  EvaluatorBridgeSuccessV1Schema,
  EvaluatorBridgeFailureV1Schema
]);

const EvaluatorBridgeSuccessV2Schema = z.strictObject({
  contractVersion: z.literal("cortex.evaluator-bridge-response.v2"),
  callId: UuidV7Schema,
  status: z.literal("SUCCESS"),
  output: z.strictObject({
    text: z.string(),
    structured: JsonValueSchema.nullable(),
    tokenUsage: TokenUsageV1Schema.nullable()
  })
});

const EvaluatorBridgeFailureV2Schema = z.strictObject({
  contractVersion: z.literal("cortex.evaluator-bridge-response.v2"),
  callId: UuidV7Schema,
  status: z.literal("ERROR"),
  error: z.strictObject({
    code: EvaluatorBridgeErrorCodeSchema,
    retryable: z.literal(false),
    message: z.string().trim().min(1)
  })
});

/** Bridge v2 response with no automatic retry semantics. */
export const EvaluatorBridgeResponseV2Schema = z.discriminatedUnion("status", [
  EvaluatorBridgeSuccessV2Schema,
  EvaluatorBridgeFailureV2Schema
]);

/** Stable error when a configured Provider cannot honor one required feature. */
export const ProviderCapabilityErrorV1Schema = z.strictObject({
  contractVersion: z.literal("cortex.provider-capability-error.v1"),
  code: z.literal("PROVIDER_CAPABILITY_UNSUPPORTED"),
  providerType: z.enum(["GOOGLE_GEMINI", "OPENAI_COMPATIBLE"]),
  capability: z.enum(["JSON_SCHEMA", "JSON_OBJECT", "THINKING_LEVEL"]),
  retryable: z.literal(false)
});
