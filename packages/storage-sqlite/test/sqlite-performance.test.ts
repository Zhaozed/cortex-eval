import { performance } from "node:perf_hooks";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CaseDefinitionWriter } from "@cortex-eval/application/src/features/test-suites/case-definition-writer.ts";
import type { CaseDefinition } from "@cortex-eval/domain/src/domain-evaluation.ts";
import { hashSuite } from "@cortex-eval/domain/src/domain-resource-hashes.ts";
import { runBenchmark } from "../../../tooling/src/benchmark-harness.ts";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { initializeSqliteStorage } from "../src/sqlite-database.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function definition(index: number): CaseDefinition {
  return {
    caseKey: `case-${index.toString().padStart(4, "0")}`,
    description: `Case ${index}`,
    threshold: 1,
    task: "route",
    requestBody: { index },
    metadata: {
      requestId: `req-${index}`,
      taskId: `task-${index}`,
      businessModule: index % 2 === 0 ? "chat" : "search",
      scenarioTag: index % 3 === 0 ? "smoke" : "regression"
    },
    assertions: [
      {
        type: index % 2 === 0 ? "contains" : "contains-json",
        metric: index % 5 === 0 ? "quality" : "schema",
        weight: 1
      }
    ]
  };
}

describe("SQLite 千级 Case 性能门禁", () => {
  it("全量导入、Hash 和组合查询满足固定阈值", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-performance-"));
    const storage = await initializeSqliteStorage({ projectRoot });
    const database = new Database(storage.databasePath);
    database
      .prepare("INSERT INTO test_suite VALUES (?, ?, ?, 0, ?, 0, ?, ?)")
      .run(
        "suite-1",
        "Performance",
        "1000 cases",
        hashSuite({ contractVersion: "cortex.suite.v1", cases: [] }),
        NOW,
        NOW
      );
    database.close();
    let id = 0;
    const writer = new CaseDefinitionWriter({
      transactionManager: storage.createTransactionManager(),
      idGenerator: {
        nextId: (): string => {
          id += 1;
          return `internal-${id}`;
        }
      },
      clock: { now: (): string => NOW }
    });
    const startedAt = performance.now();
    const imported = await writer.replaceAllCases({
      suiteId: "suite-1",
      expectedSuiteRevision: 0,
      definitions: Array.from({ length: 1_000 }, (_, index) => definition(index))
    });
    const importMs = performance.now() - startedAt;
    expect(imported.ok).toBe(true);
    expect(importMs).toBeLessThanOrEqual(10_000);

    const benchmark = await runBenchmark(
      async () => {
        const page = await storage.createTransactionManager().execute(async (transaction) =>
          transaction.testSuites.queryCases({
            suiteId: "suite-1",
            businessModule: "chat",
            scenarioTag: "smoke",
            assertionType: "contains",
            metric: "quality",
            limit: 50
          })
        );
        expect(page.items.every((item) => item.assertionTypes.includes("contains"))).toBe(true);
        expect(page.items.some((item) => item.assertionTypes.includes("contains-json"))).toBe(
          false
        );
      },
      5,
      30
    );
    expect(benchmark.environment).toMatchObject({ platform: "darwin", architecture: "arm64" });
    expect(benchmark.p95Ms).toBeLessThanOrEqual(250);
    expect(benchmark.p99Ms).toBeLessThanOrEqual(500);
    await storage.close();
  }, 30_000);
});
