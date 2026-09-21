import type { GenerateContentParameters, GenerateContentResponse } from "@google/genai";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming
} from "openai/resources/chat/completions/completions.js";
import type OpenAI from "openai";
import { expect, it, vi } from "vitest";
import { diagnosisFixture } from "@cortex-eval/contracts/test-support/diagnostic-report-fixture.ts";
import {
  createDiagnosticModelClient,
  type DiagnosticModelRequest
} from "../src/diagnostic-model-client.ts";
import type { FrozenAnalyzerSdkFactories } from "../src/frozen-analyzer-model-client.ts";

function request(
  provider: "OPENAI_COMPATIBLE" | "GOOGLE_GEMINI" = "OPENAI_COMPATIBLE",
  mode: "JSON_SCHEMA" | "JSON_OBJECT" = "JSON_SCHEMA"
): DiagnosticModelRequest {
  const common = {
    model: "configured-model",
    thinkingLevel: "OFF" as const,
    temperature: 0,
    topP: 1,
    maxOutputTokens: 2000,
    timeoutMs: 3000,
    structuredOutput: mode
  };
  return {
    input: '{"evidence":[]}',
    signal: new AbortController().signal,
    config:
      provider === "OPENAI_COMPATIBLE"
        ? {
            ...common,
            providerType: provider,
            baseUrl: "http://localhost:1234/v1",
            auth: { kind: "NONE" }
          }
        : {
            ...common,
            providerType: provider,
            apiKey: { kind: "ENV_SECRET", envKey: "REPORT_KEY" }
          }
  };
}
function factories(text = JSON.stringify(diagnosisFixture())): FrozenAnalyzerSdkFactories {
  return {
    openAi: () => ({
      create: () => Promise.resolve({ choices: [{ message: { content: text } }] } as ChatCompletion)
    }),
    gemini: () => ({ generateContent: () => Promise.resolve({ text } as GenerateContentResponse) })
  };
}
it.each(["JSON_SCHEMA", "JSON_OBJECT"] as const)(
  "OpenAI %s reuses config, disables retries and omits auth for local models",
  async (mode) => {
    let body: ChatCompletionCreateParamsNonStreaming | undefined;
    let options: OpenAI.RequestOptions | undefined;
    const sdk = factories();
    const create = vi.fn(
      (value: ChatCompletionCreateParamsNonStreaming, opts?: OpenAI.RequestOptions) => {
        body = value;
        options = opts;
        return Promise.resolve({
          choices: [{ message: { content: JSON.stringify(diagnosisFixture()) } }]
        } as ChatCompletion);
      }
    );
    const construct = vi.fn(() => ({ create }));
    const wired = { ...sdk, openAi: construct };
    const client = createDiagnosticModelClient({ factories: wired, readSecret: () => undefined });
    await expect(client.diagnose(request("OPENAI_COMPATIBLE", mode))).resolves.toEqual(
      diagnosisFixture()
    );
    expect(construct).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: "http://localhost:1234/v1", maxRetries: 0 })
    );
    expect(create).toHaveBeenCalledOnce();
    expect(body?.model).toBe("configured-model");
    expect(body?.response_format?.type).toBe(
      mode === "JSON_SCHEMA" ? "json_schema" : "json_object"
    );
    expect(body?.messages[0]?.role).toBe("system");
    expect(body?.messages[0]?.content).toContain("不得改写 PASS/FAIL");
    expect(options).toMatchObject({
      maxRetries: 0,
      timeout: 3000,
      headers: { authorization: null }
    });
  }
);
it.each(["JSON_SCHEMA", "JSON_OBJECT"] as const)(
  "Gemini %s maps config and only sends compatible schema",
  async (mode) => {
    let body: GenerateContentParameters | undefined;
    const sdk = factories();
    const generate = vi.fn((value: GenerateContentParameters) => {
      body = value;
      return Promise.resolve({
        text: JSON.stringify(diagnosisFixture())
      } as GenerateContentResponse);
    });
    const construct = vi.fn(() => ({ generateContent: generate }));
    const wired = { ...sdk, gemini: construct };
    const client = createDiagnosticModelClient({
      factories: wired,
      readSecret: () => "not-a-real-key"
    });
    await client.diagnose(request("GOOGLE_GEMINI", mode));
    expect(construct).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "not-a-real-key",
        httpOptions: { timeout: 3000, retryOptions: { attempts: 1 } }
      })
    );
    expect(generate).toHaveBeenCalledOnce();
    expect(body?.config?.thinkingConfig).toEqual({ thinkingBudget: 0 });
    expect(body?.config?.responseMimeType).toBe("application/json");
    if (mode === "JSON_SCHEMA")
      expect(JSON.stringify(body?.config?.responseJsonSchema)).not.toMatch(
        /"(?:minLength|maxLength|pattern)":/
      );
    else expect(body?.config?.responseJsonSchema).toBeUndefined();
  }
);
it.each(["not json", "{}", JSON.stringify({ ...diagnosisFixture(), extra: "not allowed" })])(
  "rejects invalid output: %s",
  async (text) => {
    const client = createDiagnosticModelClient({
      factories: factories(text),
      readSecret: () => undefined
    });
    await expect(client.diagnose(request())).rejects.toThrow("ANALYZER_OUTPUT_INVALID");
  }
);
it("synthesize parses narrative markdown and uses the report-writing system prompt", async () => {
  let body: ChatCompletionCreateParamsNonStreaming | undefined;
  let options: OpenAI.RequestOptions | undefined;
  const create = vi.fn(
    (value: ChatCompletionCreateParamsNonStreaming, opts?: OpenAI.RequestOptions) => {
      body = value;
      options = opts;
      return Promise.resolve({
        choices: [{ message: { content: JSON.stringify({ markdown: "**一、示例正文**" }) } }]
      } as ChatCompletion);
    }
  );
  const construct = vi.fn(() => ({ create }));
  const client = createDiagnosticModelClient({
    factories: { ...factories(), openAi: construct },
    readSecret: () => undefined
  });
  await expect(client.synthesize(request())).resolves.toEqual({ markdown: "**一、示例正文**" });
  expect(create).toHaveBeenCalledOnce();
  expect(body?.messages[0]?.role).toBe("system");
  expect(String(body?.messages[0]?.content)).toContain("根问题");
  expect(String(body?.messages[0]?.content)).toContain("不得改写 PASS/FAIL");
  expect(String(body?.messages[0]?.content)).not.toContain("放弃、撤销或改变评测");
  expect(options).toMatchObject({ maxRetries: 0 });
});

it("fails before network for missing secrets, aborted requests and oversized inputs", async () => {
  const sdk = factories();
  const construct = vi.spyOn(sdk, "openAi");
  const client = createDiagnosticModelClient({ factories: sdk, readSecret: () => undefined });
  await expect(client.diagnose(request("GOOGLE_GEMINI"))).rejects.toThrow(
    "ANALYZER_SECRET_MISSING"
  );
  await expect(client.diagnose({ ...request(), signal: AbortSignal.abort() })).rejects.toThrow(
    "ANALYZER_CANCELLED"
  );
  await expect(client.diagnose({ ...request(), input: "x".repeat(200000) })).rejects.toThrow(
    "ANALYZER_INPUT_TOO_LARGE"
  );
  expect(construct).not.toHaveBeenCalled();
});
