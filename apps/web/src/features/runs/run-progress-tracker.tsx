import { useEffect, useState, type ReactElement } from "react";
import { Check, CircleAlert, LoaderCircle } from "lucide-react";
import type { PlatformRunDetail } from "../../lib/run-api.ts";
import {
  formatRunDuration,
  runElapsedMs,
  runProgressSnapshot,
  runRemainingEstimateMs,
  type RunStageProgress,
  type RunStageState
} from "./run-progress-model.ts";

/** Current wall-clock ms, ticking once per second only while the Run can still advance. */
function useNowMs(live: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return (): void => {
      clearInterval(timer);
    };
  }, [live]);
  return nowMs;
}

// One stage marker: a tick when finished, a spinner while in flight, a warning when stopped.
function StageIcon({ state }: { readonly state: RunStageState }): ReactElement {
  if (state === "DONE") return <Check size={12} aria-hidden="true" />;
  if (state === "ACTIVE")
    return <LoaderCircle size={12} aria-hidden="true" className="run-progress-spin" />;
  if (state === "BLOCKED") return <CircleAlert size={12} aria-hidden="true" />;
  return <span aria-hidden="true" />;
}

/** Full stage-by-stage evaluation progress for one Run detail page. */
export function RunProgressTracker({
  run,
  hasReport
}: {
  readonly run: PlatformRunDetail;
  readonly hasReport: boolean;
}): ReactElement {
  const live = run.status === "RUNNING" || run.status === "READY";
  const nowMs = useNowMs(live);
  const snapshot = runProgressSnapshot(run, hasReport);
  const elapsed = runElapsedMs(run, nowMs);
  const remaining = runRemainingEstimateMs(run, nowMs);
  const stageLabel = `阶段 ${snapshot.activeIndex + 1}/${snapshot.stages.length} ${snapshot.active.label}`;
  return (
    <section className="run-progress" data-tone={snapshot.tone} aria-label="评测进度">
      <header className="run-progress-head">
        <div className="run-progress-heading">
          <strong>{snapshot.headline}</strong>
          <span>{snapshot.subline}</span>
        </div>
        <div className="run-progress-figures">
          {elapsed !== null && (
            <span title="开始至现在的墙钟时间，包含等待与重试间隔">
              已用 <b>{formatRunDuration(elapsed)}</b>
            </span>
          )}
          {remaining !== null && (
            <span title="按执行阶段已完成条目的均速线性外推，仅供参考">
              预计剩余 <b>≈{formatRunDuration(remaining)}</b>
            </span>
          )}
          <span title="REST 阶段同时发往 Agent 的请求数；同一 uid 只能串行">
            执行并发 <b>{run.runExecutionLimits.restConcurrency}</b>
          </span>
          <span title="Judge 阶段并发数，不受 Agent 侧 uid 锁限制">
            评测并发 <b>{run.runExecutionLimits.evalConcurrency}</b>
          </span>
        </div>
      </header>
      <div
        className="run-progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={snapshot.overallPercent}
        aria-label={`${snapshot.headline}，${stageLabel}，整体阶段进度 ${snapshot.overallPercent}%`}
      >
        {snapshot.stages.map((stage) => (
          <div className="run-progress-seg" key={stage.key} data-state={stage.state}>
            <i style={{ width: `${Math.round(stage.ratio * 100)}%` }} />
          </div>
        ))}
      </div>
      <ol className="run-progress-steps">
        {snapshot.stages.map((stage, index) => (
          <StageStep stage={stage} ordinal={index + 1} key={stage.key} />
        ))}
      </ol>
      <div className="run-progress-counts">
        <span>
          执行 <b>{run.rest.completed}</b>/{run.rest.total} · 成功 {run.rest.succeeded} · 异常{" "}
          {run.rest.error}
        </span>
        <span>
          评测 <b>{run.evaluation.completed}</b>/{run.evaluation.total} · 通过{" "}
          {run.evaluation.passed} · 未通过 {run.evaluation.failed} · 评测异常 {run.evaluation.error}{" "}
          · 未评测 {run.evaluation.notEvaluated}
        </span>
        {snapshot.cancelRequested && <span data-tone="warning">已请求停止，等待当前条目收尾…</span>}
      </div>
    </section>
  );
}

// One stepper entry: marker, stage name and its measured counters.
function StageStep({
  stage,
  ordinal
}: {
  readonly stage: RunStageProgress;
  readonly ordinal: number;
}): ReactElement {
  return (
    <li data-state={stage.state}>
      <span className="run-progress-dot">
        <StageIcon state={stage.state} />
        {stage.state === "PENDING" ? ordinal : null}
      </span>
      <span className="run-progress-step-text">
        <b>{stage.label}</b>
        <em>{stage.detail ?? stage.hint}</em>
      </span>
    </li>
  );
}

/** Compact two-segment progress bar for Run list rows. */
export function RunProgressMini({
  run
}: {
  readonly run: Pick<
    PlatformRunDetail,
    "status" | "stage" | "rest" | "evaluation" | "cancelRequestedAt"
  >;
}): ReactElement {
  const snapshot = runProgressSnapshot(run, false);
  const rest = snapshot.stages[0];
  const evaluation = snapshot.stages[1];
  const restRatio = rest === undefined ? 0 : rest.ratio;
  const evaluationRatio = evaluation === undefined ? 0 : evaluation.ratio;
  return (
    <div
      className="run-progress-mini"
      data-tone={snapshot.tone}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={snapshot.overallPercent}
      aria-label={`${snapshot.headline}，执行 ${run.rest.completed}/${run.rest.total}，评测 ${run.evaluation.completed}/${run.evaluation.total}`}
    >
      <span className="run-progress-mini-track">
        <span
          data-state={rest?.state ?? "PENDING"}
          title={`执行 ${run.rest.completed}/${run.rest.total}`}
        >
          <i style={{ width: `${Math.round(restRatio * 100)}%` }} />
        </span>
        <span
          data-state={evaluation?.state ?? "PENDING"}
          title={`评测 ${run.evaluation.completed}/${run.evaluation.total}`}
        >
          <i style={{ width: `${Math.round(evaluationRatio * 100)}%` }} />
        </span>
      </span>
      <b className="run-progress-mini-percent">{snapshot.overallPercent}%</b>
    </div>
  );
}
