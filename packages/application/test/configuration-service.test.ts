import { describe, expect, it } from "vitest";

import type {
  AnalysisPromptDefinition,
  EndpointConfigDefinition,
  LlmConfigDefinition
} from "@cortex-eval/domain/src/domain-resource-models.ts";

import { ConfigurationService } from "../src/features/configurations/configuration-service.ts";
import { InMemoryApplicationStore } from "./test-support/in-memory-application-store.ts";

const endpoint: EndpointConfigDefinition = {
  urlTemplate: "https://example.test/{{vars.task}}",
  method: "POST",
  headers: { Authorization: { kind: "ENV_SECRET", envKey: "SERVICE_TOKEN" } },
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

describe("ConfigurationService", () => {
  it("创建和更新 Endpoint 时使用独立 Revision，显示名称变化也能检测旧 Token", async () => {
    const store = new InMemoryApplicationStore();
    const service = new ConfigurationService(store.configurationDependencies());
    const created = await service.create({
      kind: "ENDPOINT",
      name: "Primary",
      definition: endpoint
    });
    expect(created).toMatchObject({ ok: true, resource: { revision: 0, name: "Primary" } });
    if (!created.ok) return;

    const updated = await service.update({
      kind: "ENDPOINT",
      id: created.resource.id,
      expectedRevision: 0,
      name: "Renamed",
      definition: endpoint
    });
    const stale = await service.update({
      kind: "ENDPOINT",
      id: created.resource.id,
      expectedRevision: 0,
      name: "Lost update",
      definition: endpoint
    });

    expect(updated).toMatchObject({ ok: true, resource: { revision: 1, name: "Renamed" } });
    expect(stale).toMatchObject({
      ok: false,
      error: { code: "RESOURCE_REVISION_CONFLICT", actualRevision: 1, expectedRevision: 0 }
    });
    expect(await service.get("ENDPOINT", created.resource.id)).toMatchObject({ name: "Renamed" });
    expect((await service.list("ENDPOINT")).map((item) => item.id)).toEqual([created.resource.id]);
    expect(
      await service.create({ kind: "ENDPOINT", name: "Renamed", definition: endpoint })
    ).toEqual({
      ok: false,
      error: { code: "RESOURCE_UNIQUE_CONFLICT", field: "name" }
    });
  });

  it("拒绝非法 LLM，Rubric 被 Case 引用时拒绝删除", async () => {
    const store = new InMemoryApplicationStore();
    const service = new ConfigurationService(store.configurationDependencies());
    const invalid = await service.create({
      kind: "LLM",
      name: "Remote",
      definition: {
        ...gemini,
        providerType: "OPENAI_COMPATIBLE",
        baseUrl: "https://models.example.test/v1",
        auth: { kind: "NONE" }
      } as LlmConfigDefinition
    });
    expect(invalid).toMatchObject({ ok: false, error: { code: "LLM_CONFIG_INVALID" } });

    const prompt = await service.create({
      kind: "LLM_RUBRIC_PROMPT",
      name: "Quality",
      definition: {
        kind: "LLM_RUBRIC",
        promptKey: "quality",
        messages: [{ role: "SYSTEM", content: "Evaluate." }]
      }
    });
    expect(prompt.ok).toBe(true);
    if (!prompt.ok) return;
    expect(
      await service.create({
        kind: "LLM_RUBRIC_PROMPT",
        name: "Another",
        definition: {
          kind: "LLM_RUBRIC",
          promptKey: "quality",
          messages: [{ role: "SYSTEM", content: "Evaluate again." }]
        }
      })
    ).toEqual({
      ok: false,
      error: { code: "RESOURCE_UNIQUE_CONFLICT", field: "promptKey" }
    });
    store.seedRubricReference("quality");
    expect(
      await service.delete({
        kind: "LLM_RUBRIC_PROMPT",
        id: prompt.resource.id,
        expectedRevision: 0
      })
    ).toEqual({ ok: false, error: { code: "RUBRIC_PROMPT_IN_USE", promptKey: "quality" } });
    expect(
      await service.update({
        kind: "LLM_RUBRIC_PROMPT",
        id: prompt.resource.id,
        expectedRevision: 0,
        name: "Renamed key",
        definition: {
          kind: "LLM_RUBRIC",
          promptKey: "quality-v2",
          messages: [{ role: "SYSTEM", content: "Evaluate." }]
        }
      })
    ).toEqual({ ok: false, error: { code: "RUBRIC_PROMPT_IN_USE", promptKey: "quality" } });
  });

  it("预览 Analysis Prompt 变量并在事务外执行 Endpoint/LLM 外部验证", async () => {
    const store = new InMemoryApplicationStore();
    const calls: string[] = [];
    const service = new ConfigurationService({
      ...store.configurationDependencies(),
      endpointValidator: {
        validate: (): Promise<void> => {
          calls.push("endpoint");
          return Promise.resolve();
        }
      },
      llmValidator: {
        validate: (): Promise<void> => {
          calls.push("llm");
          return Promise.resolve();
        }
      }
    });
    const prompt: AnalysisPromptDefinition = {
      kind: "CASE_ANALYSIS",
      promptKey: "analysis",
      messages: [{ role: "USER", content: "{{run_context}} {{ case_definition }}" }]
    };
    expect(service.previewAnalysisPromptVariables(prompt)).toEqual([
      "case_definition",
      "run_context"
    ]);
    const transactionCount = store.transactionCount;
    await service.validateEndpoint(endpoint);
    await service.validateLlm(gemini);
    expect(calls).toEqual(["endpoint", "llm"]);
    expect(store.transactionCount).toBe(transactionCount);
  });

  it("创建四类配置并按资源类型执行活动引用与普通删除规则", async () => {
    const store = new InMemoryApplicationStore();
    const service = new ConfigurationService(store.configurationDependencies());
    const llm = await service.create({ kind: "LLM", name: "Gemini", definition: gemini });
    const analysis = await service.create({
      kind: "CASE_ANALYSIS_PROMPT",
      name: "Analyzer Prompt",
      definition: {
        kind: "CASE_ANALYSIS",
        promptKey: "analysis",
        messages: [{ role: "USER", content: "{{case_definition}}" }]
      }
    });
    expect(llm.ok).toBe(true);
    expect(analysis.ok).toBe(true);
    if (!llm.ok || !analysis.ok) return;

    expect(
      await service.delete({ kind: "LLM", id: llm.resource.id, expectedRevision: 1 })
    ).toMatchObject({ ok: false, error: { code: "RESOURCE_REVISION_CONFLICT" } });
    store.seedActiveResourceReference("LLM", llm.resource.id);
    expect(await service.delete({ kind: "LLM", id: llm.resource.id, expectedRevision: 0 })).toEqual(
      { ok: false, error: { code: "RESOURCE_IN_ACTIVE_RUN" } }
    );
    store.clearActiveResourceReferences();
    expect(await service.delete({ kind: "LLM", id: llm.resource.id, expectedRevision: 0 })).toEqual(
      { ok: true }
    );
    expect(
      await service.delete({
        kind: "CASE_ANALYSIS_PROMPT",
        id: analysis.resource.id,
        expectedRevision: 0
      })
    ).toEqual({ ok: true });
    expect(await service.delete({ kind: "ENDPOINT", id: "missing", expectedRevision: 0 })).toEqual({
      ok: false,
      error: { code: "CONFIGURATION_NOT_FOUND" }
    });
  });

  it("更新时收敛名称与 Prompt Key 冲突，并拒绝非法预览和外部验证输入", async () => {
    const store = new InMemoryApplicationStore();
    const service = new ConfigurationService(store.configurationDependencies());
    const first = await service.create({ kind: "ENDPOINT", name: "First", definition: endpoint });
    await service.create({ kind: "ENDPOINT", name: "Second", definition: endpoint });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(
      await service.update({
        kind: "ENDPOINT",
        id: first.resource.id,
        expectedRevision: 0,
        name: "Second",
        definition: endpoint
      })
    ).toEqual({ ok: false, error: { code: "RESOURCE_UNIQUE_CONFLICT", field: "name" } });
    expect(
      await service.update({
        kind: "ENDPOINT",
        id: "missing",
        expectedRevision: 0,
        name: "Missing",
        definition: endpoint
      })
    ).toEqual({ ok: false, error: { code: "CONFIGURATION_NOT_FOUND" } });

    const firstPrompt = await service.create({
      kind: "LLM_RUBRIC_PROMPT",
      name: "First Prompt",
      definition: {
        kind: "LLM_RUBRIC",
        promptKey: "first",
        messages: [{ role: "SYSTEM", content: "First" }]
      }
    });
    await service.create({
      kind: "LLM_RUBRIC_PROMPT",
      name: "Second Prompt",
      definition: {
        kind: "LLM_RUBRIC",
        promptKey: "second",
        messages: [{ role: "SYSTEM", content: "Second" }]
      }
    });
    expect(firstPrompt.ok).toBe(true);
    if (!firstPrompt.ok) return;
    expect(
      await service.update({
        kind: "LLM_RUBRIC_PROMPT",
        id: firstPrompt.resource.id,
        expectedRevision: 0,
        name: "First Prompt",
        definition: {
          kind: "LLM_RUBRIC",
          promptKey: "second",
          messages: [{ role: "SYSTEM", content: "First" }]
        }
      })
    ).toEqual({
      ok: false,
      error: { code: "RESOURCE_UNIQUE_CONFLICT", field: "promptKey" }
    });

    const invalidPrompt: AnalysisPromptDefinition = {
      kind: "CASE_ANALYSIS",
      promptKey: "analysis",
      messages: [{ role: "USER", content: "{{unknown}}" }]
    };
    expect(service.previewAnalysisPromptVariables(invalidPrompt)).toEqual([]);
    await expect(service.validateEndpoint({ ...endpoint, timeoutMs: 1 })).rejects.toThrow(
      "ENDPOINT_CONFIG_INVALID"
    );
    await expect(service.validateLlm({ ...gemini, topP: 2 })).rejects.toThrow("LLM_CONFIG_INVALID");
  });
});
