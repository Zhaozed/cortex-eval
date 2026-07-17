import type {
  OfflineRestCaseResult,
  OfflineRestExecutionResult,
  OfflineRestExecutionService
} from "@cortex-eval/application/src/features/runs/offline-rest-execution-service.ts";
import { ERROR_CODES, type ErrorCode } from "@cortex-eval/contracts/src/error-contracts.ts";
import type {
  PublishedStageArtifact,
  OpenWorkPackageExecutionSessionInput,
  WorkPackageExecutionSession,
  WorkPackageExecutionContextHasher,
  WorkPackageExecutionRerun,
  WorkPackageAnalysisLimitOverrides,
  WorkPackageRunLimitOverrides
} from "@cortex-eval/work-package/src/work-package-execution-session.ts";
import type { WorkPackageCaseDefinitionHasher } from "@cortex-eval/work-package/src/work-package-input-reader.ts";
import type { WorkPackageRestSemanticHashing } from "@cortex-eval/work-package/src/work-package-rest-retry-reader.ts";
import { WorkPackageRestArtifactWriter } from "@cortex-eval/work-package/src/work-package-rest-artifact-writer.ts";

import type { CliProcessIdentity } from "./package-command-service.ts";

const ERROR_CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES);

/** Validated source REST Artifact boundary used only by retry-failed. */
export interface WorkPackageRestRetryResults {
  /** Preflight the complete source Artifact, then expose aligned reusable successes. */
  readonly prepare: (input: {
    /** Locked package session containing both source and target Executions. */
    readonly session: WorkPackageExecutionSession;
    /** Existing immutable source Execution identity. */
    readonly sourceExecutionId: string;
    /** Command cancellation signal. */
    readonly signal: AbortSignal;
  }) => Promise<AsyncIterable<OfflineRestCaseResult> | Iterable<OfflineRestCaseResult>>;
}

/** Stage-scoped Secret availability boundary. */
export interface WorkPackageStageEnvironment {
  /** Reject a missing current-stage Secret before state mutation. */
  readonly require: (keys: readonly string[]) => void;
}

/** Concrete adapter over the locked Work Package source Artifact reader. */
export class SessionWorkPackageRestRetryResults implements WorkPackageRestRetryResults {
  /** Pure REST semantic hash Ports. */
  readonly #hashing: WorkPackageRestSemanticHashing;

  /** Bind the Domain semantic hash implementation. */
  public constructor(hashing: WorkPackageRestSemanticHashing) {
    this.#hashing = hashing;
  }

  /** Delegate preflight and streaming to the source-owning package session. */
  public prepare(input: {
    readonly session: WorkPackageExecutionSession;
    readonly sourceExecutionId: string;
    readonly signal: AbortSignal;
  }): Promise<AsyncIterable<OfflineRestCaseResult>> {
    return input.session.prepareRestRetryResults(
      input.sourceExecutionId,
      this.#hashing,
      input.signal
    );
  }
}

/** Dependencies of the package-local REST orchestration boundary. */
export interface WorkPackageRestRunServiceDependencies {
  /** Pure Execution context hash Port. */
  readonly contextHasher: WorkPackageExecutionContextHasher;
  /** Pure Case Definition hash Port. */
  readonly caseHasher: WorkPackageCaseDefinitionHasher;
  /** Shared Application REST execution use case. */
  readonly restExecution: OfflineRestExecutionService;
  /** UUIDv7 source for the new immutable Execution. */
  readonly nextId: () => string;
  /** Collision-resistant package temporary-name source. */
  readonly nonce: () => string;
  /** UTC clock for durable state transitions. */
  readonly now: () => string;
  /** Operating-system process identity adapter. */
  readonly processIdentity: CliProcessIdentity;
  /** Strict two-pass source Artifact reader for retry-failed. */
  readonly retryResults: WorkPackageRestRetryResults;
  /** Current command Secret source and preflight validator. */
  readonly environment: WorkPackageStageEnvironment;
  /** Locked Work Package session factory. */
  readonly openSession: (
    input: OpenWorkPackageExecutionSessionInput
  ) => Promise<WorkPackageExecutionSession>;
  /** Resilient observer for private REST cleanup failures. */
  readonly cleanupFailureSink: WorkPackageRestCleanupFailureSink;
}

/** Sanitized REST cleanup failure observer that cannot replace the stage outcome. */
export interface WorkPackageRestCleanupFailureSink {
  /** Record one cleanup failure without path, response or Secret content. */
  readonly record: (failure: { readonly executionId: string }) => Promise<void>;
}

/** One new, forced or retry-failed offline REST invocation. */
export interface WorkPackageRestRunInput {
  /** Existing validated Work Package directory. */
  readonly packagePath: string;
  /** Immutable rerun provenance for the new Execution. */
  readonly rerun: WorkPackageExecutionRerun;
  /** Optional explicit REST and Evaluation limits frozen before start. */
  readonly runExecutionLimits?: WorkPackageRunLimitOverrides | undefined;
  /** Optional explicit Analysis limit frozen before start. */
  readonly analysisExecutionLimits?: WorkPackageAnalysisLimitOverrides | undefined;
  /** Command cancellation signal. */
  readonly signal: AbortSignal;
}

/** Non-sensitive completion facts returned to the CLI presentation layer. */
export interface WorkPackageRestRunResult {
  /** Immutable Work Package identity. */
  readonly packageId: string;
  /** Newly created immutable Execution identity. */
  readonly executionId: string;
  /** Number of ordinary per-Case REST errors. */
  readonly restErrorCount: number;
  /** Stable complete REST Result Set hash. */
  readonly resultSetHash: string;
  /** Fixed relative REST Artifact path. */
  readonly artifactPath: string;
}

