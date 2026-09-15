import type { PlatformRunDetail } from "../../lib/run-api.ts";

/** One pipeline stage rendered by the progress tracker, in execution order. */
export type RunStageKey = "REST" | "EVALUATION" | "REPORT" | "DONE";

/** Visual state of one stage: finished, in flight, not reached, or stopped by a terminal fault. */
export type RunStageState = "DONE" | "ACTIVE" | "PENDING" | "BLOCKED";

/** Colour tone derived only from the persisted Run status. */
export type RunProgressTone = "idle" | "running" | "success" | "warning" | "danger";

/** Persisted progress facts shared by Run detail and Run list projections. */
export interface RunProgressInput {
  readonly status: PlatformRunDetail["status"];
  readonly stage: PlatformRunDetail["stage"];
  readonly rest: PlatformRunDetail["rest"];
  readonly evaluation: PlatformRunDetail["evaluation"];
  readonly cancelRequestedAt: string | null;
  readonly startedAt?: string | null | undefined;
  readonly completedAt?: string | null | undefined;
}

/** One stage row: measured counters plus the derived visual state. */
export interface RunStageProgress {
  readonly key: RunStageKey;
  readonly label: string;
  readonly hint: string;
  readonly state: RunStageState;
  readonly completed: number;
  readonly total: number;
  readonly ratio: number;
  readonly detail: string | null;
}

/** Complete progress picture for one Run, derived from persisted facts only. */
export interface RunProgressSnapshot {
  readonly stages: readonly RunStageProgress[];
  readonly activeIndex: number;
  readonly active: RunStageProgress;
  readonly tone: RunProgressTone;
  readonly stagePercent: number;
  readonly overallPercent: number;
  readonly headline: string;
  readonly subline: string;
  readonly cancelRequested: boolean;
}

const STAGE_ORDER: readonly RunStageKey[] = ["REST", "EVALUATION", "REPORT", "DONE"];

const STAGE_LABELS: Readonly<Record<RunStageKey, string>> = {
  REST: "执行",
  EVALUATION: "评测",
  REPORT: "报告",
  DONE: "完成"
};

const STAGE_HINTS: Readonly<Record<RunStageKey, string>> = {
  REST: "调用 Agent，采集出站证据",
  EVALUATION: "Judge 逐条打分",
  REPORT: "汇总生成报告",
  DONE: "结果已归档"
};

const BLOCKED_STATUSES: ReadonlySet<PlatformRunDetail["status"]> = new Set([
  "FAILED",
  "CANCELLED",
  "INTERRUPTED"
]);

const BLOCKED_LABELS: Readonly<Record<string, string>> = {
  FAILED: "执行失败",
  CANCELLED: "已取消",
  INTERRUPTED: "已中断"
};

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function counterRatio(completed: number, total: number, passed: boolean): number {
  if (total > 0) return clampRatio(completed / total);
  return passed ? 1 : 0;
}

// Measure one stage from persisted counters; REPORT and DONE are single-step stages.
function measureStage(
  key: RunStageKey,
  run: RunProgressInput,
  hasReport: boolean,
  activeIndex: number,
  succeeded: boolean
): { readonly completed: number; readonly total: number; readonly ratio: number } {
  if (succeeded) return { completed: 1, total: 1, ratio: 1 };
  if (key === "REST")
    return {
      completed: run.rest.completed,
      total: run.rest.total,
      ratio: counterRatio(run.rest.completed, run.rest.total, activeIndex > 0)
    };
  if (key === "EVALUATION")
    return {
      completed: run.evaluation.completed,
      total: run.evaluation.total,
      ratio: counterRatio(run.evaluation.completed, run.evaluation.total, activeIndex > 1)
    };
  if (key === "REPORT") {
    const done = hasReport || activeIndex > 2;
    return { completed: done ? 1 : 0, total: 1, ratio: done ? 1 : 0 };
  }
  return { completed: 0, total: 1, ratio: 0 };
}

