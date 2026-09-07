import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  PlatformRun,
  StoredRestCaseResult
} from "@cortex-eval/application/src/features/runs/platform-run-models.ts";
import { caseDefinitionJson } from "@cortex-eval/domain/src/domain-case-projection.ts";
import {
  hashCaseDefinition,
  hashFinalCaseResult,
  hashRestResult,
  hashRunContext
} from "@cortex-eval/domain/src/domain-hash-inputs.ts";
import {
  hashEndpointConfig,
  hashLlmConfig,
  hashRubricPromptSet,
  hashSuite
} from "@cortex-eval/domain/src/domain-resource-hashes.ts";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { initializeSqliteStorage } from "../src/sqlite-database.ts";
import { SqlitePlatformRunRepository } from "../src/sqlite-platform-run-repository.ts";
import {
  sqliteEvalArtifactManifest as evalArtifactManifest,
  sqliteEvalResultSetHash,
  sqlitePassingEvalResult,
  sqliteRestArtifactManifest as restArtifactManifest,
  sqliteRunCaseDefinition
} from "../test-support/sqlite-platform-run-fixtures.ts";

const openStorages: { close(): Promise<void> }[] = [];
const FIRST_TIME = "2026-07-13T00:00:00.000Z";
const SECOND_TIME = "2026-07-13T00:00:01.000Z";
const HASH = "a".repeat(64);
const RUN_A = "01900000-0000-7000-8000-000000000001";
const RUN_B = "01900000-0000-7000-8000-000000000002";
const RUN_C = "01900000-0000-7000-8000-000000000003";
const RUN_RUNNING = "01900000-0000-7000-8000-000000000004";
const RUN_READY = "01900000-0000-7000-8000-000000000005";
const SUITE_ID = "01900000-0000-7000-8000-000000000100";
const ENDPOINT_ID = "01900000-0000-7000-8000-000000000200";
const EVALUATOR_ID = "01900000-0000-7000-8000-000000000300";

afterEach(async () => {
  await Promise.all(openStorages.splice(0).map(async (storage) => storage.close()));
});

const DEFINITION = sqliteRunCaseDefinition("case-1");
const DEFINITION_HASH = hashCaseDefinition({
  contractVersion: "cortex.case-definition.v1",
  caseKey: DEFINITION.caseKey,
  definition: caseDefinitionJson(DEFINITION)
});
const SUITE_HASH = hashSuite({
  contractVersion: "cortex.suite.v1",
  cases: [{ caseKey: DEFINITION.caseKey, ordinal: 0, definitionHash: DEFINITION_HASH }]
});
const ENDPOINT_DEFINITION = {
  urlTemplate: "https://example.test/{{vars.task}}",
  method: "POST" as const,
  headers: {},
  bodySelector: "/request_body",
  timeoutMs: 1_000,
  defaultConcurrency: 4
};
const ENDPOINT_HASH = hashEndpointConfig({
  contractVersion: "cortex.endpoint-config.v1",
  config: ENDPOINT_DEFINITION
});
const EVALUATOR_DEFINITION = {
  providerType: "GOOGLE_GEMINI" as const,
  apiKey: { kind: "ENV_SECRET" as const, envKey: "GEMINI_API_KEY" },
  model: "gemini-test",
  thinkingLevel: "OFF" as const,
  temperature: 0,
  topP: 1,
  maxOutputTokens: 1_024,
  timeoutMs: 60_000,
  structuredOutput: "JSON_SCHEMA" as const
};
const EVALUATOR_HASH = hashLlmConfig({
  contractVersion: "cortex.llm-config.v1",
  config: EVALUATOR_DEFINITION
});
const RUBRIC_SET_HASH = hashRubricPromptSet({
  contractVersion: "cortex.rubric-prompt-set.v1",
  prompts: []
});
const LIMITS = {
  contractVersion: "cortex.run-execution-limits.v1" as const,
  restConcurrency: 4,
  evalConcurrency: 2
};
const RUN_CONTEXT_HASH = hashRunContext({
  contractVersion: "cortex.run-context.v1",
  suiteHash: SUITE_HASH,
  endpointConfigHash: ENDPOINT_HASH,
  evaluatorConfigHash: EVALUATOR_HASH,
  rubricPromptSetHash: RUBRIC_SET_HASH,
  promptfooVersion: "0.121.18",
  runExecutionLimits: LIMITS
});

