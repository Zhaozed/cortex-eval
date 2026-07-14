import type {
  GenerateContentParameters,
  GenerateContentResponse,
  GoogleGenAIOptions
} from "@google/genai";
import type OpenAI from "openai";
import type { ClientOptions } from "openai";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming
} from "openai/resources/chat/completions/completions.js";
import { describe, expect, it } from "vitest";

import {
  createFrozenEvaluatorModelClient,
  type FrozenEvaluatorSdkFactories
} from "../src/frozen-evaluator-model-client.ts";

const signal = new AbortController().signal;

describe("冻结 Evaluator 官方 SDK Adapter", () => {
  it.each([
    ["OPENAI_COMPATIBLE", 400],
    ["GOOGLE_GEMINI", 422]
  ] as const)("%s 将 Provider 能力不支持映射为稳定错误", async (providerType, status) => {
    const factories: FrozenEvaluatorSdkFactories = {
      openAi: () => ({
        create: () => Promise.reject(Object.assign(new Error("provider payload"), { status }))
      }),
      gemini: () => ({
        generateContent: () =>
          Promise.reject(Object.assign(new Error("provider payload"), { status }))
      })
    };
    const common = {
      model: "judge-model",
      thinkingLevel: "OFF" as const,
      temperature: 0,
      topP: 1,
      maxOutputTokens: 128,
      timeoutMs: 1_000,
      structuredOutput: "JSON_OBJECT" as const
    };
    const config =
      providerType === "OPENAI_COMPATIBLE"
        ? {
            ...common,
            providerType,
            baseUrl: "https://models.example.test/v1",
            auth: {
              kind: "BEARER_ENV" as const,
              secret: { kind: "ENV_SECRET" as const, envKey: "JUDGE_KEY" }
            }
          }
        : {
            ...common,
            providerType,
            apiKey: { kind: "ENV_SECRET" as const, envKey: "GEMINI_KEY" }
          };
    const client = createFrozenEvaluatorModelClient({
      config,
      readSecret: () => "secret",
      factories
    });

    await expect(client.generate({ prompt: "grade", signal })).rejects.toMatchObject({
      code: "PROVIDER_CAPABILITY_UNSUPPORTED"
    });
  });

  it("OpenAI-compatible 显式关闭重试、传递取消和超时，并从环境边界读取 Bearer", async () => {
    let clientOptions: ClientOptions | undefined;
    let request: ChatCompletionCreateParamsNonStreaming | undefined;
    let requestOptions: OpenAI.RequestOptions | undefined;
    const factories: FrozenEvaluatorSdkFactories = {
      openAi: (options) => {
        clientOptions = options;
        return {
          create: (input, perRequest): Promise<ChatCompletion> => {
            request = input;
            requestOptions = perRequest;
            return Promise.resolve({
              choices: [{ message: { content: "judge result" } }],
              usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }
            } as unknown as ChatCompletion);
          }
        };
      },
      gemini: () => {
        throw new Error("unexpected");
      }
    };
    const client = createFrozenEvaluatorModelClient({
      config: {
        providerType: "OPENAI_COMPATIBLE",
        model: "judge-model",
        baseUrl: "https://models.example.test/v1",
        auth: { kind: "BEARER_ENV", secret: { kind: "ENV_SECRET", envKey: "JUDGE_KEY" } },
        thinkingLevel: "MEDIUM",
        temperature: 0.2,
        topP: 0.8,
        maxOutputTokens: 512,
        timeoutMs: 2_000,
        structuredOutput: "JSON_OBJECT"
      },
      readSecret: (key) => (key === "JUDGE_KEY" ? "secret-value" : undefined),
      factories
    });

    await expect(client.generate({ prompt: "grade", signal })).resolves.toEqual({
      text: "judge result",
      structured: null,
      tokenUsage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 }
    });
    expect(clientOptions).toMatchObject({
      apiKey: "secret-value",
      baseURL: "https://models.example.test/v1",
      maxRetries: 0,
      timeout: 2_000
    });
    expect(request).toMatchObject({
      model: "judge-model",
      messages: [{ role: "user", content: "grade" }],
      reasoning_effort: "medium",
      temperature: 0.2,
      top_p: 0.8,
      max_tokens: 512
    });
    expect(requestOptions).toMatchObject({ signal, timeout: 2_000, maxRetries: 0 });
  });

  it("OpenAI-compatible 回环 NONE 不发送 Authorization", async () => {
    let requestOptions: OpenAI.RequestOptions | undefined;
    const factories: FrozenEvaluatorSdkFactories = {
      openAi: () => ({
        create: (_input, options): Promise<ChatCompletion> => {
          requestOptions = options;
          return Promise.resolve({
            choices: [{ message: { content: "local" } }]
          } as unknown as ChatCompletion);
        }
      }),
      gemini: () => {
        throw new Error("unexpected");
      }
    };
    const client = createFrozenEvaluatorModelClient({
      config: {
        providerType: "OPENAI_COMPATIBLE",
        model: "local-model",
        baseUrl: "http://127.0.0.1:11434/v1",
        auth: { kind: "NONE" },
        thinkingLevel: "OFF",
        temperature: 0,
        topP: 1,
        maxOutputTokens: 128,
        timeoutMs: 1_000,
        structuredOutput: "JSON_OBJECT"
      },
      readSecret: () => undefined,
      factories
    });

    await client.generate({ prompt: "grade", signal });
    expect(requestOptions?.headers).toEqual({ authorization: null });
  });

  it("Gemini 显式关闭重试、映射思考级别并传递取消、超时和 Usage", async () => {
    let clientOptions: GoogleGenAIOptions | undefined;
    let request: GenerateContentParameters | undefined;
    const factories: FrozenEvaluatorSdkFactories = {
      openAi: () => {
        throw new Error("unexpected");
      },
      gemini: (options) => {
        clientOptions = options;
        return {
          generateContent: (input): Promise<GenerateContentResponse> => {
            request = input;
            return Promise.resolve({
              text: "gemini result",
              usageMetadata: {
                promptTokenCount: 8,
                candidatesTokenCount: 4,
                totalTokenCount: 12
              }
            } as unknown as GenerateContentResponse);
          }
        };
      }
    };
    const client = createFrozenEvaluatorModelClient({
      config: {
        providerType: "GOOGLE_GEMINI",
        model: "gemini-judge",
        apiKey: { kind: "ENV_SECRET", envKey: "GEMINI_KEY" },
        thinkingLevel: "HIGH",
        temperature: 0,
        topP: 1,
        maxOutputTokens: 256,
        timeoutMs: 3_000,
        structuredOutput: "JSON_SCHEMA"
      },
      readSecret: (key) => (key === "GEMINI_KEY" ? "gemini-secret" : undefined),
      factories
    });

    await expect(client.generate({ prompt: "grade", signal })).resolves.toEqual({
      text: "gemini result",
      structured: null,
      tokenUsage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 }
    });
    expect(clientOptions).toEqual({
      apiKey: "gemini-secret",
      httpOptions: { timeout: 3_000, retryOptions: { attempts: 1 } }
    });
    expect(request).toMatchObject({
      model: "gemini-judge",
      contents: "grade",
      config: {
        abortSignal: signal,
        httpOptions: { timeout: 3_000, retryOptions: { attempts: 1 } },
        thinkingConfig: { thinkingLevel: "HIGH" },
        temperature: 0,
        topP: 1,
        maxOutputTokens: 256
      }
    });
  });
});
