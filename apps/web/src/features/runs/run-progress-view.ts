import type { PlatformRunDetail } from "../../lib/run-api.ts";

/** Persisted progress facts selected for the current or last committed stage. */
export type RunProgressView =
  | ({ readonly kind: "REST" } & PlatformRunDetail["rest"])
  | ({ readonly kind: "EVALUATION" } & PlatformRunDetail["evaluation"]);

/** Select terminal progress from persisted facts without guessing from the DONE stage. */
export function selectRunProgressView(run: PlatformRunDetail): RunProgressView {
  const evaluationWasCommitted = run.evaluation.completed > 0;
  const showRest = run.stage === "REST" || (run.stage === "DONE" && !evaluationWasCommitted);
  return showRest ? { kind: "REST", ...run.rest } : { kind: "EVALUATION", ...run.evaluation };
}
