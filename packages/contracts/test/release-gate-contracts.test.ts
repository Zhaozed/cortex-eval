import { describe, expect, it } from "vitest";

import { ReleaseLiveConfigV1Schema } from "../src/release-gate-contracts.ts";

const gemini = {
  contractVersion: "cortex.llm-config.v1",
  providerType: "GOOGLE_GEMINI",
  model: "gemini-live",
  apiKey: { kind: "ENV_SECRET", envKey: "GEMINI_API_KEY" },
  thinkingLevel: "OFF",
  temperature: 0,
  topP: 1,
  maxOutputTokens: 1024,
  timeoutMs: 60_000,
  structuredOutput: "JSON_SCHEMA"
} as const;

describe("P10 显式 Live 配置契约", () => {
  it("只接受双 Gemini、Rubric Prompt 和 Analysis Prompt 的完整配置", () => {
    const parsed = ReleaseLiveConfigV1Schema.parse({
      contractVersion: "cortex.release-live-config.v1",
      evaluator: { ...gemini, structuredOutput: "JSON_OBJECT" },
      analyzer: gemini,
      rubricPrompt: {
        contractVersion: "cortex.prompt.v1",
        kind: "LLM_RUBRIC",
        promptKey: "release-rubric",
        messages: [{ role: "USER", content: "Rubric" }]
      },
      analysisPrompt: {
        contractVersion: "cortex.prompt.v1",
        kind: "CASE_ANALYSIS",
        promptKey: "release-analysis",
        messages: [{ role: "USER", content: "Analyze {{run_context}}" }]
      }
    });

    expect(parsed.evaluator.providerType).toBe("GOOGLE_GEMINI");
    expect(parsed.analyzer.structuredOutput).toBe("JSON_SCHEMA");
  });

  it("拒绝 OpenAI-compatible、未知字段和非结构化 Analyzer", () => {
    const valid = {
      contractVersion: "cortex.release-live-config.v1",
      evaluator: { ...gemini, structuredOutput: "JSON_OBJECT" },
      analyzer: gemini,
      rubricPrompt: {
        contractVersion: "cortex.prompt.v1",
        kind: "LLM_RUBRIC",
        promptKey: "release-rubric",
        messages: [{ role: "USER", content: "Rubric" }]
      },
      analysisPrompt: {
        contractVersion: "cortex.prompt.v1",
        kind: "CASE_ANALYSIS",
        promptKey: "release-analysis",
        messages: [{ role: "USER", content: "Analyze" }]
      }
    } as const;
    expect(
      ReleaseLiveConfigV1Schema.safeParse({ ...valid, analyzer: { ...gemini, extra: true } })
        .success
    ).toBe(false);
    expect(
      ReleaseLiveConfigV1Schema.safeParse({
        ...valid,
        analyzer: { ...gemini, structuredOutput: "JSON_OBJECT" }
      }).success
    ).toBe(false);
    expect(
      ReleaseLiveConfigV1Schema.safeParse({
        ...valid,
        evaluator: {
          ...gemini,
          providerType: "OPENAI_COMPATIBLE",
          baseUrl: "http://127.0.0.1:11434/v1",
          auth: { kind: "NONE" }
        }
      }).success
    ).toBe(false);
  });
});
