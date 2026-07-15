import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ImportExecutionAnalysis,
  type ImportExecutionAnalysisCommand
} from "@cortex-eval/application/src/features/execution-imports/import-execution-analysis.ts";
import type { ImportedAnalysisCase } from "@cortex-eval/application/src/features/case-analysis/case-analysis-models.ts";
import type { AnalysisResultDraft } from "@cortex-eval/domain/src/domain-analysis.ts";
import { analysisProposalJson } from "@cortex-eval/domain/src/domain-analysis-projection.ts";
import { hashAnalysisResult } from "@cortex-eval/domain/src/domain-hash-inputs.ts";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { initializeSqliteStorage } from "../src/sqlite-database.ts";

const PACKAGE_ID = "01900000-0000-7000-8000-000000000010";
const EXECUTION_ID = "01900000-0000-7000-8000-000000000011";
const RUN_ID = "01900000-0000-7000-8000-000000000012";
const ANALYSIS_ID = "01900000-0000-7000-8000-000000000013";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const TIME = "2026-07-15T00:00:00.000Z";
const openStorages: { close(): Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(openStorages.splice(0).map(async (storage) => storage.close()));
});

function seedImportedReport(databasePath: string): void {
  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  database
    .prepare(
      `INSERT INTO run_log (
        id, source_type, source_package_id, execution_id, source_run_id, rerun_mode,
        suite_snapshot_json, endpoint_snapshot_json, evaluator_snapshot_json,
        rubric_prompts_snapshot_json, run_context_hash, promptfoo_version,
        contract_versions_json, run_execution_limits_json, run_mode, status, stage,
        rest_completed_count, rest_error_count, eval_completed_count, eval_error_count,
        summary_json, result_set_hash, report_result_set_hash, artifact_manifest_json,
        completed_at, created_at, updated_at
      ) VALUES (?, 'OFFLINE_IMPORT', ?, ?, NULL, 'NONE', '{}', '{}', '{}', '[]', ?,
        '0.121.18', '{}', '{}', 'STAGED', 'COMPLETED_WITH_ERRORS', 'DONE', 1, 0, 1, 1,
        '{}', ?, ?, '{}', ?, ?, ?)`
    )
    .run(RUN_ID, PACKAGE_ID, EXECUTION_ID, HASH_A, HASH_A, HASH_A, TIME, TIME, TIME);
  database
    .prepare(
      `INSERT INTO case_result (
        run_id, case_key, ordinal, case_definition_json, case_definition_hash,
        rest_status, http_status, provider_output_json, duration_ms, error_type,
        error_message, completed_at, run_result_hash
      ) VALUES (?, 'case-1', 0, '{}', ?, 'SUCCEEDED', 200, '{"ok":false,"errorMessage":"business"}',
        1, NULL, NULL, ?, ?)`
    )
    .run(RUN_ID, HASH_A, TIME, HASH_B);
  database
    .prepare(
      `INSERT INTO eval_result (
        run_id, case_key, eval_status, promptfoo_success, score, reason, evaluation_error,
        assertion_results_json, expected_actual_diffs_json, metric_results_json,
        allowlist_raw_evidence_json, eval_result_hash, final_case_result_hash, created_at, updated_at
      ) VALUES (?, 'case-1', 'EVALUATION_ERROR', NULL, NULL, NULL, '{"code":"EVALUATOR_TIMEOUT"}',
        '[]', '[]', '[]', 'null', ?, ?, ?, ?)`
    )
    .run(RUN_ID, HASH_B, HASH_C, TIME, TIME);
  database.close();
}

const output: AnalysisResultDraft = {
  classification: "NORMAL_FAILURE",
  confidence: 0.8,
  evidence: [{ source: "failed_assertions", fieldPath: null, conclusion: "断言失败" }],
  explanation: "结果不满足约束",
  recommendedAction: "修复系统"
};

function resultHash(inputHash = HASH_B, value: AnalysisResultDraft = output): string {
  return hashAnalysisResult({
    contractVersion: "cortex.analysis-result.v1",
    caseKey: "case-1",
    finalCaseResultHash: HASH_C,
    analysisInputHash: inputHash,
    result: {
      status: "SUCCEEDED",
      classification: value.classification,
      confidence: value.confidence,
      evidence: value.evidence,
      explanation: value.explanation,
      recommendedAction: value.recommendedAction,
      proposal: value.proposal === undefined ? null : analysisProposalJson(value.proposal)
    }
  });
}

