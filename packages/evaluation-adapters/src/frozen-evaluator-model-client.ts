import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import type {
  GenerateContentParameters,
  GenerateContentResponse,
  GoogleGenAIOptions
} from "@google/genai";
import {
  isValidFrozenRunEvaluatorDefinition,
  type FrozenRunEvaluator
} from "@cortex-eval/application/src/features/runs/platform-run-models.ts";
import OpenAI, { type ClientOptions } from "openai";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming
} from "openai/resources/chat/completions/completions.js";

import type { EvaluatorModelClient, EvaluatorModelResult } from "./evaluator-bridge-v2.ts";
import {
  classifyEvaluatorProviderFailure,
  MAX_PROVIDER_RETRY_AFTER_MS
} from "./evaluator-model-errors.ts";

/** Narrow OpenAI SDK surface owned by this Adapter. */
export interface FrozenOpenAiSdkClient {
  /** Execute one non-streaming Chat Completion. */
  readonly create: (
    input: ChatCompletionCreateParamsNonStreaming,
    options: OpenAI.RequestOptions
  ) => Promise<ChatCompletion>;
}

/** Narrow Gemini SDK surface owned by this Adapter. */
export interface FrozenGeminiSdkClient {
  /** Execute one Generate Content request. */
  readonly generateContent: (input: GenerateContentParameters) => Promise<GenerateContentResponse>;
}

/** Injectable official SDK constructors used by deterministic tests. */
export interface FrozenEvaluatorSdkFactories {
  /** Construct the locked OpenAI SDK client. */
  readonly openAi: (options: ClientOptions) => FrozenOpenAiSdkClient;
  /** Construct the locked Google GenAI SDK client. */
  readonly gemini: (options: GoogleGenAIOptions) => FrozenGeminiSdkClient;
}

/** Input required to construct one frozen Evaluator model client. */
export interface CreateFrozenEvaluatorModelClientInput {
  /** Validated frozen Evaluator definition. */
  readonly config: FrozenRunEvaluator["definition"];
  /** Read one Secret only at the infrastructure boundary. */
  readonly readSecret: (envKey: string) => string | undefined;
  /** Optional deterministic SDK seams. */
  readonly factories?: FrozenEvaluatorSdkFactories;
}

const DEFAULT_FACTORIES: FrozenEvaluatorSdkFactories = {
  openAi: (options) => {
    const client = new OpenAI(options);
    return {
      create: (input, requestOptions) => client.chat.completions.create(input, requestOptions)
    };
  },
  gemini: (options) => {
    const client = new GoogleGenAI(options);
    return { generateContent: (input) => client.models.generateContent(input) };
  }
};

// Return exact usage only when the OpenAI provider supplied every counter.
function openAiUsage(response: ChatCompletion): EvaluatorModelResult["tokenUsage"] {
  const usage = response.usage;
  if (
    usage === undefined ||
    typeof usage.prompt_tokens !== "number" ||
    typeof usage.completion_tokens !== "number" ||
    typeof usage.total_tokens !== "number" ||
    !Number.isSafeInteger(usage.prompt_tokens) ||
    !Number.isSafeInteger(usage.completion_tokens) ||
    !Number.isSafeInteger(usage.total_tokens)
  ) {
    return null;
  }
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens
  };
}

// Return exact usage only when the Gemini provider supplied every counter.
function geminiUsage(response: GenerateContentResponse): EvaluatorModelResult["tokenUsage"] {
  const usage = response.usageMetadata;
  if (
    usage === undefined ||
    typeof usage.promptTokenCount !== "number" ||
    typeof usage.candidatesTokenCount !== "number" ||
    typeof usage.totalTokenCount !== "number" ||
    !Number.isSafeInteger(usage.promptTokenCount) ||
    !Number.isSafeInteger(usage.candidatesTokenCount) ||
    !Number.isSafeInteger(usage.totalTokenCount)
  ) {
    return null;
  }
  return {
    inputTokens: usage.promptTokenCount,
    outputTokens: usage.candidatesTokenCount,
    totalTokens: usage.totalTokenCount
  };
}

// Translate the provider-neutral thinking level into OpenAI Chat Completions.
function openAiReasoningEffort(
  value: FrozenRunEvaluator["definition"]["thinkingLevel"]
): "none" | "low" | "medium" | "high" {
  if (value === "OFF") return "none";
  if (value === "LOW") return "low";
  if (value === "MEDIUM") return "medium";
  return "high";
}

// Translate the provider-neutral thinking level into Gemini Generate Content.
function geminiThinkingConfig(
  value: FrozenRunEvaluator["definition"]["thinkingLevel"]
): { readonly thinkingBudget: 0 } | { readonly thinkingLevel: ThinkingLevel } {
  if (value === "OFF") return { thinkingBudget: 0 };
  if (value === "LOW") return { thinkingLevel: ThinkingLevel.LOW };
  if (value === "MEDIUM") return { thinkingLevel: ThinkingLevel.MEDIUM };
  return { thinkingLevel: ThinkingLevel.HIGH };
}

// Read a required Secret without allowing an empty credential.
function requiredSecret(
  envKey: string,
  readSecret: (envKey: string) => string | undefined
): string {
  const value = readSecret(envKey);
  if (value === undefined || value.trim() === "") throw new Error("EVALUATOR_SECRET_MISSING");
  return value;
}

