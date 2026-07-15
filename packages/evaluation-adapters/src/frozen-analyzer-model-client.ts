import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import type {
  Content,
  GenerateContentParameters,
  GenerateContentResponse,
  GoogleGenAIOptions
} from "@google/genai";
import type {
  AnalysisModelClient,
  AnalysisModelRequest
} from "@cortex-eval/application/src/features/case-analysis/case-analysis-model-client.ts";
import {
  analysisResultFromBoundary,
  prepareAnalysisModelRequest
} from "@cortex-eval/application/src/features/case-analysis/case-analysis-model-boundary.ts";
import type { PreparedAnalysisModelRequest } from "@cortex-eval/application/src/features/case-analysis/case-analysis-model-boundary.ts";
import {
  AnalysisOutputV1JsonSchema,
  AnalysisOutputV1Schema
} from "@cortex-eval/contracts/src/analysis-contracts.ts";
import OpenAI, { type ClientOptions } from "openai";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming
} from "openai/resources/chat/completions/completions.js";

import { AnalyzerModelError, analyzerModelErrorFromProvider } from "./analyzer-model-errors.ts";
import { AnalysisOutputV1GeminiJsonSchema } from "./gemini-analysis-output-schema.ts";

/** Fixed maximum UTF-8 size for one normalized Analysis input or response. */
export const ANALYZER_CASE_MAX_BYTES = 32 * 1_024 * 1_024;

/** Narrow OpenAI SDK surface owned by the Analyzer Adapter. */
export interface FrozenAnalyzerOpenAiClient {
  /** Execute one non-streaming Chat Completion. */
  readonly create: (
    input: ChatCompletionCreateParamsNonStreaming,
    options: OpenAI.RequestOptions
  ) => Promise<ChatCompletion>;
}

/** Narrow Gemini SDK surface owned by the Analyzer Adapter. */
export interface FrozenAnalyzerGeminiClient {
  /** Execute one non-streaming Generate Content request. */
  readonly generateContent: (input: GenerateContentParameters) => Promise<GenerateContentResponse>;
}

/** Injectable official SDK constructors used by deterministic tests. */
export interface FrozenAnalyzerSdkFactories {
  /** Construct the OpenAI-compatible client. */
  readonly openAi: (options: ClientOptions) => FrozenAnalyzerOpenAiClient;
  /** Construct the Gemini client. */
  readonly gemini: (options: GoogleGenAIOptions) => FrozenAnalyzerGeminiClient;
}

/** Dependencies required by the no-retry Analyzer Adapter. */
export interface CreateFrozenAnalyzerModelClientInput {
  /** Read one Secret only at the infrastructure boundary. */
  readonly readSecret: (envKey: string) => string | undefined;
  /** Optional deterministic official SDK seams. */
  readonly factories?: FrozenAnalyzerSdkFactories;
}

const DEFAULT_FACTORIES: FrozenAnalyzerSdkFactories = {
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

type AnalyzerDefinition = AnalysisModelRequest["analyzer"];
type AnalyzerResult = Awaited<ReturnType<AnalysisModelClient["analyze"]>>;
type RenderedMessage = Extract<
  PreparedAnalysisModelRequest,
  { readonly ok: true }
>["messages"][number];

// Translate the provider-neutral thinking level into OpenAI reasoning effort.
function openAiReasoningEffort(
  value: AnalyzerDefinition["thinkingLevel"]
): "none" | "low" | "medium" | "high" {
  if (value === "OFF") return "none";
  if (value === "LOW") return "low";
  if (value === "MEDIUM") return "medium";
  return "high";
}

// Translate the provider-neutral thinking level into Gemini thinking configuration.
function geminiThinkingConfig(
  value: AnalyzerDefinition["thinkingLevel"]
): { readonly thinkingBudget: 0 } | { readonly thinkingLevel: ThinkingLevel } {
  if (value === "OFF") return { thinkingBudget: 0 };
  if (value === "LOW") return { thinkingLevel: ThinkingLevel.LOW };
  if (value === "MEDIUM") return { thinkingLevel: ThinkingLevel.MEDIUM };
  return { thinkingLevel: ThinkingLevel.HIGH };
}

// Read one required credential without retaining the environment name in an error.
function requiredSecret(envKey: string, readSecret: (key: string) => string | undefined): string {
  const value = readSecret(envKey);
  if (value === undefined || value.trim() === "") {
    throw new AnalyzerModelError("ANALYZER_SECRET_MISSING");
  }
  return value;
}

// Reject one oversized rendered request before any SDK side effect.
function validateInputSize(messages: readonly RenderedMessage[]): void {
  const bytes = messages.reduce((total, message) => total + Buffer.byteLength(message.content), 0);
  if (bytes > ANALYZER_CASE_MAX_BYTES) {
    throw new AnalyzerModelError("ANALYZER_INPUT_TOO_LARGE");
  }
}

// Strictly parse one bounded provider response and map it into Domain.
function analysisResult(text: string): AnalyzerResult {
  if (Buffer.byteLength(text) > ANALYZER_CASE_MAX_BYTES) {
    throw new AnalyzerModelError("ANALYZER_OUTPUT_TOO_LARGE");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new AnalyzerModelError("ANALYZER_OUTPUT_INVALID");
  }
  const output = AnalysisOutputV1Schema.safeParse(parsed);
  if (!output.success) throw new AnalyzerModelError("ANALYZER_OUTPUT_INVALID");
  const result = analysisResultFromBoundary(output.data);
  if (result === null) throw new AnalyzerModelError("ANALYZER_OUTPUT_INVALID");
  return result;
}

// Execute one SDK call while removing untrusted provider error details.
async function providerCall<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw analyzerModelErrorFromProvider(error, signal);
  }
}

