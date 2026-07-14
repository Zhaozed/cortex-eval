import type { Clock } from "../../application-ports.ts";
import type { DomainJsonObject } from "@cortex-eval/domain/src/domain-canonical-hash.ts";
import type { ProviderOutput } from "@cortex-eval/domain/src/domain-evaluation.ts";
import { hashEvalResultSet } from "@cortex-eval/domain/src/domain-hash-inputs.ts";

import type {
  PlatformRunActionResult,
  PlatformRunMessageResolver,
  PlatformRunMutationResult,
  PlatformRunRevisionInput
} from "../runs/platform-run-service.ts";
import type {
  PlatformRun,
  PlatformRunProgress,
  StoredRestCaseResult
} from "../runs/platform-run-models.ts";
import type { PlatformRunTransactionManager } from "../runs/platform-run-ports.ts";
import type { PublishedRunArtifact, RunArtifactStore } from "../runs/run-artifact-port.ts";
import type {
  PlatformEvalCaseResult,
  PlatformEvalResultPage,
  PlatformEvalResultQuery
} from "./platform-eval-models.ts";
import type { PlatformEvalTransactionManager } from "./platform-eval-ports.ts";
import {
  disposeFrozenEvaluationRaw,
  isFrozenEvaluationRawSource,
  type FrozenEvaluationRaw
} from "./frozen-evaluation-engine.ts";
import type {
  PlatformEvaluationEngine,
  PlatformEvaluationRuntimePreflight
} from "./platform-evaluation-engine.ts";
import {
  importPartialPromptfooResults,
  type PromptfooImportCase
} from "./promptfoo-result-importer.ts";
import { importPartialPromptfooResultRows } from "./promptfoo-row-stream-importer.ts";
import { readArtifactBackedEvaluationResults } from "./platform-evaluation-reuse-reader.ts";

/** Safe Evaluation lifecycle event names. */
export type PlatformEvaluationBusinessEventName =
  | "RUN_EVALUATION_STARTED"
  | "RUN_EVALUATION_COMPLETED"
  | "RUN_EVALUATION_RAW_CLEANUP_FAILED"
  | "RUN_CANCEL_REQUESTED"
  | "RUN_CANCELLED";

/** Safe Evaluation lifecycle event without prompts, outputs or Secrets. */
export interface PlatformEvaluationBusinessEvent {
  /** Stable event discriminator. */
  readonly event: PlatformEvaluationBusinessEventName;
  /** Owning Run identity. */
  readonly runId: string;
  /** Durable event timestamp. */
  readonly timestamp: string;
}

/** Entrypoint-owned safe Evaluation event sink. */
export interface PlatformEvaluationEventSink {
  /** Record one sanitized lifecycle event. */
  readonly record: (event: PlatformEvaluationBusinessEvent) => Promise<void>;
}

/** Explicit dependencies for the platform Evaluation use case. */
export interface PlatformEvaluationServiceDependencies {
  /** Short Run transaction boundary for claim, cancellation and failure. */
  readonly runTransactionManager: PlatformRunTransactionManager;
  /** Short atomic Eval commit boundary. */
  readonly evalTransactionManager: PlatformEvalTransactionManager;
  /** Controlled external Promptfoo execution Port. */
  readonly engine: PlatformEvaluationEngine;
  /** Frozen Assertion interpreter capability Port. */
  readonly runtimePreflight: PlatformEvaluationRuntimePreflight;
  /** Immutable Run Artifact Port. */
  readonly artifactStore: RunArtifactStore;
  /** Application time source. */
  readonly clock: Clock;
  /** Externalized stable message lookup. */
  readonly messageResolver: PlatformRunMessageResolver;
  /** Resilient safe lifecycle event sink. */
  readonly eventSink: PlatformEvaluationEventSink;
  /** Cross-process cancellation observation interval. */
  readonly cancellationPollMs?: number | undefined;
}

