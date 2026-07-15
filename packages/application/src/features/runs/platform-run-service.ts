import type { Clock, IdGenerator } from "../../application-ports.ts";
import { collectRubricPromptKeys } from "@cortex-eval/domain/src/domain-resource-models.ts";
import { hashRestResult, hashRunContext } from "@cortex-eval/domain/src/domain-hash-inputs.ts";
import { hashRubricPromptSet } from "@cortex-eval/domain/src/domain-resource-hashes.ts";

import type {
  ClaimRunStageResult,
  PlatformRunTransaction,
  PlatformRunTransactionManager
} from "./platform-run-ports.ts";
import type {
  PlatformRun,
  PlatformRunDetail,
  PlatformRunExecutionLimits,
  PlatformRunPage,
  PlatformRunQuery,
  PlatformRunProgress,
  RestResultPage,
  RestResultQuery,
  StoredRestCaseResult
} from "./platform-run-models.ts";
import type { RunArtifactAvailability, RunArtifactStore } from "./run-artifact-port.ts";
import type { FrozenRunCase, RestCaseExecutionResult, RestExecutor } from "./run-rest-models.ts";
import { restExecutionMessageCode } from "./run-rest-models.ts";

/** Shared current-resource selection for preflight and Run creation. */
export interface PlatformRunSelection {
  /** Current Suite identity. */
  readonly suiteId: string;
  /** Current Endpoint identity. */
  readonly endpointConfigId: string;
  /** Current Evaluator identity. */
  readonly evaluatorConfigId: string;
}

/** Platform Run creation input. */
export interface CreatePlatformRunInput extends PlatformRunSelection {
  /** Manual staged or automatic pipeline mode. */
  readonly runMode: "STAGED" | "PIPELINE";
  /** Optional explicit limits; defaults are frozen server-side. */
  readonly runExecutionLimits?: PlatformRunExecutionLimits | undefined;
}

/** Run action guarded by the caller's latest Revision. */
export interface PlatformRunRevisionInput {
  /** Target Run identity. */
  readonly runId: string;
  /** Latest caller-observed Revision. */
  readonly expectedRevision: number;
}

/** Exact preflight facts shown before creating a Run. */
export interface PlatformRunPreflight {
  /** Selected current Suite. */
  readonly suiteId: string;
  /** Selected current Endpoint. */
  readonly endpointConfigId: string;
  /** Selected current Evaluator. */
  readonly evaluatorConfigId: string;
  /** Current executable Case count. */
  readonly caseCount: number;
  /** Sorted referenced Rubric Prompt keys. */
  readonly rubricPromptKeys: readonly string[];
  /** Environment keys required by each closed stage. */
  readonly requiredEnvKeys: {
    /** REST Header Secret references. */
    readonly REST: readonly string[];
    /** Evaluator Secret references. */
    readonly EVALUATION: readonly string[];
  };
  /** Current Endpoint timeout. */
  readonly endpointTimeoutMs: number;
  /** Current defaults that creation will freeze when omitted. */
  readonly defaultRunExecutionLimits: PlatformRunExecutionLimits;
}

/** Stable platform Run use-case error. */
export type PlatformRunServiceError =
  | { readonly code: "RUN_NOT_FOUND" }
  | { readonly code: "RUN_SUITE_EMPTY" }
  | { readonly code: "SUITE_NOT_FOUND" }
  | { readonly code: "CONFIGURATION_NOT_FOUND"; readonly kind: "ENDPOINT" | "LLM" }
  | { readonly code: "RUBRIC_PROMPT_NOT_FOUND"; readonly promptKey: string }
  | { readonly code: "VALIDATION_FAILED"; readonly path: string }
  | {
      readonly code: "RUN_STATE_CONFLICT";
      readonly reason: "STATE_OR_REVISION" | "GLOBAL_RUNNING" | "STAGE_UNAVAILABLE";
    };

/** Exact Run mutation result. */
export type PlatformRunMutationResult =
  | { readonly ok: true; readonly run: PlatformRun }
  | { readonly ok: false; readonly error: PlatformRunServiceError };

