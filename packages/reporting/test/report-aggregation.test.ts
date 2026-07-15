import { describe, expect, it } from "vitest";

import {
  createReportAccumulator,
  type ReportAccumulator,
  type ReportCaseFacts
} from "../src/report-aggregation.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const OWNER = {
  kind: "EXECUTION" as const,
  id: "018f1e2d-3c4b-7abc-8def-0123456789ab"
};

function reportCase(
  ordinal: number,
  status: ReportCaseFacts["evaluation"]["status"],
  metricStatuses: readonly ReportCaseFacts["evaluation"]["metrics"][number]["status"][]
): ReportCaseFacts {
  const restStatus = status === "NOT_EVALUATED" ? "ERROR" : "SUCCEEDED";
  return {
    caseKey: `case-${ordinal}`,
    ordinal,
    rest: { status: restStatus, resultHash: HASH_A },
    evaluation: {
      status,
      evalResultHash: HASH_B,
      finalCaseResultHash: HASH_C,
      metrics: metricStatuses.map((metricStatus, index) => ({
        metric: index === 0 ? "quality" : "safety",
        status: metricStatus
      }))
    }
  };
}

function accumulator(caseKeys: readonly string[]): ReportAccumulator {
  return createReportAccumulator({
    owner: OWNER,
    runContextHash: HASH_A,
    evaluationContextHash: HASH_B,
    evaluationResultSetHash: HASH_C,
    expectedCaseKey: (ordinal) => caseKeys[ordinal] ?? null
  });
}

describe("流式报告聚合", () => {
  it("计算三种整体 Rate、独立错误计数和按 Metric 聚合", () => {
    const report = accumulator(["case-0", "case-1", "case-2", "case-3"]);
    report.add(reportCase(0, "PASS", ["PASS"]));
    report.add(reportCase(1, "FAIL", ["FAIL"]));
    report.add(reportCase(2, "EVALUATION_ERROR", ["ERROR"]));
    report.add(reportCase(3, "NOT_EVALUATED", ["NOT_EVALUATED"]));

    expect(report.finish()).toMatchObject({
      summary: {
        total: 4,
        restSucceeded: 3,
        restError: 1,
        evalPass: 1,
        evalFail: 1,
        evalError: 1,
        notEvaluated: 1,
        effectivePassRate: 0.25,
        evaluatedPassRate: 0.5,
        coverageRate: 0.5
      },
      byMetric: [
        {
          metric: "quality",
          pass: 1,
          fail: 1,
          error: 1,
          skipped: 0,
          notEvaluated: 1,
          passRate: 0.5
        }
      ]
    });
  });

  it("空的已评估与 Metric 分母保持 null", () => {
    const report = accumulator(["case-0"]);
    report.add(reportCase(0, "NOT_EVALUATED", ["NOT_EVALUATED"]));

    expect(report.finish()).toMatchObject({
      summary: {
        effectivePassRate: 0,
        evaluatedPassRate: null,
        coverageRate: 0
      },
      byMetric: [{ metric: "quality", passRate: null }]
    });
  });

  it("拒绝错序、重复 Metric 和 REST/Eval 状态矛盾", () => {
    const outOfOrder = accumulator(["case-0"]);
    expect(() => outOfOrder.add(reportCase(1, "PASS", ["PASS"]))).toThrow("REPORT_CASE_ALIGNMENT");

    const duplicateMetric = accumulator(["case-0"]);
    const original = reportCase(0, "FAIL", ["FAIL"]);
    const duplicated: ReportCaseFacts = {
      ...original,
      evaluation: {
        ...original.evaluation,
        metrics: [
          { metric: "quality", status: "FAIL" },
          { metric: "quality", status: "ERROR" }
        ]
      }
    };
    expect(() => duplicateMetric.add(duplicated)).toThrow("REPORT_METRIC_DUPLICATE");

    const contradictory = accumulator(["case-0"]);
    expect(() =>
      contradictory.add({
        ...reportCase(0, "NOT_EVALUATED", ["NOT_EVALUATED"]),
        rest: { status: "SUCCEEDED", resultHash: HASH_A }
      })
    ).toThrow("REPORT_RECONCILIATION_FAILED");
  });

  it("相同事实生成稳定哈希，执行身份或评估版本改变时哈希不同", () => {
    const first = accumulator(["case-0"]);
    first.add(reportCase(0, "PASS", ["PASS"]));
    const firstHash = first.finish().reportResultSetHash;

    const same = accumulator(["case-0"]);
    same.add(reportCase(0, "PASS", ["PASS"]));
    expect(same.finish().reportResultSetHash).toBe(firstHash);

    const anotherExecution = createReportAccumulator({
      owner: { ...OWNER, id: "018f1e2d-3c4b-7abc-8def-0123456789ac" },
      runContextHash: HASH_A,
      evaluationContextHash: HASH_B,
      evaluationResultSetHash: HASH_C,
      expectedCaseKey: (ordinal) => (ordinal === 0 ? "case-0" : null)
    });
    anotherExecution.add(reportCase(0, "PASS", ["PASS"]));
    expect(anotherExecution.finish().reportResultSetHash).not.toBe(firstHash);

    const anotherEvaluation = createReportAccumulator({
      owner: OWNER,
      runContextHash: HASH_A,
      evaluationContextHash: HASH_C,
      evaluationResultSetHash: HASH_B,
      expectedCaseKey: (ordinal) => (ordinal === 0 ? "case-0" : null)
    });
    anotherEvaluation.add(reportCase(0, "PASS", ["PASS"]));
    expect(anotherEvaluation.finish().reportResultSetHash).not.toBe(firstHash);
  });

  it("完成后拒绝继续追加或二次完成", () => {
    const report = accumulator(["case-0"]);
    report.add(reportCase(0, "PASS", ["PASS"]));
    report.finish();
    expect(() => report.add(reportCase(0, "PASS", ["PASS"]))).toThrow("REPORT_ALREADY_FINISHED");
    expect(() => report.finish()).toThrow("REPORT_ALREADY_FINISHED");
  });
});
