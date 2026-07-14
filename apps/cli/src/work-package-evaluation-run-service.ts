import type {
  FrozenEvaluationEngine,
  FrozenEvaluationRaw,
  FrozenEvaluationJsonObject
} from "@cortex-eval/application/src/features/evaluation/frozen-evaluation-engine.ts";
import {
  disposeFrozenEvaluationRaw,
  isFrozenEvaluationRawSource
} from "@cortex-eval/application/src/features/evaluation/frozen-evaluation-engine.ts";
import type { PlatformEvaluationRuntimePreflight } from "@cortex-eval/application/src/features/evaluation/platform-evaluation-engine.ts";
import {
  importPromptfooCaseResultRows,
  promptfooResultRowCaseKey
} from "@cortex-eval/application/src/features/evaluation/promptfoo-row-stream-importer.ts";
import { ERROR_CODES, type ErrorCode } from "@cortex-eval/contracts/src/error-contracts.ts";
import {
  openWorkPackageExecutionSession,
  type PublishedStageArtifact,
  type WorkPackageExecutionContextHasher
} from "@cortex-eval/work-package/src/work-package-execution-session.ts";
import type { WorkPackageCaseDefinitionHasher } from "@cortex-eval/work-package/src/work-package-input-reader.ts";
import type { WorkPackageEvalSemanticHashing } from "@cortex-eval/work-package/src/work-package-evaluation-retry-reader.ts";
import { WorkPackageNormalizedEvalArtifactWriter } from "@cortex-eval/work-package/src/work-package-normalized-eval-artifact-writer.ts";
import { writeWorkPackageRawPromptfooArtifact } from "@cortex-eval/work-package/src/work-package-raw-promptfoo-artifact-writer.ts";
import type { WorkPackageRestSemanticHashing } from "@cortex-eval/work-package/src/work-package-rest-retry-reader.ts";

import type { CliProcessIdentity } from "./package-command-service.ts";
import type {
  WorkPackageEvaluationStagingFactory,
  WorkPackageEvaluationStagingStore
} from "./work-package-evaluation-staging-store.ts";
import type { WorkPackageStageEnvironment } from "./work-package-rest-run-service.ts";

const ERROR_CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES);

/** Dependencies of one package-local Evaluation stage orchestration. */
export interface WorkPackageEvaluationRunServiceDependencies {
  /** Pure Execution context hash Port. */
  readonly contextHasher: WorkPackageExecutionContextHasher;
  /** Pure Case Definition hash Port. */
  readonly caseHasher: WorkPackageCaseDefinitionHasher;
  /** Pure REST result and Result Set hash Ports. */
  readonly restHashing: WorkPackageRestSemanticHashing;
  /** Pure Eval result, Final result and Result Set hash Ports. */
  readonly evalHashing: WorkPackageEvalSemanticHashing;
  /** Shared fixed-version Promptfoo engine. */
  readonly engine: FrozenEvaluationEngine;
  /** Real interpreter capability preflight. */
  readonly runtimePreflight: PlatformEvaluationRuntimePreflight;
  /** Current command Secret source and preflight validator. */
  readonly environment: WorkPackageStageEnvironment;
  /** Operating-system process identity adapter. */
  readonly processIdentity: CliProcessIdentity;
  /** Collision-resistant package temporary-name source. */
  readonly nonce: () => string;
  /** UTC clock for durable state transitions. */
  readonly now: () => string;
  /** Resilient observer for private Evaluation cleanup failures. */
  readonly cleanupFailureSink: WorkPackageEvaluationCleanupFailureSink;
  /** Owner-private disk staging for bounded Evaluation joins and ordering. */
  readonly stagingFactory: WorkPackageEvaluationStagingFactory;
}

/** Safe cleanup failure fact without Prompt, output or Secret data. */
export interface WorkPackageEvaluationCleanupFailure {
  /** Owning immutable Execution version. */
  readonly executionId: string;
  /** Observation timestamp. */
  readonly timestamp: string;
}

/** Entrypoint-owned cleanup failure observer that cannot change the stage outcome. */
export interface WorkPackageEvaluationCleanupFailureSink {
  /** Record one sanitized private Evaluation cleanup failure. */
  readonly record: (failure: WorkPackageEvaluationCleanupFailure) => Promise<void>;
}

