import { describe, expect, it } from "vitest";

import {
  endpointDefinitionToForm,
  endpointApiPathToFormField,
  endpointFormToDefinition,
  llmDefinitionToForm,
  llmApiPathToFormField,
  llmFormToDefinition,
  promptDefinitionToForm,
  promptApiPathToFormField,
  promptFormToDefinition,
  type EndpointFormValues,
  type LlmFormValues,
  type PromptFormValues
} from "../src/features/configurations/configuration-form-mappers.ts";

describe("配置表单 DTO 映射", () => {
  it("Endpoint Header 只发送 Literal 或 EnvSecretRef，不展开 Secret", () => {
    const form: EndpointFormValues = {
      name: "客服接口",
      urlTemplate: "https://example.com/v1/{{ vars.task }}",
      headers: [
        { name: "content-type", kind: "LITERAL", value: "application/json", envKey: "" },
        { name: "authorization", kind: "ENV_SECRET", value: "", envKey: "PROVIDER_TOKEN" }
      ],
      bodySelector: "/request_body",
      timeoutMs: 30_000,
      defaultConcurrency: 4
    };

    expect(endpointFormToDefinition(form)).toEqual({
      ok: true,
      definition: {
        contractVersion: "cortex.endpoint-config.v1",
        urlTemplate: form.urlTemplate,
        method: "POST",
        headers: {
          "content-type": { kind: "LITERAL", value: "application/json" },
          authorization: { kind: "ENV_SECRET", envKey: "PROVIDER_TOKEN" }
        },
        bodySelector: "/request_body",
        timeoutMs: 30_000,
        defaultConcurrency: 4
      }
    });
  });

  it("拒绝重复 Header 名并返回可定位字段", () => {
    const form: EndpointFormValues = {
      name: "重复 Header",
      urlTemplate: "https://example.com",
      headers: [
        { name: "accept", kind: "LITERAL", value: "application/json", envKey: "" },
        { name: "Accept", kind: "LITERAL", value: "text/plain", envKey: "" }
      ],
      bodySelector: "",
      timeoutMs: 1_000,
      defaultConcurrency: 1
    };

    expect(endpointFormToDefinition(form)).toEqual({
      ok: false,
      field: "headers.1.name",
      code: "HEADER_NAME_DUPLICATE"
    });
  });

  it("把 Endpoint 敏感 Header 与 LLM 远端认证错误映射到真实表单字段", () => {
    const endpoint: EndpointFormValues = {
      name: "不安全 Header",
      urlTemplate: "https://example.com",
      headers: [{ name: "Authorization", kind: "LITERAL", value: "secret", envKey: "" }],
      bodySelector: "",
      timeoutMs: 60_000,
      defaultConcurrency: 4
    };
    expect(endpointFormToDefinition(endpoint)).toMatchObject({
      ok: false,
      field: "headers.0.name"
    });

    const llm: LlmFormValues = {
      name: "远端模型",
      providerType: "OPENAI_COMPATIBLE",
      model: "remote-model",
      thinkingLevel: "OFF",
      temperature: 0,
      topP: 1,
      maxOutputTokens: 1_024,
      timeoutMs: 60_000,
      structuredOutput: "JSON_OBJECT",
      geminiApiKeyEnv: "",
      baseUrl: "https://llm.example.com/v1",
      authKind: "NONE",
      bearerEnvKey: ""
    };
    expect(llmFormToDefinition(llm)).toMatchObject({ ok: false, field: "authKind" });
  });

  it("映射 Gemini 的统一推理参数和 Env Key", () => {
    const form: LlmFormValues = {
      name: "Gemini 评估器",
      providerType: "GOOGLE_GEMINI",
      model: "gemini-model",
      thinkingLevel: "MEDIUM",
      temperature: 0.2,
      topP: 0.9,
      maxOutputTokens: 2048,
      timeoutMs: 60_000,
      structuredOutput: "JSON_SCHEMA",
      geminiApiKeyEnv: "GEMINI_API_KEY",
      baseUrl: "",
      authKind: "NONE",
      bearerEnvKey: ""
    };

    expect(llmFormToDefinition(form)).toEqual({
      ok: true,
      definition: {
        contractVersion: "cortex.llm-config.v1",
        providerType: "GOOGLE_GEMINI",
        model: "gemini-model",
        thinkingLevel: "MEDIUM",
        temperature: 0.2,
        topP: 0.9,
        maxOutputTokens: 2048,
        timeoutMs: 60_000,
        structuredOutput: "JSON_SCHEMA",
        apiKey: { kind: "ENV_SECRET", envKey: "GEMINI_API_KEY" }
      }
    });
  });

  it("映射 OpenAI-compatible 显式认证模式", () => {
    const form: LlmFormValues = {
      name: "本地模型",
      providerType: "OPENAI_COMPATIBLE",
      model: "local-model",
      thinkingLevel: "OFF",
      temperature: 0,
      topP: 1,
      maxOutputTokens: 1024,
      timeoutMs: 10_000,
      structuredOutput: "JSON_OBJECT",
      geminiApiKeyEnv: "",
      baseUrl: "http://127.0.0.1:11434/v1",
      authKind: "NONE",
      bearerEnvKey: ""
    };

    expect(llmFormToDefinition(form)).toMatchObject({
      ok: true,
      definition: {
        providerType: "OPENAI_COMPATIBLE",
        baseUrl: "http://127.0.0.1:11434/v1",
        auth: { kind: "NONE" }
      }
    });
  });

  it("Prompt 内容更新独立于 Prompt Key 并保留角色顺序", () => {
    const form: PromptFormValues = {
      name: "质量评估",
      promptKey: "quality.default",
      messages: [
        { role: "SYSTEM", content: "系统规则" },
        { role: "USER", content: "{{provider_output}}" }
      ]
    };

    expect(promptFormToDefinition("LLM_RUBRIC", form)).toEqual({
      ok: true,
      definition: {
        contractVersion: "cortex.prompt.v1",
        kind: "LLM_RUBRIC",
        promptKey: "quality.default",
        messages: form.messages
      }
    });
  });

  it("把 Endpoint 定义还原为稳定 Header 行且只显示 Env Key", () => {
    expect(
      endpointDefinitionToForm("客服接口", {
        contractVersion: "cortex.endpoint-config.v1",
        urlTemplate: "https://example.com",
        method: "POST",
        headers: {
          authorization: { kind: "ENV_SECRET", envKey: "PROVIDER_TOKEN" },
          accept: { kind: "LITERAL", value: "application/json" }
        },
        bodySelector: "",
        timeoutMs: 1_000,
        defaultConcurrency: 2
      })
    ).toMatchObject({
      name: "客服接口",
      headers: [
        { name: "accept", kind: "LITERAL", value: "application/json", envKey: "" },
        { name: "authorization", kind: "ENV_SECRET", value: "", envKey: "PROVIDER_TOKEN" }
      ]
    });
  });

  it("按 provider discriminator 还原 LLM 表单", () => {
    expect(
      llmDefinitionToForm("远端模型", {
        contractVersion: "cortex.llm-config.v1",
        providerType: "OPENAI_COMPATIBLE",
        model: "model",
        thinkingLevel: "LOW",
        temperature: 0.1,
        topP: 0.8,
        maxOutputTokens: 512,
        timeoutMs: 5_000,
        structuredOutput: "JSON_SCHEMA",
        baseUrl: "https://llm.example.com/v1",
        auth: { kind: "BEARER_ENV", secret: { kind: "ENV_SECRET", envKey: "LLM_TOKEN" } }
      })
    ).toMatchObject({
      name: "远端模型",
      providerType: "OPENAI_COMPATIBLE",
      authKind: "BEARER_ENV",
      bearerEnvKey: "LLM_TOKEN",
      geminiApiKeyEnv: ""
    });
  });

  it("还原 Prompt 时保持 Key 与消息顺序", () => {
    const definition = {
      contractVersion: "cortex.prompt.v1",
      kind: "CASE_ANALYSIS",
      promptKey: "analysis.default",
      messages: [
        { role: "SYSTEM", content: "规则" },
        { role: "USER", content: "{{case_definition}}" }
      ]
    } as const;
    expect(
      promptDefinitionToForm("失败分析", { ...definition, messages: [...definition.messages] })
    ).toEqual({
      name: "失败分析",
      promptKey: "analysis.default",
      messages: definition.messages
    });
  });

  it("Endpoint、LLM 与两类 Prompt 都返回首个可定位契约字段", () => {
    const endpoint: EndpointFormValues = {
      name: "无效接口",
      urlTemplate: "not-a-url",
      headers: [],
      bodySelector: "invalid-pointer",
      timeoutMs: 0,
      defaultConcurrency: 0
    };
    expect(endpointFormToDefinition(endpoint)).toMatchObject({ ok: false, field: "urlTemplate" });

    const gemini: LlmFormValues = {
      name: "无效 Gemini",
      providerType: "GOOGLE_GEMINI",
      model: "",
      thinkingLevel: "OFF",
      temperature: 0,
      topP: 1,
      maxOutputTokens: 1,
      timeoutMs: 100,
      structuredOutput: "JSON_SCHEMA",
      geminiApiKeyEnv: "",
      baseUrl: "",
      authKind: "NONE",
      bearerEnvKey: ""
    };
    expect(llmFormToDefinition(gemini)).toMatchObject({ ok: false, field: "model" });

    const prompt: PromptFormValues = { name: "无效", promptKey: " bad ", messages: [] };
    expect(promptFormToDefinition("LLM_RUBRIC", prompt)).toMatchObject({ ok: false });
    expect(promptFormToDefinition("CASE_ANALYSIS", prompt)).toMatchObject({ ok: false });
  });

  it("还原 Gemini 和 Analysis Prompt 的另一联合分支", () => {
    expect(
      llmDefinitionToForm("Gemini", {
        contractVersion: "cortex.llm-config.v1",
        providerType: "GOOGLE_GEMINI",
        model: "gemini",
        thinkingLevel: "HIGH",
        temperature: 0.2,
        topP: 0.9,
        maxOutputTokens: 512,
        timeoutMs: 5_000,
        structuredOutput: "JSON_OBJECT",
        apiKey: { kind: "ENV_SECRET", envKey: "GEMINI_API_KEY" }
      })
    ).toMatchObject({
      providerType: "GOOGLE_GEMINI",
      geminiApiKeyEnv: "GEMINI_API_KEY",
      authKind: "NONE"
    });
    expect(
      promptDefinitionToForm("分析", {
        contractVersion: "cortex.prompt.v1",
        kind: "CASE_ANALYSIS",
        promptKey: "analysis.default",
        messages: [{ role: "USER", content: "{{run_context}}" }]
      })
    ).toMatchObject({ name: "分析", promptKey: "analysis.default" });
  });

  it("把服务端配置路径映射到当前可聚焦表单字段", () => {
    expect(
      endpointApiPathToFormField("definition.headers.Authorization.envKey", [
        { name: "authorization", kind: "ENV_SECRET", value: "", envKey: "TOKEN" }
      ])
    ).toBe("headers.0.envKey");
    expect(endpointApiPathToFormField("definition.timeoutMs", [])).toBe("timeoutMs");
    expect(endpointApiPathToFormField("definition.unknown", [])).toBeNull();
    expect(llmApiPathToFormField("definition.apiKey.envKey")).toBe("geminiApiKeyEnv");
    expect(llmApiPathToFormField("definition.auth.secret.envKey")).toBe("bearerEnvKey");
    expect(llmApiPathToFormField("definition.auth")).toBe("authKind");
    expect(llmApiPathToFormField("name")).toBe("name");
    expect(promptApiPathToFormField("definition.messages.1.content")).toBe("messages.1.content");
    expect(promptApiPathToFormField("messages.variables")).toBe("messages.0.content");
    expect(promptApiPathToFormField("definition.unknown")).toBeNull();
  });
});
