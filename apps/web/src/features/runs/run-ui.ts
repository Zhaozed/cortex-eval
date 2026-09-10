import { ApiClientError } from "../../lib/api-client.ts";
import type { PlatformRunDetail, PlatformRunPage } from "../../lib/run-api.ts";
import { message, type MessageKey } from "../../messages/messages.ts";

type RunStatus = PlatformRunDetail["status"];
type RunStage = PlatformRunDetail["stage"];
type RunSummary = PlatformRunPage["items"][number];

/** Read one externalized Run status label. */
export function runStatusLabel(status: RunStatus): string {
  const key: MessageKey =
    status === "READY"
      ? "runs.status.ready"
      : status === "RUNNING"
        ? "runs.status.running"
        : status === "COMPLETED"
          ? "runs.status.completed"
          : status === "COMPLETED_WITH_ERRORS"
            ? "runs.status.completedWithErrors"
            : status === "FAILED"
              ? "runs.status.failed"
              : status === "CANCELLED"
                ? "runs.status.cancelled"
                : "runs.status.interrupted";
  return message(key);
}

/** Read one externalized Run stage label. */
export function runStageLabel(stage: RunStage): string {
  const key: MessageKey =
    stage === "REST"
      ? "runs.stage.rest"
      : stage === "EVALUATION"
        ? "runs.stage.evaluation"
        : stage === "REPORT"
          ? "runs.stage.report"
          : "runs.stage.done";
  return message(key);
}

/** Format one server timestamp for the local operator. */
export function displayRunDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date(value));
}

/** Whether one Run has reached a persisted terminal status. */
export function isRunTerminal(run: Pick<RunSummary, "status">): boolean {
  return run.status !== "READY" && run.status !== "RUNNING";
}

/** Keep conflicts distinct: stale revision, unavailable stage, and another active Run. */
export function runMutationErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiClientError) {
    if (error.runStateReason === "STATE_OR_REVISION") return message("runs.mutationErrorStale");
    if (error.runStateReason === "STAGE_UNAVAILABLE")
      return message("runs.mutationErrorStageUnavailable");
    if (error.runStateReason === "GLOBAL_RUNNING")
      return message("runs.mutationErrorGlobalRunning");
  }
  return fallback;
}
