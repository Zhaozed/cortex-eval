import { describe, expect, it, vi } from "vitest";

import type {
  GeminiLlmConfigDefinition,
  OpenAiCompatibleLlmConfigDefinition
} from "@cortex-eval/domain/src/domain-resource-models.ts";

const sdkCalls = vi.hoisted(() => ({
  gemini: vi.fn((...arguments_: unknown[]): Promise<object> => {
    void arguments_;
    return Promise.resolve({});
  }),
  openAi: vi.fn((...arguments_: unknown[]): Promise<object> => {
    void arguments_;
    return Promise.resolve({});
  }),
  openAiOptions: [] as unknown[]
}));

vi.mock("@google/genai", () => ({
  ThinkingLevel: { LOW: "LOW", MEDIUM: "MEDIUM", HIGH: "HIGH" },
  GoogleGenAI: class {
    public readonly models = { generateContent: sdkCalls.gemini };
  }
}));

vi.mock("openai", () => ({
  default: class {
    public readonly chat = { completions: { create: sdkCalls.openAi } };

    public constructor(options: unknown) {
      sdkCalls.openAiOptions.push(options);
    }
  }
}));

import {
  EndpointConnectivityValidator,
  LlmAvailabilityValidator,
  SdkLlmProbeClients,
  type LlmProbeClients
} from "../src/configuration-probe-adapters.ts";

const gemini: GeminiLlmConfigDefinition = {
  providerType: "GOOGLE_GEMINI",
  model: "gemini-model",
  thinkingLevel: "LOW",
  temperature: 0,
  topP: 1,
  maxOutputTokens: 64,
  timeoutMs: 1000,
  structuredOutput: "JSON_SCHEMA",
  apiKey: { kind: "ENV_SECRET", envKey: "GEMINI_API_KEY" }
};

const openAi: OpenAiCompatibleLlmConfigDefinition = {
  providerType: "OPENAI_COMPATIBLE",
  model: "local-model",
  baseUrl: "http://127.0.0.1:11434/v1",
  auth: { kind: "NONE" },
  thinkingLevel: "OFF",
  temperature: 0,
  topP: 1,
  maxOutputTokens: 64,
  timeoutMs: 1000,
  structuredOutput: "JSON_SCHEMA"
};

describe("P3 pinned SDK probe clients", () => {
  it("Gemini 显式映射四种 Thinking，并按结构输出模式发送最小请求", async () => {
    sdkCalls.gemini.mockClear();
    const clients = new SdkLlmProbeClients();
    for (const thinkingLevel of ["OFF", "LOW", "MEDIUM", "HIGH"] as const) {
      await clients.probeGemini(
        {
          ...gemini,
          thinkingLevel,
          structuredOutput: thinkingLevel === "HIGH" ? "JSON_OBJECT" : "JSON_SCHEMA"
        },
        "secret",
        new AbortController().signal
      );
    }

    expect(sdkCalls.gemini).toHaveBeenCalledTimes(4);
    expect(sdkCalls.gemini.mock.calls[0]?.[0]).toMatchObject({
      config: { thinkingConfig: { thinkingBudget: 0 }, responseJsonSchema: { type: "object" } }
    });
    expect(sdkCalls.gemini.mock.calls[1]?.[0]).toMatchObject({
      config: { thinkingConfig: { thinkingLevel: "LOW" } }
    });
    expect(sdkCalls.gemini.mock.calls[2]?.[0]).toMatchObject({
      config: { thinkingConfig: { thinkingLevel: "MEDIUM" } }
    });
    expect(sdkCalls.gemini.mock.calls[3]?.[0]).toMatchObject({
      config: { thinkingConfig: { thinkingLevel: "HIGH" } }
    });
    expect(JSON.stringify(sdkCalls.gemini.mock.calls[3]?.[0])).not.toContain("responseJsonSchema");
  });

  it("OpenAI-compatible 显式映射四种 Thinking、禁用重试并覆盖结构输出", async () => {
    sdkCalls.openAi.mockClear();
    sdkCalls.openAiOptions.length = 0;
    const clients = new SdkLlmProbeClients();
    for (const thinkingLevel of ["OFF", "LOW", "MEDIUM", "HIGH"] as const) {
      await clients.probeOpenAiCompatible(
        {
          ...openAi,
          thinkingLevel,
          structuredOutput: thinkingLevel === "HIGH" ? "JSON_OBJECT" : "JSON_SCHEMA"
        },
        null,
        new AbortController().signal
      );
    }

    expect(sdkCalls.openAiOptions).toHaveLength(4);
    for (const options of sdkCalls.openAiOptions) {
      expect(options).toMatchObject({
        baseURL: openAi.baseUrl,
        adminAPIKey: null,
        organization: null,
        project: null,
        timeout: 1000,
        maxRetries: 0,
        defaultHeaders: { Authorization: null }
      });
    }
    expect(sdkCalls.openAi.mock.calls.map((call) => call[0])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reasoning_effort: "none" }),
        expect.objectContaining({ reasoning_effort: "low" }),
        expect.objectContaining({ reasoning_effort: "medium" }),
        expect.objectContaining({ reasoning_effort: "high" })
      ])
    );
    expect(sdkCalls.openAi.mock.calls[0]?.[0]).toMatchObject({
      response_format: { type: "json_schema" }
    });
    expect(sdkCalls.openAi.mock.calls[3]?.[0]).toMatchObject({
      response_format: { type: "json_object" }
    });
    expect(sdkCalls.openAi.mock.calls[0]?.[1]).toMatchObject({ timeout: 1000, maxRetries: 0 });
  });
});

