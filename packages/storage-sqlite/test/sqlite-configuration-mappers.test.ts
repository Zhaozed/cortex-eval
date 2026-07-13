import { describe, expect, it } from "vitest";

import {
  hashEndpointConfig,
  hashLlmConfig,
  hashPrompt
} from "@cortex-eval/domain/src/domain-resource-hashes.ts";

import {
  mapAnalysisPromptResource,
  mapEndpointResource,
  mapLlmResource,
  mapRubricPromptResource
} from "../src/sqlite-configuration-mappers.ts";

const INVALID_HASH = "a".repeat(64);
const BASE = {
  id: "resource-1",
  name: "Resource",
  revision: 0,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z"
};

const endpointRow = {
  ...BASE,
  url_template: "https://example.test/{{vars.task}}",
  method: "POST" as const,
  headers_json: '{"Authorization":{"kind":"ENV_SECRET","envKey":"SERVICE_TOKEN"}}',
  body_selector: "/request_body",
  timeout_ms: 60_000,
  default_concurrency: 4,
  config_hash: hashEndpointConfig({
    contractVersion: "cortex.endpoint-config.v1",
    config: {
      urlTemplate: "https://example.test/{{vars.task}}",
      method: "POST",
      headers: { Authorization: { kind: "ENV_SECRET", envKey: "SERVICE_TOKEN" } },
      bodySelector: "/request_body",
      timeoutMs: 60_000,
      defaultConcurrency: 4
    }
  })
};

const geminiRow = {
  ...BASE,
  provider_type: "GOOGLE_GEMINI" as const,
  model: "gemini",
  options_json:
    '{"thinkingLevel":"LOW","temperature":0,"topP":1,"maxOutputTokens":1024,"timeoutMs":60000,"structuredOutput":"JSON_OBJECT"}',
  secret_refs_json: '{"apiKey":"GEMINI_API_KEY"}',
  config_hash: hashLlmConfig({
    contractVersion: "cortex.llm-config.v1",
    config: {
      providerType: "GOOGLE_GEMINI",
      model: "gemini",
      thinkingLevel: "LOW",
      temperature: 0,
      topP: 1,
      maxOutputTokens: 1_024,
      timeoutMs: 60_000,
      structuredOutput: "JSON_OBJECT",
      apiKey: { kind: "ENV_SECRET", envKey: "GEMINI_API_KEY" }
    }
  })
};

const openAiRow = {
  ...geminiRow,
  provider_type: "OPENAI_COMPATIBLE" as const,
  options_json:
    '{"thinkingLevel":"OFF","temperature":0,"topP":1,"maxOutputTokens":1024,"timeoutMs":60000,"structuredOutput":"JSON_OBJECT","baseUrl":"https://models.example.test/v1","authKind":"BEARER_ENV"}',
  secret_refs_json: '{"bearer":"MODEL_API_TOKEN"}',
  config_hash: hashLlmConfig({
    contractVersion: "cortex.llm-config.v1",
    config: {
      providerType: "OPENAI_COMPATIBLE",
      model: "gemini",
      thinkingLevel: "OFF",
      temperature: 0,
      topP: 1,
      maxOutputTokens: 1_024,
      timeoutMs: 60_000,
      structuredOutput: "JSON_OBJECT",
      baseUrl: "https://models.example.test/v1",
      auth: {
        kind: "BEARER_ENV",
        secret: { kind: "ENV_SECRET", envKey: "MODEL_API_TOKEN" }
      }
    }
  })
};

const rubricRow = {
  ...BASE,
  prompt_key: "quality",
  messages_json: '[{"role":"SYSTEM","content":"Evaluate."}]',
  prompt_hash: hashPrompt({
    contractVersion: "cortex.prompt.v1",
    kind: "LLM_RUBRIC",
    promptKey: "quality",
    messages: [{ role: "SYSTEM", content: "Evaluate." }]
  })
};

const analysisRow = {
  ...BASE,
  prompt_key: "analysis",
  messages_template_json: '[{"role":"USER","content":"{{case_definition}}"}]',
  prompt_hash: hashPrompt({
    contractVersion: "cortex.prompt.v1",
    kind: "CASE_ANALYSIS",
    promptKey: "analysis",
    messages: [{ role: "USER", content: "{{case_definition}}" }]
  })
};

function expectInvalid(operation: () => unknown): void {
  expect(operation).toThrow(expect.objectContaining({ code: "SQLITE_ROW_INVALID" }));
}

