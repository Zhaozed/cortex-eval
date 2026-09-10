import { describe, expect, it } from "vitest";
import {
  dashboardConfig,
  dashboardCounts,
  dashboardPages,
  evaluationState,
  executionState,
  judgeUsage,
  resultBucket,
  safeEndpointLocation,
  type DashboardCase
} from "../src/features/runs/run-dashboard-model.ts";
import { runDetail, runReportCase } from "./run-test-fixture.ts";

function row(): DashboardCase {
  return {
    caseKey: runReportCase.caseKey,
    ordinal: 0,
    rest: runReportCase.rest,
    definition: runReportCase.definition,
    evaluation: runReportCase.evaluation,
    report: runReportCase
  };
}

describe("Run dashboard facts", () => {
  it("does not equate HTTP success with evaluation pass", () => {
    const value = { ...row(), evaluation: undefined };
    expect(executionState(value)).toBe("COMPLETED");
    expect(evaluationState(value)).toBe("PENDING");
    expect(resultBucket(value)).toBe("PENDING");
  });
  it("partitions execution faults, judge errors, cancellation and remaining cases exactly once", () => {
    const base = row();
    const fault: DashboardCase = {
      ...base,
      caseKey: "fault",
      rest: {
        ...runReportCase.rest,
        status: "ERROR",
        httpStatus: null,
        providerOutput: null,
        error: { type: "TIMEOUT", message: "timeout" }
      }
    };
    const cancelled: DashboardCase = {
      ...fault,
      caseKey: "cancelled",
      rest: {
        ...runReportCase.rest,
        status: "ERROR",
        httpStatus: null,
        providerOutput: null,
        error: { type: "CANCELLED", message: "cancelled" }
      }
    };
    const judge: DashboardCase = {
      ...base,
      caseKey: "judge",
      evaluation: {
        ...runReportCase.evaluation,
        status: "EVALUATION_ERROR",
        score: null,
        reason: null,
        promptfooSuccess: null,
        evaluationError: { code: "EVALUATOR_TIMEOUT" }
      }
    };
    const counts = dashboardCounts(6, [base, fault, cancelled, judge]);
    expect(counts).toEqual({ PASS: 1, FAIL: 0, ERROR: 2, CANCELLED: 1, PENDING: 2 });
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(6);
    expect(evaluationState(fault)).toBe("PASS"); // retain evidence, never promote the faulty execution into overall success
    expect(evaluationState(judge)).toBe("EVALUATION_ERROR");
  });
  it("rejects duplicate records rather than manufacturing a total", () => {
    expect(() => dashboardCounts(3, [row(), row()])).toThrow("RUN_CASE_COUNTS_INVALID");
  });
  it("does not treat missing usage as collected zero", () => {
    const evaluation = runReportCase.evaluation;
    if (evaluation.status !== "PASS") throw new Error("EXPECTED_PASS_FIXTURE");
    expect(
      judgeUsage([{ ...row(), evaluation: { ...runReportCase.evaluation, tokenUsage: null } }])
    ).toMatchObject({ recorded: 0, total: 0, expected: 1 });
    expect(
      judgeUsage([
        {
          ...row(),
          evaluation: {
            ...evaluation,
            tokenUsage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 }
          }
        }
      ])
    ).toMatchObject({ recorded: 1, total: 5, input: 3, output: 2 });
  });
  it("excludes reused grader consumption from this Run", () => {
    const value = runReportCase.evaluation;
    if (value.status !== "PASS") throw new Error("EXPECTED_PASS_FIXTURE");
    expect(
      judgeUsage([
        {
          ...row(),
          evaluation: {
            ...value,
            tokenUsage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
            provenance: {
              sourceKind: "RUN",
              sourceId: runDetail().id,
              sourceResultHash: runDetail().suite.hash
            }
          }
        }
      ])
    ).toMatchObject({ recorded: 0, expected: 0, total: 0, reused: 1 });
  });
  it("redacts credentials and uses only stored snapshot versions", () => {
    const value = runDetail();
    const config = JSON.stringify(dashboardConfig(value));
    expect(config).not.toContain('"apiKey"');
    expect(config).not.toContain('"headers"');
    expect(config).toContain(value.suite.hash);
    expect(safeEndpointLocation("https://user:secret@example.com/api?q=secret#secret")).toBe(
      "https://example.com/api"
    );
  });
  it("reads subsequent pages and rejects cyclic cursors", async () => {
    expect(
      await dashboardPages((cursor) =>
        Promise.resolve({
          items: [cursor ?? "first"],
          nextCursor: cursor === null ? "second" : null
        })
      )
    ).toEqual(["first", "second"]);
    await expect(
      dashboardPages(() => Promise.resolve({ items: [], nextCursor: "loop" }))
    ).rejects.toThrow("RUN_CURSOR_CYCLE");
  });
});