describe("P3 probe failure branches", () => {
  it("Endpoint 区分预取消、请求中取消、超时和普通不可用", async () => {
    const preCancelled = new AbortController();
    preCancelled.abort();
    expect(
      await new EndpointConnectivityValidator().validate(endpoint(), preCancelled.signal)
    ).toMatchObject({ error: { reason: "CANCELLED" } });

    const during = new AbortController();
    const cancelled = new EndpointConnectivityValidator({
      fetch: (): Promise<Response> => {
        during.abort();
        return Promise.reject(new Error("private"));
      }
    });
    expect(
      await cancelled.validate({ ...endpoint(), timeoutMs: 1000 }, during.signal)
    ).toMatchObject({ error: { reason: "CANCELLED" } });

    const timeout = new EndpointConnectivityValidator({
      fetch: (_input, init): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("private"), { name: "TimeoutError" })),
            { once: true }
          );
        })
    });
    expect(
      await timeout.validate({ ...endpoint(), timeoutMs: 1 }, new AbortController().signal)
    ).toMatchObject({ error: { reason: "TIMEOUT" } });

    const unavailable = new EndpointConnectivityValidator({
      fetch: (): Promise<Response> => Promise.reject(new Error("private"))
    });
    expect(await unavailable.validate(endpoint(), new AbortController().signal)).toMatchObject({
      error: { reason: "UNAVAILABLE" }
    });
  });

  it("LLM 覆盖本地无认证、Bearer Env、空 Secret、Provider 错误和请求中取消", async () => {
    const calls: (string | null)[] = [];
    const clients: LlmProbeClients = {
      probeGemini: (): Promise<void> =>
        Promise.reject(Object.assign(new Error("private"), { name: "APIConnectionTimeoutError" })),
      probeOpenAiCompatible: (_definition, secret, signal): Promise<void> => {
        calls.push(secret);
        return signal.aborted ? Promise.reject(new Error("private")) : Promise.resolve();
      }
    };
    const validator = new LlmAvailabilityValidator({
      environment: { get: (key): string | undefined => (key === "TOKEN" ? "bearer" : "") },
      clients
    });
    expect(await validator.validate(openAi, new AbortController().signal)).toEqual({ ok: true });
    expect(
      await validator.validate(
        {
          ...openAi,
          auth: { kind: "BEARER_ENV", secret: { kind: "ENV_SECRET", envKey: "TOKEN" } }
        },
        new AbortController().signal
      )
    ).toEqual({ ok: true });
    expect(calls).toEqual([null, "bearer"]);
    expect(await validator.validate(gemini, new AbortController().signal)).toMatchObject({
      error: { reason: "UNAVAILABLE" }
    });

    const timeoutValidator = new LlmAvailabilityValidator({
      environment: { get: (): string => "secret" },
      clients
    });
    expect(await timeoutValidator.validate(gemini, new AbortController().signal)).toMatchObject({
      error: { reason: "TIMEOUT" }
    });

    const during = new AbortController();
    const cancellingClients: LlmProbeClients = {
      probeGemini: (): Promise<void> => {
        during.abort();
        return Promise.reject(new Error("private"));
      },
      probeOpenAiCompatible: (): Promise<void> => Promise.resolve()
    };
    expect(
      await new LlmAvailabilityValidator({
        environment: { get: (): string => "secret" },
        clients: cancellingClients
      }).validate(gemini, during.signal)
    ).toMatchObject({ error: { reason: "CANCELLED" } });
  });

  it("Provider 拒绝统一能力参数时收敛为 CAPABILITY_UNSUPPORTED", async () => {
    const clients: LlmProbeClients = {
      probeGemini: (): Promise<void> => Promise.resolve(),
      probeOpenAiCompatible: (): Promise<void> =>
        Promise.reject(Object.assign(new Error("private"), { status: 400 }))
    };

    expect(
      await new LlmAvailabilityValidator({
        environment: { get: (): undefined => undefined },
        clients
      }).validate(openAi, new AbortController().signal)
    ).toMatchObject({ error: { reason: "CAPABILITY_UNSUPPORTED" } });
  });
});

// Return one valid Endpoint definition for adapter-only boundary tests.
function endpoint(): {
  readonly urlTemplate: string;
  readonly method: "POST";
  readonly headers: Readonly<Record<string, never>>;
  readonly bodySelector: string;
  readonly timeoutMs: number;
  readonly defaultConcurrency: number;
} {
  return {
    urlTemplate: "https://example.test/tasks/{{vars.task}}",
    method: "POST",
    headers: {},
    bodySelector: "/request_body",
    timeoutMs: 1000,
    defaultConcurrency: 1
  };
}