/** Exact lightweight Run action result. */
export type PlatformRunActionResult =
  | { readonly ok: true; readonly run: PlatformRunProgress }
  | { readonly ok: false; readonly error: PlatformRunServiceError };

/** Exact Run preflight result. */
export type PlatformRunPreflightResult =
  | { readonly ok: true; readonly preflight: PlatformRunPreflight }
  | { readonly ok: false; readonly error: PlatformRunServiceError };

/** Externalized stable message lookup owned by the entrypoint. */
export interface PlatformRunMessageResolver {
  /** Resolve one stable code to a safe persisted message. */
  readonly message: (code: string) => string;
}

/** Safe Run lifecycle event names exposed to an entrypoint logger. */
export type PlatformRunBusinessEventName =
  | "RUN_INPUT_FROZEN"
  | "RUN_REST_STARTED"
  | "RUN_REST_COMPLETED"
  | "RUN_CANCEL_REQUESTED"
  | "RUN_CANCELLED";

/** Safe Run lifecycle event without frozen inputs or provider output. */
export interface PlatformRunBusinessEvent {
  /** Stable event discriminator. */
  readonly event: PlatformRunBusinessEventName;
  /** Safe owning Run identity. */
  readonly runId: string;
  /** Durable event timestamp. */
  readonly timestamp: string;
}

/** Entrypoint-owned safe business-event sink. */
export interface PlatformRunEventSink {
  /** Record one already-sanitized Run lifecycle event. */
  readonly record: (event: PlatformRunBusinessEvent) => Promise<void>;
}

/** Narrow P6 continuation Port used only after a durable REST commit. */
export interface PipelineEvaluationStarter {
  /** Claim and launch READY/EVALUATION with the just-committed Revision. */
  readonly start: (input: PlatformRunRevisionInput) => Promise<PlatformRunMutationResult>;
}

/** Platform Run orchestration dependencies. */
export interface PlatformRunServiceDependencies {
  /** Dedicated short database transaction boundary. */
  readonly transactionManager: PlatformRunTransactionManager;
  /** Real REST execution Port. */
  readonly restExecutor: RestExecutor;
  /** Run-owned immutable Artifact Port. */
  readonly artifactStore: RunArtifactStore;
  /** Application time source. */
  readonly clock: Clock;
  /** Application Run identity source. */
  readonly idGenerator: IdGenerator;
  /** Externalized safe message source. */
  readonly messageResolver: PlatformRunMessageResolver;
  /** Resilient safe Run business-event sink. */
  readonly eventSink: PlatformRunEventSink;
  /** Optional closed P6 continuation used only by PIPELINE Runs. */
  readonly pipelineEvaluationStarter?: PipelineEvaluationStarter | undefined;
  /** Cross-process cancellation observation interval. */
  readonly cancellationPollMs?: number | undefined;
}

interface FrozenRunPreparation {
  /** Complete frozen Run facts except new identity and mutable state. */
  readonly suite: PlatformRun["suite"];
  /** Frozen Endpoint. */
  readonly endpoint: PlatformRun["endpoint"];
  /** Frozen Evaluator. */
  readonly evaluator: PlatformRun["evaluator"];
  /** Frozen referenced Prompt set. */
  readonly rubricPrompts: PlatformRun["rubricPrompts"];
  /** Default limits derived from the frozen Endpoint. */
  readonly defaultLimits: PlatformRunExecutionLimits;
  /** Sorted referenced Prompt keys. */
  readonly rubricPromptKeys: readonly string[];
  /** Sorted REST Secret references. */
  readonly restEnvKeys: readonly string[];
  /** Sorted Evaluation Secret references. */
  readonly evaluationEnvKeys: readonly string[];
}

// Validate one caller-supplied limit object without depending on transport schemas.
function validLimits(value: PlatformRunExecutionLimits): boolean {
  return (
    Number.isInteger(value.restConcurrency) &&
    value.restConcurrency >= 1 &&
    value.restConcurrency <= 64 &&
    Number.isInteger(value.evalConcurrency) &&
    value.evalConcurrency >= 1 &&
    value.evalConcurrency <= 16
  );
}

// Read cancellation state after asynchronous callbacks without stale control-flow narrowing.
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