function errorResultHash(inputHash: string, errorCode: string): string {
  return hashAnalysisResult({
    contractVersion: "cortex.analysis-result.v1",
    caseKey: "case-1",
    finalCaseResultHash: HASH_C,
    analysisInputHash: inputHash,
    result: { status: "ERROR", errorCode }
  });
}

function analysisCommand(
  values: readonly ImportedAnalysisCase[],
  analysisResultSetHash = HASH_C
): ImportExecutionAnalysisCommand {
  return {
    packageId: PACKAGE_ID,
    executionId: EXECUTION_ID,
    identity: {
      selector: "errors" as const,
      reportResultSetHash: HASH_A,
      finalCaseResultSetHash: HASH_B,
      analysisResultSetHash,
      artifactPath: `executions/${EXECUTION_ID}/analysis-results.json`,
      artifactSha256: HASH_D,
      artifactSizeBytes: 42
    },
    prompt: { sourceId: null, promptKey: "analysis", promptHash: HASH_A, snapshot: {} },
    analyzer: {
      sourceId: null,
      configHash: HASH_B,
      provider: "OPENAI_COMPATIBLE" as const,
      model: "analyzer",
      snapshot: {}
    },
    analysisExecutionLimits: {
      contractVersion: "cortex.analysis-execution-limits.v1" as const,
      analysisConcurrency: 1
    },
    openCases: async function* (): AsyncGenerator<ImportedAnalysisCase> {
      await Promise.resolve();
      yield* values;
    }
  };
}

async function createSubject(): Promise<{
  readonly storage: Awaited<ReturnType<typeof initializeSqliteStorage>>;
  readonly useCase: ImportExecutionAnalysis;
}> {
  const projectRoot = await mkdtemp(join(tmpdir(), "cortex-analysis-import-stage-"));
  const storage = await initializeSqliteStorage({ projectRoot });
  openStorages.push(storage);
  seedImportedReport(storage.databasePath);
  let nextId = 0;
  return {
    storage,
    useCase: new ImportExecutionAnalysis({
      stagingFactory: storage.createAnalysisImportStagingFactory(),
      idGenerator: {
        nextId: (): string => (nextId++ === 0 ? ANALYSIS_ID : crypto.randomUUID())
      },
      clock: { now: (): string => TIME }
    })
  };
}