// Await one bounded cancellation poll interval.
function waitForPoll(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timeout = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

// Re-read cancellation after an asynchronous wait without relying on stale narrowing.
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

// Stream an already ordered in-memory set exactly once into the Artifact Port.
async function* evalResultStream<T>(values: readonly T[]): AsyncGenerator<T> {
  for (const value of values) yield await Promise.resolve(value);
}

// Copy the closed Provider Output union into the Domain JSON boundary.
function providerOutputJson(value: ProviderOutput): DomainJsonObject {
  if (!value.ok) return { ok: false, errorMessage: value.errorMessage };
  return {
    ok: true,
    taskName: value.taskName,
    resolvedConfig: value.resolvedConfig,
    parsedOutput: value.parsedOutput
  };
}

/** Platform P6 Evaluation orchestration with all external work outside transactions. */
export class PlatformEvaluationService {
  /** Short Run transaction boundary. */
  readonly #runTransactions: PlatformRunTransactionManager;
  /** Atomic Eval transaction boundary. */
  readonly #evalTransactions: PlatformEvalTransactionManager;
  /** External Promptfoo engine. */
  readonly #engine: PlatformEvaluationEngine;
  /** Interpreter capability preflight. */
  readonly #runtimePreflight: PlatformEvaluationRuntimePreflight;
  /** Immutable Artifact store. */
  readonly #artifacts: RunArtifactStore;
  /** Application clock. */
  readonly #clock: Clock;
  /** Safe message lookup. */
  readonly #messages: PlatformRunMessageResolver;
  /** Safe event sink. */
  readonly #events: PlatformEvaluationEventSink;
  /** Cancellation polling interval. */
  readonly #pollMs: number;
  /** Active Evaluation Abort controllers. */
  readonly #controllers = new Map<string, AbortController>();
  /** Active Evaluation owners. */
  readonly #tasks = new Map<string, Promise<void>>();
  /** Owners interrupted by runtime shutdown. */
  readonly #interrupting = new Set<string>();

  /** Bind the complete P6 use-case boundary. */
  public constructor(dependencies: PlatformEvaluationServiceDependencies) {
    const poll = dependencies.cancellationPollMs ?? 40;
    if (!Number.isInteger(poll) || poll < 25 || poll > 50) {
      throw new Error("RUN_CANCELLATION_POLL_INVALID");
    }
    this.#runTransactions = dependencies.runTransactionManager;
    this.#evalTransactions = dependencies.evalTransactionManager;
    this.#engine = dependencies.engine;
    this.#runtimePreflight = dependencies.runtimePreflight;
    this.#artifacts = dependencies.artifactStore;
    this.#clock = dependencies.clock;
    this.#messages = dependencies.messageResolver;
    this.#events = dependencies.eventSink;
    this.#pollMs = poll;
  }

  /** Claim and asynchronously execute only READY/EVALUATION. */
  public async start(input: PlatformRunRevisionInput): Promise<PlatformRunMutationResult> {
    const candidate = await this.#runTransactions.execute(async (transaction) =>
      transaction.runs.getPlatformRun(input.runId)
    );
    if (candidate === null) return { ok: false, error: { code: "RUN_NOT_FOUND" } };
    if (candidate.stage !== "EVALUATION") {
      return {
        ok: false,
        error: { code: "RUN_STATE_CONFLICT", reason: "STAGE_UNAVAILABLE" }
      };
    }
    if (candidate.status !== "READY" || candidate.lockRevision !== input.expectedRevision) {
      return {
        ok: false,
        error: { code: "RUN_STATE_CONFLICT", reason: "STATE_OR_REVISION" }
      };
    }
    const availableRestResults = await this.#loadAvailableRestResults(candidate);
    const reusable = await this.#loadReusableEvaluationResults(candidate, availableRestResults);
    const preflightCases = availableRestResults.flatMap((result) => {
      if (result.status !== "SUCCEEDED" || reusable.has(result.ordinal)) return [];
      const frozen = candidate.suite.cases[result.ordinal];
      return frozen?.caseKey === result.caseKey ? [frozen] : [];
    });
    const preflight = await this.#runtimePreflight.check(
      preflightCases,
      new AbortController().signal
    );
    if (!preflight.ok) {
      return { ok: false, error: { code: "VALIDATION_FAILED", path: preflight.path } };
    }
    const claim = await this.#runTransactions.execute(async (transaction) => {
      const current = await transaction.runs.getPlatformRunProgress(input.runId);
      if (current === null) return { kind: "NOT_FOUND" as const };
      if (current.stage !== "EVALUATION") return { kind: "STAGE_UNAVAILABLE" as const };
      const result = await transaction.runs.claimStage(
        input.runId,
        input.expectedRevision,
        this.#clock.now()
      );
      return { kind: "CLAIM" as const, result };
    });
    if (claim.kind === "NOT_FOUND") return { ok: false, error: { code: "RUN_NOT_FOUND" } };
    if (claim.kind === "STAGE_UNAVAILABLE") {
      return {
        ok: false,
        error: { code: "RUN_STATE_CONFLICT", reason: "STAGE_UNAVAILABLE" }
      };
    }
    if (!claim.result.ok) {
      return claim.result.reason === "NOT_FOUND"
        ? { ok: false, error: { code: "RUN_NOT_FOUND" } }
        : {
            ok: false,
            error: { code: "RUN_STATE_CONFLICT", reason: claim.result.reason }
          };
    }
    await this.#recordEvent(
      "RUN_EVALUATION_STARTED",
      claim.result.run.id,
      claim.result.run.updatedAt
    );
    this.#launch(claim.result.run);
    return { ok: true, run: claim.result.run };
  }

  /** Persist Evaluation-stage cancellation and abort the local owner immediately. */
  public async cancel(input: PlatformRunRevisionInput): Promise<PlatformRunActionResult> {
    const result = await this.#runTransactions.execute(async (transaction) =>
      transaction.runs.requestCancel(input.runId, input.expectedRevision, this.#clock.now())
    );
    if (!result.ok) {
      return result.reason === "NOT_FOUND"
        ? { ok: false, error: { code: "RUN_NOT_FOUND" } }
        : {
            ok: false,
            error: { code: "RUN_STATE_CONFLICT", reason: "STATE_OR_REVISION" }
          };
    }
    await this.#recordEvent("RUN_CANCEL_REQUESTED", result.run.id, result.run.updatedAt);
    this.#controllers.get(input.runId)?.abort();
    return { ok: true, run: result.run };
  }

  /** Query complete normalized Evaluation facts. */
  public queryResults(query: PlatformEvalResultQuery): Promise<PlatformEvalResultPage> {
    return this.#evalTransactions.execute(async (transaction) =>
      transaction.evaluations.queryResults(query)
    );
  }

  /** Wait until all currently active Evaluation owners settle. */
  public async waitForIdle(): Promise<void> {
    while (this.#tasks.size > 0) await Promise.all([...this.#tasks.values()]);
  }

  /** Abort active work and persist interruption rather than cancellation. */
  public async shutdown(): Promise<void> {
    for (const [runId, controller] of this.#controllers) {
      this.#interrupting.add(runId);
      controller.abort();
    }
    await this.waitForIdle();
  }

  // Register one background Evaluation owner before returning the accepted claim.
  #launch(run: PlatformRun): void {
    const task = this.#execute(run)
      .catch(async () => this.#settleFailure(run.id))
      .then(async () => {
        if (this.#interrupting.has(run.id)) await this.#settleInterruption(run.id);
      })
      .catch(() => undefined)
      .finally(() => {
        this.#tasks.delete(run.id);
        this.#controllers.delete(run.id);
        this.#interrupting.delete(run.id);
      });
    this.#tasks.set(run.id, task);
  }

  // Execute Promptfoo, write both immutable Artifacts and atomically commit the result set.
  async #execute(run: PlatformRun): Promise<void> {
    if (run.resultSetHash === null) throw new Error("RUN_EVALUATION_REST_HASH_MISSING");
    const controller = new AbortController();
    const pollController = new AbortController();
    this.#controllers.set(run.id, controller);
    let pollFailure: Error | undefined;
    const poll = this.#pollCancellation(run.id, controller, pollController.signal).catch(
      (error: unknown) => {
        pollFailure =
          error instanceof Error
            ? error
            : new Error("RUN_EVALUATION_CANCELLATION_POLL_FAILED", { cause: error });
        controller.abort();
      }
    );
    const uncommitted: PublishedRunArtifact[] = [];
    let rawToDispose: FrozenEvaluationRaw | undefined;
    try {
      const restResults = await this.#loadRestResults(run);
      const reusedByOrdinal = await this.#loadReusableEvaluationResults(run, restResults);
      const pendingRestResults = restResults.filter(
        (result) => !reusedByOrdinal.has(result.ordinal)
      );
      const executed = await this.#engine.execute({
        run,
        restResults: pendingRestResults,
        restResultSetHash: run.resultSetHash,
        signal: controller.signal
      });
      rawToDispose = executed.raw;
      const rawPublication = await this.#artifacts.writeRawPromptfooEvidence({
        runId: run.id,
        runContextHash: run.runContextHash,
        evaluationContextHash: executed.evaluationContextHash,
        promptfooVersion: executed.promptfooVersion,
        exitCode: executed.exitCode,
        durationMs: executed.durationMs,
        raw: executed.raw
      });
      uncommitted.push(rawPublication);
      const rawDescriptor = rawPublication.descriptor;
      const importCases: PromptfooImportCase[] = pendingRestResults.map((result) => {
        const frozen = run.suite.cases[result.ordinal];
        if (frozen?.caseKey !== result.caseKey) throw new Error("RUN_EVALUATION_CASE_ALIGNMENT");
        return {
          caseKey: result.caseKey,
          ordinal: result.ordinal,
          caseDefinitionHash: result.caseDefinitionHash,
          definition: frozen.definition,
          restResult:
            result.status === "SUCCEEDED"
              ? {
                  status: "SUCCEEDED" as const,
                  resultHash: result.resultHash,
                  providerOutput: providerOutputJson(result.providerOutput)
                }
              : { status: "ERROR" as const, resultHash: result.resultHash }
        };
      });
      const importInput = {
        promptfooVersion: executed.promptfooVersion,
        cases: importCases,
        rawEvidence: {
          present: true as const,
          path: rawDescriptor.path,
          expectedSha256: rawDescriptor.expectedSha256,
          expectedSizeBytes: rawDescriptor.expectedSizeBytes
        },
        rubricPromptMaterializations: executed.rubricPromptMaterializations
      };
      const imported = isFrozenEvaluationRawSource(executed.raw)
        ? await importPartialPromptfooResultRows({ ...importInput, rows: executed.raw.openRows() })
        : importPartialPromptfooResults({ ...importInput, raw: executed.raw });
      const completedAt = this.#clock.now();
      const importedByOrdinal = new Map(imported.map((item) => [item.ordinal, item]));
      const results = run.suite.cases.map((frozen) => {
        const reused = reusedByOrdinal.get(frozen.ordinal);
        if (reused !== undefined) {
          if (run.sourceRunId === null) throw new Error("RUN_EVALUATION_REUSE_SOURCE_MISSING");
          return {
            ...reused,
            runId: run.id,
            provenance: {
              sourceKind: "RUN" as const,
              sourceId: run.sourceRunId,
              sourceResultHash: reused.evalResultHash
            },
            createdAt: completedAt,
            updatedAt: completedAt
          };
        }
        const item = importedByOrdinal.get(frozen.ordinal);
        if (item?.caseKey !== frozen.caseKey) {
          throw new Error("RUN_EVALUATION_RESULT_ALIGNMENT");
        }
        return {
          ...item,
          runId: run.id,
          createdAt: completedAt,
          updatedAt: completedAt
        };
      });
      const resultSetHash = hashEvalResultSet({
        contractVersion: "cortex.eval-result-set.v1",
        owner: { kind: "RUN", id: run.id },
        evaluationContextHash: executed.evaluationContextHash,
        cases: results.map((item) => ({
          caseKey: item.caseKey,
          ordinal: item.ordinal,
          evalResultHash: item.evalResultHash
        }))
      });
      const normalizedPublication = await this.#artifacts.writeNormalizedEvalResults({
        runId: run.id,
        runContextHash: run.runContextHash,
        evaluationContextHash: executed.evaluationContextHash,
        completedAt,
        expectedTotal: run.suite.cases.length,
        resultSetHash,
        cases: evalResultStream(results)
      });
      uncommitted.push(normalizedPublication);
      const normalizedDescriptor = normalizedPublication.descriptor;
      pollController.abort();
      await poll;
      if (pollFailure !== undefined) throw pollFailure;
      const current = await this.#getProgress(run.id);
      if (current?.status !== "RUNNING") return;
      if (this.#interrupting.has(run.id)) {
        await this.#removeUncommitted(uncommitted);
        uncommitted.length = 0;
        await this.#interrupt(current);
        return;
      }
      if (current.cancelRequestedAt !== null) {
        await this.#removeUncommitted(uncommitted);
        uncommitted.length = 0;
        await this.#commitCancellation(current);
        return;
      }
      const committed = await this.#evalTransactions.execute(async (transaction) =>
        transaction.evaluations.completeStage({
          runId: run.id,
          expectedRevision: current.lockRevision,
          expectedTotal: run.suite.cases.length,
          resultSetHash,
          evaluationContextHash: executed.evaluationContextHash,
          results,
          artifactManifest: {
            contractVersion: "cortex.artifact-manifest.v1",
            owner: { kind: "RUN", id: run.id },
            artifacts: [rawDescriptor, normalizedDescriptor]
          },
          updatedAt: completedAt
        })
      );
      if (!committed.ok) {
        await this.#removeUncommitted(uncommitted);
        uncommitted.length = 0;
        throw new Error(`RUN_EVALUATION_COMMIT_${committed.reason}`);
      }
      uncommitted.length = 0;
      await this.#recordEvent("RUN_EVALUATION_COMPLETED", run.id, completedAt);
    } finally {
      if (rawToDispose !== undefined) {
        await disposeFrozenEvaluationRaw(rawToDispose).catch(async () => {
          await this.#recordEvent("RUN_EVALUATION_RAW_CLEANUP_FAILED", run.id, this.#clock.now());
        });
      }
      pollController.abort();
      await poll.catch(() => undefined);
      await this.#removeUncommitted(uncommitted);
    }
  }

  // Load only PASS/FAIL source Eval facts backed by complete immutable source artifacts.
  async #loadReusableEvaluationResults(
    run: PlatformRun,
    restResults: readonly StoredRestCaseResult[]
  ): Promise<ReadonlyMap<number, PlatformEvalCaseResult>> {
    const sourceRunId = run.sourceRunId;
    if (run.rerunMode !== "RETRY_FAILED" || sourceRunId === null) return new Map();
    const source = await this.#runTransactions.execute(async (transaction) =>
      transaction.runs.getPlatformRun(sourceRunId)
    );
    if (source?.runContextHash !== run.runContextHash) return new Map();
    const sourceResults = await readArtifactBackedEvaluationResults({
      sourceRunId,
      runTransactionManager: this.#runTransactions,
      evalTransactionManager: this.#evalTransactions,
      artifactStore: this.#artifacts
    });
    const sourceByCase = new Map(sourceResults.map((result) => [result.caseKey, result]));
    const reusable = new Map<number, PlatformEvalCaseResult>();
    for (const rest of restResults) {
      const provenance = rest.provenance;
      const evaluation = sourceByCase.get(rest.caseKey);
      if (rest.status !== "SUCCEEDED") continue;
      if (provenance?.sourceKind !== "RUN") continue;
      if (provenance.sourceId !== sourceRunId) continue;
      if (provenance.sourceResultHash !== rest.resultHash) continue;
      if (evaluation === undefined) continue;
      if (evaluation.status !== "PASS" && evaluation.status !== "FAIL") continue;
      if (evaluation.ordinal !== rest.ordinal) continue;
      reusable.set(rest.ordinal, evaluation);
    }
    return reusable;
  }

  // Load every real REST result in frozen order inside one short read transaction.
  #loadRestResults(run: PlatformRun): Promise<readonly StoredRestCaseResult[]> {
    return this.#runTransactions.execute(async (transaction) => {
      const results: StoredRestCaseResult[] = [];
      for (const frozen of run.suite.cases) {
        const result = await transaction.runs.getRestResult(run.id, frozen.caseKey);
        if (result?.ordinal !== frozen.ordinal) {
          throw new Error("RUN_EVALUATION_REST_INCOMPLETE");
        }
        results.push(result);
      }
      return results;
    });
  }

  // Read currently available REST facts for preflight without changing asynchronous failure rules.
  #loadAvailableRestResults(run: PlatformRun): Promise<readonly StoredRestCaseResult[]> {
    return this.#runTransactions.execute(async (transaction) => {
      const results: StoredRestCaseResult[] = [];
      for (const frozen of run.suite.cases) {
        const result = await transaction.runs.getRestResult(run.id, frozen.caseKey);
        if (result?.ordinal === frozen.ordinal) results.push(result);
      }
      return results;
    });
  }

  // Poll durable cancellation so another local process can stop this owner.
  async #pollCancellation(
    runId: string,
    controller: AbortController,
    signal: AbortSignal
  ): Promise<void> {
    while (!signal.aborted && !controller.signal.aborted) {
      await waitForPoll(this.#pollMs, signal);
      if (isAborted(signal)) return;
      const current = await this.#getProgress(runId);
      if (current?.status !== "RUNNING" || current.cancelRequestedAt !== null) {
        controller.abort();
        return;
      }
    }
  }

  // Read one latest small Run state.
  #getProgress(runId: string): Promise<PlatformRunProgress | null> {
    return this.#runTransactions.execute(async (transaction) =>
      transaction.runs.getPlatformRunProgress(runId)
    );
  }

  // Delete only files not yet referenced by a durable Manifest.
  async #removeUncommitted(artifacts: readonly PublishedRunArtifact[]): Promise<void> {
    for (const artifact of [...artifacts].reverse()) {
      await this.#artifacts.removeUncommitted(artifact).catch(() => undefined);
    }
  }

  // Commit cancellation from the latest revision after external work has settled.
  async #commitCancellation(run: PlatformRunProgress): Promise<void> {
    const completedAt = this.#clock.now();
    const completed = await this.#runTransactions.execute(async (transaction) =>
      transaction.runs.commitCancellation(run.id, run.lockRevision, completedAt)
    );
    if (completed !== null) await this.#recordEvent("RUN_CANCELLED", run.id, completedAt);
  }

  // Persist runtime interruption after the active owner has released resources.
  async #interrupt(run: PlatformRunProgress): Promise<void> {
    await this.#runTransactions.execute(async (transaction) =>
      transaction.runs.interruptRun(run.id, run.lockRevision, this.#clock.now())
    );
  }

  // Re-read current state and settle one system failure without exposing the cause.
  async #settleFailure(runId: string): Promise<void> {
    const current = await this.#getProgress(runId).catch(() => null);
    if (current?.status !== "RUNNING") return;
    if (this.#interrupting.has(runId)) {
      await this.#interrupt(current);
      return;
    }
    if (current.cancelRequestedAt !== null) {
      await this.#commitCancellation(current);
      return;
    }
    await this.#runTransactions.execute(async (transaction) =>
      transaction.runs.failRun({
        runId,
        expectedRevision: current.lockRevision,
        errorCode: "EVALUATION_STAGE_FAILED",
        errorMessage: this.#messages.message("EVALUATION_STAGE_FAILED"),
        completedAt: this.#clock.now()
      })
    );
  }

  // Re-read and interrupt only a still-active owner after shutdown.
  async #settleInterruption(runId: string): Promise<void> {
    const current = await this.#getProgress(runId).catch(() => null);
    if (current !== null && current.stage !== "DONE") await this.#interrupt(current);
  }

  // Record one event without making observability a pipeline failure source.
  async #recordEvent(
    event: PlatformEvaluationBusinessEventName,
    runId: string,
    timestamp: string
  ): Promise<void> {
    await this.#events.record({ event, runId, timestamp }).catch(() => undefined);
  }
}
