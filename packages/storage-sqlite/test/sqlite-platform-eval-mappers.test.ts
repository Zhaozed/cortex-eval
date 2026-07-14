import type { PlatformEvalCaseResult } from "@cortex-eval/application/src/features/evaluation/platform-eval-models.ts";
import { canonicalJson } from "@cortex-eval/domain/src/domain-canonical-hash.ts";
import { hashEvalResult, hashFinalCaseResult } from "@cortex-eval/domain/src/domain-hash-inputs.ts";
import { describe, expect, it } from "vitest";

import {
  evalResultInsertValues,
  mapPlatformEvalResult,
  type EvalResultRowProjection
} from "../src/sqlite-platform-eval-mappers.ts";

const RUN_ID = "01900000-0000-7000-8000-000000000001";
const SOURCE_ID = "01900000-0000-7000-8000-000000000002";
const NOW = "2026-07-14T00:00:00.000Z";
const DEFINITION_HASH = "a".repeat(64);
const REST_HASH = "b".repeat(64);
const EVIDENCE_HASH = "c".repeat(64);

function result(
  status: "PASS" | "FAIL" | "EVALUATION_ERROR" | "NOT_EVALUATED",
  provenance: PlatformEvalCaseResult["provenance"] = null
): PlatformEvalCaseResult {
  const observed = status === "PASS" || status === "FAIL";
  const passed = status === "PASS";
  const promptfooSuccess = observed ? passed : null;
  const score = observed ? (passed ? 1 : 0) : null;
  const reason = observed ? (passed ? "passed" : "failed") : null;
  const evaluationError = status === "EVALUATION_ERROR" ? { code: "EVALUATOR_TIMEOUT" } : null;
  const rawEvidence =
    status === "NOT_EVALUATED"
      ? null
      : {
          present: true as const,
          path: "runs/raw.json",
          expectedSha256: EVIDENCE_HASH,
          expectedSizeBytes: 10
        };
  let assertions: PlatformEvalCaseResult["assertions"] = [];
  if (status === "PASS") {
    assertions = [
      {
        index: 0,
        definitionHash: DEFINITION_HASH,
        type: "equals",
        metric: "quality",
        weight: 1,
        status: "PASS",
        score: 1,
        reason: "passed"
      }
    ];
  }
  if (status === "FAIL") {
    assertions = [
      {
        index: 0,
        definitionHash: DEFINITION_HASH,
        type: "equals",
        metric: "quality",
        weight: 1,
        status: "FAIL",
        score: 0,
        reason: "failed"
      }
    ];
  }
  let metricStatus: PlatformEvalCaseResult["metrics"][number]["status"] = "PASS";
  if (status === "FAIL") metricStatus = "FAIL";
  if (status === "NOT_EVALUATED") metricStatus = "NOT_EVALUATED";
  if (status === "EVALUATION_ERROR") metricStatus = "ERROR";
  const metrics = [
    {
      metric: "quality",
      status: metricStatus
    }
  ];
  const tokenUsage = observed ? { inputTokens: 1, outputTokens: 2, totalTokens: 3 } : null;
  const evalResultHash = hashEvalResult({
    contractVersion: "cortex.eval-result.v1",
    caseKey: "case-1",
    status,
    promptfooSuccess,
    score,
    reason,
    evaluationError,
    assertions,
    diffs: [],
    metrics
  });
  return {
    runId: RUN_ID,
    caseKey: "case-1",
    ordinal: 0,
    status,
    promptfooSuccess,
    score,
    reason,
    evaluationError,
    assertions,
    diffs: [],
    metrics,
    latencyMs: observed ? 5 : null,
    tokenUsage,
    cost: observed ? 0.01 : null,
    rawEvidence,
    evalResultHash,
    finalCaseResultHash: hashFinalCaseResult({
      contractVersion: "cortex.final-case-result.v1",
      caseDefinitionHash: DEFINITION_HASH,
      restResultHash: REST_HASH,
      evalResultHash
    }),
    provenance,
    createdAt: NOW,
    updatedAt: NOW
  };
}