// Await a bounded interval while allowing prompt loop shutdown.
function waitForPoll(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timeout = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** Closed P5 use case for platform Run creation, REST execution and cancellation. */
export class PlatformRunService {
  /** Dedicated transaction boundary. */
  readonly #transactionManager: PlatformRunTransactionManager;
  /** REST external side-effect Port. */
  readonly #restExecutor: RestExecutor;
  /** Immutable Artifact file Port. */
  readonly #artifactStore: RunArtifactStore;
  /** Application time source. */
  readonly #clock: Clock;
  /** Application identity source. */
  readonly #idGenerator: IdGenerator;
  /** Externalized safe message lookup. */
  readonly #messageResolver: PlatformRunMessageResolver;
  /** Entrypoint-owned resilient business-event sink. */
  readonly #eventSink: PlatformRunEventSink;
  /** Closed automatic REST-to-Evaluation continuation. */
  readonly #pipelineEvaluationStarter: PipelineEvaluationStarter | undefined;
  /** Cross-process cancellation polling interval. */
  readonly #cancellationPollMs: number;
  /** Active Run-owned Abort controllers. */
  readonly #controllers = new Map<string, AbortController>();
  /** Active background execution owners. */
  readonly #tasks = new Map<string, Promise<void>>();
  /** Runs stopping because the runtime is shutting down. */
  readonly #interrupting = new Set<string>();

  /** Bind explicit business and side-effect dependencies. */
  public constructor(dependencies: PlatformRunServiceDependencies) {
    const poll = dependencies.cancellationPollMs ?? 40;
    if (!Number.isInteger(poll) || poll < 25 || poll > 50) {
      throw new Error("RUN_CANCELLATION_POLL_INVALID");
    }
    this.#transactionManager = dependencies.transactionManager;
    this.#restExecutor = dependencies.restExecutor;
    this.#artifactStore = dependencies.artifactStore;
    this.#clock = dependencies.clock;
    this.#idGenerator = dependencies.idGenerator;
    this.#messageResolver = dependencies.messageResolver;
    this.#eventSink = dependencies.eventSink;
    this.#pipelineEvaluationStarter = dependencies.pipelineEvaluationStarter;
    this.#cancellationPollMs = poll;
  }

  /** Read current dependencies and defaults without creating a Run. */
  public async preflight(input: PlatformRunSelection): Promise<PlatformRunPreflightResult> {
    return this.#transactionManager.execute(async (transaction) => {
      const prepared = await this.#prepare(transaction, input);
      if ("code" in prepared) return { ok: false, error: prepared };
      return {
        ok: true,
        preflight: {
          ...input,
          caseCount: prepared.suite.cases.length,
          rubricPromptKeys: prepared.rubricPromptKeys,
          requiredEnvKeys: {
            REST: prepared.restEnvKeys,
            EVALUATION: prepared.evaluationEnvKeys
          },
          endpointTimeoutMs: prepared.endpoint.definition.timeoutMs,
          defaultRunExecutionLimits: prepared.defaultLimits
        }
      };
    });
  }

  /** Atomically freeze current resources into one READY/REST Run. */
  public async create(input: CreatePlatformRunInput): Promise<PlatformRunMutationResult> {
    if (input.runExecutionLimits !== undefined && !validLimits(input.runExecutionLimits)) {
      return { ok: false, error: { code: "VALIDATION_FAILED", path: "runExecutionLimits" } };
    }
    const runId = this.#idGenerator.nextId();
    const createdAt = this.#clock.now();
    const result = await this.#transactionManager.execute<PlatformRunMutationResult>(
      async (transaction) => {
        const prepared = await this.#prepare(transaction, input);
        if ("code" in prepared) return { ok: false, error: prepared };
        const limits = input.runExecutionLimits ?? prepared.defaultLimits;
        const rubricPromptSetHash = hashRubricPromptSet({
          contractVersion: "cortex.rubric-prompt-set.v1",
          prompts: prepared.rubricPrompts.map((item) => ({
            promptKey: item.definition.promptKey,
            promptHash: item.promptHash
          }))
        });
        const runContextHash = hashRunContext({
          contractVersion: "cortex.run-context.v1",
          suiteHash: prepared.suite.suiteHash,
          endpointConfigHash: prepared.endpoint.configHash,
          evaluatorConfigHash: prepared.evaluator.configHash,
          rubricPromptSetHash,
          promptfooVersion: "0.121.18",
          runExecutionLimits: limits
        });
        const run: PlatformRun = {
          id: runId,
          sourceType: "PLATFORM",
          sourceRunId: null,
          rerunMode: "NONE",
          suite: prepared.suite,
          endpoint: prepared.endpoint,
          evaluator: prepared.evaluator,
          rubricPrompts: prepared.rubricPrompts,
          runContextHash,
          promptfooVersion: "0.121.18",
          contractVersions: {
            runSnapshot: "cortex.run-snapshot.v1",
            caseDefinition: "cortex.case-definition.v1",
            platformRestResults: "cortex.platform-rest-results.v1"
          },
          runExecutionLimits: limits,
          runMode: input.runMode,
          status: "READY",
          stage: "REST",
          lockRevision: 0,
          cancelRequestedAt: null,
          restCompletedCount: 0,
          restErrorCount: 0,
          evalCompletedCount: 0,
          evalPassCount: 0,
          evalFailCount: 0,
          evalErrorCount: 0,
          evalNotEvaluatedCount: 0,
          resultSetHash: null,
          evaluationContextHash: null,
          evaluationResultSetHash: null,
          reportResultSetHash: null,
          reportSummary: null,
          artifactManifest: {
            contractVersion: "cortex.artifact-manifest.v1",
            owner: { kind: "RUN", id: runId },
            artifacts: []
          },
          errorCode: null,
          errorMessage: null,
          startedAt: null,
          completedAt: null,
          createdAt,
          updatedAt: createdAt
        };
        await transaction.runs.insertPlatformRun(run);
        return { ok: true, run };
      }
    );
    if (result.ok) await this.#recordEvent("RUN_INPUT_FROZEN", result.run.id, result.run.createdAt);
    return result;
  }

  /** Claim and asynchronously execute only the closed REST stage. */
  public async start(input: PlatformRunRevisionInput): Promise<PlatformRunMutationResult> {
    const claim = await this.#transactionManager.execute(async (transaction) => {
      const run = await transaction.runs.getPlatformRunProgress(input.runId);
      if (run === null) return { kind: "NOT_FOUND" as const };
      if (run.stage !== "REST") return { kind: "STAGE_UNAVAILABLE" as const };
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
    const mapped = this.#mapClaim(claim.result);
    if (!mapped.ok) return mapped;
    await this.#recordEvent("RUN_REST_STARTED", mapped.run.id, mapped.run.updatedAt);
    this.#launch(mapped.run);
    return mapped;
  }

  /** Persist a cancellation request and notify the local owner immediately. */
  public async cancel(input: PlatformRunRevisionInput): Promise<PlatformRunActionResult> {
    const result = await this.#transactionManager.execute(async (transaction) =>
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

  /** Read one current platform Run. */
  public get(runId: string): Promise<PlatformRunDetail | null> {
    return this.#transactionManager.execute(async (transaction) =>
      transaction.runs.getPlatformRunDetail(runId)
    );
  }

  /** Read one small durable Run state for progress and existence checks. */
  public getProgress(runId: string): Promise<PlatformRunProgress | null> {
    return this.#transactionManager.execute(async (transaction) =>
      transaction.runs.getPlatformRunProgress(runId)
    );
  }

  /** Query recent platform Run summaries without frozen payloads. */
  public queryRuns(query: PlatformRunQuery): Promise<PlatformRunPage> {
    return this.#transactionManager.execute(async (transaction) =>
      transaction.runs.queryPlatformRuns(query)
    );
  }

  /** Query real REST Case results in frozen order. */
  public queryRestResults(query: RestResultQuery): Promise<RestResultPage> {
    return this.#transactionManager.execute(async (transaction) =>
      transaction.runs.queryRestResults(query)
    );
  }

  /** Read one real REST Case result without manufacturing pending rows. */
  public getRestResult(runId: string, caseKey: string): Promise<StoredRestCaseResult | null> {
    return this.#transactionManager.execute(async (transaction) =>
      transaction.runs.getRestResult(runId, caseKey)
    );
  }

  /** Inspect immutable Artifact availability without changing Run facts. */
  public async inspectArtifacts(runId: string): Promise<readonly RunArtifactAvailability[] | null> {
    const run = await this.getProgress(runId);
    if (run === null) return null;
    return this.#artifactStore.inspect(run.artifactManifest);
  }

  /** Recover abandoned RUNNING facts before accepting new work. */
  public recover(): Promise<readonly PlatformRunProgress[]> {
    return this.#transactionManager.execute(async (transaction) =>
      transaction.runs.recoverRunning(this.#clock.now())
    );
  }

  /** Recover abandoned owners, then clean only artifacts absent from durable Manifests. */
  public async initialize(): Promise<readonly PlatformRunProgress[]> {
    const recovered = await this.recover();
    const manifests = await this.#transactionManager.execute(async (transaction) =>
      transaction.runs.listPlatformRunManifests()
    );
    await this.#artifactStore.cleanupOrphans(manifests);
    return recovered;
  }

  /** Wait until every currently or transitively active owner has settled. */
  public async waitForIdle(): Promise<void> {
    while (this.#tasks.size > 0) await Promise.all([...this.#tasks.values()]);
  }

  /** Abort active external work and persist interruption, never cancellation. */
  public async shutdown(): Promise<void> {
    for (const [runId, controller] of this.#controllers) {
      this.#interrupting.add(runId);
      controller.abort();
    }
    await this.waitForIdle();
  }

  // Read and validate all current inputs inside one freeze transaction.
  async #prepare(
    transaction: PlatformRunTransaction,
    input: PlatformRunSelection
  ): Promise<FrozenRunPreparation | PlatformRunServiceError> {
    const suite = await transaction.resources.getSuite(input.suiteId);
    if (suite === null) return { code: "SUITE_NOT_FOUND" };
    const cases = await transaction.resources.listCases(input.suiteId);
    if (cases.length === 0) return { code: "RUN_SUITE_EMPTY" };
    const endpoint = await transaction.resources.getConfiguration(
      "ENDPOINT",
      input.endpointConfigId
    );
    if (endpoint?.kind !== "ENDPOINT") {
      return { code: "CONFIGURATION_NOT_FOUND", kind: "ENDPOINT" };
    }
    const evaluator = await transaction.resources.getConfiguration("LLM", input.evaluatorConfigId);
    if (evaluator?.kind !== "LLM") {
      return { code: "CONFIGURATION_NOT_FOUND", kind: "LLM" };
    }
    const rubricPromptKeys = [
      ...new Set(cases.flatMap((item) => collectRubricPromptKeys(item.definition)))
    ].sort();
    const available = await transaction.resources.listRubricPrompts();
    const byKey = new Map(
      available
        .filter((item) => item.kind === "LLM_RUBRIC_PROMPT")
        .map((item) => [item.definition.promptKey, item] as const)
    );
    const missing = rubricPromptKeys.find((key) => !byKey.has(key));
    if (missing !== undefined) return { code: "RUBRIC_PROMPT_NOT_FOUND", promptKey: missing };
    const rubricPrompts = rubricPromptKeys.map((key) => {
      const prompt = byKey.get(key);
      if (prompt === undefined) {
        throw new Error("RUN_PROMPT_FREEZE_INVALID");
      }
      return {
        sourceId: prompt.id,
        name: prompt.name,
        promptHash: prompt.semanticHash,
        definition: prompt.definition
      };
    });
    const restEnvKeys = Object.values(endpoint.definition.headers)
      .filter((header) => header.kind === "ENV_SECRET")
      .map((header) => header.envKey)
      .sort();
    const evaluationEnvKeys =
      evaluator.definition.providerType === "GOOGLE_GEMINI"
        ? [evaluator.definition.apiKey.envKey]
        : evaluator.definition.auth.kind === "BEARER_ENV"
          ? [evaluator.definition.auth.secret.envKey]
          : [];
    return {
      suite: {
        id: suite.id,
        name: suite.name,
        suiteHash: suite.suiteHash,
        cases: cases.map((item) => ({
          caseKey: item.caseKey,
          ordinal: item.ordinal,
          definitionHash: item.definitionHash,
          definition: item.definition
        }))
      },
      endpoint: {
        sourceId: endpoint.id,
        name: endpoint.name,
        configHash: endpoint.semanticHash,
        definition: endpoint.definition
      },
      evaluator: {
        sourceId: evaluator.id,
        name: evaluator.name,
        configHash: evaluator.semanticHash,
        definition: evaluator.definition
      },
      rubricPrompts,
      defaultLimits: {
        contractVersion: "cortex.run-execution-limits.v1",
        restConcurrency: endpoint.definition.defaultConcurrency,
        evalConcurrency: 2
      },
      rubricPromptKeys,
      restEnvKeys: [...new Set(restEnvKeys)],
      evaluationEnvKeys: [...new Set(evaluationEnvKeys)].sort()
    };
  }

  // Map one storage claim fact to the public service union.
  #mapClaim(result: ClaimRunStageResult): PlatformRunMutationResult {
    if (result.ok) return { ok: true, run: result.run };
    if (result.reason === "NOT_FOUND") return { ok: false, error: { code: "RUN_NOT_FOUND" } };
    return {
      ok: false,
      error: {
        code: "RUN_STATE_CONFLICT",
        reason: result.reason
      }
    };
  }

  // Register one background owner before returning the accepted snapshot.
  #launch(run: PlatformRun): void {
    const task = this.#executeRest(run)
      .catch(async (error: unknown): Promise<void> => this.#settleSystemFailure(run.id, error))
      .then(async (): Promise<void> => {
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

  // Execute, persist and atomically expose one complete REST stage.
  async #executeRest(run: PlatformRun): Promise<void> {
    const controller = new AbortController();
    const pollController = new AbortController();
    this.#controllers.set(run.id, controller);
    let pollFailure: unknown;
    const poll = this.#pollCancellation(run.id, controller, pollController.signal).catch(
      (error: unknown): void => {
        pollFailure = error;
        controller.abort();
      }
    );
    try {
      const pendingCases = await this.#pendingRestCases(run);
      if (pendingCases.length > 0) {
        await this.#restExecutor.execute({
          cases: pendingCases,
          endpoint: run.endpoint.definition,
          concurrency: run.runExecutionLimits.restConcurrency,
          signal: controller.signal,
          onResult: async (result): Promise<void> => {
            const stored = this.#storeResult(run, result, this.#clock.now());
            const progress = await this.#transactionManager.execute(async (transaction) =>
              transaction.runs.recordRestResult(stored, stored.completedAt)
            );
            if (progress === null) throw new Error("RUN_PROGRESS_CONFLICT");
          }
        });
      }
      pollController.abort();
      await poll;
      if (pollFailure !== undefined) {
        throw pollFailure instanceof Error
          ? pollFailure
          : new Error("RUN_CANCELLATION_POLL_FAILED", { cause: pollFailure });
      }
      const current = await this.getProgress(run.id);
      if (current?.status !== "RUNNING") return;
      if (this.#interrupting.has(run.id)) {
        await this.#interrupt(current);
        return;
      }
      if (current.cancelRequestedAt !== null) {
        await this.#commitCancellation(current);
        return;
      }
      if (current.restCompletedCount !== run.suite.cases.length) {
        throw new Error("RUN_REST_RESULT_INCOMPLETE");
      }
      const completedAt = this.#clock.now();
      const written = await this.#artifactStore.writeRestResults({
        runId: run.id,
        runContextHash: run.runContextHash,
        completedAt,
        expectedTotal: run.suite.cases.length,
        cases: this.#iterateResults(run.id)
      });
      const { descriptor, resultSetHash } = written;
      if (this.#interrupting.has(run.id)) {
        await this.#artifactStore.removeUncommitted(written);
        await this.#interrupt(current);
        return;
      }
      const artifactManifest = {
        ...current.artifactManifest,
        artifacts: [...current.artifactManifest.artifacts, descriptor]
      };
      const completed = await this.#transactionManager.execute(async (transaction) =>
        transaction.runs.completeRestStage({
          runId: run.id,
          expectedRevision: current.lockRevision,
          expectedTotal: run.suite.cases.length,
          resultSetHash,
          artifactManifest,
          updatedAt: completedAt
        })
      );
      if (completed !== null) {
        await this.#recordEvent("RUN_REST_COMPLETED", completed.id, completed.updatedAt);
        if (this.#interrupting.has(run.id)) {
          await this.#interrupt(completed);
          return;
        }
        if (run.runMode === "PIPELINE" && this.#pipelineEvaluationStarter !== undefined) {
          try {
            const started = await this.#pipelineEvaluationStarter.start({
              runId: run.id,
              expectedRevision: completed.lockRevision
            });
            if (started.ok) return;
          } catch {
            // The unchanged handoff Revision below prevents overriding another owner.
          }
          if (completed.stage === "EVALUATION") {
            await this.#settlePipelineEvaluationStartFailure(run.id, completed.lockRevision);
          }
        }
        return;
      }
      await this.#artifactStore.removeUncommitted(written);
      const raced = await this.getProgress(run.id);
      if (raced?.status === "RUNNING" && raced.cancelRequestedAt !== null) {
        await this.#commitCancellation(raced);
      }
    } catch (error) {
      pollController.abort();
      await poll;
      await this.#settleSystemFailure(run.id, error);
    }
  }

  // Select only Cases without a durable preseeded reuse result.
  #pendingRestCases(run: PlatformRun): Promise<readonly FrozenRunCase[]> {
    return this.#transactionManager.execute(async (transaction) => {
      const pending: FrozenRunCase[] = [];
      for (const frozen of run.suite.cases) {
        const existing = await transaction.runs.getRestResult(run.id, frozen.caseKey);
        if (existing === null) pending.push(frozen);
      }
      return pending;
    });
  }

  // Poll durable state so cancellation from another process reaches the local Adapter.
  async #pollCancellation(
    runId: string,
    controller: AbortController,
    signal: AbortSignal
  ): Promise<void> {
    while (!signal.aborted && !controller.signal.aborted) {
      await waitForPoll(this.#cancellationPollMs, signal);
      if (isAborted(signal)) return;
      const current = await this.getProgress(runId);
      if (current?.status !== "RUNNING" || current.cancelRequestedAt !== null) {
        controller.abort();
        return;
      }
    }
  }

  // Convert one Adapter fact into a durable semantic result.
  #storeResult(
    run: PlatformRun,
    result: RestCaseExecutionResult,
    completedAt: string
  ): StoredRestCaseResult {
    const frozenCase = run.suite.cases[result.ordinal];
    if (frozenCase?.caseKey !== result.caseKey) {
      throw new Error("RUN_REST_RESULT_ALIGNMENT");
    }
    if (result.status === "SUCCEEDED") {
      const resultHash = hashRestResult({
        contractVersion: "cortex.rest-result.v1",
        caseKey: result.caseKey,
        caseDefinitionHash: frozenCase.definitionHash,
        result: {
          status: result.status,
          httpStatus: result.httpStatus,
          providerOutput: result.providerOutput
        }
      });
      return {
        runId: run.id,
        caseKey: result.caseKey,
        ordinal: result.ordinal,
        definition: frozenCase.definition,
        caseDefinitionHash: frozenCase.definitionHash,
        status: result.status,
        httpStatus: result.httpStatus,
        providerOutput: result.providerOutput,
        errorType: null,
        errorMessage: null,
        durationMs: result.durationMs,
        completedAt,
        resultHash,
        provenance: null
      };
    }
    const resultHash = hashRestResult({
      contractVersion: "cortex.rest-result.v1",
      caseKey: result.caseKey,
      caseDefinitionHash: frozenCase.definitionHash,
      result: {
        status: result.status,
        httpStatus: result.httpStatus,
        errorType: result.errorType
      }
    });
    return {
      runId: run.id,
      caseKey: result.caseKey,
      ordinal: result.ordinal,
      definition: frozenCase.definition,
      caseDefinitionHash: frozenCase.definitionHash,
      status: result.status,
      httpStatus: result.httpStatus,
      providerOutput: null,
      errorType: result.errorType,
      errorMessage: this.#messageResolver.message(restExecutionMessageCode(result.errorType)),
      durationMs: result.durationMs,
      completedAt,
      resultHash,
      provenance: null
    };
  }

  // Stream every real result in frozen order with at most one visible item per page.
  async *#iterateResults(runId: string): AsyncGenerator<StoredRestCaseResult> {
    let afterOrdinal: number | undefined;
    for (;;) {
      const page = await this.#transactionManager.execute(async (transaction) =>
        transaction.runs.queryRestResults({
          runId,
          limit: 1,
          ...(afterOrdinal === undefined ? {} : { afterOrdinal })
        })
      );
      for (const item of page.items) yield item;
      if (page.nextCursor === null) return;
      if (afterOrdinal !== undefined && page.nextCursor <= afterOrdinal) {
        throw new Error("RUN_REST_RESULT_CURSOR_INVALID");
      }
      afterOrdinal = page.nextCursor;
    }
  }

  // Commit final cancellation from the latest durable progress Revision.
  async #commitCancellation(run: PlatformRunProgress): Promise<void> {
    const completedAt = this.#clock.now();
    const completed = await this.#transactionManager.execute(async (transaction) =>
      transaction.runs.commitCancellation(run.id, run.lockRevision, completedAt)
    );
    if (completed !== null) await this.#recordEvent("RUN_CANCELLED", run.id, completedAt);
  }

  // Commit runtime interruption from the latest durable progress Revision.
  async #interrupt(run: PlatformRunProgress): Promise<void> {
    await this.#transactionManager.execute(async (transaction) =>
      transaction.runs.interruptRun(run.id, run.lockRevision, this.#clock.now())
    );
  }

  // Re-read the latest owned state so shutdown wins any finalization CAS race.
  async #settleInterruption(runId: string): Promise<void> {
    const current = await this.getProgress(runId);
    if (current === null || current.stage === "DONE") return;
    await this.#interrupt(current);
  }

  // Degrade logging failures without changing Run state transitions.
  async #recordEvent(
    event: PlatformRunBusinessEventName,
    runId: string,
    timestamp: string
  ): Promise<void> {
    await this.#eventSink.record({ event, runId, timestamp }).catch(() => undefined);
  }

  // Collapse an unexpected stage error without overriding cancellation or shutdown.
  async #settleSystemFailure(runId: string, error: unknown): Promise<void> {
    const current = await this.getProgress(runId);
    if (current?.status !== "RUNNING") return;
    if (this.#interrupting.has(runId)) {
      await this.#interrupt(current);
      return;
    }
    if (current.cancelRequestedAt !== null) {
      await this.#commitCancellation(current);
      return;
    }
    const errorCode =
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ARTIFACT_WRITE_FAILED"
        ? "ARTIFACT_WRITE_FAILED"
        : "INTERNAL_ERROR";
    await this.#transactionManager.execute(async (transaction) =>
      transaction.runs.failRun({
        runId,
        expectedRevision: current.lockRevision,
        errorCode,
        errorMessage: this.#messageResolver.message(errorCode),
        completedAt: this.#clock.now()
      })
    );
  }

  // Persist an automatic transition failure only while the Run remains at its untouched handoff.
  async #settlePipelineEvaluationStartFailure(
    runId: string,
    expectedRevision: number
  ): Promise<void> {
    const current = await this.getProgress(runId);
    if (
      current?.status !== "READY" ||
      current.stage !== "EVALUATION" ||
      current.lockRevision !== expectedRevision
    ) {
      return;
    }
    const completedAt = this.#clock.now();
    await this.#transactionManager.execute(async (transaction) =>
      transaction.runs.failRun({
        runId,
        expectedRevision,
        errorCode: "EVALUATION_STAGE_FAILED",
        errorMessage: this.#messageResolver.message("EVALUATION_STAGE_FAILED"),
        completedAt
      })
    );
  }
}
