import type { DashboardCase } from "./run-dashboard-model.ts";
import { modelCalls, object, payload, records, text } from "./run-evidence-model.ts";

function identifier(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

export function traceModelId(call: Record<string, unknown>, index: number): string {
  return `case-model-${encodeURIComponent(identifier(call.req_id))}-${encodeURIComponent(identifier(call.call_id) || `index-${index}`)}`;
}
export function traceStepId(step: Record<string, unknown>): string {
  return `case-step-${step.req_id ? `${encodeURIComponent(identifier(step.req_id))}-` : ""}${encodeURIComponent(identifier(step.step_id))}`;
}
/** Same actual audit call appears once in Trace and the cost table. Conflicting usage stays flagged in the aggregate. */
export function uniqueModelCalls(row: DashboardCase): Record<string, unknown>[] {
  const seen = new Set<string>();
  return modelCalls(row).filter((call) => {
    if (typeof call.call_id !== "string" && typeof call.call_id !== "number") return true;
    const key = `${identifier(call.req_id)}/${String(call.call_id)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
export function duration(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value < 1000
      ? `${Math.round(value)} ms`
      : `${(value / 1000).toFixed(2)} s`
    : "未采集";
}
/** Only translate explicit recorded component names; never infer a component from output text. */
export function stageName(value: string): string {
  const known: Record<string, string> = {
    router: "router",
    planner: "planner",
    responsegate: "ResponseGate"
  };
  return known[value.replace(/[_\s-]/g, "").toLowerCase()] ?? value;
}
export function recordedStage(record: Record<string, unknown>): string | null {
  const value = text(record.stage) ?? text(record.component) ?? text(record.task);
  return value ? stageName(value) : null;
}
export function modelRole(call: Record<string, unknown>): string {
  return recordedStage(call) ?? "环节未记录";
}
export interface ToolTiming {
  readonly name: string;
  readonly target: string;
  readonly durationMs: number | null;
}
/** Only calculate intervals from a unique, explicitly linked start and terminal pair. */
export function toolTimings(row: DashboardCase): ToolTiming[] {
  const p = payload(row),
    timeline = records(p.timeline);
  return records(p.tool_executions).map((execution) => {
    const starts = timeline.filter(
      (s) => s.step_id === execution.call_step_id && typeof s.step_id === "string"
    );
    const ids = Array.isArray(execution.terminal_step_ids) ? execution.terminal_step_ids : [];
    const ends = timeline.filter((s) => ids.includes(s.step_id));
    const start = starts.length === 1 ? starts[0] : undefined,
      end = ends.length === 1 ? ends[0] : undefined;
    const from = Date.parse(text(start?.created_at) ?? ""),
      to = Date.parse(text(end?.created_at) ?? "");
    const sameRequest = typeof start?.req_id === "string" && start.req_id === end?.req_id;
    const sameTool =
      object(object(start?.payload).tool_call).tool_request_id === execution.tool_request_id &&
      object(object(end?.payload).tool_ret).tool_request_id === execution.tool_request_id &&
      typeof execution.tool_request_id === "string";
    return {
      name:
        records(execution.calls)
          .map((c) => text(c.name) ?? "工具")
          .join("、") || "工具执行",
      target: start ? traceStepId(start) : "",
      durationMs:
        sameRequest && sameTool && Number.isFinite(from) && Number.isFinite(to) && to >= from
          ? to - from
          : null
    };
  });
}

/** An explicit step link is usable only within a compatible request and when unique. */
export function relatedModelStep(
  call: Record<string, unknown>,
  steps: readonly Record<string, unknown>[]
): Record<string, unknown> | undefined {
  const related = identifier(call.related_step_id);
  if (!related) return undefined;
  const matches = steps.filter(
    (step) =>
      identifier(step.step_id) === related &&
      (!identifier(call.req_id) ||
        !identifier(step.req_id) ||
        identifier(call.req_id) === identifier(step.req_id))
  );
  return matches.length === 1 ? matches[0] : undefined;
}
