import type { EvalCaseV1 } from "@cortex-eval/contracts/src/artifact-contracts.ts";
import type {
  ExecutionV1,
  WorkPackageManifestV1
} from "@cortex-eval/contracts/src/work-package-contracts.ts";

import type { SecureWorkPackageDirectory } from "./secure-work-package-directory.ts";
import {
  prepareWorkPackageEvaluationResults,
  type PreparedWorkPackageEvaluationResults
} from "./work-package-evaluation-result-reader.ts";
import {
  prepareWorkPackageRestResults,
  type WorkPackageRestSemanticHashing
} from "./work-package-rest-retry-reader.ts";

/** Incremental Domain Eval Result Set hash boundary. */
export interface WorkPackageEvalResultSetHasher {
  /** Add one ordered normalized Case identity. */
  readonly add: (value: {
    /** Stable Case key. */
    readonly caseKey: string;
    /** Frozen Case ordinal. */
    readonly ordinal: number;
    /** Validated semantic Eval hash. */
    readonly evalResultHash: string;
  }) => void;
  /** Finalize the nonempty owner-bound set. */
  readonly finish: (
    owner: { readonly kind: "EXECUTION"; readonly id: string },
    evaluationContextHash: string
  ) => string;
}

/** Pure Domain hash Ports required to distrust source Evaluation fields. */
export interface WorkPackageEvalSemanticHashing {
  /** Recompute one transport-neutral normalized Eval result hash. */
  readonly hashResult: (value: EvalCaseV1) => string;
  /** Recompute one Case Definition + REST + Eval identity. */
  readonly hashFinalResult: (value: {
    /** Frozen Case Definition identity. */
    readonly caseDefinitionHash: string;
    /** Validated REST semantic identity. */
    readonly restResultHash: string;
    /** Validated Eval semantic identity. */
    readonly evalResultHash: string;
  }) => string;
  /** Create one ordered Eval Result Set hasher bound to frozen Case identities. */
  readonly createResultSetHasher: (
    expectedCaseKey: (ordinal: number) => string | null
  ) => WorkPackageEvalResultSetHasher;
}

/** Complete locked inputs for one Evaluation retry selection. */
export interface PrepareWorkPackageEvaluationRetryInput {
  /** Stable package directory owned by the caller's lock session. */
  readonly directory: SecureWorkPackageDirectory;
  /** Frozen package Manifest. */
  readonly manifest: WorkPackageManifestV1;
  /** New retry Execution whose REST stage already completed. */
  readonly targetExecution: ExecutionV1;
  /** Read another validated Execution state by identity. */
  readonly readExecution: (executionId: string) => ExecutionV1 | null;
  /** Pure REST semantic hash Ports. */
  readonly restHashing: WorkPackageRestSemanticHashing;
  /** Pure Eval semantic hash Ports. */
  readonly evalHashing: WorkPackageEvalSemanticHashing;
  /** Cancellation signal. */
  readonly signal: AbortSignal;
}

// Preserve cancellation while treating unavailable source evidence as non-reusable.
function sourceUnavailable(error: unknown): null {
  if (error instanceof Error && error.message === "REQUEST_ABORTED") throw error;
  return null;
}

// Return one replayable empty selection without allocating result arrays.
function emptyRetryResults(): AsyncIterable<EvalCaseV1> {
  return (async function* (values: readonly EvalCaseV1[]): AsyncGenerator<EvalCaseV1> {
    for (const value of values) yield await Promise.resolve(value);
  })([]);
}

/** Select only aligned PASS/FAIL facts backed by a present ancestor Raw Artifact. */
export async function prepareWorkPackageEvaluationRetryResults(
  input: PrepareWorkPackageEvaluationRetryInput
): Promise<AsyncIterable<EvalCaseV1>> {
  if (input.targetExecution.rerun.mode !== "RETRY_FAILED") return emptyRetryResults();
  const sourceExecutionId = input.targetExecution.rerun.sourceExecutionId;
  const sourceExecution = input.readExecution(sourceExecutionId);
  if (sourceExecution === null) return emptyRetryResults();
  let source: PreparedWorkPackageEvaluationResults;
  try {
    source = await prepareWorkPackageEvaluationResults({
      directory: input.directory,
      manifest: input.manifest,
      sourceExecution,
      readExecution: input.readExecution,
      restHashing: input.restHashing,
      evalHashing: input.evalHashing,
      signal: input.signal
    });
  } catch (error) {
    sourceUnavailable(error);
    return emptyRetryResults();
  }
  const targetRest = await prepareWorkPackageRestResults({
    directory: input.directory,
    manifest: input.manifest,
    sourceExecution: input.targetExecution,
    hashing: input.restHashing,
    signal: input.signal
  });
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<EvalCaseV1> {
      const sourceReader = source.results[Symbol.asyncIterator]();
      const targetReader = targetRest.results[Symbol.asyncIterator]();
      for (;;) {
        const [sourceStep, targetStep] = await Promise.all([
          sourceReader.next(),
          targetReader.next()
        ]);
        if (sourceStep.done || targetStep.done) {
          if (sourceStep.done !== targetStep.done) throw new Error("WORK_PACKAGE_INVALID");
          return;
        }
        const result = sourceStep.value;
        const targetRestCase = targetStep.value;
        if (
          result.ordinal !== targetRestCase.ordinal ||
          result.caseKey !== targetRestCase.caseKey
        ) {
          throw new Error("WORK_PACKAGE_INVALID");
        }
        if (result.status !== "PASS" && result.status !== "FAIL") continue;
        const manifestCase = input.manifest.cases[result.ordinal];
        if (
          manifestCase?.caseKey !== result.caseKey ||
          targetRestCase.status !== "SUCCEEDED" ||
          input.evalHashing.hashFinalResult({
            caseDefinitionHash: manifestCase.baseDefinitionHash,
            restResultHash: targetRestCase.resultHash,
            evalResultHash: result.evalResultHash
          }) !== result.finalCaseResultHash
        ) {
          continue;
        }
        yield {
          ...result,
          provenance: {
            sourceKind: "EXECUTION",
            sourceId: sourceExecutionId,
            sourceResultHash: result.evalResultHash
          }
        };
      }
    }
  };
}
