import { describe, expect, it } from "vitest";

import { CaseDefinitionV1Schema, normalizeRubricPromptReference } from "../src/case-contracts.ts";
import { EndpointConfigV1Schema, LlmConfigV1Schema } from "../src/provider-contracts.ts";

const validCase = {
  contractVersion: "cortex.case-definition.v1",
  description: "route case",
  threshold: 0.75,
  vars: { task: "route", request_body: { text: "hello" } },
  metadata: {
    case_id: "ROUTE-001",
    req_id: "REQ-1",
    task_id: "TASK-1",
    business_module: "Slack",
    scenario_tag: "reply"
  },
  assert: [
    {
      type: "llm-rubric",
      metric: "semantic",
      weight: 1,
      value: "expected",
      rubricPrompt: "prompt://reply-quality"
    }
  ]
};

describe("Case 与 Provider 边界契约", () => {
  it("接受完整 Case，拒绝运行结果、Provider 覆盖和外部代码", () => {
    expect(CaseDefinitionV1Schema.safeParse(validCase).success).toBe(true);
    expect(CaseDefinitionV1Schema.safeParse({ ...validCase, providerOutput: {} }).success).toBe(
      false
    );
    expect(
      CaseDefinitionV1Schema.safeParse({
        ...validCase,
        assert: [{ type: "equals", metric: "x", provider: "openai:gpt", value: "ok" }]
      }).success
    ).toBe(false);
    expect(
      CaseDefinitionV1Schema.safeParse({
        ...validCase,
        assert: [{ type: "javascript", metric: "x", value: "file://outside.js" }]
      }).success
    ).toBe(false);
  });

  it("只规范化受控 Fixture Rubric 别名", () => {
    expect(normalizeRubricPromptReference("prompt://reply-quality")).toBe("prompt://reply-quality");
    expect(normalizeRubricPromptReference("file://rubric_prompt/reply-quality.json")).toBe(
      "prompt://reply-quality"
    );
    expect(() => normalizeRubricPromptReference("file://../secret.json")).toThrow(
      "RUBRIC_REFERENCE_INVALID"
    );
  });

  it("Endpoint 只允许安全 Literal Header，秘密使用 EnvSecretRef", () => {
    const endpoint = {
      contractVersion: "cortex.endpoint-config.v1",
      urlTemplate: "https://example.com/tasks/{{vars.task}}",
      method: "POST",
      headers: {
        "Content-Type": { kind: "LITERAL", value: "application/json" },
        Authorization: { kind: "ENV_SECRET", envKey: "ENDPOINT_AUTH" }
      },
      bodySelector: "/request_body",
      timeoutMs: 60_000,
      defaultConcurrency: 4
    };
    expect(EndpointConfigV1Schema.safeParse(endpoint).success).toBe(true);
    expect(
      EndpointConfigV1Schema.safeParse({
        ...endpoint,
        urlTemplate: "https://{{vars.host}}/tasks"
      }).success
    ).toBe(false);
    for (const sensitiveName of [
      "apiKey",
      "token",
      "client_secret",
      "credential",
      "password",
      "auth"
    ]) {
      expect(
        EndpointConfigV1Schema.safeParse({
          ...endpoint,
          urlTemplate: `https://example.com/tasks?${sensitiveName}=literal`
        }).success
      ).toBe(false);
    }
    for (const expression of ["{{evil}}", "{{vars.foo + secret}}", "x?safe={{secret}}"]) {
      expect(
        EndpointConfigV1Schema.safeParse({
          ...endpoint,
          urlTemplate: `https://example.com/${expression}`
        }).success
      ).toBe(false);
    }
    for (const path of [
      '{{vars["route-id"]}}',
      "{{vars.items[0].name}}",
      '{{vars["复杂键"][1]}}'
    ]) {
      expect(
        EndpointConfigV1Schema.safeParse({
          ...endpoint,
          urlTemplate: `https://example.com/tasks/${path}`
        }).success
      ).toBe(true);
    }
    for (const dynamicName of ["{{vars.task}}=literal", "to{{vars.task}}ken=literal"]) {
      expect(
        EndpointConfigV1Schema.safeParse({
          ...endpoint,
          urlTemplate: `https://example.com/tasks?${dynamicName}`
        }).success
      ).toBe(false);
    }
    expect(
      EndpointConfigV1Schema.safeParse({
        ...endpoint,
        headers: { Authorization: { kind: "LITERAL", value: "Bearer secret" } }
      }).success
    ).toBe(false);
  });

  it("统一 LLM 配置拒绝秘密字段和不安全远程 NONE 认证", () => {
    const gemini = {
      contractVersion: "cortex.llm-config.v1",
      providerType: "GOOGLE_GEMINI",
      model: "gemini-model",
      thinkingLevel: "MEDIUM",
      temperature: 0.2,
      topP: 0.9,
      maxOutputTokens: 2048,
      timeoutMs: 30_000,
      apiKey: { kind: "ENV_SECRET", envKey: "GEMINI_API_KEY" },
      structuredOutput: "JSON_SCHEMA"
    };
    expect(LlmConfigV1Schema.safeParse(gemini).success).toBe(true);
    expect(LlmConfigV1Schema.safeParse({ ...gemini, token: "secret" }).success).toBe(false);
    expect(
      LlmConfigV1Schema.safeParse({
        ...gemini,
        providerType: "OPENAI_COMPATIBLE",
        baseUrl: "https://remote.example/v1",
        auth: { kind: "NONE" },
        apiKey: undefined
      }).success
    ).toBe(false);
    const local = {
      contractVersion: "cortex.llm-config.v1",
      providerType: "OPENAI_COMPATIBLE",
      model: "local-model",
      thinkingLevel: "OFF",
      temperature: 0.2,
      topP: 0.9,
      maxOutputTokens: 2048,
      timeoutMs: 30_000,
      structuredOutput: "JSON_OBJECT",
      baseUrl: "ftp://localhost/v1",
      auth: { kind: "NONE" }
    };
    expect(LlmConfigV1Schema.safeParse(local).success).toBe(false);
    expect(
      LlmConfigV1Schema.safeParse({ ...local, baseUrl: "http://localhost:11434/v1" }).success
    ).toBe(true);
  });
});