function seedCurrentResources(databasePath: string): void {
  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  database
    .prepare(
      `INSERT INTO test_suite
       (id, name, description, case_count, suite_hash, revision, created_at, updated_at)
       VALUES (?, 'Suite', 'Suite', 1, ?, 0, ?, ?)`
    )
    .run(SUITE_ID, SUITE_HASH, FIRST_TIME, FIRST_TIME);
  database
    .prepare(
      `INSERT INTO endpoint_config
       (id, name, url_template, method, headers_json, body_selector, timeout_ms,
        default_concurrency, config_hash, revision, created_at, updated_at)
       VALUES (?, 'Endpoint', ?, 'POST', '{}', '/request_body', 1000, 4, ?, 0, ?, ?)`
    )
    .run(ENDPOINT_ID, ENDPOINT_DEFINITION.urlTemplate, ENDPOINT_HASH, FIRST_TIME, FIRST_TIME);
  database
    .prepare(
      `INSERT INTO llm_config
       (id, name, provider_type, model, options_json, secret_refs_json, config_hash,
        revision, created_at, updated_at)
       VALUES (?, 'Evaluator', 'GOOGLE_GEMINI', 'gemini-test', ?, ?, ?, 0, ?, ?)`
    )
    .run(
      EVALUATOR_ID,
      JSON.stringify({
        thinkingLevel: "OFF",
        temperature: 0,
        topP: 1,
        maxOutputTokens: 1_024,
        timeoutMs: 60_000,
        structuredOutput: "JSON_SCHEMA"
      }),
      JSON.stringify({ apiKey: "GEMINI_API_KEY" }),
      EVALUATOR_HASH,
      FIRST_TIME,
      FIRST_TIME
    );
  database.close();
}

function platformRun(
  id: string,
  sourceRunId: string | null = null,
  rerunMode: PlatformRun["rerunMode"] = "NONE"
): PlatformRun {
  return {
    id,
    sourceType: "PLATFORM",
    sourceRunId,
    rerunMode,
    suite: {
      id: SUITE_ID,
      name: `Suite ${id}`,
      suiteHash: SUITE_HASH,
      cases: [
        {
          caseKey: "case-1",
          ordinal: 0,
          definitionHash: DEFINITION_HASH,
          definition: DEFINITION
        }
      ]
    },
    endpoint: {
      sourceId: ENDPOINT_ID,
      name: "Endpoint",
      configHash: ENDPOINT_HASH,
      definition: ENDPOINT_DEFINITION
    },
    evaluator: {
      sourceId: EVALUATOR_ID,
      name: "Evaluator",
      configHash: EVALUATOR_HASH,
      definition: EVALUATOR_DEFINITION
    },
    rubricPrompts: [],
    runContextHash: RUN_CONTEXT_HASH,
    promptfooVersion: "0.121.18",
    contractVersions: {
      runSnapshot: "cortex.run-snapshot.v1",
      caseDefinition: "cortex.case-definition.v1",
      platformRestResults: "cortex.platform-rest-results.v1"
    },
    runExecutionLimits: LIMITS,
    runMode: "STAGED",
    status: "READY",
    stage: "REST",
    lockRevision: 0,
    cancelRequestedAt: null,
    restCompletedCount: 0,
    restErrorCount: 0,
    evalCompletedCount: 0,
    evalPassCount: 0,
    evalFailCount: 0,
    evalErrorCount: 0,
    evalNotEvaluatedCount: 0,
    resultSetHash: null,
    evaluationContextHash: null,
    evaluationResultSetHash: null,
    reportResultSetHash: null,
    reportSummary: null,
    artifactManifest: {
      contractVersion: "cortex.artifact-manifest.v1",
      owner: { kind: "RUN", id },
      artifacts: []
    },
    errorCode: null,
    errorMessage: null,
    startedAt: null,
    completedAt: null,
    createdAt: FIRST_TIME,
    updatedAt: FIRST_TIME
  };
}

function successResult(
  runId: string,
  provenance: StoredRestCaseResult["provenance"] = null
): StoredRestCaseResult {
  const providerOutput = { ok: false as const, errorMessage: "business" };
  return {
    runId,
    caseKey: "case-1",
    ordinal: 0,
    definition: DEFINITION,
    caseDefinitionHash: DEFINITION_HASH,
    status: "SUCCEEDED",
    httpStatus: 200,
    providerOutput,
    errorType: null,
    errorMessage: null,
    durationMs: 10,
    completedAt: SECOND_TIME,
    resultHash: hashRestResult({
      contractVersion: "cortex.rest-result.v1",
      caseKey: "case-1",
      caseDefinitionHash: DEFINITION_HASH,
      result: { status: "SUCCEEDED", httpStatus: 200, providerOutput }
    }),
    provenance
  };
}

function passingEvalResult(runId: string): ReturnType<typeof sqlitePassingEvalResult> {
  return sqlitePassingEvalResult({
    runId,
    definitionHash: DEFINITION_HASH,
    restResultHash: successResult(runId).resultHash,
    evidenceHash: HASH,
    completedAt: SECOND_TIME
  });
}

describe("SQLite Platform Run Repository", () => {
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
