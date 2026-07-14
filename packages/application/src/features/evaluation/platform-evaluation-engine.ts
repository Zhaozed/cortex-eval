import type { DomainJsonObject } from "@cortex-eval/domain/src/domain-canonical-hash.ts";
import { hashEvaluationContext } from "@cortex-eval/domain/src/domain-hash-inputs.ts";

import type { PlatformRun, StoredRestCaseResult } from "../runs/platform-run-models.ts";
import type { FrozenRunCase } from "../runs/run-rest-models.ts";

/** JSON object accepted from the fixed external Evaluation process. */
export type PlatformEvaluationJsonObject = DomainJsonObject;

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
  return hashEvaluationContext({
    contractVersion: "cortex.evaluation-context.v1",
    executionBinding: { kind: "RUN", id: input.run.id },
    runContextHash: input.run.runContextHash,
    restResultSetHash: input.restResultSetHash,
    evaluatorConfigHash: input.run.evaluator.configHash,
    promptfooVersion: input.run.promptfooVersion,
    configContractVersion: "cortex.promptfoo-config.v1",
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
export interface PlatformEvaluationEngineResult {
  /** Verified exact Promptfoo version. */
  readonly promptfooVersion: "0.121.18";
  /** Native success or Assertion-fail exit code. */
  readonly exitCode: 0 | 100;
  /** Whole fixed-version process duration. */
  readonly durationMs: number;
  /** JSON raw evidence, including a synthetic empty v3 result when Promptfoo is skipped. */
  readonly raw: PlatformEvaluationJsonObject;
  /** Frozen Prompt reference to exact controlled inline materialization. */
  readonly rubricPromptMaterializations: Readonly<Record<string, string>>;
  /** Evaluation config/context version bound by Bridge v2. */
  readonly evaluationContextHash: string;
}

/** Infrastructure Port for one controlled Promptfoo Evaluation call lifetime. */
export interface PlatformEvaluationEngine {
  /** Execute outside a database transaction and return only bounded JSON facts. */
  execute(input: PlatformEvaluationEngineInput): Promise<PlatformEvaluationEngineResult>;
}

/** Closed interpreter capability result checked before an Evaluation stage is claimed. */
export type PlatformEvaluationRuntimePreflightResult =
  { readonly ok: true } | { readonly ok: false; readonly path: "runtime.python" | "runtime.ruby" };

/** Infrastructure Port for frozen Assertion interpreter capability checks. */
export interface PlatformEvaluationRuntimePreflight {
  /** Check only runtimes required by Cases that will actually enter Promptfoo. */
  check(cases: readonly FrozenRunCase[]): Promise<PlatformEvaluationRuntimePreflightResult>;
}
