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

/** Stable error when a configured Provider cannot honor one required feature. */
export const ProviderCapabilityErrorV1Schema = z.strictObject({
  contractVersion: z.literal("cortex.provider-capability-error.v1"),
  code: z.literal("PROVIDER_CAPABILITY_UNSUPPORTED"),
  providerType: z.enum(["GOOGLE_GEMINI", "OPENAI_COMPATIBLE"]),
  capability: z.enum(["JSON_SCHEMA", "JSON_OBJECT", "THINKING_LEVEL"]),
  retryable: z.literal(false)
});