// Convert prompt roles into OpenAI Chat Completions messages.
function openAiMessages(
  messages: readonly RenderedMessage[]
): ChatCompletionCreateParamsNonStreaming["messages"] {
  return messages.map((message) => ({
    role: message.role === "SYSTEM" ? "system" : message.role === "USER" ? "user" : "assistant",
    content: message.content
  }));
}

// Convert non-system prompt roles into Gemini content roles.
function geminiContents(messages: readonly RenderedMessage[]): Content[] {
  return messages
    .filter((message) => message.role !== "SYSTEM")
    .map((message) => ({
      role: message.role === "ASSISTANT" ? "model" : "user",
      parts: [{ text: message.content }]
    }));
}

// Execute one OpenAI-compatible structured Analysis call.
async function analyzeOpenAi(
  request: AnalysisModelRequest,
  messages: readonly RenderedMessage[],
  factories: FrozenAnalyzerSdkFactories,
  readSecret: (key: string) => string | undefined
): Promise<AnalyzerResult> {
  const config = request.analyzer;
  if (config.providerType !== "OPENAI_COMPATIBLE") {
    throw new AnalyzerModelError("ANALYZER_CONFIG_INVALID");
  }
  const noAuth = config.auth.kind === "NONE";
  const apiKey = noAuth
    ? "cortex-eval-no-auth"
    : requiredSecret(config.auth.secret.envKey, readSecret);
  const client = factories.openAi({
    apiKey,
    baseURL: config.baseUrl,
    maxRetries: 0,
    timeout: config.timeoutMs
  });
  const responseFormat: ChatCompletionCreateParamsNonStreaming["response_format"] =
    config.structuredOutput === "JSON_SCHEMA"
      ? {
          type: "json_schema",
          json_schema: {
            name: "cortex_analysis_output_v1",
            strict: true,
            schema: AnalysisOutputV1JsonSchema
          }
        }
      : { type: "json_object" };
  const response = await providerCall(
    () =>
      client.create(
        {
          model: config.model,
          messages: openAiMessages(messages),
          response_format: responseFormat,
          reasoning_effort: openAiReasoningEffort(config.thinkingLevel),
          temperature: config.temperature,
          top_p: config.topP,
          max_tokens: config.maxOutputTokens
        },
        {
          signal: request.signal,
          timeout: config.timeoutMs,
          maxRetries: 0,
          ...(noAuth ? { headers: { authorization: null } } : {})
        }
      ),
    request.signal
  );
  const text = response.choices[0]?.message.content;
  if (typeof text !== "string") throw new AnalyzerModelError("ANALYZER_OUTPUT_INVALID");
  return analysisResult(text);
}

// Execute one Gemini JSON-Schema Analysis call.
async function analyzeGemini(
  request: AnalysisModelRequest,
  messages: readonly RenderedMessage[],
  factories: FrozenAnalyzerSdkFactories,
  readSecret: (key: string) => string | undefined
): Promise<AnalyzerResult> {
  const config = request.analyzer;
  if (config.providerType !== "GOOGLE_GEMINI") {
    throw new AnalyzerModelError("ANALYZER_CONFIG_INVALID");
  }
  const apiKey = requiredSecret(config.apiKey.envKey, readSecret);
  const httpOptions = { timeout: config.timeoutMs, retryOptions: { attempts: 1 } } as const;
  const client = factories.gemini({ apiKey, httpOptions });
  const contents = geminiContents(messages);
  const systemInstruction = messages
    .filter((message) => message.role === "SYSTEM")
    .map((message) => message.content)
    .join("\n");
  const response = await providerCall(
    () =>
      client.generateContent({
        model: config.model,
        contents: contents.length === 0 ? "" : contents,
        config: {
          abortSignal: request.signal,
          httpOptions,
          ...(systemInstruction === "" ? {} : { systemInstruction }),
          thinkingConfig: geminiThinkingConfig(config.thinkingLevel),
          temperature: config.temperature,
          topP: config.topP,
          maxOutputTokens: config.maxOutputTokens,
          responseMimeType: "application/json",
          ...(config.structuredOutput === "JSON_SCHEMA"
            ? { responseJsonSchema: AnalysisOutputV1GeminiJsonSchema }
            : {})
        }
      }),
    request.signal
  );
  const text = response.text;
  if (typeof text !== "string") throw new AnalyzerModelError("ANALYZER_OUTPUT_INVALID");
  return analysisResult(text);
}

/** Create a direct official-SDK Analyzer client with no Bridge and no automatic retry. */
export function createFrozenAnalyzerModelClient(
  input: CreateFrozenAnalyzerModelClientInput
): AnalysisModelClient {
  const factories = input.factories ?? DEFAULT_FACTORIES;
  return {
    analyze: async (request): Promise<AnalyzerResult> => {
      if (request.signal.aborted) throw new AnalyzerModelError("ANALYZER_CANCELLED");
      const prepared = prepareAnalysisModelRequest(request);
      if (!prepared.ok) throw new AnalyzerModelError("ANALYZER_CONFIG_INVALID");
      validateInputSize(prepared.messages);
      return request.analyzer.providerType === "OPENAI_COMPATIBLE"
        ? analyzeOpenAi(request, prepared.messages, factories, input.readSecret)
        : analyzeGemini(request, prepared.messages, factories, input.readSecret);
    }
  };
}