/** Input for an independent Evaluation stage on one existing Execution version. */
export interface WorkPackageEvaluationRunInput {
  /** Existing validated Work Package directory. */
  readonly packagePath: string;
  /** Existing Execution whose REST stage already succeeded. */
  readonly executionId: string;
  /** Command cancellation signal. */
  readonly signal: AbortSignal;
}

/** Input for a read-only Evaluation runtime preflight. */
export interface WorkPackageEvaluationPreflightInput {
  /** Validated Work Package directory. */
  readonly packagePath: string;
  /** Command cancellation signal. */
  readonly signal: AbortSignal;
}

/** Non-sensitive Evaluation completion facts returned to the CLI layer. */
export interface WorkPackageEvaluationRunResult {
  /** Immutable Work Package identity. */
  readonly packageId: string;
  /** Immutable Execution version identity. */
  readonly executionId: string;
  /** Native Promptfoo success or Assertion-fail code. */
  readonly promptfooExitCode: 0 | 100;
  /** Number of normalized FAIL Cases. */
  readonly evalFailCount: number;
  /** Number of normalized Evaluation errors. */
  readonly evalErrorCount: number;
  /** Complete owner-bound Evaluation Result Set identity. */
  readonly resultSetHash: string;
  /** Fixed relative Raw Artifact path. */
  readonly rawArtifactPath: string;
  /** Fixed relative Normalized Artifact path. */
  readonly normalizedArtifactPath: string;
}

// Read the small in-memory adapter form through the same per-Row import path.
function inMemoryPromptfooRows(raw: FrozenEvaluationJsonObject): readonly unknown[] {
  const results = raw.results;
  if (
    results === null ||
    typeof results !== "object" ||
    Array.isArray(results) ||
    results.version !== 3 ||
    !Array.isArray(results.results)
  ) {
    throw new Error("PROMPTFOO_PROCESS_ERROR");
  }
  return results.results;
}

// Preserve stable public errors and collapse unknown Evaluation implementation failures.
function stableEvaluationError(error: unknown): {
  readonly code: ErrorCode;
  readonly error: Error;
} {
  if (error instanceof Error && error.message === "PROMPTFOO_PROCESS_CANCELLED") {
    return {
      code: "EVALUATOR_CANCELLED",
      error: new Error("EVALUATOR_CANCELLED", { cause: error })
    };
  }
  if (error instanceof Error && ERROR_CODE_SET.has(error.message)) {
    return { code: error.message as ErrorCode, error };
  }
  return {
    code: "EVALUATION_STAGE_FAILED",
    error: new Error("EVALUATION_STAGE_FAILED", { cause: error })
  };
}

// Preserve pre-claim cancellation while giving a claimed Evaluation its stable stage code.
function requireEvaluationActive(signal: AbortSignal, stageStarted: boolean): void {
  if (!signal.aborted) return;
  throw new Error(stageStarted ? "EVALUATOR_CANCELLED" : "REQUEST_ABORTED");
}

// Add cancellation backpressure to a third-party Raw Row stream.
async function* abortAwareRows(rows: AsyncIterable<unknown>, signal: AbortSignal): AsyncGenerator {
  for await (const row of rows) {
    requireEvaluationActive(signal, true);
    yield row;
  }
  requireEvaluationActive(signal, true);
}

// Report cleanup failure without allowing the observer to replace the stage outcome.
async function reportCleanupFailure(
  dependencies: WorkPackageEvaluationRunServiceDependencies,
  executionId: string
): Promise<void> {
  await dependencies.cleanupFailureSink
    .record({ executionId, timestamp: dependencies.now() })
    .catch(() => undefined);
}

/** Locked offline Evaluation orchestration over one existing Execution. */
export class WorkPackageEvaluationRunService {
  /** Complete explicit service dependencies. */
  readonly #dependencies: WorkPackageEvaluationRunServiceDependencies;

  /** Bind execution, hashing, process and secure file boundaries. */
  public constructor(dependencies: WorkPackageEvaluationRunServiceDependencies) {
    this.#dependencies = dependencies;
  }

