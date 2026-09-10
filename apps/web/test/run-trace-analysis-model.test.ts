import { expect, it } from "vitest";
import { relatedModelStep, traceStepId } from "../src/features/runs/run-call-model.ts";
import { traceBranches } from "../src/features/runs/run-evidence-model.ts";
import { traceAnalysisOverlay } from "../src/features/runs/run-trace-analysis-model.ts";
import { evidenceRow } from "./run-case-drawer-fixture.ts";
import { traceAnalysisFixture } from "./run-trace-analysis-fixture.ts";
import { RUN_ID } from "./run-test-fixture.ts";
const step = { req_id: "turn-1", step_id: "s1", payload: { tool_call: { name: "query" } } };

it("only resolves present Analyzer-input JSON pointers and never mutates the verdict", () => {
  const row = evidenceRow({ timeline: [step] }),
    analysis = traceAnalysisFixture(row);
  const before = JSON.stringify(row);
  const overlay = traceAnalysisOverlay(row, RUN_ID, analysis);
  expect([...overlay.byNode.keys()]).toEqual([traceStepId(step)]);
  expect(JSON.stringify(row)).toBe(before);
  for (const fieldPath of [
    "/parsedOutput/timeline/9",
    "/parsedOutput/timeline/0/missing",
    "/parsed_output/timeline/0",
    "/parsedOutput",
    "/parsedOutput/timeline/01",
    null
  ]) {
    const result = traceAnalysisOverlay(row, RUN_ID, {
      ...analysis,
      output: { ...analysis.output!, evidence: [{ ...analysis.output!.evidence[0]!, fieldPath }] }
    });
    expect(result.byNode.size).toBe(0);
    expect(result.unlinked).toHaveLength(1);
  }
});
it("stale or wrong-run analyses and Analyzer errors do not mark current nodes", () => {
  const row = evidenceRow({ timeline: [step] }),
    analysis = traceAnalysisFixture(row);
  for (const patch of [
    { finalCaseResultHash: "b".repeat(64) },
    { caseKey: "other" },
    { runId: "other" }
  ]) {
    expect(traceAnalysisOverlay(row, RUN_ID, { ...analysis, ...patch })).toMatchObject({
      state: "stale",
      byNode: new Map()
    });
  }
  expect(traceAnalysisOverlay(row, RUN_ID, { ...analysis, status: "ERROR" }).byNode.size).toBe(0);
});
it("model linkage is request-aware, unique, and never guessed from a stage", () => {
  const other = { ...step, req_id: "turn-2" };
  expect(relatedModelStep({ related_step_id: "s1", req_id: "turn-2" }, [step, other])).toBe(other);
  expect(relatedModelStep({ related_step_id: "s1" }, [step, other])).toBeUndefined();
  expect(relatedModelStep({ task: "planner", req_id: "turn-1" }, [step])).toBeUndefined();
  expect(relatedModelStep({ related_step_id: "s1", req_id: "turn-3" }, [step])).toBeUndefined();
  expect(traceStepId(step)).not.toBe(traceStepId(other));
  const parent = { req_id: "turn-1", call_id: 1 },
    wrongChild = { req_id: "turn-2", call_id: 2, parent_call_id: 1 };
  expect(traceBranches([parent, wrongChild], "call_id", "parent_call_id")).toHaveLength(2);
});
it("maps each evidence kind and rejects conflicting duplicate audit copies", () => {
  const row = evidenceRow({
    llm_calls: [
      { call_id: 1, output: "first" },
      { call_id: 1, output: "conflict" }
    ],
    tool_executions: [{ status: "FAILED" }],
    route: { decision: "NEW" },
    coverage: { truncated: false }
  });
  const analysis = traceAnalysisFixture(row);
  const paths = [
    "/parsedOutput/llm_calls/0/output",
    "/parsedOutput/llm_calls/1/output",
    "/parsedOutput/tool_executions/0/status",
    "/parsedOutput/route/decision",
    "/parsedOutput/coverage/truncated"
  ];
  const result = traceAnalysisOverlay(row, RUN_ID, {
    ...analysis,
    output: {
      ...analysis.output!,
      evidence: paths.map((fieldPath) => ({
        source: "provider_output",
        fieldPath,
        conclusion: "check"
      }))
    }
  });
  expect([...result.byNode.keys()]).toEqual([
    "case-model--1",
    "case-tool-execution-0",
    "case-route",
    "case-trace-coverage"
  ]);
  expect(result.unlinked).toHaveLength(1);
});
