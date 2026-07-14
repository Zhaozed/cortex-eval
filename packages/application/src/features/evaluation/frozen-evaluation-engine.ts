import type { DomainJsonObject } from "@cortex-eval/domain/src/domain-canonical-hash.ts";
import type { ProviderOutput } from "@cortex-eval/domain/src/domain-evaluation.ts";
import { hashEvaluationContext } from "@cortex-eval/domain/src/domain-hash-inputs.ts";

import type { FrozenRunEvaluator, FrozenRunRubricPrompt } from "../runs/platform-run-models.ts";
import type { FrozenRunCase } from "../runs/run-rest-models.ts";

/** Immutable platform or offline Evaluation owner. */
export type FrozenEvaluationBinding =
  | { readonly kind: "RUN"; readonly id: string }
  | { readonly kind: "EXECUTION"; readonly id: string };

/** Minimal aligned REST fact consumed by controlled Promptfoo generation. */
export type FrozenEvaluationRestResult =
  | {
      readonly caseKey: string;
      readonly ordinal: number;
      readonly caseDefinitionHash: string;
      readonly status: "SUCCEEDED";
      readonly providerOutput: ProviderOutput;
    }
  | {
      readonly caseKey: string;
      readonly ordinal: number;
      readonly caseDefinitionHash: string;
      readonly status: "ERROR";
      readonly providerOutput: null;
    };

/** One frozen Case joined to the exact REST fact entering Evaluation. */
export interface FrozenEvaluationCaseInput {
  /** Complete immutable Case definition. */
  readonly testCase: FrozenRunCase;
  /** Aligned REST fact for the same Case version. */
  readonly restResult: FrozenEvaluationRestResult;
}

/** Replayable bounded Case source used by platform memory and offline disk adapters. */
export interface FrozenEvaluationCaseSource {
  /** Open a fresh ordered pass without retaining the whole collection. */
  readonly open: () => AsyncIterable<FrozenEvaluationCaseInput>;
}

/** Complete frozen input shared by platform Run and offline Execution adapters. */
export interface FrozenEvaluationEngineInput {
  /** Immutable execution-version owner. */
  readonly binding: FrozenEvaluationBinding;
  /** Platform Run Context hash or offline Execution Context hash. */
  readonly executionContextHash: string;
  /** Replayable aligned Case and REST source. */
  readonly caseSource: FrozenEvaluationCaseSource;
  /** Frozen Evaluator configuration. */
  readonly evaluator: FrozenRunEvaluator;
  /** Complete referenced Rubric Prompt set. */
  readonly rubricPrompts: readonly FrozenRunRubricPrompt[];
  /** Exact external Promptfoo version. */
  readonly promptfooVersion: "0.121.18";
  /** Frozen maximum Evaluator concurrency. */
  readonly evalConcurrency: number;
  /** Complete REST Result Set identity consumed by Evaluation. */
  readonly restResultSetHash: string;
  /** Owner cancellation signal. */
  readonly signal: AbortSignal;
}

/** JSON object accepted from the fixed external Evaluation process. */
export type FrozenEvaluationJsonObject = DomainJsonObject;

/** Replayable, explicitly owned Raw source returned by a real external process. */
export interface FrozenEvaluationRawSource {
  /** Runtime-safe source discriminator. */
  readonly kind: "PROMPTFOO_RAW_SOURCE";
  /** Open a fresh bounded byte stream for immutable Artifact publication. */
  readonly openBytes: () => AsyncIterable<Uint8Array>;
  /** Open a fresh per-Row parser stream for strict normalization. */
  readonly openRows: () => AsyncIterable<unknown>;
  /** Reclaim the private process output after every consumer finishes. */
  readonly dispose: () => Promise<void>;
}

/** Small in-memory test output or a real replayable process source. */
export type FrozenEvaluationRaw = FrozenEvaluationJsonObject | FrozenEvaluationRawSource;

/** Narrow one internal engine result without trusting arbitrary object fields. */
export function isFrozenEvaluationRawSource(
  raw: FrozenEvaluationRaw
): raw is FrozenEvaluationRawSource {
  const candidate = raw as Partial<FrozenEvaluationRawSource>;
  return (
    candidate.kind === "PROMPTFOO_RAW_SOURCE" &&
    typeof candidate.openBytes === "function" &&
    typeof candidate.openRows === "function" &&
    typeof candidate.dispose === "function"
  );
}

/** Reclaim only an owned process source; in-memory values need no cleanup. */
export async function disposeFrozenEvaluationRaw(raw: FrozenEvaluationRaw): Promise<void> {
  if (isFrozenEvaluationRawSource(raw)) await raw.dispose();
}

/** Raw fixed-version facts returned before strict import. */
export interface FrozenEvaluationEngineResult {
  /** Verified exact Promptfoo version. */
  readonly promptfooVersion: "0.121.18";
  /** Native success or Assertion-fail exit code. */
  readonly exitCode: 0 | 100;
  /** Whole fixed-version process duration. */
  readonly durationMs: number;
  /** Bounded Raw evidence source or a small in-memory adapter value. */
  readonly raw: FrozenEvaluationRaw;
  /** Exact inline Rubric Prompt materializations. */
  readonly rubricPromptMaterializations: Readonly<Record<string, string>>;
  /** Frozen Evaluation context identity. */
  readonly evaluationContextHash: string;
}

/** Stable inputs needed to bind one Adapter-derived Evaluator call budget. */
export interface FrozenEvaluationContextHashInput {
  /** Immutable execution-version owner. */
  readonly binding: FrozenEvaluationBinding;
  /** Platform Run Context hash or offline Execution Context hash. */
  readonly executionContextHash: string;
  /** Complete REST Result Set identity consumed by Evaluation. */
  readonly restResultSetHash: string;
  /** Frozen Evaluator configuration identity. */
  readonly evaluatorConfigHash: string;
  /** Exact external Promptfoo version. */
  readonly promptfooVersion: "0.121.18";
  /** Locked capability-matrix version. */
  readonly capabilityMatrixHash: string;
  /** Deterministically derived Evaluator call budget. */
  readonly evaluatorCallBudget: number;
}

/** Compute one immutable Evaluation context for a Run or Execution. */
export function createFrozenEvaluationContextHash(input: FrozenEvaluationContextHashInput): string {
  return hashEvaluationContext({
    contractVersion: "cortex.evaluation-context.v1",
    executionBinding: input.binding,
    runContextHash: input.executionContextHash,
    restResultSetHash: input.restResultSetHash,
    evaluatorConfigHash: input.evaluatorConfigHash,
    promptfooVersion: input.promptfooVersion,
    configContractVersion: "cortex.promptfoo-config.v1",
    capabilityMatrixHash: input.capabilityMatrixHash,
    evaluatorCallBudget: input.evaluatorCallBudget
  });
}

/** Infrastructure Port for one controlled Promptfoo call lifetime. */
export interface FrozenEvaluationEngine {
  /** Execute outside storage transactions. */
  readonly execute: (input: FrozenEvaluationEngineInput) => Promise<FrozenEvaluationEngineResult>;
}
