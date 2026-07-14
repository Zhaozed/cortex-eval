import { describe, expect, it } from "vitest";

import { aggregateCaseMetrics, aggregateMetrics, calculateRate } from "../src/domain-metrics.ts";

describe("Metric 聚合与 Rate", () => {
  it("同 Case 同 Metric 只贡献一次并按失败优先", () => {
    const summary = aggregateMetrics([
      { caseKey: "A", metric: "quality", status: "PASS" },
      { caseKey: "A", metric: "quality", status: "FAIL" },
      { caseKey: "B", metric: "quality", status: "ERROR" },
      { caseKey: "C", metric: "quality", status: "SKIPPED" },
      { caseKey: "D", metric: "quality", status: "NOT_EVALUATED" },
      { caseKey: "E", metric: "quality", status: "PASS" }
    ]);
    expect(summary).toEqual([
      {
        metric: "quality",
        pass: 1,
        fail: 1,
        error: 1,
        skipped: 1,
        notEvaluated: 1,
        passRate: 0.5
      }
    ]);
  });

  it("分母为零时 Rate 缺失", () => {
    expect(calculateRate(0, 0)).toBeNull();
    expect(calculateRate(1, 4)).toBe(0.25);
  });

  it("单 Case Metric 保留固定优先级并按名称稳定排序", () => {
    expect(
      aggregateCaseMetrics([
        { metric: "quality", status: "ERROR" },
        { metric: "quality", status: "FAIL" },
        { metric: "accuracy", status: "PASS" },
        { metric: "accuracy", status: "SKIPPED" }
      ])
    ).toEqual([
      { metric: "accuracy", status: "PASS" },
      { metric: "quality", status: "FAIL" }
    ]);
  });
});
