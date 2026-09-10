import type { RunReview } from "@cortex-eval/contracts/src/run-review-contracts.ts";
import type { DashboardCase } from "../src/features/runs/run-dashboard-model.ts";
import { runReportCase, RUN_ID } from "./run-test-fixture.ts";
export function evidenceRow(p: Record<string, unknown>): DashboardCase {
  return {
    ...runReportCase,
    report: runReportCase,
    rest: {
      ...runReportCase.rest,
      status: "SUCCEEDED",
      httpStatus: 200,
      providerOutput: {
        ok: true,
        task_name: "EVAL_E2E",
        resolved_config: {},
        parsed_output: { schema_version: 1, ...p }
      }
    }
  };
}
export function reviewFixture(overrides: Partial<RunReview> = {}): RunReview {
  return {
    runId: RUN_ID,
    caseKey: "case-1",
    evidenceHash: "a".repeat(64),
    revision: 0,
    capture: "NOT_COLLECTED",
    captureNote: "",
    images: [],
    history: [],
    ...overrides
  };
}
