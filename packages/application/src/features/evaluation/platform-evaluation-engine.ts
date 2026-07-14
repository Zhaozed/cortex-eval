import type { PlatformRun, StoredRestCaseResult } from "../runs/platform-run-models.ts";
import type { FrozenRunCase } from "../runs/run-rest-models.ts";
import {
  createFrozenEvaluationContextHash,
  type FrozenEvaluationEngineResult,
  type FrozenEvaluationJsonObject
} from "./frozen-evaluation-engine.ts";

/** JSON object accepted from the fixed external Evaluation process. */
export type PlatformEvaluationJsonObject = FrozenEvaluationJsonObject;

/** Stable inputs needed to bind one Adapter-derived evaluator call budget. */
export interface PlatformEvaluationContextHashInput {
  /** Frozen target Run. */
  readonly run: PlatformRun;
  /** Complete REST result-set version. */
  readonly restResultSetHash: string;
  /** Locked capability-matrix version. */
  readonly capabilityMatrixHash: string;
  /** Deterministically derived evaluator call budget. */
  readonly evaluatorCallBudget: number;
}

/** Compute the immutable Evaluation context without exposing Domain to Infrastructure. */
export function createPlatformEvaluationContextHash(
  input: PlatformEvaluationContextHashInput
): string {
  return createFrozenEvaluationContextHash({
    binding: { kind: "RUN", id: input.run.id },
    executionContextHash: input.run.runContextHash,
    restResultSetHash: input.restResultSetHash,
    evaluatorConfigHash: input.run.evaluator.configHash,
    promptfooVersion: input.run.promptfooVersion,
    capabilityMatrixHash: input.capabilityMatrixHash,
    evaluatorCallBudget: input.evaluatorCallBudget
  });
}

/** Complete external Evaluation execution input built from frozen Run facts. */
export interface PlatformEvaluationEngineInput {
  /** Claimed immutable Run snapshot. */
  readonly run: PlatformRun;
  /** Complete ordered durable REST results. */
  readonly restResults: readonly StoredRestCaseResult[];
  /** REST result-set version consumed by Evaluation. */
  readonly restResultSetHash: string;
  /** Run-owned cancellation signal. */
  readonly signal: AbortSignal;
}

/** Raw fixed-version Evaluation facts returned before strict import. */
export type PlatformEvaluationEngineResult = FrozenEvaluationEngineResult;

/** Infrastructure Port for one controlled Promptfoo Evaluation call lifetime. */
export interface PlatformEvaluationEngine {
  /** Execute outside a database transaction and return only bounded JSON facts. */
  execute(input: PlatformEvaluationEngineInput): Promise<PlatformEvaluationEngineResult>;
}

/** Closed interpreter capability result checked before an Evaluation stage is claimed. */
export type PlatformEvaluationRuntimePreflightResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly path: "runtime.promptfoo" | "runtime.python" | "runtime.ruby";
    };

/** Infrastructure Port for frozen Assertion interpreter capability checks. */
export interface PlatformEvaluationRuntimePreflight {
  /** Check only runtimes required by Cases that will actually enter Promptfoo. */
  check(
    cases: AsyncIterable<FrozenRunCase> | Iterable<FrozenRunCase>,
    signal: AbortSignal
  ): Promise<PlatformEvaluationRuntimePreflightResult>;
}