  /** Validate Evaluation Secrets, frozen Cases and required runtimes without changing state. */
  public async preflight(input: WorkPackageEvaluationPreflightInput): Promise<void> {
    const acquiredAt = this.#dependencies.now();
    const processStartedAt = await this.#dependencies.processIdentity.processStartedAt(process.pid);
    if (processStartedAt === null) throw new Error("WORK_PACKAGE_LOCKED");
    const session = await openWorkPackageExecutionSession({
      rootPath: input.packagePath,
      owner: {
        pid: process.pid,
        processStartedAt,
        executionId: null,
        acquiredAt
      },
      contextHasher: this.#dependencies.contextHasher,
      nonce: this.#dependencies.nonce
    });
    try {
      requireEvaluationActive(input.signal, false);
      this.#dependencies.environment.require(session.inputs.requiredEnvKeys("EVALUATION"));
      await session.inputs.readEvaluationInputs(
        session.inputs.streamCases(this.#dependencies.caseHasher, input.signal)
      );
      requireEvaluationActive(input.signal, false);
      const result = await this.#dependencies.runtimePreflight.check(
        session.inputs.streamCases(this.#dependencies.caseHasher, input.signal),
        input.signal
      );
      requireEvaluationActive(input.signal, false);
      if (!result.ok) throw new Error("VALIDATION_FAILED");
    } finally {
      await session.close();
    }
  }

  /** Execute Promptfoo and publish Raw plus Normalized Artifacts as one stage fact. */
  public async run(input: WorkPackageEvaluationRunInput): Promise<WorkPackageEvaluationRunResult> {
    const acquiredAt = this.#dependencies.now();
    const processStartedAt = await this.#dependencies.processIdentity.processStartedAt(process.pid);
    if (processStartedAt === null) throw new Error("WORK_PACKAGE_LOCKED");
    const session = await openWorkPackageExecutionSession({
      rootPath: input.packagePath,
      owner: {
        pid: process.pid,
        processStartedAt,
        executionId: input.executionId,
        acquiredAt
      },
      contextHasher: this.#dependencies.contextHasher,
      nonce: this.#dependencies.nonce
    });
    let stageStarted = false;
    let normalizedWriter: WorkPackageNormalizedEvalArtifactWriter | undefined;
    let rawToDispose: FrozenEvaluationRaw | undefined;
    let staging: WorkPackageEvaluationStagingStore | undefined;
    let rawArtifact: PublishedStageArtifact | undefined;
    let normalizedArtifact: PublishedStageArtifact | undefined;
    try {
      requireEvaluationActive(input.signal, false);
      this.#dependencies.environment.require(session.inputs.requiredEnvKeys("EVALUATION"));
      const execution = session.readExecution(input.executionId);
      if (execution === null) throw new Error("WORK_PACKAGE_INVALID");
      const evaluationInputs = await session.inputs.readEvaluationInputs(
        session.inputs.streamCases(this.#dependencies.caseHasher, input.signal)
      );
      const preparedRest = await session.prepareRestResults(
        input.executionId,
        this.#dependencies.restHashing,
        input.signal
      );
      const reusable = await session.prepareEvaluationRetryResults(
        input.executionId,
        this.#dependencies.restHashing,
        this.#dependencies.evalHashing,
        input.signal
      );
      staging = await this.#dependencies.stagingFactory.create();
      await staging.stageInputs(
        session.inputs.streamCases(this.#dependencies.caseHasher, input.signal),
        preparedRest.results,
        session.inputs.expectedCaseCount,
        input.signal
      );
      await staging.stageReusable(reusable, input.signal);
      requireEvaluationActive(input.signal, false);
      const preflight = await this.#dependencies.runtimePreflight.check(
        staging.openPreflightCases(),
        input.signal
      );
      requireEvaluationActive(input.signal, false);
      if (!preflight.ok) throw new Error("VALIDATION_FAILED");
      requireEvaluationActive(input.signal, false);
      await session.startStage(input.executionId, "EVALUATION", this.#dependencies.now());
      stageStarted = true;
      requireEvaluationActive(input.signal, true);
      const executed = await this.#dependencies.engine.execute({
        binding: { kind: "EXECUTION", id: input.executionId },
        executionContextHash: execution.executionContextHash,
        caseSource: staging.caseSource(),
        evaluator: evaluationInputs.evaluator,
        rubricPrompts: evaluationInputs.rubricPrompts,
        promptfooVersion: "0.121.18",
        evalConcurrency: execution.runExecutionLimits.evalConcurrency,
        restResultSetHash: preparedRest.resultSetHash,
        signal: input.signal
      });
      rawToDispose = executed.raw;
      requireEvaluationActive(input.signal, true);
      rawArtifact = await writeWorkPackageRawPromptfooArtifact(
        session,
        input.executionId,
        executed,
        input.signal
      );
      requireEvaluationActive(input.signal, true);
      const importInput = {
        promptfooVersion: executed.promptfooVersion,
        rawEvidence: {
          present: true as const,
          path: rawArtifact.path,
          expectedSha256: rawArtifact.sha256,
          expectedSizeBytes: rawArtifact.sizeBytes
        },
        rubricPromptMaterializations: executed.rubricPromptMaterializations
      };
      const rows = isFrozenEvaluationRawSource(executed.raw)
        ? abortAwareRows(executed.raw.openRows(), input.signal)
        : inMemoryPromptfooRows(executed.raw);
      try {
        let rowIndex = 0;
        for await (const row of rows) {
          requireEvaluationActive(input.signal, true);
          const caseKey = promptfooResultRowCaseKey(row, rowIndex);
          const expected = staging.findPendingImportCase(caseKey);
          if (expected === null) throw new Error("PROMPTFOO_IMPORT_CASE_UNKNOWN");
          staging.storeImported(importPromptfooCaseResultRows(importInput, expected, [row]));
          rowIndex += 1;
        }
        staging.commitImportedBatch();
        for await (const expected of staging.openMissingImportCases()) {
          requireEvaluationActive(input.signal, true);
          staging.storeImported(importPromptfooCaseResultRows(importInput, expected, []));
        }
        staging.commitImportedBatch();
      } catch (error) {
        staging.rollbackImportedBatch();
        throw error;
      }
      requireEvaluationActive(input.signal, true);
      normalizedWriter = await WorkPackageNormalizedEvalArtifactWriter.create(
        session,
        input.executionId,
        executed.evaluationContextHash
      );
      let evalFailCount = 0;
      let evalErrorCount = 0;
      const resultSetHasher = this.#dependencies.evalHashing.createResultSetHasher(
        (ordinal): string | null => session.inputs.expectedCaseKey(ordinal)
      );
      for await (const item of staging.openFinalResults()) {
        requireEvaluationActive(input.signal, true);
        if (item.status === "FAIL") evalFailCount += 1;
        if (item.status === "EVALUATION_ERROR") evalErrorCount += 1;
        resultSetHasher.add({
          caseKey: item.caseKey,
          ordinal: item.ordinal,
          evalResultHash: item.evalResultHash
        });
        await normalizedWriter.append(item);
      }
      const resultSetHash = resultSetHasher.finish(
        { kind: "EXECUTION", id: input.executionId },
        executed.evaluationContextHash
      );
      const completedAt = this.#dependencies.now();
      requireEvaluationActive(input.signal, true);
      normalizedArtifact = await normalizedWriter.commit(completedAt, resultSetHash);
      requireEvaluationActive(input.signal, true);
      await session.completeStage(input.executionId, "EVALUATION", completedAt, [
        rawArtifact,
        normalizedArtifact
      ]);
      return {
        packageId: session.packageSummary.packageId,
        executionId: input.executionId,
        promptfooExitCode: executed.exitCode,
        evalFailCount,
        evalErrorCount,
        resultSetHash,
        rawArtifactPath: rawArtifact.path,
        normalizedArtifactPath: normalizedArtifact.path
      };
    } catch (error) {
      await normalizedWriter?.abort().catch(async () => {
        await reportCleanupFailure(this.#dependencies, input.executionId);
      });
      const stable = stableEvaluationError(
        input.signal.aborted
          ? new Error(stageStarted ? "EVALUATOR_CANCELLED" : "REQUEST_ABORTED", { cause: error })
          : error
      );
      try {
        if (stageStarted) {
          await session.failStage(
            input.executionId,
            "EVALUATION",
            this.#dependencies.now(),
            stable.code
          );
        }
      } finally {
        for (const artifact of [rawArtifact, normalizedArtifact]) {
          if (artifact === undefined) continue;
          await session
            .discardUnregisteredStageArtifact(input.executionId, "EVALUATION", artifact)
            .catch(async () => {
              await reportCleanupFailure(this.#dependencies, input.executionId);
            });
        }
      }
      throw stable.error;
    } finally {
      if (rawToDispose !== undefined) {
        await disposeFrozenEvaluationRaw(rawToDispose).catch(async () => {
          await reportCleanupFailure(this.#dependencies, input.executionId);
        });
      }
      if (staging !== undefined) {
        await staging.dispose().catch(async () => {
          await reportCleanupFailure(this.#dependencies, input.executionId);
        });
      }
      await session.close();
    }
  }
}
