import { describe, expect, it } from "vitest";

import {
  buildAnalysisInput,
  selectAnalysisCases,
  type AnalysisCaseFacts
} from "../src/features/case-analysis/case-analysis-input-builder.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function analysisCase(status: AnalysisCaseFacts["evaluation"]["status"]): AnalysisCaseFacts {
  return {
    caseKey: `case-${status.toLowerCase()}`,
    ordinal: status === "FAIL" ? 1 : status === "EVALUATION_ERROR" ? 3 : 5,
    definitionHash: HASH_A,
    definition: {
      caseKey: `case-${status.toLowerCase()}`,
      description: "分析输入",
      threshold: 1,
      task: "reply",
      requestBody: { text: "hello" },
      metadata: {
        requestId: "req-1",
        taskId: "task-1",
        businessModule: "support",
        scenarioTag: "reply"
      },
      assertions: [
        { type: "equals", metric: "quality", weight: 1, value: "ok" },
        {
          type: "llm-rubric",
          metric: "tone",
          weight: 1,
          rubricPrompt: "prompt://tone"
        }
      ]
    },
    providerOutput: {
      ok: true,
      taskName: "reply",
      resolvedConfig: { tool: "search" },
      parsedOutput: { answer: "wrong" }
    },
    evaluation: {
      status,
      finalCaseResultHash: HASH_B,
      assertions: [
        {
          index: 0,
          definitionHash: HASH_A,
          type: "equals",
          metric: "quality",
          weight: 1,
          status: "FAIL",
          score: 0,
          reason: "mismatch"
        },
        {
          index: 1,
          definitionHash: HASH_C,
          type: "llm-rubric",
          metric: "tone",
          weight: 1,
          status: "PASS",
          score: 1,
          reason: "ok"
        }
      ],
      diffs: [
        {
          assertionIndex: 0,
          instancePath: "/answer",
          schemaPath: "/const",
          keyword: "const",
          expectedConstraint: "ok",
          actual: "wrong",
          reason: "值不匹配",
          validatorVersion: "8.17.1",
          schemaDialect: "https://json-schema.org/draft/2020-12/schema",
          diffContractVersion: "cortex.assertion-diff.v1"
        }
      ]
    }
  };
}

describe("Case Analysis Input Builder", () => {
  it("Selector 只选择可分析状态并保持冻结 Ordinal", () => {
    const cases = [
      analysisCase("PASS"),
      analysisCase("EVALUATION_ERROR"),
      analysisCase("FAIL"),
      analysisCase("NOT_EVALUATED")
    ];
    expect(selectAnalysisCases(cases, "failed").map((item) => item.evaluation.status)).toEqual([
      "FAIL"
    ]);
    expect(selectAnalysisCases(cases, "errors").map((item) => item.evaluation.status)).toEqual([
      "EVALUATION_ERROR"
    ]);
    expect(selectAnalysisCases(cases, "all").map((item) => item.ordinal)).toEqual([1, 3]);
  });

  it("构造完整脱敏变量并把 Case、Prompt、Analyzer、结果和限制纳入输入身份", () => {
    const source = analysisCase("FAIL");
    const built = buildAnalysisInput({
      source,
      runContextHash: HASH_A,
      runContext: {
        owner: { kind: "RUN", id: "01900000-0000-7000-8000-000000000001" },
        run_context_hash: HASH_A
      },
      analysisPromptHash: HASH_B,
      analyzerConfigHash: HASH_C,
      analysisExecutionLimits: {
        contractVersion: "cortex.analysis-execution-limits.v1",
        analysisConcurrency: 1
      }
    });

    expect(built.input).toMatchObject({
      contractVersion: "cortex.analysis-input.v1",
      caseKey: source.caseKey,
      finalCaseResultHash: HASH_B,
      runContextHash: HASH_A,
      diffContractVersion: "cortex.assertion-diff.v1",
      analysisOutputContractVersion: "cortex.analysis-output.v1"
    });
    expect(built.input.variables.case_definition).toMatchObject({
      contractVersion: "cortex.case-definition.v1",
      metadata: { case_id: source.caseKey }
    });
    expect(built.input.variables.failed_assertions).toHaveLength(1);
    expect(built.input.variables.llm_rubric_results).toHaveLength(1);
    expect(built.input.variables.expected_actual_diffs).toHaveLength(1);
    expect(built.analysisInputHash).toMatch(/^[0-9a-f]{64}$/);

    expect(
      buildAnalysisInput({
        source,
        runContextHash: HASH_A,
        runContext: {},
        analysisPromptHash: HASH_B,
        analyzerConfigHash: HASH_C,
        analysisExecutionLimits: {
          contractVersion: "cortex.analysis-execution-limits.v1",
          analysisConcurrency: 2
        }
      }).analysisInputHash
    ).not.toBe(built.analysisInputHash);
  });
});