describe("SQLite Analysis import staging", () => {
  it("事务外暂存，最终事务批量导入并按完整 Artifact 身份幂等", async () => {
    const { storage, useCase } = await createSubject();
    const command = analysisCommand([
      {
        caseKey: "case-1",
        finalCaseResultHash: HASH_C,
        analysisInputHash: HASH_B,
        analysisResultHash: resultHash(),
        status: "SUCCEEDED" as const,
        output
      }
    ]);

    await expect(useCase.execute(command)).resolves.toMatchObject({
      ok: true,
      runId: RUN_ID,
      idempotent: false,
      importedCount: 1
    });
    await expect(useCase.execute(command)).resolves.toMatchObject({
      ok: true,
      runId: RUN_ID,
      idempotent: true,
      importedCount: 0
    });
    await expect(
      storage
        .createAnalysisTransactionManager()
        .execute((transaction) => transaction.analyses.getCurrent(RUN_ID, "case-1"))
    ).resolves.toMatchObject({
      id: ANALYSIS_ID,
      revision: 3,
      status: "SUCCEEDED",
      analysisResultHash: resultHash(),
      output: { evidence: output.evidence }
    });
  });

  it("批量替换 Proposal 并导入 Error 终态", async () => {
    const { storage, useCase } = await createSubject();
    await useCase.execute(
      analysisCommand([
        {
          caseKey: "case-1",
          finalCaseResultHash: HASH_C,
          analysisInputHash: HASH_B,
          analysisResultHash: resultHash(),
          status: "SUCCEEDED",
          output
        }
      ])
    );

    const proposalOutput: AnalysisResultDraft = {
      ...output,
      proposal: {
        action: "ADD_ASSERTION",
        baseDefinitionHash: HASH_A,
        targetAssertionIndex: 0,
        assertion: { type: "equals", metric: "quality", weight: 1, value: "ok" }
      }
    };
    await expect(
      useCase.execute(
        analysisCommand(
          [
            {
              caseKey: "case-1",
              finalCaseResultHash: HASH_C,
              analysisInputHash: HASH_D,
              analysisResultHash: resultHash(HASH_D, proposalOutput),
              status: "SUCCEEDED",
              output: proposalOutput
            }
          ],
          HASH_D
        )
      )
    ).resolves.toMatchObject({ ok: true, idempotent: false, importedCount: 1 });
    await expect(
      storage
        .createAnalysisTransactionManager()
        .execute((transaction) => transaction.analyses.getCurrent(RUN_ID, "case-1"))
    ).resolves.toMatchObject({ revision: 6, decision: "PENDING", applyStatus: "NOT_APPLIED" });

    const errorCode = "ANALYZER_OUTPUT_INVALID";
    await expect(
      useCase.execute(
        analysisCommand(
          [
            {
              caseKey: "case-1",
              finalCaseResultHash: HASH_C,
              analysisInputHash: HASH_A,
              analysisResultHash: errorResultHash(HASH_A, errorCode),
              status: "ERROR",
              errorCode,
              errorMessage: "平台已重建的错误文案"
            }
          ],
          HASH_A
        )
      )
    ).resolves.toMatchObject({ ok: true, idempotent: false, importedCount: 1 });
    await expect(
      storage
        .createAnalysisTransactionManager()
        .execute((transaction) => transaction.analyses.getCurrent(RUN_ID, "case-1"))
    ).resolves.toMatchObject({
      revision: 9,
      status: "ERROR",
      errorCode,
      errorMessage: "平台已重建的错误文案"
    });
  });

  it("拒绝重复 Case Key 与相同输入的不同结果", async () => {
    const { useCase } = await createSubject();
    const firstCase: ImportedAnalysisCase = {
      caseKey: "case-1",
      finalCaseResultHash: HASH_C,
      analysisInputHash: HASH_B,
      analysisResultHash: resultHash(),
      status: "SUCCEEDED",
      output
    };
    await expect(useCase.execute(analysisCommand([firstCase, firstCase]))).rejects.toThrow(
      "ANALYSIS_IMPORT_STATE_INVALID"
    );
    await useCase.execute(analysisCommand([firstCase]));

    const changedOutput: AnalysisResultDraft = { ...output, explanation: "不同结果" };
    await expect(
      useCase.execute(
        analysisCommand(
          [
            {
              ...firstCase,
              analysisResultHash: resultHash(HASH_B, changedOutput),
              output: changedOutput
            }
          ],
          HASH_D
        )
      )
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "EXECUTION_RESULT_CONFLICT" }
    });
  });

  it("关闭 staging writer 后拒绝继续写入", async () => {
    const { storage } = await createSubject();
    const session = await storage.createAnalysisImportStagingFactory().open();
    await expect(
      session.withStagedTransaction(async () => {
        await Promise.resolve();
        return "done";
      })
    ).resolves.toBe("done");
    expect(() =>
      session.stage({
        id: ANALYSIS_ID,
        caseKey: "case-1",
        finalCaseResultHash: HASH_C,
        analysisInputHash: HASH_B,
        analysisResultHash: resultHash(),
        status: "SUCCEEDED",
        output
      })
    ).toThrow("ANALYSIS_IMPORT_STAGING_CLOSED");
    await session.cleanup();
  });

  it("最终事务失败时回滚并在 DETACH 后传播原始错误", async () => {
    const { storage } = await createSubject();
    const session = await storage.createAnalysisImportStagingFactory().open();
    await expect(
      session.withStagedTransaction(async () => {
        await Promise.resolve();
        throw new Error("EXPECTED_RECONCILE_FAILURE");
      })
    ).rejects.toThrow("EXPECTED_RECONCILE_FAILURE");
    await session.cleanup();
  });
});