/**
 * Bounded retry policy for transient provider faults such as HTTP 429 burst throttling.
 * Retries live above the SDK on purpose: the frozen contract keeps SDK retries disabled.
 */
const PROVIDER_RETRY_POLICY = {
  maxAttempts: 4,
  baseDelayMs: 1_500,
  maxDelayMs: 20_000
} as const;

// Exponential backoff with ±10% jitter, capped so one call stays inside the Bridge budget.
function backoffDelayMs(attempt: number): number {
  const exponential = PROVIDER_RETRY_POLICY.baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(exponential, PROVIDER_RETRY_POLICY.maxDelayMs);
  return Math.round(capped * (0.9 + Math.random() * 0.2));
}

// Wait one bounded interval, rejecting early when the Bridge cancels or times out.
function waitBeforeRetry(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error("EVALUATOR_CANCELLED"));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("EVALUATOR_CANCELLED"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Convert provider failures into one stable boundary error without leaking payloads or Secrets.
 * Transient faults get a bounded number of smoothed attempts; permanent faults fail at once.
 */
async function stableProviderCall<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  let failure: Error | null = null;
  for (let attempt = 1; attempt <= PROVIDER_RETRY_POLICY.maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const classified = classifyEvaluatorProviderFailure(error);
      failure = classified.error;
      const exhausted = attempt >= PROVIDER_RETRY_POLICY.maxAttempts;
      if (!classified.detail.transient || exhausted || signal?.aborted === true) {
        throw classified.error;
      }
      const waitMs = Math.min(
        classified.detail.retryAfterMs ?? backoffDelayMs(attempt),
        MAX_PROVIDER_RETRY_AFTER_MS
      );
      try {
        await waitBeforeRetry(waitMs, signal);
      } catch {
        throw classified.error;
      }
    }
  }
  throw failure ?? new Error("EVALUATOR_PROVIDER_REQUEST_FAILED");
}

// Construct the OpenAI-compatible Evaluator path from one frozen definition.
function createOpenAiEvaluator(
  input: CreateFrozenEvaluatorModelClientInput,
  factories: FrozenEvaluatorSdkFactories
): EvaluatorModelClient {
  const config = input.config;
  if (config.providerType !== "OPENAI_COMPATIBLE") throw new Error("EVALUATOR_CONFIG_INVALID");
  const noAuth = config.auth.kind === "NONE";
  const apiKey = noAuth
    ? "cortex-eval-no-auth"
    : requiredSecret(config.auth.secret.envKey, input.readSecret);
  const client = factories.openAi({
    apiKey,
    baseURL: config.baseUrl,
    maxRetries: 0,
    timeout: config.timeoutMs
  });
  return {
    generate: async ({ prompt, signal }): Promise<EvaluatorModelResult> => {
      const response = await stableProviderCall(
        () =>
          client.create(
            {
              model: config.model,
              messages: [{ role: "user", content: prompt }],
              reasoning_effort: openAiReasoningEffort(config.thinkingLevel),
              temperature: config.temperature,
              top_p: config.topP,
              max_tokens: config.maxOutputTokens
            },
            {
              signal,
              timeout: config.timeoutMs,
              maxRetries: 0,
              ...(noAuth ? { headers: { authorization: null } } : {})
            }
          ),
        signal
      );
      const text = response.choices[0]?.message.content;
      if (typeof text !== "string") throw new Error("EVALUATOR_PROVIDER_RESPONSE_INVALID");
      return { text, structured: null, tokenUsage: openAiUsage(response) };
    }
  };
}

// Construct the Gemini Evaluator path from one frozen definition.
function createGeminiEvaluator(
  input: CreateFrozenEvaluatorModelClientInput,
  factories: FrozenEvaluatorSdkFactories
): EvaluatorModelClient {
  const config = input.config;
  if (config.providerType !== "GOOGLE_GEMINI") throw new Error("EVALUATOR_CONFIG_INVALID");
  const apiKey = requiredSecret(config.apiKey.envKey, input.readSecret);
  const httpOptions = { timeout: config.timeoutMs, retryOptions: { attempts: 1 } } as const;
  const client = factories.gemini({ apiKey, httpOptions });
  return {
    generate: async ({ prompt, signal }): Promise<EvaluatorModelResult> => {
      const response = await stableProviderCall(
        () =>
          client.generateContent({
            model: config.model,
            contents: prompt,
            config: {
              abortSignal: signal,
              httpOptions,
              thinkingConfig: geminiThinkingConfig(config.thinkingLevel),
              temperature: config.temperature,
              topP: config.topP,
              maxOutputTokens: config.maxOutputTokens
            }
          }),
        signal
      );
      const text = response.text;
      if (typeof text !== "string") throw new Error("EVALUATOR_PROVIDER_RESPONSE_INVALID");
      return { text, structured: null, tokenUsage: geminiUsage(response) };
    }
  };
}

/** Create an official-SDK Evaluator client with no SDK retries and bounded cancellation. */
export function createFrozenEvaluatorModelClient(
  input: CreateFrozenEvaluatorModelClientInput
): EvaluatorModelClient {
  if (!isValidFrozenRunEvaluatorDefinition(input.config)) {
    throw new Error("EVALUATOR_CONFIG_INVALID");
  }
  const factories = input.factories ?? DEFAULT_FACTORIES;
  return input.config.providerType === "OPENAI_COMPATIBLE"
    ? createOpenAiEvaluator(input, factories)
    : createGeminiEvaluator(input, factories);
}
