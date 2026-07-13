import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigurationService } from "@cortex-eval/application/src/features/configurations/configuration-service.ts";
import type { ConfigurationResourceKind } from "@cortex-eval/application/src/features/configurations/configuration-models.ts";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initializeSqliteStorage } from "../src/sqlite-database.ts";

let storage: Awaited<ReturnType<typeof initializeSqliteStorage>>;
let nextId = 1;

beforeEach(async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "cortex-config-repository-"));
  storage = await initializeSqliteStorage({ projectRoot });
  nextId = 1;
});

afterEach(async () => {
  await storage.close();
});

function service(): ConfigurationService {
  return new ConfigurationService({
    transactionManager: storage.createTransactionManager(),
    idGenerator: {
      nextId: (): string => {
        const id = `resource-${nextId}`;
        nextId += 1;
        return id;
      }
    },
    clock: { now: (): string => "2026-01-01T00:00:00.000Z" },
    endpointValidator: { validate: (): Promise<void> => Promise.resolve() },
    llmValidator: { validate: (): Promise<void> => Promise.resolve() }
  });
}

describe("SQLite Configuration Repository", () => {
  it("严格往返四类配置和两个 LLM Provider，并支持原位 Revision 更新", async () => {
    const configurationService = service();
    const commands = [
      {
        kind: "ENDPOINT" as const,
        name: "Endpoint",
        definition: {
          urlTemplate: "https://example.test/{{vars.task}}",
          method: "POST" as const,
          headers: { Accept: { kind: "LITERAL" as const, value: "application/json" } },
          bodySelector: "/request_body",
          timeoutMs: 60_000,
          defaultConcurrency: 4
        }
      },
      {
        kind: "LLM" as const,
        name: "Gemini",
        definition: {
          providerType: "GOOGLE_GEMINI" as const,
          model: "gemini",
          thinkingLevel: "LOW" as const,
          temperature: 0,
          topP: 1,
          maxOutputTokens: 1_024,
          timeoutMs: 60_000,
          structuredOutput: "JSON_OBJECT" as const,
          apiKey: { kind: "ENV_SECRET" as const, envKey: "GEMINI_API_KEY" }
        }
      },
      {
        kind: "LLM" as const,
        name: "Local",
        definition: {
          providerType: "OPENAI_COMPATIBLE" as const,
          model: "local",
          thinkingLevel: "OFF" as const,
          temperature: 0,
          topP: 1,
          maxOutputTokens: 1_024,
          timeoutMs: 60_000,
          structuredOutput: "JSON_SCHEMA" as const,
          baseUrl: "http://127.0.0.1:11434/v1",
          auth: { kind: "NONE" as const }
        }
      },
      {
        kind: "LLM" as const,
        name: "Remote",
        definition: {
          providerType: "OPENAI_COMPATIBLE" as const,
          model: "remote",
          thinkingLevel: "MEDIUM" as const,
          temperature: 0.2,
          topP: 0.9,
          maxOutputTokens: 2_048,
          timeoutMs: 30_000,
          structuredOutput: "JSON_OBJECT" as const,
          baseUrl: "https://models.example.test/v1",
          auth: {
            kind: "BEARER_ENV" as const,
            secret: { kind: "ENV_SECRET" as const, envKey: "MODEL_TOKEN" }
          }
        }
      },
      {
        kind: "LLM_RUBRIC_PROMPT" as const,
        name: "Rubric",
        definition: {
          kind: "LLM_RUBRIC" as const,
          promptKey: "quality",
          messages: [{ role: "SYSTEM" as const, content: "Evaluate." }]
        }
      },
      {
        kind: "CASE_ANALYSIS_PROMPT" as const,
        name: "Analysis",
        definition: {
          kind: "CASE_ANALYSIS" as const,
          promptKey: "analysis",
          messages: [{ role: "USER" as const, content: "{{case_definition}}" }]
        }
      }
    ];
    const created = [];
    for (const command of commands) {
      const result = await configurationService.create(command);
      expect(result.ok).toBe(true);
      if (result.ok) created.push(result.resource);
    }

    for (const expected of created) {
      const read = await storage
        .createTransactionManager()
        .execute(async (transaction) =>
          transaction.configurations.getResource(expected.kind, expected.id)
        );
      expect(read).toEqual(expected);
    }

    for (const current of created) {
      const updateCommand = {
        kind: current.kind,
        id: current.id,
        expectedRevision: 0,
        name: `${current.name} renamed`,
        definition: current.definition
      };
      const updated =
        current.kind === "ENDPOINT"
          ? await configurationService.update({
              ...updateCommand,
              kind: current.kind,
              definition: current.definition
            })
          : current.kind === "LLM"
            ? await configurationService.update({
                ...updateCommand,
                kind: current.kind,
                definition: current.definition
              })
            : current.kind === "LLM_RUBRIC_PROMPT"
              ? await configurationService.update({
                  ...updateCommand,
                  kind: current.kind,
                  definition: current.definition
                })
              : await configurationService.update({
                  ...updateCommand,
                  kind: current.kind,
                  definition: current.definition
                });
      expect(updated).toMatchObject({ ok: true, resource: { revision: 1 } });
      expect(
        await configurationService.delete({
          kind: current.kind,
          id: current.id,
          expectedRevision: 1
        })
      ).toEqual({ ok: true });
    }
  });

  it("删除不存在资源、错误 Kind 和脏持久化配置均返回稳定失败", async () => {
    const configurationService = service();
    expect(
      await configurationService.delete({ kind: "ENDPOINT", id: "missing", expectedRevision: 0 })
    ).toEqual({ ok: false, error: { code: "CONFIGURATION_NOT_FOUND" } });

    const created = await configurationService.create({
      kind: "LLM",
      name: "Gemini",
      definition: {
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
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const database = new Database(storage.databasePath);
    database.prepare("UPDATE llm_config SET options_json = '{}'").run();
    database.close();

    await expect(
      storage
        .createTransactionManager()
        .execute(async (transaction) =>
          transaction.configurations.getResource("LLM", created.resource.id)
        )
    ).rejects.toMatchObject({ code: "SQLITE_ROW_INVALID" });

    for (const kind of [
      "ENDPOINT",
      "LLM",
      "LLM_RUBRIC_PROMPT",
      "CASE_ANALYSIS_PROMPT"
    ] satisfies ConfigurationResourceKind[]) {
      expect(
        await storage
          .createTransactionManager()
          .execute(async (transaction) => transaction.configurations.getResource(kind, "missing"))
      ).toBeNull();
    }
  });
});
