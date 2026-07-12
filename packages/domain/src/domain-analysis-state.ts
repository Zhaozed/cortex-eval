/** Analysis lifecycle status. */
export type AnalysisStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "ERROR";

/** Current user decision for one Analysis. */
export type AnalysisDecision =
  "NO_PROPOSAL" | "PENDING" | "ACCEPTED" | "REJECTED" | "EDITED_AND_ACCEPTED";

/** Proposal application outcome. */
export type AnalysisApplyStatus = "NOT_APPLICABLE" | "NOT_APPLIED" | "APPLIED" | "CONFLICT";

/** Analysis state fields used to reject dirty persisted combinations. */
interface AnalysisStateFields {
  /** Lifecycle status candidate. */
  readonly status: AnalysisStatus;
  /** Decision candidate. */
  readonly decision: AnalysisDecision;
  /** Apply-status candidate. */
  readonly applyStatus: AnalysisApplyStatus;
  /** Optimistic-concurrency revision starting at one. */
  readonly revision: number;
}

/** Pending, running or failed Analysis without an applicable Proposal. */
export interface AnalysisUnresolvedState extends AnalysisStateFields {
  /** Lifecycle discriminator. */
  readonly status: "PENDING" | "RUNNING" | "ERROR";
  /** No decision is possible. */
  readonly decision: "NO_PROPOSAL";
  /** No Proposal can be applied. */
  readonly applyStatus: "NOT_APPLICABLE";
}

/** Successful Analysis without a Proposal. */
export interface AnalysisNoProposalState extends AnalysisStateFields {
  /** Lifecycle discriminator. */
  readonly status: "SUCCEEDED";
  /** No decision is possible. */
  readonly decision: "NO_PROPOSAL";
  /** No Proposal can be applied. */
  readonly applyStatus: "NOT_APPLICABLE";
}

/** Successful Analysis awaiting a Proposal decision. */
export interface AnalysisPendingDecisionState extends AnalysisStateFields {
  /** Lifecycle discriminator. */
  readonly status: "SUCCEEDED";
  /** Proposal awaits a decision. */
  readonly decision: "PENDING";
  /** Proposal has not been applied. */
  readonly applyStatus: "NOT_APPLIED";
}

/** Successful Analysis with a rejected Proposal. */
export interface AnalysisRejectedState extends AnalysisStateFields {
  /** Lifecycle discriminator. */
  readonly status: "SUCCEEDED";
  /** Proposal was rejected. */
  readonly decision: "REJECTED";
  /** Rejected Proposal remains unapplied. */
  readonly applyStatus: "NOT_APPLIED";
}

/** Successful Analysis whose accepted Proposal reached an apply outcome. */
export interface AnalysisAcceptedState extends AnalysisStateFields {
  /** Lifecycle discriminator. */
  readonly status: "SUCCEEDED";
  /** Original or edited Proposal was accepted. */
  readonly decision: "ACCEPTED" | "EDITED_AND_ACCEPTED";
  /** Apply completed or detected a conflict. */
  readonly applyStatus: "APPLIED" | "CONFLICT";
}

/** Closed Analysis state discriminated union. */
export type AnalysisState =
  | AnalysisUnresolvedState
  | AnalysisNoProposalState
  | AnalysisPendingDecisionState
  | AnalysisRejectedState
  | AnalysisAcceptedState;

/** Analysis state-machine event. */
export type AnalysisStateEvent = (
  | { readonly type: "START" }
  | { readonly type: "SUCCEED"; readonly hasProposal: boolean }
  | { readonly type: "FAIL" }
  | { readonly type: "REJECT" }
  | {
      readonly type: "ACCEPT";
      readonly edited: boolean;
      readonly applyResult: "APPLIED" | "CONFLICT";
    }
  | { readonly type: "REANALYZE" }
) & { readonly expectedRevision: number };

