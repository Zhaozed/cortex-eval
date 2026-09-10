import type { CurrentCaseAnalysis } from "../../lib/run-api.ts";
import type { DashboardCase } from "./run-dashboard-model.ts";
import { payload, records } from "./run-evidence-model.ts";
import { traceModelId, traceStepId, uniqueModelCalls } from "./run-call-model.ts";

export type TraceAnalysisEvidence = NonNullable<CurrentCaseAnalysis["output"]>["evidence"][number];
export interface TraceAnalysisOverlay {
  readonly state: "absent" | "stale" | "pending" | "error" | "ready";
  readonly byNode: ReadonlyMap<string, readonly TraceAnalysisEvidence[]>;
  readonly unlinked: readonly TraceAnalysisEvidence[];
}
/** JSON Pointer must resolve in the actual Analyzer input, not a guessed UI projection. */
function pointerParts(root: unknown, pointer: string | null): string[] | null {
  if (!pointer?.startsWith("/") || /~(?:[^01]|$)/.test(pointer)) return null;
  const parts = pointer
    .slice(1)
    .split("/")
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let value = root;
  for (const part of parts) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, part)) return null;
    value = (value as Record<string, unknown>)[part];
  }
  return parts;
}
export function traceAnalysisOverlay(
  row: DashboardCase,
  runId: string,
  analysis: CurrentCaseAnalysis | null | undefined
): TraceAnalysisOverlay {
  const byNode = new Map<string, TraceAnalysisEvidence[]>();
  const empty = (state: TraceAnalysisOverlay["state"]): TraceAnalysisOverlay => ({
    state,
    byNode,
    unlinked: []
  });
  if (!analysis) return empty("absent");
  if (
    analysis.runId !== runId ||
    analysis.caseKey !== row.caseKey ||
    !row.evaluation?.finalCaseResultHash ||
    analysis.finalCaseResultHash !== row.evaluation.finalCaseResultHash
  )
    return empty("stale");
  if (analysis.status === "ERROR") return empty("error");
  if (analysis.status !== "SUCCEEDED" || !analysis.output) return empty("pending");
  const p = payload(row),
    calls = uniqueModelCalls(row),
    timeline = records(p.timeline);
  const rest = "providerOutput" in row.rest ? row.rest.providerOutput : undefined;
  // The analysis application uses camelCase, unlike the REST evidence wire protocol.
  const source = rest?.ok
    ? { ok: true, taskName: rest.task_name, resolvedConfig: rest.resolved_config, parsedOutput: p }
    : {};
  const unlinked: TraceAnalysisEvidence[] = [];
  for (const evidence of analysis.output.evidence) {
    const parts =
      evidence.source === "provider_output" ? pointerParts(source, evidence.fieldPath) : null;
    let nodeId: string | null = null;
    if (parts?.[0] === "parsedOutput" && parts[1]) {
      const group = parts[1],
        index = Number(parts[2]);
      const indexed = parts[2] !== undefined && /^(0|[1-9]\d*)$/.test(parts[2]);
      if (group === "timeline" && indexed && timeline[index]) {
        const step = timeline[index];
        const id = traceStepId(step);
        if (step.step_id === undefined || step.step_id === null)
          nodeId = `case-step-missing-${index}`;
        else if (timeline.filter((s) => traceStepId(s) === id).length === 1) nodeId = id;
      } else if (group === "llm_calls" && indexed) {
        const call = records(p.llm_calls)[index];
        // Conflicting duplicate audit records must not point at the retained first record.
        const callIndex = calls.findIndex((c) => c === call);
        if (call && callIndex >= 0) nodeId = traceModelId(call, callIndex);
      } else if (group === "tool_executions" && indexed && records(p.tool_executions)[index]) {
        nodeId = `case-tool-execution-${index}`;
      } else if (
        group === "route" &&
        !Array.isArray(p.route) &&
        p.route &&
        typeof p.route === "object" &&
        Object.keys(p.route).length
      ) {
        nodeId = "case-route";
      } else if (group === "causal_events" && records(p.causal_events).length)
        nodeId = "case-causal-events";
      else if (group === "coverage") nodeId = "case-trace-coverage";
    }
    if (nodeId) byNode.set(nodeId, [...(byNode.get(nodeId) ?? []), evidence]);
    else unlinked.push(evidence);
  }
  return { state: "ready", byNode, unlinked };
}
