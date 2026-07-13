import { describe, expect, it } from "vitest";

import {
  collectAnalysisPromptVariables,
  collectRubricPromptKeys,
  validateAnalysisPrompt,
  validateEndpointConfig,
  validateLlmConfig,
  validatePrompt
} from "../src/domain-resource-models.ts";
import type {
  AnalysisPromptDefinition,
  EndpointConfigDefinition,
  LlmConfigDefinition,
  PromptDefinition
} from "../src/domain-resource-models.ts";
import type { CaseDefinition } from "../src/domain-evaluation.ts";

const endpoint: EndpointConfigDefinition = {
  urlTemplate: "https://example.test/v1/{{vars.task}}?locale=en",
  method: "POST",
  headers: {
    Accept: { kind: "LITERAL", value: "application/json" },
    Authorization: { kind: "ENV_SECRET", envKey: "SERVICE_TOKEN" }
  },
  bodySelector: "/request_body",
  timeoutMs: 60_000,
  defaultConcurrency: 4
};

const gemini: LlmConfigDefinition = {
  providerType: "GOOGLE_GEMINI",
  model: "gemini-2.5-flash",
  thinkingLevel: "LOW",
  temperature: 0,
  topP: 1,
  maxOutputTokens: 1_024,
  timeoutMs: 60_000,
  structuredOutput: "JSON_OBJECT",
  apiKey: { kind: "ENV_SECRET", envKey: "GEMINI_API_KEY" }
};

const rubricPrompt: PromptDefinition = {
  kind: "LLM_RUBRIC",
  promptKey: "quality",
  messages: [{ role: "SYSTEM", content: "Evaluate the response." }]
};