describe("SQLite Configuration 行映射错误边界", () => {
  it("映射 EnvSecret Header 并拒绝非法 Header JSON 与联合成员", () => {
    expect(mapEndpointResource(endpointRow)).toMatchObject({
      definition: {
        headers: { Authorization: { kind: "ENV_SECRET", envKey: "SERVICE_TOKEN" } }
      }
    });
    expectInvalid(() => mapEndpointResource({ ...endpointRow, headers_json: "{" }));
    expectInvalid(() => mapEndpointResource({ ...endpointRow, headers_json: "[]" }));
    expectInvalid(() => mapEndpointResource({ ...endpointRow, headers_json: '{"X":null}' }));
    expectInvalid(() =>
      mapEndpointResource({ ...endpointRow, headers_json: '{"X":{"kind":"UNKNOWN"}}' })
    );
    expectInvalid(() =>
      mapEndpointResource({
        ...endpointRow,
        headers_json:
          '{"Authorization":{"kind":"ENV_SECRET","envKey":"SERVICE_TOKEN","value":"shadow"}}'
      })
    );
    expectInvalid(() => mapEndpointResource({ ...endpointRow, timeout_ms: 1 }));
    expectInvalid(() => mapEndpointResource({ ...endpointRow, config_hash: INVALID_HASH }));
  });

  it("拒绝 LLM 缺失、错类型和非法 Secret 引用", () => {
    expect(mapLlmResource(geminiRow)).toMatchObject({
      definition: { providerType: "GOOGLE_GEMINI" }
    });
    expectInvalid(() => mapLlmResource({ ...geminiRow, options_json: "{" }));
    expectInvalid(() => mapLlmResource({ ...geminiRow, options_json: "[]" }));
    expectInvalid(() => mapLlmResource({ ...geminiRow, options_json: "{}" }));
    expectInvalid(() =>
      mapLlmResource({
        ...geminiRow,
        options_json: geminiRow.options_json.replace('"temperature":0', '"temperature":"zero"')
      })
    );
    expectInvalid(() => mapLlmResource({ ...geminiRow, secret_refs_json: "{}" }));
    expectInvalid(() =>
      mapLlmResource({ ...geminiRow, secret_refs_json: '{"apiKey":"invalid-key"}' })
    );
    expectInvalid(() => mapLlmResource({ ...geminiRow, config_hash: INVALID_HASH }));
    expectInvalid(() =>
      mapLlmResource({
        ...geminiRow,
        options_json: geminiRow.options_json.replace('"LOW"', '"EXTREME"')
      })
    );
    expectInvalid(() =>
      mapLlmResource({
        ...geminiRow,
        options_json: geminiRow.options_json.replace('"JSON_OBJECT"', '"TEXT"')
      })
    );
    expectInvalid(() =>
      mapLlmResource({
        ...geminiRow,
        options_json: geminiRow.options_json.replace(/}$/, ',"x":1}')
      })
    );
    expectInvalid(() =>
      mapLlmResource({ ...geminiRow, secret_refs_json: '{"apiKey":"GEMINI_API_KEY","x":"y"}' })
    );
  });

  it("只接受显式 OpenAI-compatible 认证联合及对应 Secret 形状", () => {
    expect(mapLlmResource(openAiRow)).toMatchObject({
      definition: { providerType: "OPENAI_COMPATIBLE", auth: { kind: "BEARER_ENV" } }
    });
    expectInvalid(() =>
      mapLlmResource({
        ...openAiRow,
        options_json: openAiRow.options_json.replace('"BEARER_ENV"', '"BASIC"')
      })
    );
    expectInvalid(() =>
      mapLlmResource({
        ...openAiRow,
        options_json: openAiRow.options_json.replace('"BEARER_ENV"', '"NONE"'),
        secret_refs_json: openAiRow.secret_refs_json
      })
    );
  });

  it("拒绝 Prompt 消息 JSON、成员、角色、空内容和 Analysis 未知变量", () => {
    expect(mapRubricPromptResource(rubricRow)).toMatchObject({ kind: "LLM_RUBRIC_PROMPT" });
    expect(mapAnalysisPromptResource(analysisRow)).toMatchObject({ kind: "CASE_ANALYSIS_PROMPT" });
    expectInvalid(() => mapRubricPromptResource({ ...rubricRow, messages_json: "{" }));
    expectInvalid(() => mapRubricPromptResource({ ...rubricRow, messages_json: "{}" }));
    expectInvalid(() => mapRubricPromptResource({ ...rubricRow, messages_json: "[null]" }));
    expectInvalid(() =>
      mapRubricPromptResource({
        ...rubricRow,
        messages_json: '[{"role":"TOOL","content":"Evaluate."}]'
      })
    );
    expectInvalid(() =>
      mapRubricPromptResource({
        ...rubricRow,
        messages_json: '[{"role":"SYSTEM","content":""}]'
      })
    );
    expectInvalid(() =>
      mapRubricPromptResource({
        ...rubricRow,
        messages_json: '[{"role":"SYSTEM","content":"Evaluate.","name":"hidden"}]'
      })
    );
    expectInvalid(() =>
      mapAnalysisPromptResource({
        ...analysisRow,
        messages_template_json: '[{"role":"USER","content":"{{unknown}}"}]'
      })
    );
    expectInvalid(() => mapRubricPromptResource({ ...rubricRow, prompt_hash: INVALID_HASH }));
    expectInvalid(() => mapAnalysisPromptResource({ ...analysisRow, prompt_hash: INVALID_HASH }));
  });
});
