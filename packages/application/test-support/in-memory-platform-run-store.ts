import type {
  ClaimRunStageResult,
  CompleteRestStageInput,
  FailPlatformRunInput,
  PlatformRunRepository,
  RequestRunCancellationResult
} from "../src/features/runs/platform-run-ports.ts";
import {
  platformRunDetail,
  platformRunProgress,
  type PlatformRun,
  type PlatformRunDetail,
  type PlatformRunPage,
  type PlatformRunProgress,
  type PlatformRunQuery,
  type RestResultPage,
  type RestResultQuery,
  type RunArtifactManifest,
  type StoredRestCaseResult
} from "../src/features/runs/platform-run-models.ts";

const NOW = "2026-07-13T00:00:00.000Z";

/** In-memory platform Run repository for Application orchestration tests. */
export class MemoryPlatformRunStore implements PlatformRunRepository {
  /** Current test Runs. */
  readonly values = new Map<string, PlatformRun>();
  /** Durable test Case results. */
  readonly results = new Map<string, StoredRestCaseResult>();

  /** Insert one Run. */
  public insertPlatformRun(value: PlatformRun): Promise<void> {
    this.values.set(value.id, value);
    return Promise.resolve();
  }

  /** Read one Run. */
  public getPlatformRun(runId: string): Promise<PlatformRun | null> {
    return Promise.resolve(this.values.get(runId) ?? null);
  }

  /** Read one bounded Run detail. */
  public getPlatformRunDetail(runId: string): Promise<PlatformRunDetail | null> {
    const run = this.values.get(runId);
    return Promise.resolve(run === undefined ? null : platformRunDetail(run));
  }

  /** Read one small durable state projection. */
  public getPlatformRunProgress(runId: string): Promise<PlatformRunProgress | null> {
    const run = this.values.get(runId);
    return Promise.resolve(run === undefined ? null : platformRunProgress(run));
  }

  /** Query small test Run summaries. */
  public queryPlatformRuns(query: PlatformRunQuery): Promise<PlatformRunPage> {
    const items = [...this.values.values()].slice(0, query.limit).map((run) => ({
      id: run.id,
      sourceType: run.sourceType,
      suiteId: run.suite.id,
      suiteName: run.suite.name,
      runMode: run.runMode,
      status: run.status,
      stage: run.stage,
      lockRevision: run.lockRevision,
      cancelRequestedAt: run.cancelRequestedAt,
      restTotalCount: run.suite.cases.length,
      restCompletedCount: run.restCompletedCount,
      restErrorCount: run.restErrorCount,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt
    }));
    return Promise.resolve({ items, nextCursor: null });
  }

  /** Claim one READY Run. */
  public claimStage(
    runId: string,
    expectedRevision: number,
    updatedAt: string
  ): Promise<ClaimRunStageResult> {
    const run = this.values.get(runId);
    if (run === undefined) return Promise.resolve({ ok: false, reason: "NOT_FOUND" });
    if (run.status !== "READY" || run.lockRevision !== expectedRevision) {
      return Promise.resolve({ ok: false, reason: "STATE_OR_REVISION" });
    }
    const claimed = {
      ...run,
      status: "RUNNING" as const,
      lockRevision: run.lockRevision + 1,
      startedAt: run.startedAt ?? updatedAt,
      updatedAt
    };
    this.values.set(runId, claimed);
    return Promise.resolve({ ok: true, run: claimed });
  }

  /** Request cancellation through CAS. */
  public requestCancel(
    runId: string,
    expectedRevision: number,
    updatedAt: string
  ): Promise<RequestRunCancellationResult> {
    const run = this.values.get(runId);
    if (run === undefined) return Promise.resolve({ ok: false, reason: "NOT_FOUND" });
    if (run.status !== "RUNNING" || run.lockRevision !== expectedRevision) {
      return Promise.resolve({ ok: false, reason: "STATE_OR_REVISION" });
    }
    const cancelled = {
      ...run,
      cancelRequestedAt: updatedAt,
      lockRevision: run.lockRevision + 1,
      updatedAt
    };
    this.values.set(runId, cancelled);
    return Promise.resolve({ ok: true, run: platformRunProgress(cancelled) });
  }

  /** Record one real REST result. */
  public recordRestResult(
    value: StoredRestCaseResult,
    updatedAt: string
  ): Promise<PlatformRunProgress | null> {
    const run = this.values.get(value.runId);
    if (run?.status !== "RUNNING") return Promise.resolve(null);
    if (this.results.has(`${value.runId}:${value.caseKey}`)) {
      return Promise.resolve(platformRunProgress(run));
    }
    this.results.set(`${value.runId}:${value.caseKey}`, value);
    const progress = {
      ...run,
      restCompletedCount: run.restCompletedCount + 1,
      restErrorCount: run.restErrorCount + (value.status === "ERROR" ? 1 : 0),
      lockRevision: run.lockRevision + 1,
      updatedAt
    };
    this.values.set(run.id, progress);
    return Promise.resolve(platformRunProgress(progress));
  }

  /** Commit a complete REST stage. */
  public completeRestStage(input: CompleteRestStageInput): Promise<PlatformRunProgress | null> {
    const run = this.values.get(input.runId);
    if (
      run?.status !== "RUNNING" ||
      run.cancelRequestedAt !== null ||
      run.lockRevision !== input.expectedRevision ||
      run.restCompletedCount !== input.expectedTotal
    ) {
      return Promise.resolve(null);
    }
    const completed = {
      ...run,
      status: "READY" as const,
      stage: "EVALUATION" as const,
      lockRevision: run.lockRevision + 1,
      resultSetHash: input.resultSetHash,
      artifactManifest: input.artifactManifest,
      updatedAt: input.updatedAt
    };
    this.values.set(run.id, completed);
    return Promise.resolve(platformRunProgress(completed));
  }

