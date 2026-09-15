import { expect, it } from "vitest";
import { executionIssue } from "../src/features/runs/run-execution-issue.ts";
import { evidenceRow } from "./run-case-drawer-fixture.ts";
import type { DashboardCase } from "../src/features/runs/run-dashboard-model.ts";

function failed(code: string): DashboardCase {
  const row = evidenceRow({});
  if (row.rest.status !== "SUCCEEDED") throw new Error("FIXTURE_INVALID");
  return { ...row, rest: { ...row.rest, providerOutput: { ok: false, err_msg: code } } };
}
it("does not mistake a successful response for an ingress failure", () => {
  expect(executionIssue(evidenceRow({}))).toBeNull();
});
it("explains multi-turn setup failure without hiding its original code", () => {
  const issue = executionIssue(failed("EVAL_E2E_CONTEXT_MODE_REQUIRED"));
  expect(issue).toContain("未执行");
  expect(issue).toContain("EVAL_E2E_CONTEXT_MODE_REQUIRED");
});
it("keeps partial execution and cancellation limitations explicit", () => {
  expect(executionIssue(failed("EVAL_E2E_MULTI_TURN_INCOMPLETE"))).toContain("部分结果");
  expect(executionIssue(failed("EVAL_E2E_TIMEOUT"))).toContain("不等于");
});
it("preserves unknown errors without fabricating attribution", () => {
  expect(executionIssue(failed("UNKNOWN_FAILURE"))).toContain("UNKNOWN_FAILURE");
});