/** Build the complete stage picture from persisted Run facts; nothing is inferred from wall-clock time. */
export function runProgressSnapshot(
  run: RunProgressInput,
  hasReport: boolean
): RunProgressSnapshot {
  const activeIndex = Math.max(0, STAGE_ORDER.indexOf(run.stage));
  const succeeded = run.status === "COMPLETED" || run.status === "COMPLETED_WITH_ERRORS";
  const blocked = BLOCKED_STATUSES.has(run.status);
  const stages: RunStageProgress[] = STAGE_ORDER.map((key, index) => {
    const measured = measureStage(key, run, hasReport, activeIndex, succeeded);
    const state: RunStageState = succeeded
      ? "DONE"
      : index < activeIndex
        ? "DONE"
        : index === activeIndex
          ? blocked
            ? "BLOCKED"
            : "ACTIVE"
          : "PENDING";
    const ratio = state === "DONE" ? 1 : state === "PENDING" ? 0 : measured.ratio;
    const detail =
      measured.total > 1
        ? `${measured.completed}/${measured.total}`
        : state === "BLOCKED"
          ? "已停止"
          : ratio === 1
            ? "已完成"
            : null;
    return {
      key,
      label: STAGE_LABELS[key],
      hint: STAGE_HINTS[key],
      state,
      completed: measured.completed,
      total: measured.total,
      ratio,
      detail
    };
  });
  const fallback: RunStageProgress = {
    key: "REST",
    label: STAGE_LABELS.REST,
    hint: STAGE_HINTS.REST,
    state: "PENDING",
    completed: 0,
    total: 0,
    ratio: 0,
    detail: null
  };
  const active = stages[activeIndex] ?? fallback;
  const tone: RunProgressTone =
    run.status === "RUNNING"
      ? run.cancelRequestedAt !== null
        ? "warning"
        : "running"
      : run.status === "COMPLETED"
        ? "success"
        : run.status === "COMPLETED_WITH_ERRORS"
          ? "warning"
          : run.status === "FAILED"
            ? "danger"
            : "idle";
  const headline = succeeded
    ? "已完成"
    : blocked
      ? `${BLOCKED_LABELS[run.status] ?? "已停止"} · 停在${active.label}`
      : run.status === "RUNNING"
        ? `正在${active.label}`
        : `等待开始 · ${active.label}`;
  const overallPercent = Math.round(
    (stages.reduce((sum, stage) => sum + stage.ratio, 0) / stages.length) * 100
  );
  return {
    stages,
    activeIndex,
    active,
    tone,
    stagePercent: Math.round(active.ratio * 100),
    overallPercent,
    headline,
    subline: `阶段 ${activeIndex + 1}/${stages.length} · ${active.detail ?? active.hint}`,
    cancelRequested: run.cancelRequestedAt !== null
  };
}

/** Elapsed wall-clock span of one Run in ms; null when the Run never started or has no timestamps. */
export function runElapsedMs(run: RunProgressInput, nowMs: number): number | null {
  if (run.startedAt === undefined || run.startedAt === null) return null;
  const start = Date.parse(run.startedAt);
  if (Number.isNaN(start)) return null;
  const endedAt =
    run.completedAt === undefined || run.completedAt === null ? nowMs : Date.parse(run.completedAt);
  if (Number.isNaN(endedAt)) return null;
  return Math.max(0, endedAt - start);
}

/** Remaining-time estimate for the execution stage only, from its own measured throughput. */
export function runRemainingEstimateMs(run: RunProgressInput, nowMs: number): number | null {
  if (run.status !== "RUNNING" || run.stage !== "REST") return null;
  const elapsed = runElapsedMs(run, nowMs);
  if (elapsed === null || elapsed <= 0) return null;
  const { completed, total } = run.rest;
  if (completed < 1 || total <= completed) return null;
  return Math.round((elapsed / completed) * (total - completed));
}

/** Format one duration as a stable tabular clock string. */
export function formatRunDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}
