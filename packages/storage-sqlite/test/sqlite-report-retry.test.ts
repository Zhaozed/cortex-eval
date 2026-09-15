import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { initializeSqliteStorage } from "../src/sqlite-database.ts";
import {
  canRetryReport,
  platformRunProgress
} from "@cortex-eval/application/src/features/runs/platform-run-models.ts";
import {
  platformRun,
  seedCurrentResources,
  successResult,
  passingEvalResult,
  RUN_A,
  RUN_B,
  SECOND_TIME,
  HASH
} from "../test-support/sqlite-platform-run-repository-setup.ts";
import {
  sqliteRestArtifactManifest,
  sqliteEvalArtifactManifest,
  sqliteEvalResultSetHash
} from "../test-support/sqlite-platform-run-fixtures.ts";

it("报告恢复保持 REST/Eval Hash，真实 SQLite CAS 与全局锁阻止重复启动", async () => {
  const storage = await initializeSqliteStorage({
    projectRoot: await mkdtemp(join(tmpdir(), "report-retry-"))
  });
  try {
    seedCurrentResources(storage.databasePath);
    const tx = storage.createRunTransactionManager();
    await tx.execute(async ({ runs }) => {
      await runs.insertPlatformRun(platformRun(RUN_A));
      await runs.insertPlatformRun(platformRun(RUN_B));
      await runs.claimStage(RUN_A, 0, SECOND_TIME);
      const progress = await runs.recordRestResult(successResult(RUN_A), SECOND_TIME);
      if (!progress) throw new Error("TEST_PROGRESS_MISSING");
      await runs.completeRestStage({
        runId: RUN_A,
        expectedRevision: progress.lockRevision,
        expectedTotal: 1,
        resultSetHash: HASH,
        artifactManifest: sqliteRestArtifactManifest(RUN_A),
        updatedAt: SECOND_TIME
      });
    });
    const evalClaim = await tx.execute(({ runs }) => runs.claimStage(RUN_A, 3, SECOND_TIME));
    if (!evalClaim.ok) throw new Error("TEST_CLAIM_FAILED");
    const evaluation = passingEvalResult(RUN_A);
    const evalHash = sqliteEvalResultSetHash(RUN_A, HASH, [evaluation]);
    const evalTx = storage.createEvalTransactionManager();
    const committed = await evalTx.execute(({ evaluations }) =>
      evaluations.completeStage({
        runId: RUN_A,
        expectedRevision: evalClaim.run.lockRevision,
        expectedTotal: 1,
        resultSetHash: evalHash,
        evaluationContextHash: HASH,
        results: [evaluation],
        artifactManifest: sqliteEvalArtifactManifest(RUN_A),
        updatedAt: SECOND_TIME
      })
    );
    if (!committed.ok) throw new Error("TEST_EVAL_FAILED");
    const claim = await tx.execute(({ runs }) =>
      runs.claimStage(RUN_A, committed.progress.lockRevision, SECOND_TIME)
    );
    if (!claim.ok) throw new Error("TEST_REPORT_CLAIM_FAILED");
    await tx.execute(({ runs }) =>
      runs.failRun({
        runId: RUN_A,
        expectedRevision: claim.run.lockRevision,
        errorCode: "REPORT_RECONCILIATION_FAILED",
        errorMessage: "test",
        completedAt: SECOND_TIME
      })
    );
    const before = await tx.execute(({ runs }) => runs.getPlatformRun(RUN_A));
    if (!before) throw new Error("TEST_RUN_MISSING");
    expect(canRetryReport(platformRunProgress(before))).toBe(true);
    expect(canRetryReport(platformRunProgress({ ...before, evaluationResultSetHash: null }))).toBe(
      false
    );
    expect(canRetryReport(platformRunProgress({ ...before, cancelRequestedAt: SECOND_TIME }))).toBe(
      false
    );
    expect(canRetryReport(platformRunProgress({ ...before, reportResultSetHash: HASH }))).toBe(
      false
    );
    expect(
      await tx.execute(({ runs }) =>
        runs.claimStage(RUN_A, before.lockRevision - 1, SECOND_TIME, "RETRY_REPORT")
      )
    ).toMatchObject({ ok: false, reason: "STATE_OR_REVISION" });
    await tx.execute(({ runs }) => runs.claimStage(RUN_B, 0, SECOND_TIME));
    expect(
      await tx.execute(({ runs }) =>
        runs.claimStage(RUN_A, before.lockRevision, SECOND_TIME, "RETRY_REPORT")
      )
    ).toMatchObject({ ok: false, reason: "GLOBAL_RUNNING" });
    await tx.execute(({ runs }) =>
      runs.failRun({
        runId: RUN_B,
        expectedRevision: 1,
        errorCode: "REST_STAGE_FAILED",
        errorMessage: "test",
        completedAt: SECOND_TIME
      })
    );
    const outcomes = await Promise.all(
      [1, 2].map(() =>
        tx.execute(({ runs }) =>
          runs.claimStage(RUN_A, before.lockRevision, SECOND_TIME, "RETRY_REPORT")
        )
      )
    );
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(outcomes.find((o) => o.ok)).toMatchObject({
      run: {
        id: RUN_A,
        status: "RUNNING",
        stage: "REPORT",
        errorCode: null,
        resultSetHash: HASH,
        evaluationResultSetHash: evalHash,
        artifactManifest: before.artifactManifest
      }
    });
    expect(
      await evalTx.execute(({ evaluations }) =>
        evaluations.queryResults({ runId: RUN_A, limit: 20 })
      )
    ).toMatchObject({ items: [{ evalResultHash: evaluation.evalResultHash }] });
  } finally {
    await storage.close();
  }
});