  /** Commit final cancellation. */
  public commitCancellation(
    runId: string,
    expectedRevision: number,
    completedAt: string
  ): Promise<PlatformRunProgress | null> {
    const run = this.values.get(runId);
    if (run?.lockRevision !== expectedRevision || run.cancelRequestedAt === null) {
      return Promise.resolve(null);
    }
    const cancelled = {
      ...run,
      status: "CANCELLED" as const,
      stage: "DONE" as const,
      lockRevision: run.lockRevision + 1,
      completedAt,
      updatedAt: completedAt
    };
    this.values.set(runId, cancelled);
    return Promise.resolve(platformRunProgress(cancelled));
  }

  /** Commit one system failure. */
  public failRun(input: FailPlatformRunInput): Promise<PlatformRunProgress | null> {
    const run = this.values.get(input.runId);
    if (run?.lockRevision !== input.expectedRevision) return Promise.resolve(null);
    const failed = {
      ...run,
      status: "FAILED" as const,
      stage: "DONE" as const,
      lockRevision: run.lockRevision + 1,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      completedAt: input.completedAt,
      updatedAt: input.completedAt
    };
    this.values.set(run.id, failed);
    return Promise.resolve(platformRunProgress(failed));
  }

  /** Commit runtime interruption. */
  public interruptRun(
    runId: string,
    expectedRevision: number,
    completedAt: string
  ): Promise<PlatformRunProgress | null> {
    const run = this.values.get(runId);
    if (
      run?.lockRevision !== expectedRevision ||
      run.stage === "DONE" ||
      (run.status !== "RUNNING" && run.status !== "READY")
    ) {
      return Promise.resolve(null);
    }
    const interrupted = {
      ...run,
      status: "INTERRUPTED" as const,
      stage: "DONE" as const,
      lockRevision: run.lockRevision + 1,
      completedAt,
      updatedAt: completedAt
    };
    this.values.set(runId, interrupted);
    return Promise.resolve(platformRunProgress(interrupted));
  }

  /** Recover all test Runs. */
  public recoverRunning(): Promise<readonly PlatformRunProgress[]> {
    return Promise.resolve([]);
  }

  /** Query all durable test results. */
  public queryRestResults(query: RestResultQuery): Promise<RestResultPage> {
    const items = [...this.results.values()].filter((item) => item.runId === query.runId);
    return Promise.resolve({ items, nextCursor: null });
  }

  /** Read one durable test result. */
  public getRestResult(runId: string, caseKey: string): Promise<StoredRestCaseResult | null> {
    return Promise.resolve(this.results.get(`${runId}:${caseKey}`) ?? null);
  }

  /** List current test Manifests. */
  public listPlatformRunManifests(): Promise<readonly RunArtifactManifest[]> {
    return Promise.resolve([...this.values.values()].map((run) => run.artifactManifest));
  }
}

/** Run store that loses every progress write. */
export class ProgressConflictRunStore extends MemoryPlatformRunStore {
  /** Simulate loss of the running progress CAS. */
  public override recordRestResult(): Promise<PlatformRunProgress | null> {
    return Promise.resolve(null);
  }
}

/** Run store returning one configured stage-claim failure. */
export class ClaimFailureRunStore extends MemoryPlatformRunStore {
  /** Claim failure returned after the initial Run read succeeds. */
  readonly #reason: "NOT_FOUND" | "STATE_OR_REVISION" | "GLOBAL_RUNNING";

  /** Bind one repository claim failure. */
  public constructor(reason: "NOT_FOUND" | "STATE_OR_REVISION" | "GLOBAL_RUNNING") {
    super();
    this.#reason = reason;
  }

  /** Return the configured claim failure. */
  public override claimStage(): Promise<ClaimRunStageResult> {
    return Promise.resolve({ ok: false, reason: this.#reason });
  }
}

/** Run store where cancellation wins the REST stage-commit race. */
export class CancellationWinsCompletionRunStore extends MemoryPlatformRunStore {
  /** Convert the failed stage-commit CAS into a concurrent cancellation fact. */
  public override completeRestStage(
    input: CompleteRestStageInput
  ): Promise<PlatformRunProgress | null> {
    const current = this.values.get(input.runId);
    if (current !== undefined) {
      this.values.set(input.runId, {
        ...current,
        cancelRequestedAt: NOW,
        lockRevision: current.lockRevision + 1
      });
    }
    return Promise.resolve(null);
  }
}

/** Run store where another terminal state wins the REST stage-commit race. */
export class TerminalWinsCompletionRunStore extends MemoryPlatformRunStore {
  /** Convert the failed stage-commit CAS into another process' terminal fact. */
  public override completeRestStage(
    input: CompleteRestStageInput
  ): Promise<PlatformRunProgress | null> {
    const current = this.values.get(input.runId);
    if (current !== undefined) {
      this.values.set(input.runId, { ...current, status: "FAILED", stage: "DONE" });
    }
    return Promise.resolve(null);
  }
}

/** Run store forcing one extra result page. */
export class PagedResultRunStore extends MemoryPlatformRunStore {
  /** Whether the first result page has already been read. */
  #pageRead = false;

  /** Force one extra empty page after returning the complete result. */
  public override queryRestResults(query: RestResultQuery): Promise<RestResultPage> {
    const items = [...this.results.values()].filter((item) => item.runId === query.runId);
    if (!this.#pageRead && query.afterOrdinal === undefined) {
      this.#pageRead = true;
      return Promise.resolve({ items, nextCursor: 0 });
    }
    return Promise.resolve({ items: [], nextCursor: null });
  }
}
