import { describe, expect, it } from "vitest";

import { generateBenchmarkCases } from "../src/deterministic-cases.ts";

describe("确定性 Benchmark 数据", () => {
  it("使用相同 Seed 生成稳定的 1,000 Case", () => {
    const first = generateBenchmarkCases(1_000, 20260713);
    const second = generateBenchmarkCases(1_000, 20260713);
    expect(first).toEqual(second);
    expect(first).toHaveLength(1_000);
    expect(new Set(first.map((testCase) => testCase.metadata.case_id)).size).toBe(1_000);
  });

  it("拒绝负数和非整数 Case 数", () => {
    expect(() => generateBenchmarkCases(-1, 1)).toThrow("BENCHMARK_CASE_COUNT");
    expect(() => generateBenchmarkCases(1.5, 1)).toThrow("BENCHMARK_CASE_COUNT");
  });
});
