import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hashFinalCaseResult } from "@cortex-eval/domain/src/domain-hash-inputs.ts";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { initializeSqliteStorage } from "../src/sqlite-database.ts";
import { SqlitePlatformRunRepository } from "../src/sqlite-platform-run-repository.ts";
import {
  sqliteEvalArtifactManifest as evalArtifactManifest,
  sqliteRestArtifactManifest as restArtifactManifest,
  sqliteEvalResultSetHash
} from "../test-support/sqlite-platform-run-fixtures.ts";
import {
  DEFINITION_HASH,
  FIRST_TIME,
  HASH,
  openStorages,
  passingEvalResult,
  platformRun,
  RUN_A,
  RUN_B,
  RUN_C,
  RUN_READY,
  RUN_RUNNING,
  SECOND_TIME,
  seedCurrentResources,
  successResult,
  SUITE_ID
} from "../test-support/sqlite-platform-run-repository-setup.ts";

afterEach(async () => {
  await Promise.all(openStorages.splice(0).map(async (storage) => storage.close()));
});

describe("SQLite Platform Run Repository", () => {
  it("Evaluation 重试使用 CAS，保留证据并遵守全局运行锁", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-eval-retry-"));
    const storage = await initializeSqliteStorage({ projectRoot });
    openStorages.push(storage);
    seedCurrentResources(storage.databasePath);
    const manager = storage.createRunTransactionManager();
    await manager.execute(async ({ runs }) => {
      await runs.insertPlatformRun(platformRun(RUN_A));
      await runs.insertPlatformRun(platformRun(RUN_B));
      await runs.claimStage(RUN_A, 0, SECOND_TIME);
      const rest = await runs.recordRestResult(successResult(RUN_A), SECOND_TIME);
      const ready = await runs.completeRestStage({
        runId: RUN_A,
        expectedRevision: rest!.lockRevision,
        expectedTotal: 1,
        resultSetHash: HASH,
        artifactManifest: restArtifactManifest(RUN_A),
        updatedAt: SECOND_TIME
      });
      const claimed = await runs.claimStage(RUN_A, ready!.lockRevision, SECOND_TIME);
      if (!claimed.ok) throw new Error("TEST_CLAIM");
      await runs.failRun({
        runId: RUN_A,
        expectedRevision: claimed.run.lockRevision,
        errorCode: "EVALUATION_STAGE_FAILED",
        errorMessage: "test failure",
        completedAt: SECOND_TIME
      });
    });
    const before = await manager.execute(({ runs }) => runs.getPlatformRun(RUN_A));
    const revision = before!.lockRevision;
    expect(
      await manager.execute(({ runs }) =>
        runs.claimStage(RUN_A, revision - 1, SECOND_TIME, "RETRY_EVALUATION")
      )
    ).toEqual({ ok: false, reason: "STATE_OR_REVISION" });
    expect(
      await manager.execute(({ runs }) => runs.claimStage(RUN_A, revision, SECOND_TIME))
    ).toEqual({ ok: false, reason: "STATE_OR_REVISION" });
    const competing = await manager.execute(({ runs }) => runs.claimStage(RUN_B, 0, SECOND_TIME));
    expect(competing.ok).toBe(true);
    expect(
      await manager.execute(({ runs }) =>
        runs.claimStage(RUN_A, revision, SECOND_TIME, "RETRY_EVALUATION")
      )
    ).toEqual({ ok: false, reason: "GLOBAL_RUNNING" });
    await manager.execute(({ runs }) =>
      runs.failRun({
        runId: RUN_B,
        expectedRevision: 1,
        errorCode: "REST_STAGE_FAILED",
        errorMessage: "test",
        completedAt: SECOND_TIME
      })
    );
    const retry = await manager.execute(({ runs }) =>
      runs.claimStage(RUN_A, revision, SECOND_TIME, "RETRY_EVALUATION")
    );
    expect(retry).toMatchObject({
      ok: true,
      run: {
        id: RUN_A,
        status: "RUNNING",
        stage: "EVALUATION",
        errorCode: null,
        errorMessage: null,
        completedAt: null,
        lockRevision: revision + 1,
        suite: before!.suite,
        artifactManifest: before!.artifactManifest,
        resultSetHash: HASH
      }
    });
    expect(await manager.execute(({ runs }) => runs.getRestResult(RUN_A, "case-1"))).not.toBeNull();
    expect(
      await manager.execute(({ runs }) =>
        runs.claimStage(RUN_A, revision, SECOND_TIME, "RETRY_EVALUATION")
      )
    ).toEqual({ ok: false, reason: "STATE_OR_REVISION" });
  });

  it("详情与进度使用不含 Case 数组和 Prompt 正文的小型投影", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-platform-run-"));
    const storage = await initializeSqliteStorage({ projectRoot });
    openStorages.push(storage);
    seedCurrentResources(storage.databasePath);
    const manager = storage.createRunTransactionManager();
    await manager.execute(async (transaction) => {
      await transaction.runs.insertPlatformRun(platformRun(RUN_READY));
    });

    const projections = await manager.execute(async (transaction) => ({
      detail: await transaction.runs.getPlatformRunDetail(RUN_READY),
      progress: await transaction.runs.getPlatformRunProgress(RUN_READY)
    }));

    expect(projections.detail).toMatchObject({
      id: RUN_READY,
      suite: { id: SUITE_ID, caseCount: 1 },
      rubricPrompts: []
    });
    expect(projections.progress).toMatchObject({
      id: RUN_READY,
      restTotalCount: 1,
      restCompletedCount: 0
    });
    expect(JSON.stringify(projections)).not.toContain('"cases"');
  });

  it("逐 Case 结果写入不调用完整冻结快照读取", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-platform-run-"));
    const storage = await initializeSqliteStorage({ projectRoot });
    openStorages.push(storage);
    seedCurrentResources(storage.databasePath);
    const manager = storage.createRunTransactionManager();
    await manager.execute(async (transaction) => {
      await transaction.runs.insertPlatformRun(platformRun(RUN_READY));
      const claimed = await transaction.runs.claimStage(RUN_READY, 0, SECOND_TIME);
      if (!claimed.ok) throw new Error("TEST_CLAIM_FAILED");
    });
    const fullRead = vi
      .spyOn(SqlitePlatformRunRepository.prototype, "getPlatformRun")
      .mockRejectedValue(new Error("FULL_SNAPSHOT_READ_FORBIDDEN"));
    try {
      const progress = await manager.execute(async (transaction) =>
        transaction.runs.recordRestResult(successResult(RUN_READY), SECOND_TIME)
      );
      expect(progress).toMatchObject({ restCompletedCount: 1, restTotalCount: 1 });
      expect(fullRead).not.toHaveBeenCalled();
    } finally {
      fullRead.mockRestore();
    }
  });

  it("以 CAS 收敛唯一运行、跨进程取消和已派发结果", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-platform-run-"));
    const first = await initializeSqliteStorage({ projectRoot });
    const second = await initializeSqliteStorage({ projectRoot });
    openStorages.push(first, second);
    seedCurrentResources(first.databasePath);
    const firstManager = first.createRunTransactionManager();
    const secondManager = second.createRunTransactionManager();
    await firstManager.execute(async (transaction) => {
      await transaction.runs.insertPlatformRun(platformRun(RUN_A));
      await transaction.runs.insertPlatformRun(platformRun(RUN_B));
    });

    const claimed = await firstManager.execute(async (transaction) =>
      transaction.runs.claimStage(RUN_A, 0, SECOND_TIME)
    );
    expect(claimed).toMatchObject({ ok: true, run: { status: "RUNNING", lockRevision: 1 } });
    const globallyBlocked = await secondManager.execute(async (transaction) =>
      transaction.runs.claimStage(RUN_B, 0, SECOND_TIME)
    );
    expect(globallyBlocked).toEqual({ ok: false, reason: "GLOBAL_RUNNING" });

    const cancelled = await secondManager.execute(async (transaction) =>
      transaction.runs.requestCancel(RUN_A, 1, SECOND_TIME)
    );
    expect(cancelled).toMatchObject({ ok: true, run: { cancelRequestedAt: SECOND_TIME } });
    const recorded = await firstManager.execute(async (transaction) =>
      transaction.runs.recordRestResult(successResult(RUN_A), SECOND_TIME)
    );
    expect(recorded).toMatchObject({ status: "RUNNING", restCompletedCount: 1 });
    const completionBlocked = await firstManager.execute(async (transaction) =>
      transaction.runs.completeRestStage({
        runId: RUN_A,
        expectedRevision: recorded?.lockRevision ?? -1,
        expectedTotal: 1,
        resultSetHash: HASH,
        artifactManifest: restArtifactManifest(RUN_A),
        updatedAt: SECOND_TIME
      })
    );
    expect(completionBlocked).toBeNull();
    const committed = await firstManager.execute(async (transaction) =>
      transaction.runs.commitCancellation(RUN_A, recorded?.lockRevision ?? -1, SECOND_TIME)
    );
    expect(committed).toMatchObject({ status: "CANCELLED", stage: "DONE" });
  });

  it("完整 REST 集合推进到 EVALUATION，并按 Ordinal 查询真实结果", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-platform-run-"));
    const storage = await initializeSqliteStorage({ projectRoot });
    openStorages.push(storage);
    seedCurrentResources(storage.databasePath);
    const manager = storage.createRunTransactionManager();
    await manager.execute(async (transaction) =>
      transaction.runs.insertPlatformRun(platformRun(RUN_C))
    );
    const claimed = await manager.execute(async (transaction) =>
      transaction.runs.claimStage(RUN_C, 0, SECOND_TIME)
    );
    if (!claimed.ok) throw new Error("TEST_CLAIM_FAILED");
    const progress = await manager.execute(async (transaction) =>
      transaction.runs.recordRestResult(successResult(RUN_C), SECOND_TIME)
    );
    const completed = await manager.execute(async (transaction) =>
      transaction.runs.completeRestStage({
        runId: RUN_C,
        expectedRevision: progress?.lockRevision ?? -1,
        expectedTotal: 1,
        resultSetHash: HASH,
        artifactManifest: restArtifactManifest(RUN_C),
        updatedAt: SECOND_TIME
      })
    );
    expect(completed).toMatchObject({ status: "READY", stage: "EVALUATION" });
    const page = await manager.execute(async (transaction) =>
      transaction.runs.queryRestResults({ runId: RUN_C, limit: 20 })
    );
    expect(page.items).toMatchObject([{ caseKey: "case-1", ordinal: 0, status: "SUCCEEDED" }]);
    expect(page.nextCursor).toBeNull();
  });

  it("持久化并还原重用 REST 结果的精确来源", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-platform-rerun-"));
    const storage = await initializeSqliteStorage({ projectRoot });
    openStorages.push(storage);
    seedCurrentResources(storage.databasePath);
    const manager = storage.createRunTransactionManager();
    const sourceResult = successResult(RUN_A);
    await manager.execute(async (transaction) => {
      await transaction.runs.insertPlatformRun(platformRun(RUN_A));
      const sourceClaim = await transaction.runs.claimStage(RUN_A, 0, SECOND_TIME);
      if (!sourceClaim.ok) throw new Error("TEST_SOURCE_CLAIM_FAILED");
      const sourceProgress = await transaction.runs.recordRestResult(sourceResult, SECOND_TIME);
      await transaction.runs.completeRestStage({
        runId: RUN_A,
        expectedRevision: sourceProgress?.lockRevision ?? -1,
        expectedTotal: 1,
        resultSetHash: HASH,
        artifactManifest: platformRun(RUN_A).artifactManifest,
        updatedAt: SECOND_TIME
      });
      await transaction.runs.insertPlatformRerun(
        { ...platformRun(RUN_B, RUN_A, "RETRY_FAILED"), restCompletedCount: 1 },
        [
          successResult(RUN_B, {
            sourceKind: "RUN",
            sourceId: RUN_A,
            sourceResultHash: sourceResult.resultHash
          })
        ]
      );
    });

    const stored = await manager.execute(async (transaction) =>
      transaction.runs.getRestResult(RUN_B, "case-1")
    );

    expect(stored?.provenance).toEqual({
      sourceKind: "RUN",
      sourceId: RUN_A,
      sourceResultHash: sourceResult.resultHash
    });
  });

  it("拒绝与目标重跑来源或来源结果 Hash 不一致的 REST 复用事实", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-platform-rerun-invalid-"));
    const storage = await initializeSqliteStorage({ projectRoot });
    openStorages.push(storage);
    seedCurrentResources(storage.databasePath);
    const manager = storage.createRunTransactionManager();
    const sourceResult = successResult(RUN_A);
    await manager.execute(async (transaction) => {
      await transaction.runs.insertPlatformRun(platformRun(RUN_A));
      await transaction.runs.insertPlatformRun(platformRun(RUN_C));
      await transaction.runs.insertPlatformRun(platformRun(RUN_B, RUN_A, "RETRY_FAILED"));
      const sourceClaim = await transaction.runs.claimStage(RUN_A, 0, SECOND_TIME);
      if (!sourceClaim.ok) throw new Error("TEST_SOURCE_CLAIM_FAILED");
      const sourceProgress = await transaction.runs.recordRestResult(sourceResult, SECOND_TIME);
      await transaction.runs.completeRestStage({
        runId: RUN_A,
        expectedRevision: sourceProgress?.lockRevision ?? -1,
        expectedTotal: 1,
        resultSetHash: HASH,
        artifactManifest: platformRun(RUN_A).artifactManifest,
        updatedAt: SECOND_TIME
      });
      const targetClaim = await transaction.runs.claimStage(RUN_B, 0, SECOND_TIME);
      if (!targetClaim.ok) throw new Error("TEST_TARGET_CLAIM_FAILED");

      await expect(
        transaction.runs.recordRestResult(
          successResult(RUN_B, {
            sourceKind: "RUN",
            sourceId: RUN_C,
            sourceResultHash: sourceResult.resultHash
          }),
          SECOND_TIME
        )
      ).rejects.toThrow();
      await expect(
        transaction.runs.recordRestResult(
          successResult(RUN_B, {
            sourceKind: "RUN",
            sourceId: RUN_A,
            sourceResultHash: HASH
          }),
          SECOND_TIME
        )
      ).rejects.toThrow();
    });
  });

  it("完整 Eval 与 Report 分别在短事务中对账并保留三类独立版本", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-platform-eval-"));
    const storage = await initializeSqliteStorage({ projectRoot });
    openStorages.push(storage);
    seedCurrentResources(storage.databasePath);
    const runManager = storage.createRunTransactionManager();
    await runManager.execute(async (transaction) => {
      await transaction.runs.insertPlatformRun(platformRun(RUN_C));
      const restClaim = await transaction.runs.claimStage(RUN_C, 0, SECOND_TIME);
      if (!restClaim.ok) throw new Error("TEST_REST_CLAIM_FAILED");
      const restProgress = await transaction.runs.recordRestResult(
        successResult(RUN_C),
        SECOND_TIME
      );
      await transaction.runs.completeRestStage({
        runId: RUN_C,
        expectedRevision: restProgress?.lockRevision ?? -1,
        expectedTotal: 1,
        resultSetHash: HASH,
        artifactManifest: restArtifactManifest(RUN_C),
        updatedAt: SECOND_TIME
      });
    });
    const evalClaim = await runManager.execute(async (transaction) =>
      transaction.runs.claimStage(RUN_C, 3, SECOND_TIME)
    );
    if (!evalClaim.ok) throw new Error("TEST_EVAL_CLAIM_FAILED");
    const evaluation = passingEvalResult(RUN_C);
    const evalResultSetHash = sqliteEvalResultSetHash(RUN_C, HASH, [evaluation]);
    const evalManager = storage.createEvalTransactionManager();
    const evalManifest = evalArtifactManifest(RUN_C);
    const committed = await evalManager.execute(async (transaction) =>
      transaction.evaluations.completeStage({
        runId: RUN_C,
        expectedRevision: evalClaim.run.lockRevision,
        expectedTotal: 1,
        resultSetHash: evalResultSetHash,
        evaluationContextHash: HASH,
        results: [evaluation],
        artifactManifest: {
          ...evalManifest,
          artifacts: [...evalManifest.artifacts].reverse()
        },
        updatedAt: SECOND_TIME
      })
    );
    expect(committed).toMatchObject({
      ok: true,
      progress: {
        status: "READY",
        stage: "REPORT",
        evalCompletedCount: 1,
        evalPassCount: 1,
        evalFailCount: 0,
        evalErrorCount: 0,
        evalNotEvaluatedCount: 0,
        evaluationContextHash: HASH,
        evaluationResultSetHash: evalResultSetHash
      }
    });
    const stored = await evalManager.execute(async (transaction) =>
      transaction.evaluations.queryResults({ runId: RUN_C, limit: 20 })
    );
    expect(stored).toMatchObject({
      items: [
        {
          caseKey: "case-1",
          status: "PASS",
          evalResultHash: evaluation.evalResultHash,
          finalCaseResultHash: evaluation.finalCaseResultHash
        }
      ],
      nextCursor: null
    });
    const progress = await runManager.execute(async (transaction) =>
      transaction.runs.getPlatformRunProgress(RUN_C)
    );
    expect(progress).toMatchObject({
      evalCompletedCount: 1,
      evalPassCount: 1,
      evalFailCount: 0,
      evalErrorCount: 0,
      evalNotEvaluatedCount: 0,
      resultSetHash: HASH,
      evaluationContextHash: HASH,
      evaluationResultSetHash: evalResultSetHash,
      reportResultSetHash: null
    });
    expect(progress?.artifactManifest.artifacts.map((item) => item.kind)).toEqual([
      "REST_RESULTS",
      "RAW_PROMPTFOO_EVIDENCE",
      "NORMALIZED_EVAL_RESULTS"
    ]);
    const reportClaim = await runManager.execute(async (transaction) =>
      transaction.runs.claimStage(RUN_C, progress?.lockRevision ?? -1, SECOND_TIME)
    );
    if (!reportClaim.ok) throw new Error("TEST_REPORT_CLAIM_FAILED");
    const aggregation = {
      summary: {
        total: 1,
        restSucceeded: 1,
        restError: 0,
        evalPass: 1,
        evalFail: 0,
        evalError: 0,
        notEvaluated: 0,
        effectivePassRate: 1,
        evaluatedPassRate: 1,
        coverageRate: 1
      },
      byMetric: [
        {
          metric: "quality",
          pass: 1,
          fail: 0,
          error: 0,
          skipped: 0,
          notEvaluated: 0,
          passRate: 1
        }
      ],
      reportResultSetHash: "d".repeat(64)
    };
    const reportCommitted = await runManager.execute(async (transaction) =>
      transaction.runs.completeReportStage({
        runId: RUN_C,
        expectedRevision: reportClaim.run.lockRevision,
        aggregation,
        artifactManifest: {
          contractVersion: "cortex.artifact-manifest.v1",
          owner: { kind: "RUN", id: RUN_C },
          artifacts: [
            {
              kind: "REPORT_JSON",
              path: `runs/${RUN_C}/report.json`,
              expectedSha256: "e".repeat(64),
              expectedSizeBytes: 100,
              contractVersion: "cortex.report.v1"
            },
            {
              kind: "REPORT_MARKDOWN",
              path: `runs/${RUN_C}/report.md`,
              expectedSha256: "f".repeat(64),
              expectedSizeBytes: 80,
              contractVersion: "cortex.report-markdown.v1"
            }
          ]
        },
        completedAt: SECOND_TIME
      })
    );
    expect(reportCommitted).toMatchObject({
      status: "COMPLETED",
      stage: "DONE",
      resultSetHash: HASH,
      evaluationContextHash: HASH,
      evaluationResultSetHash: evalResultSetHash,
      reportResultSetHash: aggregation.reportResultSetHash
    });
    const completedRun = await runManager.execute(async (transaction) =>
      transaction.runs.getPlatformRun(RUN_C)
    );
    expect(completedRun).toMatchObject({
      reportSummary: {
        summary: { total: 1, evalPass: 1, coverageRate: 1 },
        byMetric: [{ metric: "quality", pass: 1 }]
      },
      artifactManifest: {
        artifacts: [
          { kind: "REST_RESULTS" },
          { kind: "RAW_PROMPTFOO_EVIDENCE" },
          { kind: "NORMALIZED_EVAL_RESULTS" },
          { kind: "REPORT_JSON" },
          { kind: "REPORT_MARKDOWN" }
        ]
      }
    });
  });

  it("只接受与来源 Eval 和复用 REST 精确对齐的 Eval Provenance", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-platform-eval-provenance-"));
    const storage = await initializeSqliteStorage({ projectRoot });
    openStorages.push(storage);
    seedCurrentResources(storage.databasePath);
    const runManager = storage.createRunTransactionManager();
    const evalManager = storage.createEvalTransactionManager();
    const sourceRest = successResult(RUN_A);
    await runManager.execute(async (transaction) => {
      await transaction.runs.insertPlatformRun(platformRun(RUN_A));
      await transaction.runs.insertPlatformRun(platformRun(RUN_B, RUN_A, "RETRY_FAILED"));
      const sourceClaim = await transaction.runs.claimStage(RUN_A, 0, SECOND_TIME);
      if (!sourceClaim.ok) throw new Error("TEST_SOURCE_REST_CLAIM_FAILED");
      const restProgress = await transaction.runs.recordRestResult(sourceRest, SECOND_TIME);
      await transaction.runs.completeRestStage({
        runId: RUN_A,
        expectedRevision: restProgress?.lockRevision ?? -1,
        expectedTotal: 1,
        resultSetHash: HASH,
        artifactManifest: restArtifactManifest(RUN_A),
        updatedAt: SECOND_TIME
      });
    });
    const sourceEvalClaim = await runManager.execute(async (transaction) =>
      transaction.runs.claimStage(RUN_A, 3, SECOND_TIME)
    );
    if (!sourceEvalClaim.ok) throw new Error("TEST_SOURCE_EVAL_CLAIM_FAILED");
    const sourceEvaluation = passingEvalResult(RUN_A);
    const sourceResultSetHash = sqliteEvalResultSetHash(RUN_A, HASH, [sourceEvaluation]);
    await evalManager.execute(async (transaction) =>
      transaction.evaluations.completeStage({
        runId: RUN_A,
        expectedRevision: sourceEvalClaim.run.lockRevision,
        expectedTotal: 1,
        resultSetHash: sourceResultSetHash,
        evaluationContextHash: HASH,
        results: [sourceEvaluation],
        artifactManifest: evalArtifactManifest(RUN_A),
        updatedAt: SECOND_TIME
      })
    );
    const evalClaim = await runManager.execute(async (transaction) => {
      const restClaim = await transaction.runs.claimStage(RUN_B, 0, SECOND_TIME);
      if (!restClaim.ok) throw new Error("TEST_TARGET_REST_CLAIM_FAILED");
      const restProgress = await transaction.runs.recordRestResult(
        successResult(RUN_B, {
          sourceKind: "RUN",
          sourceId: RUN_A,
          sourceResultHash: sourceRest.resultHash
        }),
        SECOND_TIME
      );
      await transaction.runs.completeRestStage({
        runId: RUN_B,
        expectedRevision: restProgress?.lockRevision ?? -1,
        expectedTotal: 1,
        resultSetHash: HASH,
        artifactManifest: restArtifactManifest(RUN_B),
        updatedAt: SECOND_TIME
      });
      return transaction.runs.claimStage(RUN_B, 3, SECOND_TIME);
    });
    if (!evalClaim.ok) throw new Error("TEST_TARGET_EVAL_CLAIM_FAILED");
    const evaluation = {
      ...passingEvalResult(RUN_B),
      rawEvidence: sourceEvaluation.rawEvidence,
      provenance: {
        sourceKind: "RUN" as const,
        sourceId: RUN_A,
        sourceResultHash: sourceEvaluation.evalResultHash
      }
    };
    const resultSetHash = sqliteEvalResultSetHash(RUN_B, HASH, [evaluation]);
    const rejected = await evalManager.execute(async (transaction) =>
      transaction.evaluations.completeStage({
        runId: RUN_B,
        expectedRevision: evalClaim.run.lockRevision,
        expectedTotal: 1,
        resultSetHash,
        evaluationContextHash: HASH,
        results: [
          {
            ...evaluation,
            provenance: { ...evaluation.provenance, sourceResultHash: HASH }
          }
        ],
        artifactManifest: evalArtifactManifest(RUN_B),
        updatedAt: SECOND_TIME
      })
    );
    expect(rejected).toEqual({ ok: false, reason: "RESULT_ALIGNMENT" });
    const committed = await evalManager.execute(async (transaction) =>
      transaction.evaluations.completeStage({
        runId: RUN_B,
        expectedRevision: evalClaim.run.lockRevision,
        expectedTotal: 1,
        resultSetHash,
        evaluationContextHash: HASH,
        results: [evaluation],
        artifactManifest: evalArtifactManifest(RUN_B),
        updatedAt: SECOND_TIME
      })
    );
    expect(committed).toMatchObject({ ok: true, progress: { stage: "REPORT" } });
    const stored = await evalManager.execute(async (transaction) =>
      transaction.evaluations.queryResults({ runId: RUN_B, limit: 20 })
    );
    expect(stored.items[0]?.provenance).toEqual(evaluation.provenance);
  });

  it("Eval 集合身份或 Final Hash 不一致时整批回滚且不推进 Run", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-platform-eval-rollback-"));
    const storage = await initializeSqliteStorage({ projectRoot });
    openStorages.push(storage);
    seedCurrentResources(storage.databasePath);
    const runManager = storage.createRunTransactionManager();
    await runManager.execute(async (transaction) => {
      await transaction.runs.insertPlatformRun(platformRun(RUN_C));
      const restClaim = await transaction.runs.claimStage(RUN_C, 0, SECOND_TIME);
      if (!restClaim.ok) throw new Error("TEST_REST_CLAIM_FAILED");
      const restProgress = await transaction.runs.recordRestResult(
        successResult(RUN_C),
        SECOND_TIME
      );
      await transaction.runs.completeRestStage({
        runId: RUN_C,
        expectedRevision: restProgress?.lockRevision ?? -1,
        expectedTotal: 1,
        resultSetHash: HASH,
        artifactManifest: restArtifactManifest(RUN_C),
        updatedAt: SECOND_TIME
      });
    });
    const evalClaim = await runManager.execute(async (transaction) =>
      transaction.runs.claimStage(RUN_C, 3, SECOND_TIME)
    );
    if (!evalClaim.ok) throw new Error("TEST_EVAL_CLAIM_FAILED");
    const valid = passingEvalResult(RUN_C);
    const resultSetHash = sqliteEvalResultSetHash(RUN_C, HASH, [valid]);
    const evalManager = storage.createEvalTransactionManager();
    const rejected = await evalManager.execute(async (transaction) =>
      transaction.evaluations.completeStage({
        runId: RUN_C,
        expectedRevision: evalClaim.run.lockRevision,
        expectedTotal: 1,
        resultSetHash,
        evaluationContextHash: HASH,
        results: [{ ...valid, finalCaseResultHash: "c".repeat(64) }],
        artifactManifest: {
          contractVersion: "cortex.artifact-manifest.v1",
          owner: { kind: "RUN", id: RUN_C },
          artifacts: []
        },
        updatedAt: SECOND_TIME
      })
    );
    expect(rejected).toEqual({ ok: false, reason: "RESULT_ALIGNMENT" });
    const forgedEvalResultHash = "d".repeat(64);
    const forged = {
      ...valid,
      evalResultHash: forgedEvalResultHash,
      finalCaseResultHash: hashFinalCaseResult({
        contractVersion: "cortex.final-case-result.v1",
        caseDefinitionHash: DEFINITION_HASH,
        restResultHash: successResult(RUN_C).resultHash,
        evalResultHash: forgedEvalResultHash
      })
    };
    const forgedResultSetHash = sqliteEvalResultSetHash(RUN_C, HASH, [forged]);
    const semanticHashRejected = await evalManager.execute(async (transaction) =>
      transaction.evaluations.completeStage({
        runId: RUN_C,
        expectedRevision: evalClaim.run.lockRevision,
        expectedTotal: 1,
        resultSetHash: forgedResultSetHash,
        evaluationContextHash: HASH,
        results: [forged],
        artifactManifest: {
          contractVersion: "cortex.artifact-manifest.v1",
          owner: { kind: "RUN", id: RUN_C },
          artifacts: []
        },
        updatedAt: SECOND_TIME
      })
    );
    expect(semanticHashRejected).toEqual({ ok: false, reason: "RESULT_ALIGNMENT" });
    const missingArtifactsRejected = await evalManager.execute(async (transaction) =>
      transaction.evaluations.completeStage({
        runId: RUN_C,
        expectedRevision: evalClaim.run.lockRevision,
        expectedTotal: 1,
        resultSetHash,
        evaluationContextHash: HASH,
        results: [valid],
        artifactManifest: {
          contractVersion: "cortex.artifact-manifest.v1",
          owner: { kind: "RUN", id: RUN_C },
          artifacts: []
        },
        updatedAt: SECOND_TIME
      })
    );
    expect(missingArtifactsRejected).toEqual({ ok: false, reason: "RESULT_ALIGNMENT" });
    const wrongEvidenceManifest = evalArtifactManifest(RUN_C);
    const evidenceRejected = await evalManager.execute(async (transaction) =>
      transaction.evaluations.completeStage({
        runId: RUN_C,
        expectedRevision: evalClaim.run.lockRevision,
        expectedTotal: 1,
        resultSetHash,
        evaluationContextHash: HASH,
        results: [valid],
        artifactManifest: {
          ...wrongEvidenceManifest,
          artifacts: wrongEvidenceManifest.artifacts.map((item) =>
            item.kind === "RAW_PROMPTFOO_EVIDENCE"
              ? { ...item, expectedSha256: "c".repeat(64) }
              : item
          )
        },
        updatedAt: SECOND_TIME
      })
    );
    expect(evidenceRejected).toEqual({ ok: false, reason: "RESULT_ALIGNMENT" });
    const stored = await evalManager.execute(async (transaction) =>
      transaction.evaluations.queryResults({ runId: RUN_C, limit: 20 })
    );
    expect(stored).toEqual({ items: [], nextCursor: null });
    const progress = await runManager.execute(async (transaction) =>
      transaction.runs.getPlatformRunProgress(RUN_C)
    );
    expect(progress).toMatchObject({
      status: "RUNNING",
      stage: "EVALUATION",
      lockRevision: evalClaim.run.lockRevision
    });
  });

  it("启动恢复只把遗留 RUNNING 收敛为 INTERRUPTED", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-platform-run-"));
    const storage = await initializeSqliteStorage({ projectRoot });
    openStorages.push(storage);
    seedCurrentResources(storage.databasePath);
    const manager = storage.createRunTransactionManager();
    await manager.execute(async (transaction) => {
      await transaction.runs.insertPlatformRun(platformRun(RUN_RUNNING));
      await transaction.runs.insertPlatformRun(platformRun(RUN_READY));
      await transaction.runs.claimStage(RUN_RUNNING, 0, SECOND_TIME);
    });
    const recovered = await manager.execute(async (transaction) =>
      transaction.runs.recoverRunning(SECOND_TIME)
    );
    expect(recovered).toMatchObject([{ id: RUN_RUNNING, status: "INTERRUPTED", stage: "DONE" }]);
    const ready = await manager.execute(async (transaction) =>
      transaction.runs.getPlatformRun(RUN_READY)
    );
    expect(ready).toMatchObject({ status: "READY", stage: "REST" });
  });

  it("以创建时间和 ID 倒序分页小投影，并读取单个真实结果与 Manifest", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-platform-run-"));
    const storage = await initializeSqliteStorage({ projectRoot });
    openStorages.push(storage);
    seedCurrentResources(storage.databasePath);
    const manager = storage.createRunTransactionManager();
    await manager.execute(async (transaction) => {
      await transaction.runs.insertPlatformRun(platformRun(RUN_A));
      await transaction.runs.insertPlatformRun(platformRun(RUN_B));
      await transaction.runs.insertPlatformRun(platformRun(RUN_C));
      await transaction.runs.claimStage(RUN_B, 0, SECOND_TIME);
      await transaction.runs.recordRestResult(successResult(RUN_B), SECOND_TIME);
    });
    const allRuns = await manager.execute(async (transaction) =>
      transaction.runs.queryPlatformRuns({ limit: 20 })
    );
    expect(allRuns.items).toMatchObject([
      { id: RUN_C, status: "READY", stage: "REST" },
      { id: RUN_B, status: "RUNNING", stage: "REST", restCompletedCount: 1 },
      { id: RUN_A, status: "READY", stage: "REST" }
    ]);
    const database = new Database(storage.databasePath);
    database
      .prepare(
        `UPDATE run_log
         SET status = 'COMPLETED', stage = 'DONE', report_result_set_hash = ?,
             summary_json = '{}', completed_at = ?, updated_at = ?
         WHERE id IN (?, ?)`
      )
      .run("d".repeat(64), SECOND_TIME, SECOND_TIME, RUN_A, RUN_C);
    database.close();
    const firstPage = await manager.execute(async (transaction) =>
      transaction.runs.queryPlatformRuns({ limit: 1 })
    );
    expect(firstPage.items).toMatchObject([{ id: RUN_C, suiteId: SUITE_ID, restTotalCount: 1 }]);
    expect(firstPage.nextCursor).toEqual({ createdAt: FIRST_TIME, id: RUN_C });
    const secondPage = await manager.execute(async (transaction) =>
      transaction.runs.queryPlatformRuns({
        limit: 1,
        afterCursor: firstPage.nextCursor ?? undefined
      })
    );
    expect(secondPage.items).toMatchObject([{ id: RUN_B }]);
    const thirdPage = await manager.execute(async (transaction) =>
      transaction.runs.queryPlatformRuns({
        limit: 1,
        afterCursor: secondPage.nextCursor ?? undefined
      })
    );
    expect(thirdPage.items).toMatchObject([{ id: RUN_A }]);
    expect(thirdPage.nextCursor).toBeNull();
    const result = await manager.execute(async (transaction) =>
      transaction.runs.getRestResult(RUN_B, "case-1")
    );
    expect(result).toMatchObject({ status: "SUCCEEDED", caseKey: "case-1" });
    const manifests = await manager.execute(async (transaction) =>
      transaction.runs.listPlatformRunManifests()
    );
    expect(manifests).toHaveLength(3);
  });
});
