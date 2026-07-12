import { describe, expect, it } from "vitest";

import { AnalysisInputV1Schema, AnalysisOutputV1Schema } from "../src/analysis-contracts.ts";

const HASH = "a".repeat(64);

describe("Analysis Input/Output v1", () => {
  it("输入身份包含结构化变量、结果、上下文、Prompt、Analyzer、版本和限制", () => {
    const value = {
      contractVersion: "cortex.analysis-input.v1",
      caseKey: "case-1",
      variables: {
        case_definition: {},
        provider_output: {},
        failed_assertions: [],
        expected_actual_diffs: [],
        llm_rubric_results: [],
        run_context: {}
      },
      finalCaseResultHash: HASH,
      runContextHash: HASH,
      diffContractVersion: "cortex.assertion-diff.v1",
      analysisPromptHash: HASH,
      analyzerConfigHash: HASH,
      analysisOutputContractVersion: "cortex.analysis-output.v1",
      analysisExecutionLimits: {
        contractVersion: "cortex.analysis-execution-limits.v1",
        analysisConcurrency: 1
      }
    };
    expect(AnalysisInputV1Schema.parse(value).caseKey).toBe("case-1");
  });

  it("输出是严格分类与单一 Proposal 判别联合", () => {
    const output = {
      contractVersion: "cortex.analysis-output.v1",
      classification: "LABEL_ERROR",
      confidence: 0.8,
      evidence: ["标注冲突"],
      explanation: "预期与约束冲突",
      recommendedAction: "替换断言",
      proposal: {
        action: "REMOVE_ASSERTION",
        baseDefinitionHash: HASH,
        targetAssertionIndex: 0,
        targetAssertionDefinitionHash: HASH
      }
    };
    expect(AnalysisOutputV1Schema.parse(output).proposal?.action).toBe("REMOVE_ASSERTION");
    expect(
      AnalysisOutputV1Schema.safeParse({
        ...output,
        proposal: { ...output.proposal, assertion: {} }
      }).success
    ).toBe(false);
  });
});