describe("Domain 当前资源模型", () => {
  it("接受安全 Endpoint，并拒绝动态 Query 名、敏感 Query 与自定义 Literal Header", () => {
    expect(validateEndpointConfig(endpoint)).toEqual({ ok: true, value: endpoint });

    expect(
      validateEndpointConfig({
        ...endpoint,
        urlTemplate: "https://example.test/v1?{{vars.task}}=literal"
      })
    ).toEqual({ ok: false, error: { code: "ENDPOINT_CONFIG_INVALID", path: "urlTemplate" } });
    expect(
      validateEndpointConfig({
        ...endpoint,
        urlTemplate: "https://example.test/v1?apiToken=literal"
      })
    ).toEqual({ ok: false, error: { code: "ENDPOINT_CONFIG_INVALID", path: "urlTemplate" } });
    expect(
      validateEndpointConfig({
        ...endpoint,
        headers: { "X-Client": { kind: "LITERAL", value: "secret" } }
      })
    ).toEqual({
      ok: false,
      error: { code: "ENDPOINT_CONFIG_INVALID", path: "headers.X-Client" }
    });
    expect(
      validateEndpointConfig({
        ...endpoint,
        headers: {
          Accept: { kind: "LITERAL", value: "application/json" },
          accept: { kind: "LITERAL", value: "text/plain" }
        }
      }).ok
    ).toBe(false);
    expect(
      validateEndpointConfig({
        ...endpoint,
        headers: { "Bad Header": { kind: "ENV_SECRET", envKey: "SERVICE_TOKEN" } }
      }).ok
    ).toBe(false);
  });

  it("拒绝非法 Endpoint 范围、Body Selector 和 Secret 引用", () => {
    expect(validateEndpointConfig({ ...endpoint, defaultConcurrency: 65 }).ok).toBe(false);
    expect(validateEndpointConfig({ ...endpoint, timeoutMs: 99 }).ok).toBe(false);
    expect(validateEndpointConfig({ ...endpoint, bodySelector: "request_body" }).ok).toBe(false);
    expect(
      validateEndpointConfig({
        ...endpoint,
        headers: { Authorization: { kind: "ENV_SECRET", envKey: "raw-token" } }
      }).ok
    ).toBe(false);
  });

  it("接受 Gemini 与本地 OpenAI-compatible，拒绝远程无认证和非法公共参数", () => {
    expect(validateLlmConfig(gemini)).toEqual({ ok: true, value: gemini });
    expect(
      validateLlmConfig({
        providerType: "OPENAI_COMPATIBLE",
        model: "local-model",
        thinkingLevel: "OFF",
        temperature: 0,
        topP: 1,
        maxOutputTokens: 1_024,
        timeoutMs: 60_000,
        structuredOutput: "JSON_OBJECT",
        baseUrl: "http://127.0.0.1:11434/v1",
        auth: { kind: "NONE" }
      })
    ).toMatchObject({ ok: true });
    expect(
      validateLlmConfig({
        providerType: "OPENAI_COMPATIBLE",
        model: "remote-model",
        thinkingLevel: "OFF",
        temperature: 0,
        topP: 1,
        maxOutputTokens: 1_024,
        timeoutMs: 60_000,
        structuredOutput: "JSON_OBJECT",
        baseUrl: "https://models.example.test/v1",
        auth: { kind: "NONE" }
      }).ok
    ).toBe(false);
    expect(validateLlmConfig({ ...gemini, topP: 1.1 }).ok).toBe(false);
    expect(
      validateLlmConfig({ ...gemini, thinkingLevel: "EXTREME" } as unknown as LlmConfigDefinition)
    ).toEqual({ ok: false, error: { code: "LLM_CONFIG_INVALID", path: "thinkingLevel" } });
    expect(
      validateLlmConfig({ ...gemini, structuredOutput: "TEXT" } as unknown as LlmConfigDefinition)
    ).toEqual({ ok: false, error: { code: "LLM_CONFIG_INVALID", path: "structuredOutput" } });
  });

  it("校验两类 Prompt 并稳定预览 Analysis 模板变量", () => {
    expect(validatePrompt(rubricPrompt)).toEqual({ ok: true, value: rubricPrompt });
    const analysisPrompt: AnalysisPromptDefinition = {
      kind: "CASE_ANALYSIS",
      promptKey: "diagnose",
      messages: [
        {
          role: "USER",
          content: "{{ case_definition }} {{failed_assertions}} {{ case_definition }}"
        }
      ]
    };
    expect(validateAnalysisPrompt(analysisPrompt)).toEqual({ ok: true, value: analysisPrompt });
    expect(collectAnalysisPromptVariables(analysisPrompt)).toEqual([
      "case_definition",
      "failed_assertions"
    ]);
    expect(
      validateAnalysisPrompt({
        ...analysisPrompt,
        messages: [{ role: "USER", content: "{{ arbitrary.path }}" }]
      }).ok
    ).toBe(false);
  });

  it("递归提取并排序去重 Case 中的 Rubric Prompt Key", () => {
    const definition = {
      caseKey: "case-1",
      description: "case",
      threshold: 1,
      task: "route",
      requestBody: {},
      metadata: {
        requestId: "req-1",
        taskId: "task-1",
        businessModule: "chat",
        scenarioTag: "smoke"
      },
      assertions: [
        { type: "llm-rubric", metric: "quality", weight: 1, rubricPrompt: "prompt://z" },
        {
          type: "assert-set",
          metric: "set",
          weight: 1,
          assertions: [
            { type: "llm-rubric", metric: "nested", weight: 1, rubricPrompt: "prompt://a" }
          ]
        },
        { type: "llm-rubric", metric: "duplicate", weight: 1, rubricPrompt: "prompt://z" }
      ]
    } satisfies CaseDefinition;
    expect(collectRubricPromptKeys(definition)).toEqual(["a", "z"]);
  });

  it("覆盖资源校验的剩余边界分支", () => {
    expect(validateEndpointConfig({ ...endpoint, urlTemplate: "not-a-url" }).ok).toBe(false);
    expect(
      validateEndpointConfig({ ...endpoint, urlTemplate: "https://{{vars.task}}/v1" }).ok
    ).toBe(false);
    expect(
      validateEndpointConfig({ ...endpoint, headers: { "": { kind: "LITERAL", value: "" } } }).ok
    ).toBe(false);
    expect(validateLlmConfig({ ...gemini, model: "" }).ok).toBe(false);
    expect(validateLlmConfig({ ...gemini, temperature: 3 }).ok).toBe(false);
    expect(validateLlmConfig({ ...gemini, maxOutputTokens: 0 }).ok).toBe(false);
    expect(validateLlmConfig({ ...gemini, timeoutMs: 600_001 }).ok).toBe(false);
    expect(
      validatePrompt({ ...rubricPrompt, promptKey: " invalid", messages: rubricPrompt.messages }).ok
    ).toBe(false);
    expect(validatePrompt({ ...rubricPrompt, messages: [] }).ok).toBe(false);
    expect(
      validateAnalysisPrompt({
        kind: "CASE_ANALYSIS",
        promptKey: "analysis",
        messages: [{ role: "USER", content: "{{case_definition | filter}}" }]
      }).ok
    ).toBe(false);
  });
});
