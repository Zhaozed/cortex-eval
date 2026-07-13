import { describe, expect, it } from "vitest";

import {
  IncrementalSuiteHasher,
  hashEndpointConfig,
  hashLlmConfig,
  hashPrompt,
  hashRubricPromptSet,
  hashSuite
} from "../src/domain-resource-hashes.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

describe("Domain 资源身份哈希", () => {
  it("Suite Hash 按 Ordinal 固定顺序且排除显示字段与数据库身份", () => {
    const cases = [
      { caseKey: "case-b", ordinal: 1, definitionHash: HASH_B },
      { caseKey: "case-a", ordinal: 0, definitionHash: HASH_A }
    ];
    const hash = hashSuite({ contractVersion: "cortex.suite.v1", cases });
    expect(hash).toBe(
      hashSuite({ contractVersion: "cortex.suite.v1", cases: [...cases].reverse() })
    );
  });

  it("增量 Suite Hasher 与完整 RFC8785 Hash 字节级一致且强制 Ordinal 顺序", () => {
    const cases = [
      { caseKey: "复杂-case", ordinal: 0, definitionHash: HASH_A },
      { caseKey: "case-b", ordinal: 1, definitionHash: HASH_B }
    ];
    const hasher = new IncrementalSuiteHasher();
    for (const item of cases) hasher.append(item);
    expect(hasher.digest()).toBe(hashSuite({ contractVersion: "cortex.suite.v1", cases }));
    const secondCase = cases[1];
    if (secondCase === undefined) throw new Error("SECOND_CASE_EXPECTED");
    expect(() => hasher.append(secondCase)).toThrow("SUITE_HASH_FINALIZED");

    const outOfOrder = new IncrementalSuiteHasher();
    expect(() => outOfOrder.append({ ...secondCase, ordinal: 1 })).toThrow(
      "SUITE_HASH_ORDINAL_INVALID"
    );
  });

  it("Endpoint 与 LLM Hash 包含全部运行语义但不接收名称或角色", () => {
    const endpointHash = hashEndpointConfig({
      contractVersion: "cortex.endpoint-config.v1",
      config: {
        urlTemplate: "https://example.test/{{vars.task}}",
        method: "POST",
        headers: { Authorization: { kind: "ENV_SECRET", envKey: "SERVICE_TOKEN" } },
        bodySelector: "/request_body",
        timeoutMs: 60_000,
        defaultConcurrency: 4
      }
    });
    const llmHash = hashLlmConfig({
      contractVersion: "cortex.llm-config.v1",
      config: {
        providerType: "GOOGLE_GEMINI",
        model: "gemini-2.5-flash",
        thinkingLevel: "LOW",
        temperature: 0,
        topP: 1,
        maxOutputTokens: 1_024,
        timeoutMs: 60_000,
        structuredOutput: "JSON_OBJECT",
        apiKey: { kind: "ENV_SECRET", envKey: "GEMINI_API_KEY" }
      }
    });
    expect(endpointHash).toMatch(/^[0-9a-f]{64}$/);
    expect(llmHash).toMatch(/^[0-9a-f]{64}$/);
    expect(endpointHash).not.toBe(llmHash);
    expect(endpointHash).toBe(
      hashEndpointConfig({
        contractVersion: "cortex.endpoint-config.v1",
        config: {
          urlTemplate: "https://example.test/{{vars.task}}",
          method: "POST",
          headers: { authorization: { kind: "ENV_SECRET", envKey: "SERVICE_TOKEN" } },
          bodySelector: "/request_body",
          timeoutMs: 60_000,
          defaultConcurrency: 4
        }
      })
    );
  });

  it("Prompt Hash 排除显示名称，Prompt Set 按 Key 排序", () => {
    const promptHash = hashPrompt({
      contractVersion: "cortex.prompt.v1",
      kind: "LLM_RUBRIC",
      promptKey: "quality",
      messages: [{ role: "SYSTEM", content: "Evaluate." }]
    });
    expect(promptHash).toBe(
      hashPrompt({
        contractVersion: "cortex.prompt.v1",
        kind: "LLM_RUBRIC",
        promptKey: "quality",
        messages: [{ role: "SYSTEM", content: "Evaluate." }]
      })
    );
    expect(
      hashRubricPromptSet({
        contractVersion: "cortex.rubric-prompt-set.v1",
        prompts: [
          { promptKey: "z", promptHash: HASH_B },
          { promptKey: "a", promptHash: HASH_A }
        ]
      })
    ).toBe(
      hashRubricPromptSet({
        contractVersion: "cortex.rubric-prompt-set.v1",
        prompts: [
          { promptKey: "a", promptHash: HASH_A },
          { promptKey: "z", promptHash: HASH_B }
        ]
      })
    );
  });
});
