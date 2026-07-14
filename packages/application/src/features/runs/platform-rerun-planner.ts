import type { PlatformEvalCaseResult } from "../evaluation/platform-eval-models.ts";
import type { StoredRestCaseResult } from "./platform-run-models.ts";

/** One source Case and its complete durable stage facts. */
export interface RerunSourceCase {
  /** Stable frozen Case key. */
  readonly caseKey: string;
  /** Stable frozen Case order. */
  readonly ordinal: number;
  /** Required source REST result. */
  readonly rest: StoredRestCaseResult;
  /** Source Eval result, absent only when the source stage never committed it. */
  readonly evaluation: PlatformEvalCaseResult | null;
}

/** Exact input for the pure internal rerun selector. */
export interface CreateRerunPlanInput {
  /** Source platform Run identity. */
  readonly sourceRunId: string;
  /** Explicit retry behavior. */
  readonly mode: "RETRY_FAILED" | "FORCE";
  /** Complete source Cases in frozen order. */
  readonly cases: readonly RerunSourceCase[];
}

/** Stable provenance copied with one reused stage result. */
export interface RerunReuseFact {
  /** Source platform Run identity. */
  readonly sourceRunId: string;
  /** Exact source semantic result hash. */
  readonly sourceResultHash: string;
}

/** One Case action selected before any external work begins. */
export type RerunCasePlan =
  | {
      readonly caseKey: string;
      readonly ordinal: number;
      readonly action: "REUSE_REST_AND_EVAL";
      readonly restReuse: RerunReuseFact;
      readonly evalReuse: RerunReuseFact;
    }
  | {
      readonly caseKey: string;
      readonly ordinal: number;
      readonly action: "REUSE_REST_REEVALUATE";
      readonly restReuse: RerunReuseFact;
    }
  | {
      readonly caseKey: string;
      readonly ordinal: number;
      readonly action: "RETRY_REST_THEN_EVALUATE" | "FORCE_REST_THEN_EVALUATE";
    };

/** Complete deterministic rerun selection facts. */
export interface RerunPlan {
  /** Source platform Run identity. */
  readonly sourceRunId: string;
  /** Explicit retry behavior. */
  readonly mode: "RETRY_FAILED" | "FORCE";
  /** Ordered Case actions. */
  readonly cases: readonly RerunCasePlan[];
  /** Bounded selection totals used by the future internal use case. */
  readonly counts: {
    readonly reuseRest: number;
    readonly executeRest: number;
    readonly reuseEval: number;
    readonly executeEval: number;
  };
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

// Validate that one source Case is complete, ordered and owned by the selected Run.
function validateSourceCase(sourceRunId: string, source: RerunSourceCase, index: number): void {
  const evaluation = source.evaluation;
  if (
    source.ordinal !== index ||
    source.caseKey.trim() === "" ||
    source.rest.runId !== sourceRunId ||
    source.rest.caseKey !== source.caseKey ||
    source.rest.ordinal !== source.ordinal ||
    !SHA256_PATTERN.test(source.rest.resultHash) ||
    (evaluation !== null &&
      (evaluation.runId !== sourceRunId ||
        evaluation.caseKey !== source.caseKey ||
        evaluation.ordinal !== source.ordinal ||
        !SHA256_PATTERN.test(evaluation.evalResultHash))) ||
    (source.rest.status === "ERROR" && evaluation !== null && evaluation.status !== "NOT_EVALUATED")
  ) {
    throw new Error("RERUN_PLAN_SOURCE_ALIGNMENT");
  }
}

// Select one retry-failed action from already-validated durable source facts.
function retryFailedCase(sourceRunId: string, source: RerunSourceCase): RerunCasePlan {
  const identity = { caseKey: source.caseKey, ordinal: source.ordinal };
  if (source.rest.status === "ERROR") {
    return { ...identity, action: "RETRY_REST_THEN_EVALUATE" };
  }
  const restReuse = { sourceRunId, sourceResultHash: source.rest.resultHash };
  if (source.evaluation?.status === "PASS" || source.evaluation?.status === "FAIL") {
    return {
      ...identity,
      action: "REUSE_REST_AND_EVAL",
      restReuse,
      evalReuse: {
        sourceRunId,
        sourceResultHash: source.evaluation.evalResultHash
      }
    };
  }
  return { ...identity, action: "REUSE_REST_REEVALUATE", restReuse };
}

/** Create the deterministic internal Retry/Force selection plan without side effects. */
export function createRerunPlan(input: CreateRerunPlanInput): RerunPlan {
  if (input.cases.length === 0) throw new Error("RERUN_PLAN_SOURCE_ALIGNMENT");
  const caseKeys = new Set<string>();
  const cases = input.cases.map((source, index): RerunCasePlan => {
    validateSourceCase(input.sourceRunId, source, index);
    if (caseKeys.has(source.caseKey)) throw new Error("RERUN_PLAN_SOURCE_ALIGNMENT");
    caseKeys.add(source.caseKey);
    if (input.mode === "FORCE") {
      return {
        caseKey: source.caseKey,
        ordinal: source.ordinal,
        action: "FORCE_REST_THEN_EVALUATE"
      };
    }
    return retryFailedCase(input.sourceRunId, source);
  });
  const reuseRest = cases.filter((item) => item.action.startsWith("REUSE_REST")).length;
  const reuseEval = cases.filter((item) => item.action === "REUSE_REST_AND_EVAL").length;
  return {
    sourceRunId: input.sourceRunId,
    mode: input.mode,
    cases,
    counts: {
      reuseRest,
      executeRest: cases.length - reuseRest,
      reuseEval,
      executeEval: cases.length - reuseEval
    }
  };
}
