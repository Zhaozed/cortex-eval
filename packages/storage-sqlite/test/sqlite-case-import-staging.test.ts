import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { StreamingCaseImportService } from "@cortex-eval/application/src/features/test-suites/streaming-case-import-service.ts";
import { hashSuite } from "@cortex-eval/domain/src/domain-resource-hashes.ts";
import type { CaseDefinition } from "@cortex-eval/domain/src/domain-evaluation.ts";

import { initializeSqliteStorage, type SqliteStorage } from "../src/sqlite-database.ts";

function definition(caseKey: string): CaseDefinition {
  return {
    caseKey,
    description: caseKey,
    threshold: 1,
    task: "route",
    requestBody: { caseKey },
    metadata: {
      requestId: `req-${caseKey}`,
      taskId: `task-${caseKey}`,
      businessModule: "chat",
      scenarioTag: "smoke"
    },
    assertions: [{ type: "contains", metric: "quality", weight: 1 }]
  };
}

// Expose test definitions through a real asynchronous item boundary.
async function* asyncDefinitions(
  ...values: CaseDefinition[]
): AsyncGenerator<CaseDefinition, void, void> {
  await Promise.resolve();
  yield* values;
}

describe("SQLite Case import staging", () => {
  const roots: string[] = [];
  const storages: SqliteStorage[] = [];

  afterEach(async () => {
    await Promise.all(storages.splice(0).map(async (storage) => storage.close()));
    await Promise.all(
      roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true }))
    );
  });

  function seedSuite(databasePath: string): void {
    const database = new Database(databasePath);
    database
      .prepare(
        `INSERT INTO test_suite
         (id, name, description, case_count, suite_hash, revision, created_at, updated_at)
         VALUES (?, ?, ?, 0, ?, 0, ?, ?)`
      )
      .run(
        "suite-1",
        "Suite",
        "Current",
        hashSuite({ contractVersion: "cortex.suite.v1", cases: [] }),
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z"
      );
    database.close();
  }

  it("预检四类影响与排序，不改主库、Revision 或原记录身份", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-case-preview-"));
    roots.push(projectRoot);
    const storage = await initializeSqliteStorage({ projectRoot });
    storages.push(storage);
    seedSuite(storage.databasePath);
    let nextId = 1;
    const service = new StreamingCaseImportService({
      transactionManager: storage.createTransactionManager(),
      stagingFactory: storage.createCaseImportStagingFactory(),
      clock: { now: () => "2026-01-02T00:00:00.000Z" },
      idGenerator: {
        nextId: () => `018f0c8e-9f79-7000-8000-${(nextId++).toString(16).padStart(12, "0")}`
      }
    });
    const command = { suiteId: "suite-1", signal: new AbortController().signal };
    expect(
      await service.importCases({
        ...command,
        expectedSuiteRevision: 0,
        definitions: asyncDefinitions(definition("a"), definition("b"), definition("c"))
      })
    ).toMatchObject({ ok: true });
    const db = new Database(storage.databasePath, { readonly: true });
    try {
      const before = db.prepare("SELECT * FROM test_case ORDER BY ordinal").all();
      const suiteBefore = db.prepare("SELECT * FROM test_suite").all();
      const preview = await service.importCases({
        ...command,
        expectedSuiteRevision: 1,
        previewOnly: true,
        definitions: asyncDefinitions(
          { ...definition("b"), description: "改描述" },
          definition("a"),
          definition("d")
        )
      });
      expect(preview).toMatchObject({
        ok: true,
        count: 3,
        suite: { revision: 1 },
        preview: { added: 1, modified: 1, removed: 1, unchanged: 1, reordered: 2 }
      });
      expect(
        await service.importCases({
          ...command,
          expectedSuiteRevision: 1,
          previewOnly: true,
          definitions: asyncDefinitions()
        })
      ).toMatchObject({
        ok: true,
        count: 0,
        preview: { added: 0, modified: 0, removed: 3, unchanged: 0, reordered: 0 }
      });
      expect(
        await service.importCases({
          ...command,
          expectedSuiteRevision: 0,
          previewOnly: true,
          definitions: asyncDefinitions(definition("d"))
        })
      ).toMatchObject({ ok: false, error: { code: "RESOURCE_REVISION_CONFLICT" } });
      expect(db.prepare("SELECT * FROM test_case ORDER BY ordinal").all()).toEqual(before);
      expect(db.prepare("SELECT * FROM test_suite").all()).toEqual(suiteBefore);
    } finally {
      db.close();
    }
  });

  it("从外部 staging 原子替换 Cases，权限受控且完成后 DETACH/清理", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-case-stage-"));
    roots.push(projectRoot);
    const storage = await initializeSqliteStorage({ projectRoot });
    storages.push(storage);
    seedSuite(storage.databasePath);

    let nextId = 1;
    const result = await new StreamingCaseImportService({
      transactionManager: storage.createTransactionManager(),
      stagingFactory: storage.createCaseImportStagingFactory(),
      clock: { now: (): string => "2026-01-02T00:00:00.000Z" },
      idGenerator: {
        nextId: (): string => `018f0c8e-9f79-7000-8000-${(nextId++).toString(16).padStart(12, "0")}`
      }
    }).importCases({
      suiteId: "suite-1",
      expectedSuiteRevision: 0,
      definitions: asyncDefinitions(definition("case-1"), definition("case-2")),
      signal: new AbortController().signal
    });
    expect(result).toMatchObject({ ok: true, count: 2, suite: { revision: 1 } });

    const verification = new Database(storage.databasePath, { readonly: true });
    expect(
      verification.prepare("SELECT case_key, ordinal FROM test_case ORDER BY ordinal").all()
    ).toEqual([
      { case_key: "case-1", ordinal: 0 },
      { case_key: "case-2", ordinal: 1 }
    ]);
    expect(
      verification
        .prepare("PRAGMA database_list")
        .all()
        .map((row) => (row as { name: string }).name)
    ).toEqual(["main"]);
    verification.close();

    const temporaryRoot = join(projectRoot, ".cortex-eval", "tmp");
    expect((await stat(temporaryRoot)).mode & 0o777).toBe(0o700);
    expect(
      (await readdir(temporaryRoot)).filter((name) => name.startsWith("case-import-"))
    ).toEqual([]);
  });

  it("staging 数据库初始化失败时关闭句柄并删除已创建工作区", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-case-stage-"));
    roots.push(projectRoot);
    const storage = await initializeSqliteStorage({ projectRoot });
    storages.push(storage);
    const openedWriters: Database.Database[] = [];
    const factory = storage.createCaseImportStagingFactory(undefined, {
      initializeWriter: (writer): void => {
        openedWriters.push(writer);
        throw new Error("STAGING_INITIALIZATION_FAILED");
      }
    });

    await expect(factory.open()).rejects.toThrow("STAGING_INITIALIZATION_FAILED");
    expect(openedWriters[0]?.open).toBe(false);
    expect(
      (await readdir(join(projectRoot, ".cortex-eval", "tmp"))).filter((name) =>
        name.startsWith("case-import-")
      )
    ).toEqual([]);
  });

  it("关闭 writer 后 staging 文件为 0400，ATTACH 期间写入被 OS 拒绝且无 sidecar", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-case-stage-"));
    roots.push(projectRoot);
    const storage = await initializeSqliteStorage({ projectRoot });
    storages.push(storage);
    const session = await storage.createCaseImportStagingFactory().open();
    const temporaryRoot = join(projectRoot, ".cortex-eval", "tmp");
    const workspaceName = (await readdir(temporaryRoot)).find((name) =>
      name.startsWith("case-import-")
    );
    if (workspaceName === undefined) throw new Error("STAGING_WORKSPACE_MISSING");
    const workspace = join(temporaryRoot, workspaceName);
    const databasePath = join(workspace, "cases.sqlite3");

    await session.withStagedTransaction(async (): Promise<undefined> => {
      expect((await stat(databasePath)).mode & 0o777).toBe(0o400);
      const probe = new Database(databasePath);
      expect(() => probe.exec("INSERT INTO staged_case (id) VALUES ('x')")).toThrow(
        expect.objectContaining({ code: "SQLITE_READONLY" })
      );
      probe.close();
      return undefined;
    });
    expect((await readdir(workspace)).sort()).toEqual(["cases.sqlite3", "owner.json"]);
    await session.cleanup();
  });

  it("两个并发导入相同旧 Revision 只有一个提交，失败路径仍 DETACH/清理", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-case-stage-"));
    roots.push(projectRoot);
    const storage = await initializeSqliteStorage({ projectRoot });
    storages.push(storage);
    seedSuite(storage.databasePath);
    let nextId = 1;
    const importer = (): StreamingCaseImportService =>
      new StreamingCaseImportService({
        transactionManager: storage.createTransactionManager(),
        stagingFactory: storage.createCaseImportStagingFactory(),
        clock: { now: (): string => "2026-01-02T00:00:00.000Z" },
        idGenerator: {
          nextId: (): string =>
            `018f0c8e-9f79-7000-8000-${(nextId++).toString(16).padStart(12, "0")}`
        }
      });
    const results = await Promise.all(
      ["case-a", "case-b"].map(async (caseKey) =>
        importer().importCases({
          suiteId: "suite-1",
          expectedSuiteRevision: 0,
          definitions: asyncDefinitions(definition(caseKey)),
          signal: new AbortController().signal
        })
      )
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toMatchObject([
      { error: { code: "RESOURCE_REVISION_CONFLICT" } }
    ]);
    const verification = new Database(storage.databasePath, { readonly: true });
    expect(
      verification
        .prepare("PRAGMA database_list")
        .all()
        .map((row) => (row as { name: string }).name)
    ).toEqual(["main"]);
    verification.close();
    expect(
      (await readdir(join(projectRoot, ".cortex-eval", "tmp"))).filter((name) =>
        name.startsWith("case-import-")
      )
    ).toEqual([]);
  });
});