/** Stable Analysis transition conflict. */
export interface AnalysisStateConflict {
  /** Stable error code. */
  readonly code: "ANALYSIS_STATE_CONFLICT";
  /** Rejected event. */
  readonly event: AnalysisStateEvent["type"];
  /** Revision read from the current Analysis. */
  readonly actualRevision: number;
  /** Revision supplied by the caller. */
  readonly expectedRevision: number;
}

/** Exact Analysis transition result. */
export type AnalysisTransitionResult =
  | { readonly ok: true; readonly state: AnalysisState }
  | { readonly ok: false; readonly error: AnalysisStateConflict };

// Return one consistent conflict without exceptions or side effects.
function conflict(state: AnalysisState, event: AnalysisStateEvent): AnalysisTransitionResult {
  return {
    ok: false,
    error: {
      code: "ANALYSIS_STATE_CONFLICT",
      event: event.type,
      actualRevision: state.revision,
      expectedRevision: event.expectedRevision
    }
  };
}

// Validate a runtime state even when a dirty persistence mapper bypasses the type union.
function isValidAnalysisState(state: AnalysisStateFields): boolean {
  if (state.revision < 1 || !Number.isInteger(state.revision)) return false;
  if (state.status === "PENDING" || state.status === "RUNNING" || state.status === "ERROR") {
    return state.decision === "NO_PROPOSAL" && state.applyStatus === "NOT_APPLICABLE";
  }
  if (state.decision === "NO_PROPOSAL") return state.applyStatus === "NOT_APPLICABLE";
  if (state.decision === "PENDING" || state.decision === "REJECTED") {
    return state.applyStatus === "NOT_APPLIED";
  }
  return state.applyStatus === "APPLIED" || state.applyStatus === "CONFLICT";
}

/** Apply one pure Analysis transition. */
export function transitionAnalysisState(
  state: AnalysisState,
  event: AnalysisStateEvent
): AnalysisTransitionResult {
  if (!isValidAnalysisState(state)) {
    return conflict(state, event);
  }
  if (event.expectedRevision !== state.revision) {
    return conflict(state, event);
  }
  if (event.type === "REANALYZE") {
    if (state.status === "RUNNING") {
      return conflict(state, event);
    }
    return {
      ok: true,
      state: {
        status: "PENDING",
        decision: "NO_PROPOSAL",
        applyStatus: "NOT_APPLICABLE",
        revision: state.revision + 1
      }
    };
  }
  if (event.type === "START" && state.status === "PENDING") {
    return {
      ok: true,
      state: {
        status: "RUNNING",
        decision: "NO_PROPOSAL",
        applyStatus: "NOT_APPLICABLE",
        revision: state.revision + 1
      }
    };
  }
  if (state.status === "RUNNING" && event.type === "FAIL") {
    return {
      ok: true,
      state: {
        ...state,
        status: "ERROR",
        decision: "NO_PROPOSAL",
        applyStatus: "NOT_APPLICABLE",
        revision: state.revision + 1
      }
    };
  }
  if (state.status === "RUNNING" && event.type === "SUCCEED") {
    if (event.hasProposal) {
      return {
        ok: true,
        state: {
          status: "SUCCEEDED",
          decision: "PENDING",
          applyStatus: "NOT_APPLIED",
          revision: state.revision + 1
        }
      };
    }
    return {
      ok: true,
      state: {
        status: "SUCCEEDED",
        decision: "NO_PROPOSAL",
        applyStatus: "NOT_APPLICABLE",
        revision: state.revision + 1
      }
    };
  }
  if (state.status === "SUCCEEDED" && state.decision === "PENDING" && event.type === "REJECT") {
    return { ok: true, state: { ...state, decision: "REJECTED", revision: state.revision + 1 } };
  }
  if (state.status === "SUCCEEDED" && state.decision === "PENDING" && event.type === "ACCEPT") {
    return {
      ok: true,
      state: {
        ...state,
        decision: event.edited ? "EDITED_AND_ACCEPTED" : "ACCEPTED",
        applyStatus: event.applyResult,
        revision: state.revision + 1
      }
    };
  }
  return conflict(state, event);
}
