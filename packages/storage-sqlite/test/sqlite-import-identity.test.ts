import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ImportExecutionIdentity } from "@cortex-eval/application/src/features/execution-imports/import-execution-identity.ts";
import { describe, expect, it } from "vitest";

import { initializeSqliteStorage } from "../src/sqlite-database.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

describe("SQLite Execution 导入身份", () => {
  it("相同 Execution ID 与相同结果 Hash 幂等，不同 Hash 冲突", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-import-identity-"));
    const storage = await initializeSqliteStorage({ projectRoot });
    let id = 0;
    const useCase = new ImportExecutionIdentity({
      transactionManager: storage.createTransactionManager(),
      idGenerator: {
        nextId: (): string => {
          id += 1;
          return `run-${id}`;
        }
      },
      clock: { now: (): string => "2026-01-01T00:00:00.000Z" }
    });
    const command = {
      packageId: "package-1",
      executionId: "execution-1",
      resultSetHash: HASH_A,
      hasErrors: false,
      suiteSnapshot: {},
      endpointSnapshot: {},
      evaluatorSnapshot: {},
      rubricPromptsSnapshot: [],
      runContextHash: HASH_A,
      contractVersions: { run: "v1" },
      runExecutionLimits: { restConcurrency: 4, evalConcurrency: 2 },
      artifactManifest: [
        {
          kind: "REPORT_JSON",
          path: "executions/execution-1/report.json",
          hash: HASH_A,
          size: 10,
          contractVersion: "cortex.report.v1"
        }
      ]
    } as const;

    const inserted = await useCase.execute(command);
    const idempotent = await useCase.execute(command);
    const conflict = await useCase.execute({ ...command, resultSetHash: HASH_B });

    expect(inserted).toEqual({ ok: true, runId: "run-1", idempotent: false });
    expect(idempotent).toEqual({ ok: true, runId: "run-1", idempotent: true });
    expect(conflict).toEqual({
      ok: false,
      error: { code: "EXECUTION_RESULT_CONFLICT", executionId: "execution-1" }
    });
    expect(id).toBe(3);
    await storage.close();
  });

  it("两个独立连接并发导入相同 Execution 时稳定收敛为一次写入和一次幂等", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-import-race-"));
    const firstStorage = await initializeSqliteStorage({ projectRoot });
    const secondStorage = await initializeSqliteStorage({ projectRoot });
    const dependencies = (
      currentStorage: typeof firstStorage,
      runId: string
    ): ConstructorParameters<typeof ImportExecutionIdentity>[0] => ({
      transactionManager: currentStorage.createTransactionManager(),
      idGenerator: { nextId: (): string => runId },
      clock: { now: (): string => "2026-01-01T00:00:00.000Z" }
    });
    const command = {
      packageId: "package-1",
      executionId: "execution-race",
      resultSetHash: HASH_A,
      hasErrors: false,
      suiteSnapshot: {},
      endpointSnapshot: {},
      evaluatorSnapshot: {},
      rubricPromptsSnapshot: [],
      runContextHash: HASH_A,
      contractVersions: {},
      runExecutionLimits: {},
      artifactManifest: []
    } as const;

    const results = await Promise.all([
      new ImportExecutionIdentity(dependencies(firstStorage, "run-a")).execute(command),
      new ImportExecutionIdentity(dependencies(secondStorage, "run-b")).execute(command)
    ]);

    expect(results.filter((result) => result.ok && !result.idempotent)).toHaveLength(1);
    expect(results.filter((result) => result.ok && result.idempotent)).toHaveLength(1);
    expect(new Set(results.flatMap((result) => (result.ok ? [result.runId] : []))).size).toBe(1);
    await Promise.all([firstStorage.close(), secondStorage.close()]);
  });
});
