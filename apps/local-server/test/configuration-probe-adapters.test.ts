import { describe, expect, it } from "vitest";

import type {
  EndpointConfigDefinition,
  LlmConfigDefinition
} from "@cortex-eval/domain/src/domain-resource-models.ts";

import {
  EndpointConnectivityValidator,
  LlmAvailabilityValidator,
  type LlmProbeClients
} from "../src/configuration-probe-adapters.ts";

const endpoint: EndpointConfigDefinition = {
  urlTemplate: "https://example.test/tasks/{{vars.task}}",
  method: "POST",
  headers: {},
  bodySelector: "/request_body",
  timeoutMs: 1000,
  defaultConcurrency: 4
};

const gemini: LlmConfigDefinition = {
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

describe("P3 Configuration probe adapters", () => {
  it("Endpoint 只发无凭据 OPTIONS 连通性探针，不执行用户 POST", async () => {
    const calls: { url: string; init?: RequestInit | undefined }[] = [];
    const validator = new EndpointConnectivityValidator({
      fetch: (url, init): Promise<Response> => {
        const textUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        calls.push({ url: textUrl, init });
        return Promise.resolve(new Response(null, { status: 405 }));
      }
    });
    expect(await validator.validate(endpoint, new AbortController().signal)).toEqual({ ok: true });
    expect(calls).toMatchObject([
      {
        url: "https://example.test/tasks/probe",
        init: { method: "OPTIONS", redirect: "manual" }
      }
    ]);
    expect(calls[0]?.init?.headers).toBeUndefined();
    expect(calls[0]?.init?.body).toBeUndefined();
  });

  it("LLM 只从显式 EnvSecretRef 取值，调用一次客户端且不泄露异常", async () => {
    const calls: string[] = [];
    const clients: LlmProbeClients = {
      probeGemini: (_definition, apiKey, signal) => {
        calls.push(`gemini:${apiKey}:${signal.aborted}`);
        return Promise.resolve();
      },
      probeOpenAiCompatible: () => Promise.resolve()
    };
    const validator = new LlmAvailabilityValidator({
      environment: {
        get: (key: string): string | undefined =>
          key === "GEMINI_API_KEY" ? "secret-value" : undefined
      },
      clients
    });
    expect(await validator.validate(gemini, new AbortController().signal)).toEqual({ ok: true });
    expect(calls).toEqual(["gemini:secret-value:false"]);

    const missing = new LlmAvailabilityValidator({
      environment: { get: (): undefined => undefined },
      clients
    });
    expect(await missing.validate(gemini, new AbortController().signal)).toEqual({
      ok: false,
      error: { code: "CONFIGURATION_PROBE_FAILED", reason: "UNAVAILABLE" }
    });
  });

  it("取消、超时和 Provider 失败收敛为稳定分类", async () => {
    const clients: LlmProbeClients = {
      probeGemini: () =>
        Promise.reject(Object.assign(new Error("secret stack"), { name: "TimeoutError" })),
      probeOpenAiCompatible: () => Promise.resolve()
    };
    const validator = new LlmAvailabilityValidator({
      environment: { get: (): string => "secret" },
      clients
    });
    expect(await validator.validate(gemini, new AbortController().signal)).toEqual({
      ok: false,
      error: { code: "CONFIGURATION_PROBE_FAILED", reason: "TIMEOUT" }
    });

    const controller = new AbortController();
    controller.abort();
    expect(await validator.validate(gemini, controller.signal)).toEqual({
      ok: false,
      error: { code: "CONFIGURATION_PROBE_FAILED", reason: "CANCELLED" }
    });
  });

  it("Gemini 调用不返回时执行配置的 timeoutMs 并收敛为超时", async () => {
    const clients: LlmProbeClients = {
      probeGemini: (_definition, _apiKey, signal) =>
        new Promise<void>((resolve, reject) => {
          const fallback = setTimeout(resolve, 50);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(fallback);
              reject(new Error("private"));
            },
            { once: true }
          );
        }),
      probeOpenAiCompatible: () => Promise.resolve()
    };
    const validator = new LlmAvailabilityValidator({
      environment: { get: (): string => "secret" },
      clients
    });

    expect(
      await validator.validate({ ...gemini, timeoutMs: 1 }, new AbortController().signal)
    ).toEqual({
      ok: false,
      error: { code: "CONFIGURATION_PROBE_FAILED", reason: "TIMEOUT" }
    });
  });
});
