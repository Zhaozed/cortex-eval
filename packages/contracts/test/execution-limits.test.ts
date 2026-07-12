import { describe, expect, it } from "vitest";

import {
  AnalysisExecutionLimitsV1Schema,
  DEFAULT_ANALYSIS_EXECUTION_LIMITS_V1,
  DEFAULT_RUN_EXECUTION_LIMITS_V1,
  RunExecutionLimitsV1Schema
} from "../src/execution-limit-contracts.ts";

describe("执行限制契约", () => {
  it("冻结默认值和边界", () => {
    expect(DEFAULT_RUN_EXECUTION_LIMITS_V1).toEqual({
      contractVersion: "cortex.run-execution-limits.v1",
      restConcurrency: 4,
      evalConcurrency: 2
    });
    expect(DEFAULT_ANALYSIS_EXECUTION_LIMITS_V1).toEqual({
      contractVersion: "cortex.analysis-execution-limits.v1",
      analysisConcurrency: 1
    });
    expect(
      RunExecutionLimitsV1Schema.safeParse({
        contractVersion: "cortex.run-execution-limits.v1",
        restConcurrency: 1,
        evalConcurrency: 16
      }).success
    ).toBe(true);
    expect(
      RunExecutionLimitsV1Schema.safeParse({
        contractVersion: "cortex.run-execution-limits.v1",
        restConcurrency: 65,
        evalConcurrency: 2
      }).success
    ).toBe(false);
    expect(
      AnalysisExecutionLimitsV1Schema.safeParse({
        contractVersion: "cortex.analysis-execution-limits.v1",
        analysisConcurrency: 0
      }).success
    ).toBe(false);
  });
});
