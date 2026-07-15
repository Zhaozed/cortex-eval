import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CaseDefinitionWriter,
  type CaseDefinitionWriterDependencies
} from "@cortex-eval/application/src/features/test-suites/case-definition-writer.ts";
import { ConfigurationService } from "@cortex-eval/application/src/features/configurations/configuration-service.ts";
import { TestSuiteService } from "@cortex-eval/application/src/features/test-suites/test-suite-service.ts";
import type { CaseDefinition } from "@cortex-eval/domain/src/domain-evaluation.ts";
import { hashSuite } from "@cortex-eval/domain/src/domain-resource-hashes.ts";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { initializeSqliteStorage } from "../src/sqlite-database.ts";

const openStorages: { close(): Promise<void> }[] = [];
const HASH_EMPTY_SUITE = hashSuite({ contractVersion: "cortex.suite.v1", cases: [] });
const NOW = "2026-01-01T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(openStorages.splice(0).map(async (storage) => storage.close()));
});

function caseDefinition(caseKey: string): CaseDefinition {
  return {
    caseKey,
    description: caseKey,
    threshold: 1,
    task: "route",
    requestBody: { input: caseKey },
    metadata: {
      requestId: `req-${caseKey}`,
      taskId: `task-${caseKey}`,
      businessModule: "chat",
      scenarioTag: "smoke"
    },
    assertions: [
      {
        type: "llm-rubric",
        metric: "quality",
        weight: 1,
        rubricPrompt: "prompt://quality"
      }
    ]
  };
}

function seedCurrentResources(databasePath: string): void {
  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  database
    .prepare(
      `INSERT INTO test_suite
       (id, name, description, case_count, suite_hash, revision, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, 0, ?, ?)`
    )
    .run("suite-1", "Suite", "Current", HASH_EMPTY_SUITE, NOW, NOW);
  database
    .prepare(
      `INSERT INTO llm_rubric_prompt
       (id, prompt_key, name, messages_json, prompt_hash, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`
    )
    .run("prompt-1", "quality", "Quality", "[]", "a".repeat(64), NOW, NOW);
  database.close();
}

function dependencies(
  storage: Awaited<ReturnType<typeof initializeSqliteStorage>>,
  id: string
): CaseDefinitionWriterDependencies {
  return {
    transactionManager: storage.createTransactionManager(),
    idGenerator: { nextId: (): string => id },
    clock: { now: (): string => "2026-01-02T00:00:00.000Z" }
  };
}

function sequentialDependencies(
  storage: Awaited<ReturnType<typeof initializeSqliteStorage>>,
  prefix: string
): CaseDefinitionWriterDependencies {
  let nextId = 0;
  return {
    transactionManager: storage.createTransactionManager(),
    idGenerator: {
      nextId: (): string => {
        nextId += 1;
        return `${prefix}-${nextId}`;
      }
    },
    clock: { now: (): string => "2026-01-02T00:00:00.000Z" }
  };
}

