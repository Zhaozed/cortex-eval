import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AnalysisResultDraft } from "@cortex-eval/domain/src/domain-analysis.ts";
import type { ReplaceCurrentAnalysisInput } from "@cortex-eval/application/src/features/case-analysis/case-analysis-models.ts";
import { hashAnalysisResult } from "@cortex-eval/domain/src/domain-hash-inputs.ts";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { initializeSqliteStorage } from "../src/sqlite-database.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const RUN_ID = "01900000-0000-7000-8000-000000000001";
const ANALYSIS_ID = "01900000-0000-7000-8000-000000000101";
const REANALYSIS_ID = "01900000-0000-7000-8000-000000000102";
const TIME_A = "2026-07-15T00:00:00.000Z";
const TIME_B = "2026-07-15T00:00:01.000Z";
const openStorages: { close(): Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(openStorages.splice(0).map(async (storage) => storage.close()));
});

function seedAnalyzableCase(databasePath: string): void {
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
      ) VALUES (?, 'PLATFORM', NULL, NULL, NULL, 'NONE', '{}', '{}', '{}', '[]', ?,
        '0.121.18', '{}', '{}', 'STAGED', 'COMPLETED_WITH_ERRORS', 'DONE', 1, 0, 1, 1,
        '{}', ?, ?, ?, ?, ?, ?)`
    )
    .run(
      RUN_ID,
      HASH_A,
      HASH_A,
      HASH_B,
      JSON.stringify({
        contractVersion: "cortex.artifact-manifest.v1",
        owner: { kind: "RUN", id: RUN_ID },
        artifacts: []
      }),
      TIME_A,
      TIME_A,
      TIME_A
    );
  database
    .prepare(
      `INSERT INTO case_result (
        run_id, case_key, ordinal, case_definition_json, case_definition_hash,
        rest_status, http_status, provider_output_json, duration_ms, error_type,
        error_message, completed_at, run_result_hash
      ) VALUES (?, 'case-1', 0, '{}', ?, 'SUCCEEDED', 200, '{"ok":false,"errorMessage":"business"}',
        1, NULL, NULL, ?, ?)`
    )
    .run(RUN_ID, HASH_A, TIME_A, HASH_B);
  database
    .prepare(
      `INSERT INTO eval_result (
        run_id, case_key, eval_status, promptfoo_success, score, reason, evaluation_error,
        assertion_results_json, expected_actual_diffs_json, metric_results_json,
        allowlist_raw_evidence_json, eval_result_hash, final_case_result_hash, created_at, updated_at
      ) VALUES (?, 'case-1', 'EVALUATION_ERROR', NULL, NULL, NULL, '{"code":"EVALUATOR_TIMEOUT"}',
        '[]', '[]', '[]', 'null', ?, ?, ?, ?)`
    )
    .run(RUN_ID, HASH_B, HASH_C, TIME_A, TIME_A);
  database.close();
}

const output: AnalysisResultDraft = {
  classification: "NORMAL_FAILURE",
  confidence: 0.8,
  evidence: [
    {
      source: "expected_actual_diffs",
      fieldPath: "/0/actual",
      conclusion: "实际值不符合约束"
    }
  ],
  explanation: "系统真实失败",
  recommendedAction: "修复系统"
};
const ANALYSIS_RESULT_HASH = hashAnalysisResult({
  contractVersion: "cortex.analysis-result.v1",
  caseKey: "case-1",
  finalCaseResultHash: HASH_C,
  analysisInputHash: HASH_A,
  result: {
    status: "SUCCEEDED",
    classification: output.classification,
    confidence: output.confidence,
    evidence: output.evidence,
    explanation: output.explanation,
    recommendedAction: output.recommendedAction,
    proposal: null
  }
});

const outputWithProposal: AnalysisResultDraft = {
  ...output,
  proposal: {
    action: "ADD_ASSERTION",
    baseDefinitionHash: HASH_A,
    targetAssertionIndex: 0,
    assertion: { type: "equals", metric: "answer", weight: 1, value: "ok" }
  }
};
const PROPOSAL_RESULT_HASH = hashAnalysisResult({
  contractVersion: "cortex.analysis-result.v1",
  caseKey: "case-1",
  finalCaseResultHash: HASH_C,
  analysisInputHash: HASH_A,
  result: {
    status: "SUCCEEDED",
    classification: outputWithProposal.classification,
    confidence: outputWithProposal.confidence,
    evidence: outputWithProposal.evidence,
    explanation: outputWithProposal.explanation,
    recommendedAction: outputWithProposal.recommendedAction,
    proposal: {
      action: "ADD_ASSERTION",
      baseDefinitionHash: HASH_A,
      targetAssertionIndex: 0,
      assertion: { type: "equals", metric: "answer", weight: 1, value: "ok" }
    }
  }
});

function errorResultHash(errorCode: string): string {
  return hashAnalysisResult({
    contractVersion: "cortex.analysis-result.v1",
    caseKey: "case-1",
    finalCaseResultHash: HASH_C,
    analysisInputHash: HASH_A,
    result: { status: "ERROR", errorCode }
  });
}

function pendingInput(): ReplaceCurrentAnalysisInput {
  return {
    id: ANALYSIS_ID,
    runId: RUN_ID,
    caseKey: "case-1",
    finalCaseResultHash: HASH_C,
    expectedRevision: null,
    prompt: { sourceId: null, promptKey: "analysis", promptHash: HASH_A, snapshot: {} },
    analyzer: {
      sourceId: null,
      configHash: HASH_B,
      provider: "OPENAI_COMPATIBLE" as const,
      model: "analyzer",
      snapshot: {}
    },
    analysisInputHash: HASH_A,
    analysisExecutionLimits: {
      contractVersion: "cortex.analysis-execution-limits.v1" as const,
      analysisConcurrency: 1
    },
    timestamp: TIME_A
  };
}

describe("SQLite Case Analysis Repository", () => {
  it("以 ID+Revision CAS 完成 PENDING→RUNNING→SUCCEEDED，并拒绝迟到结果", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-analysis-repository-"));
    const storage = await initializeSqliteStorage({ projectRoot });
    openStorages.push(storage);
    seedAnalyzableCase(storage.databasePath);
    const manager = storage.createAnalysisTransactionManager();
    const pending = await manager.execute((transaction) =>
      transaction.analyses.replaceCurrent({
        id: ANALYSIS_ID,
        runId: RUN_ID,
        caseKey: "case-1",
        finalCaseResultHash: HASH_C,
        expectedRevision: null,
        prompt: {
          sourceId: "01900000-0000-7000-8000-000000000201",
          promptKey: "analysis",
          promptHash: HASH_A,
          snapshot: { contractVersion: "cortex.analysis-prompt-snapshot.v1" }
        },
        analyzer: {
          sourceId: "01900000-0000-7000-8000-000000000301",
          configHash: HASH_B,
          provider: "GOOGLE_GEMINI",
          model: "analyzer",
          snapshot: { contractVersion: "cortex.analyzer-snapshot.v1" }
        },
        analysisInputHash: HASH_A,
        analysisExecutionLimits: {
          contractVersion: "cortex.analysis-execution-limits.v1",
          analysisConcurrency: 1
        },
        timestamp: TIME_A
      })
    );
    expect(pending).toMatchObject({ ok: true, analysis: { status: "PENDING", revision: 1 } });
    const running = await manager.execute((transaction) =>
      transaction.analyses.claim(ANALYSIS_ID, 1, TIME_B)
    );
    expect(running).toMatchObject({ ok: true, analysis: { status: "RUNNING", revision: 2 } });
    const reanalysisWhileRunning = await manager.execute((transaction) =>
      transaction.analyses.replaceCurrent({
        ...pendingInput(),
        id: REANALYSIS_ID,
        expectedRevision: 2,
        timestamp: TIME_B
      })
    );
    expect(reanalysisWhileRunning).toMatchObject({
      ok: false,
      reason: "ANALYSIS_STATE_CONFLICT",
      current: { id: ANALYSIS_ID, status: "RUNNING", revision: 2 }
    });
    const complete = await manager.execute((transaction) =>
      transaction.analyses.complete({
        id: ANALYSIS_ID,
        expectedRevision: 2,
        analysisResultHash: ANALYSIS_RESULT_HASH,
        result: { status: "SUCCEEDED", output },
        errorMessage: null,
        timestamp: TIME_B
      })
    );
    expect(complete).toMatchObject({
      ok: true,
      analysis: {
        status: "SUCCEEDED",
        revision: 3,
        output: { evidence: output.evidence },
        analysisResultHash: ANALYSIS_RESULT_HASH
      }
    });
    const late = await manager.execute((transaction) =>
      transaction.analyses.complete({
        id: ANALYSIS_ID,
        expectedRevision: 2,
        analysisResultHash: ANALYSIS_RESULT_HASH,
        result: { status: "SUCCEEDED", output },
        errorMessage: null,
        timestamp: TIME_B
      })
    );
    expect(late).toMatchObject({ ok: false, reason: "ANALYSIS_REVISION_CONFLICT" });
  });

  it("重新分析替换 invocation、递增 Revision、清除旧决策，启动恢复收敛未完成记录", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-analysis-repository-"));
    const storage = await initializeSqliteStorage({ projectRoot });
    openStorages.push(storage);
    seedAnalyzableCase(storage.databasePath);
    const manager = storage.createAnalysisTransactionManager();
    const base = pendingInput();
    await manager.execute((transaction) => transaction.analyses.replaceCurrent(base));
    const replaced = await manager.execute((transaction) =>
      transaction.analyses.replaceCurrent({
        ...base,
        id: REANALYSIS_ID,
        expectedRevision: 1,
        analysisInputHash: HASH_B,
        timestamp: TIME_B
      })
    );
    expect(replaced).toMatchObject({
      ok: true,
      analysis: {
        id: REANALYSIS_ID,
        revision: 2,
        status: "PENDING",
        output: null,
        decision: "NO_PROPOSAL",
        applyStatus: "NOT_APPLICABLE"
      }
    });
    const recovered = await manager.execute((transaction) =>
      transaction.analyses.recoverUnfinished(TIME_B, "ANALYSIS_INTERRUPTED", "分析已中断")
    );
    expect(recovered).toBe(1);
    await expect(
      manager.execute((transaction) => transaction.analyses.getCurrent(RUN_ID, "case-1"))
    ).resolves.toMatchObject({
      status: "ERROR",
      revision: 3,
      errorCode: "ANALYSIS_INTERRUPTED"
    });
  });

  it("只允许当前待决 Proposal 被拒绝或记录原子应用结果", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-analysis-repository-"));
    const storage = await initializeSqliteStorage({ projectRoot });
    openStorages.push(storage);
    seedAnalyzableCase(storage.databasePath);
    const manager = storage.createAnalysisTransactionManager();
    await manager.execute((transaction) => transaction.analyses.replaceCurrent(pendingInput()));
    await manager.execute((transaction) => transaction.analyses.claim(ANALYSIS_ID, 1, TIME_B));
    await manager.execute((transaction) =>
      transaction.analyses.complete({
        id: ANALYSIS_ID,
        expectedRevision: 2,
        analysisResultHash: PROPOSAL_RESULT_HASH,
        result: { status: "SUCCEEDED", output: outputWithProposal },
        errorMessage: null,
        timestamp: TIME_B
      })
    );

    const rejected = await manager.execute((transaction) =>
      transaction.analyses.rejectProposal(ANALYSIS_ID, 3, TIME_B)
    );
    expect(rejected).toMatchObject({
      ok: true,
      analysis: { revision: 4, decision: "REJECTED", applyStatus: "NOT_APPLIED" }
    });
    await expect(
      manager.execute((transaction) =>
        transaction.analyses.recordProposalApplication({
          id: ANALYSIS_ID,
          expectedRevision: 3,
          decision: "ACCEPTED",
          applyStatus: "APPLIED",
          appliedDefinitionHash: HASH_B,
          timestamp: TIME_B
        })
      )
    ).resolves.toMatchObject({ ok: false, reason: "ANALYSIS_REVISION_CONFLICT" });
  });

  it("拒绝错误版本、非法状态迁移和不完整的终态结果", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-analysis-repository-"));
    const storage = await initializeSqliteStorage({ projectRoot });
    openStorages.push(storage);
    seedAnalyzableCase(storage.databasePath);
    const manager = storage.createAnalysisTransactionManager();

    await expect(
      manager.execute((transaction) =>
        transaction.analyses.replaceCurrent({
          ...pendingInput(),
          runId: "01900000-0000-7000-8000-000000000099"
        })
      )
    ).resolves.toEqual({ ok: false, reason: "RUN_NOT_FOUND", current: null });
    await expect(
      manager.execute((transaction) =>
        transaction.analyses.replaceCurrent({
          ...pendingInput(),
          finalCaseResultHash: HASH_B
        })
      )
    ).resolves.toEqual({ ok: false, reason: "FINAL_RESULT_MISMATCH", current: null });

    await manager.execute((transaction) => transaction.analyses.replaceCurrent(pendingInput()));
    await expect(
      manager.execute((transaction) => transaction.analyses.replaceCurrent(pendingInput()))
    ).resolves.toMatchObject({
      ok: false,
      reason: "ANALYSIS_REVISION_CONFLICT",
      current: { id: ANALYSIS_ID, revision: 1 }
    });
    await expect(
      manager.execute((transaction) =>
        transaction.analyses.claim("01900000-0000-7000-8000-000000000199", 1, TIME_B)
      )
    ).resolves.toEqual({ ok: false, reason: "ANALYSIS_REVISION_CONFLICT", current: null });
    await expect(
      manager.execute((transaction) =>
        transaction.analyses.complete({
          id: ANALYSIS_ID,
          expectedRevision: 1,
          analysisResultHash: ANALYSIS_RESULT_HASH,
          result: { status: "SUCCEEDED", output },
          errorMessage: null,
          timestamp: TIME_B
        })
      )
    ).resolves.toMatchObject({ ok: false, reason: "ANALYSIS_STATE_CONFLICT" });

    await manager.execute((transaction) => transaction.analyses.claim(ANALYSIS_ID, 1, TIME_B));
    await expect(
      manager.execute((transaction) => transaction.analyses.claim(ANALYSIS_ID, 2, TIME_B))
    ).resolves.toMatchObject({ ok: false, reason: "ANALYSIS_STATE_CONFLICT" });
    await expect(
      manager.execute((transaction) =>
        transaction.analyses.complete({
          id: ANALYSIS_ID,
          expectedRevision: 2,
          analysisResultHash: ANALYSIS_RESULT_HASH,
          result: { status: "SUCCEEDED", output: { ...output, evidence: [] } },
          errorMessage: null,
          timestamp: TIME_B
        })
      )
    ).resolves.toMatchObject({ ok: false, reason: "ANALYSIS_STATE_CONFLICT" });
    await expect(
      manager.execute((transaction) =>
        transaction.analyses.complete({
          id: ANALYSIS_ID,
          expectedRevision: 2,
          analysisResultHash: HASH_A,
          result: { status: "SUCCEEDED", output },
          errorMessage: null,
          timestamp: TIME_B
        })
      )
    ).resolves.toMatchObject({ ok: false, reason: "ANALYSIS_STATE_CONFLICT" });
    await expect(
      manager.execute((transaction) =>
        transaction.analyses.complete({
          id: ANALYSIS_ID,
          expectedRevision: 2,
          analysisResultHash: HASH_A,
          result: { status: "ERROR", errorCode: "" },
          errorMessage: "模型输出非法",
          timestamp: TIME_B
        })
      )
    ).resolves.toMatchObject({ ok: false, reason: "ANALYSIS_STATE_CONFLICT" });
    await expect(
      manager.execute((transaction) =>
        transaction.analyses.complete({
          id: ANALYSIS_ID,
          expectedRevision: 2,
          analysisResultHash: errorResultHash("ANALYZER_OUTPUT_INVALID"),
          result: { status: "ERROR", errorCode: "ANALYZER_OUTPUT_INVALID" },
          errorMessage: "   ",
          timestamp: TIME_B
        })
      )
    ).resolves.toMatchObject({ ok: false, reason: "ANALYSIS_STATE_CONFLICT" });
    const completed = await manager.execute((transaction) =>
      transaction.analyses.complete({
        id: ANALYSIS_ID,
        expectedRevision: 2,
        analysisResultHash: errorResultHash("ANALYZER_OUTPUT_INVALID"),
        result: { status: "ERROR", errorCode: "ANALYZER_OUTPUT_INVALID" },
        errorMessage: "模型输出非法",
        timestamp: TIME_B
      })
    );
    expect(completed).toMatchObject({
      ok: true,
      analysis: {
        status: "ERROR",
        revision: 3,
        errorCode: "ANALYZER_OUTPUT_INVALID",
        errorMessage: "模型输出非法"
      }
    });
    await expect(
      manager.execute((transaction) => transaction.analyses.rejectProposal(ANALYSIS_ID, 3, TIME_B))
    ).resolves.toMatchObject({ ok: false, reason: "ANALYSIS_STATE_CONFLICT" });
    await expect(
      manager.execute((transaction) =>
        transaction.analyses.recordProposalApplication({
          id: ANALYSIS_ID,
          expectedRevision: 3,
          decision: "ACCEPTED",
          applyStatus: "APPLIED",
          appliedDefinitionHash: HASH_B,
          timestamp: TIME_B
        })
      )
    ).resolves.toMatchObject({ ok: false, reason: "ANALYSIS_STATE_CONFLICT" });
  });

  it("校验 Proposal 应用哈希，并分别保存 APPLIED 与 CONFLICT 决策", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-analysis-repository-"));
    const storage = await initializeSqliteStorage({ projectRoot });
    openStorages.push(storage);
    seedAnalyzableCase(storage.databasePath);
    const manager = storage.createAnalysisTransactionManager();
    await manager.execute((transaction) => transaction.analyses.replaceCurrent(pendingInput()));
    await manager.execute((transaction) => transaction.analyses.claim(ANALYSIS_ID, 1, TIME_B));
    await manager.execute((transaction) =>
      transaction.analyses.complete({
        id: ANALYSIS_ID,
        expectedRevision: 2,
        analysisResultHash: PROPOSAL_RESULT_HASH,
        result: { status: "SUCCEEDED", output: outputWithProposal },
        errorMessage: null,
        timestamp: TIME_B
      })
    );

    for (const invalid of [
      { applyStatus: "APPLIED" as const, appliedDefinitionHash: null },
      { applyStatus: "APPLIED" as const, appliedDefinitionHash: "not-a-hash" },
      { applyStatus: "CONFLICT" as const, appliedDefinitionHash: HASH_B }
    ]) {
      await expect(
        manager.execute((transaction) =>
          transaction.analyses.recordProposalApplication({
            id: ANALYSIS_ID,
            expectedRevision: 3,
            decision: "ACCEPTED",
            ...invalid,
            timestamp: TIME_B
          })
        )
      ).resolves.toMatchObject({ ok: false, reason: "ANALYSIS_STATE_CONFLICT" });
    }
    const applied = await manager.execute((transaction) =>
      transaction.analyses.recordProposalApplication({
        id: ANALYSIS_ID,
        expectedRevision: 3,
        decision: "EDITED_AND_ACCEPTED",
        applyStatus: "APPLIED",
        appliedDefinitionHash: HASH_B,
        timestamp: TIME_B
      })
    );
    expect(applied).toMatchObject({
      ok: true,
      analysis: {
        revision: 4,
        decision: "EDITED_AND_ACCEPTED",
        applyStatus: "APPLIED",
        appliedDefinitionHash: HASH_B
      }
    });
    await expect(
      manager.execute((transaction) => transaction.analyses.rejectProposal(ANALYSIS_ID, 4, TIME_B))
    ).resolves.toMatchObject({ ok: false, reason: "ANALYSIS_STATE_CONFLICT" });

    await manager.execute((transaction) =>
      transaction.analyses.replaceCurrent({
        ...pendingInput(),
        id: REANALYSIS_ID,
        expectedRevision: 4,
        timestamp: TIME_B
      })
    );
    await manager.execute((transaction) => transaction.analyses.claim(REANALYSIS_ID, 5, TIME_B));
    await manager.execute((transaction) =>
      transaction.analyses.complete({
        id: REANALYSIS_ID,
        expectedRevision: 6,
        analysisResultHash: PROPOSAL_RESULT_HASH,
        result: { status: "SUCCEEDED", output: outputWithProposal },
        errorMessage: null,
        timestamp: TIME_B
      })
    );
    const conflicted = await manager.execute((transaction) =>
      transaction.analyses.recordProposalApplication({
        id: REANALYSIS_ID,
        expectedRevision: 7,
        decision: "ACCEPTED",
        applyStatus: "CONFLICT",
        appliedDefinitionHash: null,
        timestamp: TIME_B
      })
    );
    expect(conflicted).toMatchObject({
      ok: true,
      analysis: {
        revision: 8,
        decision: "ACCEPTED",
        applyStatus: "CONFLICT",
        appliedDefinitionHash: null
      }
    });
  });

  it("仅恢复参数完整且属于精确 Run 的未完成 Analysis", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-analysis-repository-"));
    const storage = await initializeSqliteStorage({ projectRoot });
    openStorages.push(storage);
    seedAnalyzableCase(storage.databasePath);
    const manager = storage.createAnalysisTransactionManager();
    await manager.execute((transaction) => transaction.analyses.replaceCurrent(pendingInput()));

    await expect(
      manager.execute((transaction) =>
        transaction.analyses.recoverUnfinished(TIME_B, "", "分析已中断")
      )
    ).resolves.toBe(0);
    await expect(
      manager.execute((transaction) =>
        transaction.analyses.recoverUnfinished(TIME_B, "ANALYSIS_INTERRUPTED", "")
      )
    ).resolves.toBe(0);
    for (const [runId, errorCode, errorMessage] of [
      ["", "ANALYSIS_INTERRUPTED", "分析已中断"],
      [RUN_ID, "", "分析已中断"],
      [RUN_ID, "ANALYSIS_INTERRUPTED", ""]
    ] as const) {
      await expect(
        manager.execute((transaction) =>
          transaction.analyses.recoverUnfinishedForRun(runId, TIME_B, errorCode, errorMessage)
        )
      ).resolves.toBe(0);
    }
    await expect(
      manager.execute((transaction) =>
        transaction.analyses.recoverUnfinishedForRun(
          "01900000-0000-7000-8000-000000000099",
          TIME_B,
          "ANALYSIS_INTERRUPTED",
          "分析已中断"
        )
      )
    ).resolves.toBe(0);
    await expect(
      manager.execute((transaction) =>
        transaction.analyses.recoverUnfinishedForRun(
          RUN_ID,
          TIME_B,
          "ANALYSIS_INTERRUPTED",
          "分析已中断"
        )
      )
    ).resolves.toBe(1);
    await expect(
      manager.execute((transaction) =>
        transaction.analyses.recoverUnfinishedForRun(
          RUN_ID,
          TIME_B,
          "ANALYSIS_INTERRUPTED",
          "分析已中断"
        )
      )
    ).resolves.toBe(0);
  });
});
