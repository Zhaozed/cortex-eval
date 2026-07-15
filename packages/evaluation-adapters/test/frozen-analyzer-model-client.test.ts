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

import type { AnalysisModelRequest } from "@cortex-eval/application/src/features/case-analysis/case-analysis-model-client.ts";

import {
  createFrozenAnalyzerModelClient,
  type FrozenAnalyzerSdkFactories
} from "../src/frozen-analyzer-model-client.ts";

const structuredOutput = JSON.stringify({
  contractVersion: "cortex.analysis-output.v1",
  classification: "NORMAL_FAILURE",
  confidence: 0.9,
  evidence: [
    {
      source: "failed_assertions",
      fieldPath: "/0",
      conclusion: "冻结断言失败"
    }
  ],
  explanation: "结果违反业务约束",
  recommendedAction: "修复被测系统",
  proposal: null
});

function request(
  providerType: "GOOGLE_GEMINI" | "OPENAI_COMPATIBLE",
  structured: "JSON_SCHEMA" | "JSON_OBJECT" = "JSON_SCHEMA",
  signal: AbortSignal = new AbortController().signal
): AnalysisModelRequest {
  const common = {
    model: "analyzer-model",
    thinkingLevel: "LOW" as const,
    temperature: 0,
    topP: 1,
    maxOutputTokens: 512,
    timeoutMs: 2_000,
    structuredOutput: structured
  };
  return {
    analyzer:
      providerType === "GOOGLE_GEMINI"
        ? {
            ...common,
            providerType,
            apiKey: { kind: "ENV_SECRET", envKey: "ANALYZER_KEY" }
          }
        : {
            ...common,
            providerType,
            baseUrl: "http://127.0.0.1:11434/v1",
            auth: { kind: "NONE" }
          },
    prompt: {
      kind: "CASE_ANALYSIS",
      promptKey: "analysis",
      messages: [
        { role: "SYSTEM", content: "分析失败事实" },
        { role: "USER", content: "{{failed_assertions}}" }
      ]
    },
    variables: {
      case_definition: {},
      provider_output: {},
      failed_assertions: [],
      expected_actual_diffs: [],
      llm_rubric_results: [],
      run_context: {}
    },
    signal
  };
}

describe("冻结 Analyzer 官方 SDK Adapter", () => {
  it.each([
    ["JSON_SCHEMA", "object"],
    ["JSON_OBJECT", "undefined"]
  ] as const)(
    "Gemini %s 使用对应结构输出、显式关闭重试并映射纯 Domain 结果",
    async (mode, schemaType) => {
      let clientOptions: GoogleGenAIOptions | undefined;
      let generated: GenerateContentParameters | undefined;
      let calls = 0;
      const factories: FrozenAnalyzerSdkFactories = {
        openAi: () => {
          throw new Error("UNEXPECTED_PROVIDER");
        },
        gemini: (options) => {
          clientOptions = options;
          return {
            generateContent: (input): Promise<GenerateContentResponse> => {
              calls += 1;
              generated = input;
              return Promise.resolve({ text: structuredOutput } as GenerateContentResponse);
            }
          };
        }
      };
      const client = createFrozenAnalyzerModelClient({
        readSecret: () => "secret",
        factories
      });

      await expect(client.analyze(request("GOOGLE_GEMINI", mode))).resolves.toMatchObject({
        classification: "NORMAL_FAILURE",
        evidence: [{ source: "failed_assertions", fieldPath: "/0" }]
      });
      expect(calls).toBe(1);
      expect(clientOptions?.httpOptions).toMatchObject({ retryOptions: { attempts: 1 } });
      expect(generated?.config?.responseMimeType).toBe("application/json");
      expect(generated?.config?.responseJsonSchema).toBeTypeOf(schemaType);
    }
  );

  it.each([
    ["JSON_SCHEMA", "json_schema"],
    ["JSON_OBJECT", "json_object"]
  ] as const)("OpenAI-compatible %s 使用对应结构输出且请求级重试为零", async (mode, type) => {
    let clientOptions: ClientOptions | undefined;
    let generated: ChatCompletionCreateParamsNonStreaming | undefined;
    let options: OpenAI.RequestOptions | undefined;
    const factories: FrozenAnalyzerSdkFactories = {
      openAi: (value) => {
        clientOptions = value;
        return {
          create: (input, requestOptions): Promise<ChatCompletion> => {
            generated = input;
            options = requestOptions;
            return Promise.resolve({
              choices: [{ message: { content: structuredOutput } }]
            } as unknown as ChatCompletion);
          }
        };
      },
      gemini: () => {
        throw new Error("UNEXPECTED_PROVIDER");
      }
    };
    const client = createFrozenAnalyzerModelClient({ readSecret: () => undefined, factories });

    await expect(client.analyze(request("OPENAI_COMPATIBLE", mode))).resolves.toMatchObject({
      classification: "NORMAL_FAILURE"
    });
    expect(clientOptions?.maxRetries).toBe(0);
    expect(options?.maxRetries).toBe(0);
    expect(generated?.response_format?.type).toBe(type);
  });

  it("非法 JSON、Schema 和已取消请求收敛为稳定错误且不猜测结果", async () => {
    let text = "not-json";
    let calls = 0;
    const factories: FrozenAnalyzerSdkFactories = {
      openAi: () => ({
        create: (): Promise<ChatCompletion> => {
          calls += 1;
          return Promise.resolve({
            choices: [{ message: { content: text } }]
          } as unknown as ChatCompletion);
        }
      }),
      gemini: () => {
        throw new Error("UNEXPECTED_PROVIDER");
      }
    };
    const client = createFrozenAnalyzerModelClient({ readSecret: () => undefined, factories });
    await expect(client.analyze(request("OPENAI_COMPATIBLE"))).rejects.toMatchObject({
      code: "ANALYZER_OUTPUT_INVALID"
    });
    text = JSON.stringify({ classification: "NORMAL_FAILURE" });
    await expect(client.analyze(request("OPENAI_COMPATIBLE"))).rejects.toMatchObject({
      code: "ANALYZER_OUTPUT_INVALID"
    });

    const controller = new AbortController();
    controller.abort();
    await expect(
      client.analyze(request("OPENAI_COMPATIBLE", "JSON_SCHEMA", controller.signal))
    ).rejects.toMatchObject({ code: "ANALYZER_CANCELLED" });
    expect(calls).toBe(2);
  });
});