function row(value: PlatformEvalCaseResult): EvalResultRowProjection {
  return {
    run_id: value.runId,
    case_key: value.caseKey,
    eval_status: value.status,
    promptfoo_success: value.promptfooSuccess === null ? null : value.promptfooSuccess ? 1 : 0,
    score: value.score,
    reason: value.reason,
    evaluation_error: value.evaluationError === null ? null : canonicalJson(value.evaluationError),
    assertion_results_json: canonicalJson(value.assertions.map((item) => ({ ...item }))),
    expected_actual_diffs_json: canonicalJson(value.diffs.map((item) => ({ ...item }))),
    metric_results_json: canonicalJson(value.metrics.map((item) => ({ ...item }))),
    latency_ms: value.latencyMs,
    token_usage_json: value.tokenUsage === null ? null : canonicalJson({ ...value.tokenUsage }),
    cost: value.cost,
    allowlist_raw_evidence_json:
      value.rawEvidence === null ? canonicalJson(null) : canonicalJson({ ...value.rawEvidence }),
    eval_result_hash: value.evalResultHash,
    final_case_result_hash: value.finalCaseResultHash,
    reused_from_run_id: value.provenance?.sourceKind === "RUN" ? value.provenance.sourceId : null,
    reused_from_execution_id:
      value.provenance?.sourceKind === "EXECUTION" ? value.provenance.sourceId : null,
    reused_eval_result_hash: value.provenance?.sourceResultHash ?? null,
    created_at: value.createdAt,
    updated_at: value.updatedAt,
    ordinal: value.ordinal,
    case_definition_hash: DEFINITION_HASH,
    run_result_hash: REST_HASH
  };
}

describe("SQLite 平台 Eval 行映射", () => {
  it("覆盖 PASS、FAIL、Evaluation Error、Not Evaluated 与两种来源写入形态", () => {
    const runProvenance = {
      sourceKind: "RUN" as const,
      sourceId: SOURCE_ID,
      sourceResultHash: result("PASS").evalResultHash
    };
    const executionProvenance = {
      sourceKind: "EXECUTION" as const,
      sourceId: SOURCE_ID,
      sourceResultHash: result("PASS").evalResultHash
    };

    expect(evalResultInsertValues(result("PASS", runProvenance))).toMatchObject({
      promptfoo_success: 1,
      reused_from_run_id: SOURCE_ID,
      reused_from_execution_id: null
    });
    expect(evalResultInsertValues(result("PASS", executionProvenance))).toMatchObject({
      reused_from_run_id: null,
      reused_from_execution_id: SOURCE_ID
    });
    expect(evalResultInsertValues(result("FAIL"))).toMatchObject({ promptfoo_success: 0 });
    expect(evalResultInsertValues(result("EVALUATION_ERROR"))).toMatchObject({
      promptfoo_success: null,
      evaluation_error: canonicalJson({ code: "EVALUATOR_TIMEOUT" })
    });
    expect(evalResultInsertValues(result("NOT_EVALUATED"))).toMatchObject({
      token_usage_json: null,
      allowlist_raw_evidence_json: "null"
    });
  });

  it("还原无来源、Run 来源和 Execution 来源，并复算语义 Hash", () => {
    const pass = result("PASS");
    const runReuse = result("PASS", {
      sourceKind: "RUN",
      sourceId: SOURCE_ID,
      sourceResultHash: pass.evalResultHash
    });
    const executionReuse = result("PASS", {
      sourceKind: "EXECUTION",
      sourceId: SOURCE_ID,
      sourceResultHash: pass.evalResultHash
    });

    expect(mapPlatformEvalResult(row(result("NOT_EVALUATED")))).toMatchObject({
      status: "NOT_EVALUATED",
      rawEvidence: null,
      provenance: null
    });
    expect(mapPlatformEvalResult(row(runReuse)).provenance).toEqual(runReuse.provenance);
    expect(mapPlatformEvalResult(row(executionReuse)).provenance).toEqual(
      executionReuse.provenance
    );
  });

  it("拒绝非法 JSON、非法状态形状、冲突来源和语义 Hash 篡改", () => {
    const valid = row(result("PASS"));
    expect(() => mapPlatformEvalResult({ ...valid, assertion_results_json: "{" })).toThrow();
    expect(() => mapPlatformEvalResult({ ...valid, promptfoo_success: 0 })).toThrow();
    expect(() => mapPlatformEvalResult({ ...valid, reused_from_run_id: SOURCE_ID })).toThrow();
    expect(() =>
      mapPlatformEvalResult({
        ...valid,
        reused_from_run_id: SOURCE_ID,
        reused_from_execution_id: SOURCE_ID,
        reused_eval_result_hash: valid.eval_result_hash
      })
    ).toThrow();
    expect(() =>
      mapPlatformEvalResult({ ...valid, final_case_result_hash: "d".repeat(64) })
    ).toThrow();
    expect(() =>
      evalResultInsertValues({ ...result("PASS"), evalResultHash: "d".repeat(64) })
    ).toThrow();
  });
});
