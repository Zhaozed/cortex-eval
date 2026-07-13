/** Run lifecycle status. */
export type RunStatus =
  | "READY"
  | "RUNNING"
  | "COMPLETED"
  | "COMPLETED_WITH_ERRORS"
  | "FAILED"
  | "CANCELLED"
  | "INTERRUPTED";

/** Run pipeline stage. */
export type RunStage = "REST" | "EVALUATION" | "REPORT" | "DONE";

/** Active Run pipeline stage. */
export type ActiveRunStage = Exclude<RunStage, "DONE">;

/** Run state fields used to reject dirty persisted combinations. */
interface RunStateFields {
  /** Lifecycle status candidate. */
  readonly status: RunStatus;
  /** Stage candidate. */
  readonly stage: RunStage;
  /** Optimistic-concurrency revision. */
  readonly lockRevision: number;
  /** Whether a successful cancellation request permanently blocks stage commit. */
  readonly cancelRequested: boolean;
}

/** Ready state waiting at one active pipeline stage. */
export interface ReadyRunState extends RunStateFields {
  /** Ready lifecycle discriminator. */
  readonly status: "READY";
  /** Nonterminal pipeline stage. */
  readonly stage: ActiveRunStage;
  /** A ready Run never carries an in-flight cancellation request. */
  readonly cancelRequested: false;
}

/** Running state before or after a cancellation request wins its CAS. */
export interface RunningRunState extends RunStateFields {
  /** Running lifecycle discriminator. */
  readonly status: "RUNNING";
  /** Nonterminal pipeline stage. */
  readonly stage: ActiveRunStage;
}

/** Terminal Run state after stage processing has stopped. */
export interface TerminalRunState extends RunStateFields {
  /** Terminal lifecycle discriminator. */
  readonly status: "COMPLETED" | "COMPLETED_WITH_ERRORS" | "FAILED" | "CANCELLED" | "INTERRUPTED";
  /** Terminal stage marker. */
  readonly stage: "DONE";
  /** Terminal Runs do not retain a mutable cancellation substate. */
  readonly cancelRequested: false;
}

/** Closed legal Run state union. */
export type RunState = ReadyRunState | RunningRunState | TerminalRunState;

/** State-machine input event. */
export type RunEvent = (
  | { type: "START_STAGE" }
  | { type: "REQUEST_CANCEL" }
  | { type: "PROGRESS_RECORDED" }
  | { type: "REST_COMMITTED" }
  | { type: "EVALUATION_COMMITTED" }
  | { type: "REPORT_COMMITTED"; hasErrors: boolean }
  | { type: "CANCEL_COMMITTED" }
  | { type: "FAIL" }
  | { type: "INTERRUPT" }
  | { type: "IMPORT_COMPLETED"; hasErrors: boolean }
) & { expectedRevision: number };

/** Stable state transition conflict. */
export interface RunStateConflict {
  /** Stable error code. */
  code: "RUN_STATE_CONFLICT";
  /** Existing status. */
  status: RunStatus;
  /** Existing stage. */
  stage: RunStage;
  /** Rejected event. */
  event: RunEvent["type"];
  /** Revision read from the current Run. */
  actualRevision: number;
  /** Revision supplied by the caller. */
  expectedRevision: number;
}

/** Precise transition result. */
export type RunTransitionResult =
  { ok: true; state: RunState } | { ok: false; error: RunStateConflict };

// Return one stable conflict without throwing or logging.
function conflict(state: RunState, event: RunEvent): RunTransitionResult {
  return {
    ok: false,
    error: {
      code: "RUN_STATE_CONFLICT",
      status: state.status,
      stage: state.stage,
      event: event.type,
      actualRevision: state.lockRevision,
      expectedRevision: event.expectedRevision
    }
  };
}

// Advance one legal active-state change and its revision together.
function advanceActive(
  state: RunState,
  status: ReadyRunState["status"] | RunningRunState["status"],
  stage: ActiveRunStage,
  cancelRequested: boolean
): RunTransitionResult {
  if (status === "READY") {
    if (cancelRequested) {
      return conflict(state, {
        type: "PROGRESS_RECORDED",
        expectedRevision: state.lockRevision
      });
    }
    return {
      ok: true,
      state: {
        status,
        stage,
        lockRevision: state.lockRevision + 1,
        cancelRequested: false
      }
    };
  }
  return {
    ok: true,
    state: { status, stage, lockRevision: state.lockRevision + 1, cancelRequested }
  };
}

// Advance one legal terminal-state change and its revision together.
function advanceTerminal(state: RunState, status: TerminalRunState["status"]): RunTransitionResult {
  return {
    ok: true,
    state: {
      status,
      stage: "DONE",
      lockRevision: state.lockRevision + 1,
      cancelRequested: false
    }
  };
}

// Validate a runtime state even when a dirty persistence mapper bypasses the type union.
function isValidRunState(state: RunStateFields): boolean {
  if (!Number.isInteger(state.lockRevision) || state.lockRevision < 0) return false;
  if (typeof state.cancelRequested !== "boolean") return false;
  if (state.status === "READY") return state.stage !== "DONE" && !state.cancelRequested;
  if (state.status === "RUNNING") return state.stage !== "DONE";
  return state.stage === "DONE" && !state.cancelRequested;
}

/** Apply one pure Run state transition. */
export function transitionRunState(state: RunState, event: RunEvent): RunTransitionResult {
  if (!isValidRunState(state)) {
    return conflict(state, event);
  }
  if (event.expectedRevision !== state.lockRevision) {
    return conflict(state, event);
  }
  if (event.type === "IMPORT_COMPLETED" && state.status === "READY" && state.stage === "REST") {
    return advanceTerminal(state, event.hasErrors ? "COMPLETED_WITH_ERRORS" : "COMPLETED");
  }
  if (event.type === "START_STAGE" && state.status === "READY") {
    return advanceActive(state, "RUNNING", state.stage, false);
  }
  if (state.status !== "RUNNING") {
    return conflict(state, event);
  }
  if (event.type === "REQUEST_CANCEL" && !state.cancelRequested) {
    return advanceActive(state, "RUNNING", state.stage, true);
  }
  if (event.type === "PROGRESS_RECORDED") {
    return advanceActive(state, "RUNNING", state.stage, state.cancelRequested);
  }
  if (event.type === "CANCEL_COMMITTED" && state.cancelRequested) {
    return advanceTerminal(state, "CANCELLED");
  }
  if (event.type === "FAIL") {
    return advanceTerminal(state, "FAILED");
  }
  if (event.type === "INTERRUPT") {
    return advanceTerminal(state, "INTERRUPTED");
  }
  if (state.cancelRequested) {
    return conflict(state, event);
  }
  if (event.type === "REST_COMMITTED" && state.stage === "REST") {
    return advanceActive(state, "READY", "EVALUATION", false);
  }
  if (event.type === "EVALUATION_COMMITTED" && state.stage === "EVALUATION") {
    return advanceActive(state, "READY", "REPORT", false);
  }
  if (event.type === "REPORT_COMMITTED" && state.stage === "REPORT") {
    return advanceTerminal(state, event.hasErrors ? "COMPLETED_WITH_ERRORS" : "COMPLETED");
  }
  return conflict(state, event);
}
