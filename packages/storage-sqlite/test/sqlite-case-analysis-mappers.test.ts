import type { AnalysisResultDraft } from "@cortex-eval/domain/src/domain-analysis.ts";
import { analysisProposalJson } from "@cortex-eval/domain/src/domain-analysis-projection.ts";
import { canonicalJson } from "@cortex-eval/domain/src/domain-canonical-hash.ts";
import { hashAnalysisResult } from "@cortex-eval/domain/src/domain-hash-inputs.ts";
import { describe, expect, it } from "vitest";

import {
  mapCurrentCaseAnalysis,
  type CaseAnalysisRow
} from "../src/sqlite-case-analysis-mappers.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const TIME = "2026-07-15T00:00:00.000Z";

const output: AnalysisResultDraft = {
  classification: "NORMAL_FAILURE",
  confidence: 0.8,
  evidence: [{ source: "failed_assertions", fieldPath: "/0", conclusion: "断言失败" }],
  explanation: "结果不满足约束",
  recommendedAction: "修复系统"
};

function resultHash(value: AnalysisResultDraft): string {
  return hashAnalysisResult({
    contractVersion: "cortex.analysis-result.v1",
    caseKey: "case-1",
    finalCaseResultHash: HASH_A,
    analysisInputHash: HASH_B,
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

function succeededRow(): CaseAnalysisRow {
  return {
    id: "01900000-0000-7000-8000-000000000001",
    run_id: "01900000-0000-7000-8000-000000000002",
    case_key: "case-1",
    final_case_result_hash: HASH_A,
    analysis_revision: 3,
    analysis_prompt_key: "analysis",
    analysis_prompt_hash: HASH_A,
    analysis_prompt_snapshot_json: "{}",
    analysis_prompt_id: null,
    analyzer_config_hash: HASH_C,
    analyzer_config_id: null,
    analyzer_provider: "OPENAI_COMPATIBLE",
    analyzer_model: "analyzer",
    analyzer_snapshot_json: "{}",
    analysis_input_contract_version: "cortex.analysis-input.v1",
    analysis_output_contract_version: "cortex.analysis-output.v1",
    analysis_input_hash: HASH_B,
    analysis_execution_limits_json:
      '{"analysisConcurrency":1,"contractVersion":"cortex.analysis-execution-limits.v1"}',
    analysis_status: "SUCCEEDED",
    classification: output.classification,
    confidence: output.confidence,
    evidence_json: canonicalJson(output.evidence.map((item) => ({ ...item }))),
    explanation: output.explanation,
    recommended_action: output.recommendedAction,
    proposal_json: null,
    decision: "NO_PROPOSAL",
    apply_status: "NOT_APPLICABLE",
    base_definition_hash: null,
    applied_definition_hash: null,
    analysis_result_hash: resultHash(output),
    error_code: null,
    error_message: null,
    created_at: TIME,
    updated_at: TIME
  };
}

describe("SQLite Case Analysis mapper", () => {
  it("重算成功与错误 Result Hash，拒绝持久层伪造的终态身份", () => {
    expect(mapCurrentCaseAnalysis(succeededRow()).analysisResultHash).toBe(resultHash(output));
    expect(() =>
      mapCurrentCaseAnalysis({ ...succeededRow(), analysis_result_hash: HASH_C })
    ).toThrow("SQLITE_ROW_INVALID");

    const errorCode = "ANALYZER_OUTPUT_INVALID";
    const errorHash = hashAnalysisResult({
      contractVersion: "cortex.analysis-result.v1",
      caseKey: "case-1",
      finalCaseResultHash: HASH_A,
      analysisInputHash: HASH_B,
      result: { status: "ERROR", errorCode }
    });
    const errorRow: CaseAnalysisRow = {
      ...succeededRow(),
      analysis_status: "ERROR",
      classification: null,
      confidence: null,
      evidence_json: null,
      explanation: null,
      recommended_action: null,
      analysis_result_hash: errorHash,
      error_code: errorCode,
      error_message: "Analyzer 输出结构无效"
    };
    expect(mapCurrentCaseAnalysis(errorRow).analysisResultHash).toBe(errorHash);
    expect(() => mapCurrentCaseAnalysis({ ...errorRow, error_message: "   " })).toThrow(
      "SQLITE_ROW_INVALID"
    );
  });

  it("拒绝 Proposal 与 Decision、Apply Status、Base/Applied Hash 的矛盾组合", () => {
    expect(() =>
      mapCurrentCaseAnalysis({
        ...succeededRow(),
        decision: "PENDING",
        apply_status: "NOT_APPLIED"
      })
    ).toThrow("SQLITE_ROW_INVALID");

    const proposal = {
      action: "ADD_ASSERTION" as const,
      baseDefinitionHash: HASH_A,
      targetAssertionIndex: 0,
      assertion: { type: "equals", metric: "quality", weight: 1, value: "ok" }
    };
    const withProposal: AnalysisResultDraft = { ...output, proposal };
    const proposalRow: CaseAnalysisRow = {
      ...succeededRow(),
      proposal_json: canonicalJson(proposal),
      base_definition_hash: HASH_A,
      decision: "PENDING",
      apply_status: "NOT_APPLIED",
      analysis_result_hash: resultHash(withProposal)
    };
    expect(mapCurrentCaseAnalysis(proposalRow).decision).toBe("PENDING");
    for (const dirty of [
      { ...proposalRow, decision: "NO_PROPOSAL" as const, apply_status: "NOT_APPLICABLE" as const },
      { ...proposalRow, base_definition_hash: HASH_C },
      {
        ...proposalRow,
        decision: "ACCEPTED" as const,
        apply_status: "APPLIED" as const,
        applied_definition_hash: null
      },
      {
        ...proposalRow,
        decision: "EDITED_AND_ACCEPTED" as const,
        apply_status: "CONFLICT" as const,
        applied_definition_hash: HASH_C
      }
    ]) {
      expect(() => mapCurrentCaseAnalysis(dirty)).toThrow("SQLITE_ROW_INVALID");
    }
  });

  it("拒绝非法终态 Hash、错误字段、契约版本和非成功应用字段", () => {
    expect(() => mapCurrentCaseAnalysis({ ...succeededRow(), explanation: null })).toThrow(
      "SQLITE_ROW_INVALID"
    );
    expect(() => mapCurrentCaseAnalysis({ ...succeededRow(), analysis_revision: 0 })).toThrow(
      "SQLITE_ROW_INVALID"
    );
    expect(() =>
      mapCurrentCaseAnalysis({ ...succeededRow(), analysis_result_hash: "not-a-hash" })
    ).toThrow("SQLITE_ROW_INVALID");
    expect(() =>
      mapCurrentCaseAnalysis({ ...succeededRow(), error_code: "ANALYZER_OUTPUT_INVALID" })
    ).toThrow("SQLITE_ROW_INVALID");
    expect(() =>
      mapCurrentCaseAnalysis({
        ...succeededRow(),
        analysis_output_contract_version: "cortex.analysis-output.v2"
      })
    ).toThrow("SQLITE_ROW_INVALID");

    const errorCode = "ANALYZER_OUTPUT_INVALID";
    const errorHash = hashAnalysisResult({
      contractVersion: "cortex.analysis-result.v1",
      caseKey: "case-1",
      finalCaseResultHash: HASH_A,
      analysisInputHash: HASH_B,
      result: { status: "ERROR", errorCode }
    });
    expect(() =>
      mapCurrentCaseAnalysis({
        ...succeededRow(),
        analysis_status: "ERROR",
        classification: null,
        confidence: null,
        evidence_json: null,
        explanation: null,
        recommended_action: null,
        applied_definition_hash: HASH_C,
        analysis_result_hash: errorHash,
        error_code: errorCode,
        error_message: "结构错误"
      })
    ).toThrow("SQLITE_ROW_INVALID");
  });
});