describe("SQLite Application Repository", () => {
  it("套件列表内聚按创建时间和 ID 排序的最新平台或完整离线导入 Run", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-repository-"));
    const storage = await initializeSqliteStorage({ projectRoot });
    openStorages.push(storage);
    seedCurrentResources(storage.databasePath);
    const database = new Database(storage.databasePath);
    const insert = database.prepare(
      `INSERT INTO run_log (
        id, source_type, source_package_id, execution_id, rerun_mode, suite_id,
        suite_snapshot_json, endpoint_snapshot_json, evaluator_snapshot_json,
        rubric_prompts_snapshot_json, run_context_hash, promptfoo_version,
        contract_versions_json, run_execution_limits_json, run_mode, status, stage,
        artifact_manifest_json, report_result_set_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'NONE', 'suite-1', '{}', '{}', '{}', '[]', ?,
        '0.121.18', '{}', '{}', 'STAGED', ?, ?, '{}', ?, ?, ?)`
    );
    insert.run(
      "run-old",
      "PLATFORM",
      null,
      null,
      "a".repeat(64),
      "COMPLETED",
      "DONE",
      null,
      "2026-01-02T00:00:00.000Z",
      "2026-01-02T00:01:00.000Z"
    );
    insert.run(
      "run-z-new",
      "PLATFORM",
      null,
      null,
      "b".repeat(64),
      "RUNNING",
      "REST",
      null,
      "2026-01-05T00:00:00.000Z",
      "2026-01-05T00:01:00.000Z"
    );
    insert.run(
      "run-import-newest",
      "OFFLINE_IMPORT",
      "package-1",
      "execution-1",
      "c".repeat(64),
      "COMPLETED",
      "DONE",
      "d".repeat(64),
      "2026-01-04T00:00:00.000Z",
      "2026-01-04T00:01:00.000Z"
    );
    database.close();

    const page = await storage
      .createTransactionManager()
      .execute(async (transaction) => transaction.testSuites.querySuites({ limit: 20 }));

    expect(page.items).toEqual([
      {
        id: "suite-1",
        name: "Suite",
        description: "Current",
        caseCount: 0,
        revision: 0,
        updatedAt: NOW,
        latestRun: {
          id: "run-import-newest",
          sourceType: "OFFLINE_IMPORT",
          status: "COMPLETED",
          stage: "DONE",
          updatedAt: "2026-01-04T00:01:00.000Z"
        }
      }
    ]);
  });

  it("在真实托管事务中原子保存 Case 和 Suite 聚合事实", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-repository-"));
    const storage = await initializeSqliteStorage({ projectRoot });
    openStorages.push(storage);
    seedCurrentResources(storage.databasePath);
    const writer = new CaseDefinitionWriter(dependencies(storage, "case-internal-1"));

    const result = await writer.createCase({
      suiteId: "suite-1",
      expectedSuiteRevision: 0,
      definition: caseDefinition("case-1")
    });

    expect(result.ok).toBe(true);
    const database = new Database(storage.databasePath, { readonly: true });
    const suite = database.prepare("SELECT case_count, revision FROM test_suite").get();
    const storedCase = database
      .prepare("SELECT case_key, assertion_types_json, rubric_prompt_keys_json FROM test_case")
      .get();
    database.close();
    expect(suite).toEqual({ case_count: 1, revision: 1 });
    expect(storedCase).toEqual({
      case_key: "case-1",
      assertion_types_json: '["llm-rubric"]',
      rubric_prompt_keys_json: '["quality"]'
    });
    const found = await storage.createTransactionManager().execute(async (transaction) =>
      transaction.testSuites.queryCases({
        suiteId: "suite-1",
        caseKeyContains: "CASE-1",
        descriptionContains: "CASE-1",
        limit: 20
      })
    );
    expect(found.items.map((item) => item.caseKey)).toEqual(["case-1"]);
    const missing = await storage.createTransactionManager().execute(async (transaction) =>
      transaction.testSuites.queryCases({
        suiteId: "suite-1",
        caseKeyContains: "missing",
        limit: 20
      })
    );
    expect(missing.items).toEqual([]);
  });

  it("两个独立连接使用同一旧 Revision 时只有第一个成功", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-repository-"));
    const firstStorage = await initializeSqliteStorage({ projectRoot });
    const secondStorage = await initializeSqliteStorage({ projectRoot });
    openStorages.push(firstStorage, secondStorage);
    seedCurrentResources(firstStorage.databasePath);

    const results = await Promise.all([
      new CaseDefinitionWriter(dependencies(firstStorage, "case-internal-1")).createCase({
        suiteId: "suite-1",
        expectedSuiteRevision: 0,
        definition: caseDefinition("case-1")
      }),
      new CaseDefinitionWriter(dependencies(secondStorage, "case-internal-2")).createCase({
        suiteId: "suite-1",
        expectedSuiteRevision: 0,
        definition: caseDefinition("case-2")
      })
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toMatchObject([
      {
        ok: false,
        error: { code: "RESOURCE_REVISION_CONFLICT", actualRevision: 1, expectedRevision: 0 }
      }
    ]);
  });

  it("严格拒绝被外部破坏的持久化 Case JSON", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-repository-"));
    const storage = await initializeSqliteStorage({ projectRoot });
    openStorages.push(storage);
    seedCurrentResources(storage.databasePath);
    const writer = new CaseDefinitionWriter(dependencies(storage, "case-internal-1"));
    await writer.createCase({
      suiteId: "suite-1",
      expectedSuiteRevision: 0,
      definition: caseDefinition("case-1")
    });
    const database = new Database(storage.databasePath);
    database.prepare("UPDATE test_case SET definition_json = '{}'").run();
    database.close();

    await expect(
      storage
        .createTransactionManager()
        .execute(async (transaction) => transaction.testSuites.listCases("suite-1"))
    ).rejects.toMatchObject({ code: "SQLITE_ROW_INVALID" });
  });

  it("配置原位条件更新不清空历史 Run 的当前来源 ID", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-repository-"));
    const storage = await initializeSqliteStorage({ projectRoot });
    openStorages.push(storage);
    const service = new ConfigurationService({
      ...dependencies(storage, "endpoint-new"),
      endpointValidator: {
        validate: (): Promise<{ readonly ok: true }> => Promise.resolve({ ok: true })
      },
      llmValidator: {
        validate: (): Promise<{ readonly ok: true }> => Promise.resolve({ ok: true })
      }
    });
    const endpointDefinition = {
      urlTemplate: "https://example.test/{{vars.task}}",
      method: "POST" as const,
      headers: {},
      bodySelector: "/request_body",
      timeoutMs: 60_000,
      defaultConcurrency: 4
    };
    const created = await service.create({
      kind: "ENDPOINT",
      name: "Endpoint",
      definition: endpointDefinition
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const native = new Database(storage.databasePath);
    native.pragma("foreign_keys = ON");
    native
      .prepare(
        `INSERT INTO run_log (
          id, source_type, rerun_mode, endpoint_config_id, suite_snapshot_json,
          endpoint_snapshot_json, evaluator_snapshot_json, rubric_prompts_snapshot_json,
          run_context_hash, promptfoo_version, contract_versions_json,
          run_execution_limits_json, run_mode, status, stage, artifact_manifest_json,
          created_at, updated_at
        ) VALUES ('run-1', 'PLATFORM', 'NONE', ?, '{}', '{}', '{}', '[]', ?,
          '0.121.18', '{}', '{}', 'STAGED', 'READY', 'REST', '[]', ?, ?)`
      )
      .run(created.resource.id, "a".repeat(64), NOW, NOW);
    native.close();

    const updated = await service.update({
      kind: "ENDPOINT",
      id: created.resource.id,
      expectedRevision: 0,
      name: "Renamed",
      definition: endpointDefinition
    });
    expect(updated.ok).toBe(true);
    const read = new Database(storage.databasePath, { readonly: true });
    const row = read.prepare("SELECT endpoint_config_id FROM run_log WHERE id = 'run-1'").get();
    read.close();
    expect(row).toEqual({ endpoint_config_id: created.resource.id });
    expect(
      await service.delete({
        kind: "ENDPOINT",
        id: created.resource.id,
        expectedRevision: 1
      })
    ).toEqual({ ok: false, error: { code: "RESOURCE_IN_ACTIVE_RUN" } });
    const terminal = new Database(storage.databasePath);
    terminal
      .prepare("UPDATE run_log SET status = 'COMPLETED', stage = 'DONE' WHERE id = 'run-1'")
      .run();
    terminal.close();
    expect(
      await service.delete({
        kind: "ENDPOINT",
        id: created.resource.id,
        expectedRevision: 1
      })
    ).toEqual({ ok: true });
    const afterDelete = new Database(storage.databasePath, { readonly: true });
    expect(
      afterDelete.prepare("SELECT endpoint_config_id, endpoint_snapshot_json FROM run_log").get()
    ).toEqual({ endpoint_config_id: null, endpoint_snapshot_json: "{}" });
    afterDelete.close();
  });

  it("两个独立连接并发创建同名 Suite 时返回一次成功和一次稳定唯一冲突", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-suite-unique-race-"));
    const firstStorage = await initializeSqliteStorage({ projectRoot });
    const secondStorage = await initializeSqliteStorage({ projectRoot });
    openStorages.push(firstStorage, secondStorage);
    const results = await Promise.all([
      new TestSuiteService(dependencies(firstStorage, "suite-a")).create({
        name: "Same",
        description: "First"
      }),
      new TestSuiteService(dependencies(secondStorage, "suite-b")).create({
        name: "Same",
        description: "Second"
      })
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, error: { code: "RESOURCE_UNIQUE_CONFLICT", field: "name" } }
    ]);
  });

  it.each([
    [
      "首项",
      "case-a",
      [
        ["case-b", 0, 1],
        ["case-c", 1, 1]
      ]
    ],
    [
      "中间项",
      "case-b",
      [
        ["case-a", 0, 0],
        ["case-c", 1, 1]
      ]
    ],
    [
      "末项",
      "case-c",
      [
        ["case-a", 0, 0],
        ["case-b", 1, 0]
      ]
    ]
  ] as const)(
    "真实 SQLite 删除%s时持久化连续 Ordinal 与移动项 Revision",
    async (_scope, target, expected) => {
      const projectRoot = await mkdtemp(join(tmpdir(), "cortex-case-delete-"));
      const storage = await initializeSqliteStorage({ projectRoot });
      openStorages.push(storage);
      seedCurrentResources(storage.databasePath);
      const writer = new CaseDefinitionWriter(sequentialDependencies(storage, "case-internal"));
      const imported = await writer.replaceAllCases({
        suiteId: "suite-1",
        expectedSuiteRevision: 0,
        definitions: [caseDefinition("case-a"), caseDefinition("case-b"), caseDefinition("case-c")]
      });
      expect(imported.ok).toBe(true);

      const deleted = await writer.deleteCase({
        suiteId: "suite-1",
        caseKey: target,
        expectedSuiteRevision: 1,
        expectedCaseRevision: 0
      });
      expect(deleted).toMatchObject({ ok: true, suite: { caseCount: 2, revision: 2 } });
      const cases = await storage
        .createTransactionManager()
        .execute(async (transaction) => transaction.testSuites.listCases("suite-1"));
      expect(cases.map((item) => [item.caseKey, item.ordinal, item.revision])).toEqual(expected);
      if (deleted.ok) {
        expect(deleted.suite.suiteHash).toBe(
          hashSuite({
            contractVersion: "cortex.suite.v1",
            cases: cases.map((item) => ({
              caseKey: item.caseKey,
              ordinal: item.ordinal,
              definitionHash: item.definitionHash
            }))
          })
        );
      }
    }
  );

  it("真实 SQLite 重排失败时回滚 Suite、删除和全部 Case Ordinal", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-case-delete-rollback-"));
    const storage = await initializeSqliteStorage({ projectRoot });
    openStorages.push(storage);
    seedCurrentResources(storage.databasePath);
    const writer = new CaseDefinitionWriter(sequentialDependencies(storage, "case-internal"));
    const imported = await writer.replaceAllCases({
      suiteId: "suite-1",
      expectedSuiteRevision: 0,
      definitions: [caseDefinition("case-a"), caseDefinition("case-b"), caseDefinition("case-c")]
    });
    expect(imported.ok).toBe(true);
    const native = new Database(storage.databasePath);
    native
      .prepare(
        `CREATE TRIGGER reject_case_ordinal_update
         BEFORE UPDATE OF ordinal ON test_case
         WHEN NEW.ordinal <> OLD.ordinal
         BEGIN
           SELECT RAISE(ABORT, 'forced ordinal failure');
         END`
      )
      .run();
    native.close();

    await expect(
      writer.deleteCase({
        suiteId: "suite-1",
        caseKey: "case-b",
        expectedSuiteRevision: 1,
        expectedCaseRevision: 0
      })
    ).rejects.toBeDefined();
    const read = new Database(storage.databasePath, { readonly: true });
    expect(
      read.prepare("SELECT case_count, revision FROM test_suite WHERE id = ?").get("suite-1")
    ).toEqual({ case_count: 3, revision: 1 });
    expect(
      read.prepare("SELECT case_key, ordinal, revision FROM test_case ORDER BY ordinal").all()
    ).toEqual([
      { case_key: "case-a", ordinal: 0, revision: 0 },
      { case_key: "case-b", ordinal: 1, revision: 0 },
      { case_key: "case-c", ordinal: 2, revision: 0 }
    ]);
    read.close();
  });
});