// Preserve only the shared stable error vocabulary across the CLI boundary.
function stableError(error: unknown): { readonly code: ErrorCode; readonly error: Error } {
  if (error instanceof Error && ERROR_CODE_SET.has(error.message)) {
    return { code: error.message as ErrorCode, error };
  }
  return {
    code: "INTERNAL_ERROR",
    error: new Error("INTERNAL_ERROR", { cause: error })
  };
}

// Re-read mutable AbortSignal state after awaited work.
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

/** Coordinates one package lock, Execution state and streamed REST Artifact. */
export class WorkPackageRestRunService {
  /** Complete explicit dependency set. */
  readonly #dependencies: WorkPackageRestRunServiceDependencies;

  /** Bind pure hash Ports, Application use case and operating-system edges. */
  public constructor(dependencies: WorkPackageRestRunServiceDependencies) {
    this.#dependencies = dependencies;
  }

  /** Create one Execution version and close its REST stage atomically per file. */
  public async run(input: WorkPackageRestRunInput): Promise<WorkPackageRestRunResult> {
    if (input.signal.aborted) throw new Error("REQUEST_ABORTED");

    const executionId = this.#dependencies.nextId();
    const processStartedAt = await this.#dependencies.processIdentity.processStartedAt(process.pid);
    if (processStartedAt === null) throw new Error("INTERNAL_ERROR");
    const session = await this.#dependencies.openSession({
      rootPath: input.packagePath,
      owner: {
        pid: process.pid,
        processStartedAt,
        executionId,
        acquiredAt: this.#dependencies.now()
      },
      contextHasher: this.#dependencies.contextHasher,
      nonce: this.#dependencies.nonce
    });
    let stageStarted = false;
    let writer: WorkPackageRestArtifactWriter | undefined;
    let artifact: PublishedStageArtifact | undefined;
    try {
      this.#dependencies.environment.require(session.inputs.requiredEnvKeys("REST"));
      const endpoint = await session.inputs.readEndpoint();
      const cases = session.inputs.streamCases(this.#dependencies.caseHasher, input.signal);
      const caseReader = cases[Symbol.asyncIterator]();
      for (;;) {
        const step = await caseReader.next();
        if (step.done) break;
        if (isAborted(input.signal)) throw new Error("REQUEST_ABORTED");
      }
      const reusedResults =
        input.rerun.mode === "RETRY_FAILED"
          ? await this.#dependencies.retryResults.prepare({
              session,
              sourceExecutionId: input.rerun.sourceExecutionId,
              signal: input.signal
            })
          : [];
      if (isAborted(input.signal)) throw new Error("REQUEST_ABORTED");
      const execution = await session.createExecution({
        executionId,
        createdAt: this.#dependencies.now(),
        rerun: input.rerun,
        ...(input.runExecutionLimits === undefined
          ? {}
          : { runExecutionLimits: input.runExecutionLimits }),
        ...(input.analysisExecutionLimits === undefined
          ? {}
          : { analysisExecutionLimits: input.analysisExecutionLimits })
      });
      await session.startStage(executionId, "REST", this.#dependencies.now());
      stageStarted = true;
      writer = await WorkPackageRestArtifactWriter.create(session, executionId);
      const artifactWriter = writer;
      let restErrorCount = 0;
      const result = await this.#dependencies.restExecution.execute({
        executionId,
        cases: session.inputs.streamCases(this.#dependencies.caseHasher, input.signal),
        expectedCaseCount: session.inputs.expectedCaseCount,
        endpoint,
        concurrency: execution.runExecutionLimits.restConcurrency,
        signal: input.signal,
        reusedResults,
        onOrderedResult: async (value): Promise<void> => {
          if (value.status === "ERROR") restErrorCount += 1;
          await artifactWriter.append(value);
        }
      });
      if (isAborted(input.signal)) throw new Error("REST_CANCELLED");
      artifact = await artifactWriter.commit(result.completedAt, result.resultSetHash);
      if (isAborted(input.signal)) throw new Error("REST_CANCELLED");
      await session.completeStage(executionId, "REST", result.completedAt, [artifact]);
      return this.#result(session.packageSummary.packageId, executionId, restErrorCount, result);
    } catch (error) {
      await writer?.abort().catch(async () => {
        await this.#reportCleanupFailure(executionId);
      });
      const stable = stableError(error);
      try {
        if (stageStarted) {
          await session.failStage(executionId, "REST", this.#dependencies.now(), stable.code);
        }
      } finally {
        if (artifact !== undefined) {
          await session
            .discardUnregisteredStageArtifact(executionId, "REST", artifact)
            .catch(async () => {
              await this.#reportCleanupFailure(executionId);
            });
        }
      }
      throw stable.error;
    } finally {
      await session.close();
    }
  }

  // Report cleanup failure without changing the stable REST command result.
  async #reportCleanupFailure(executionId: string): Promise<void> {
    await this.#dependencies.cleanupFailureSink.record({ executionId }).catch(() => undefined);
  }

  // Return only the fixed public completion projection.
  #result(
    packageId: string,
    executionId: string,
    restErrorCount: number,
    result: OfflineRestExecutionResult
  ): WorkPackageRestRunResult {
    return {
      packageId,
      executionId,
      restErrorCount,
      resultSetHash: result.resultSetHash,
      artifactPath: `executions/${executionId}/rest-results.jsonl`
    };
  }
}
