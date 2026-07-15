import type {
  PlatformEvalCaseResult,
  PlatformEvalResultPage,
  PlatformEvalResultQuery
} from "../src/features/evaluation/platform-eval-models.ts";
import type {
  PlatformEvalRepository,
  PlatformEvalTransactionManager
} from "../src/features/evaluation/platform-eval-ports.ts";
import type {
  PlatformNormalizedEvalArtifactInput,
  PlatformRawPromptfooArtifactInput,
  PlatformReportArtifactInput,
  PlatformReportArtifactWriteResult,
  PlatformRestArtifactInput,
  PlatformRestArtifactWriteResult,
  PublishedRunArtifact,
  RunArtifactAvailability,
  RunArtifactStore
} from "../src/features/runs/run-artifact-port.ts";
import type {
  PlatformRun,
  PlatformRunProgress,
  RunArtifactDescriptor,
  RunArtifactManifest
} from "../src/features/runs/platform-run-models.ts";
import type {
  RestExecutionErrorType,
  RestExecutionInput,
  RestExecutionSummary,
  RestExecutor
} from "../src/features/runs/run-rest-models.ts";
import { hashRestResultSet } from "@cortex-eval/domain/src/domain-hash-inputs.ts";

import { MemoryPlatformRunStore } from "./in-memory-platform-run-store.ts";

/** In-memory Evaluation repository that advances the backing Run atomically. */
export class MemoryPlatformEvalRepository implements PlatformEvalRepository {
  /** Last complete-stage input. */
  completeInput: Parameters<PlatformEvalRepository["completeStage"]>[0] | null = null;
  /** Source Evaluation rows available to rerun planning. */
  queryItems: readonly PlatformEvalCaseResult[] = [];
  /** Backing Run store advanced by the fake commit. */
  readonly #runs: MemoryPlatformRunStore;

  /** Bind one backing Run store. */
  public constructor(runs: MemoryPlatformRunStore) {
    this.#runs = runs;
  }

  /** Capture and atomically advance the fake Run. */
  public completeStage(
    input: Parameters<PlatformEvalRepository["completeStage"]>[0]
  ): ReturnType<PlatformEvalRepository["completeStage"]> {
    this.completeInput = input;
    const run = this.#runs.values.get(input.runId);
    if (run === undefined) return Promise.resolve({ ok: false, reason: "STATE_OR_REVISION" });
    const evalPassCount = input.results.filter((item) => item.status === "PASS").length;
    const evalFailCount = input.results.filter((item) => item.status === "FAIL").length;
    const evalErrorCount = input.results.filter(
      (item) => item.status === "EVALUATION_ERROR"
    ).length;
    const evalNotEvaluatedCount = input.results.filter(
      (item) => item.status === "NOT_EVALUATED"
    ).length;
    this.#runs.values.set(run.id, {
      ...run,
      status: "READY",
      stage: "REPORT",
      lockRevision: run.lockRevision + 1,
      evalCompletedCount: input.expectedTotal,
      evalPassCount,
      evalFailCount,
      evalErrorCount,
      evalNotEvaluatedCount,
      evaluationContextHash: input.evaluationContextHash,
      evaluationResultSetHash: input.resultSetHash,
      reportResultSetHash: null,
      reportSummary: null,
      artifactManifest: {
        ...run.artifactManifest,
        artifacts: [...run.artifactManifest.artifacts, ...input.artifactManifest.artifacts]
      },
      updatedAt: input.updatedAt
    });
    return Promise.resolve({
      ok: true,
      progress: {
        runId: run.id,
        status: "READY",
        stage: "REPORT",
        lockRevision: run.lockRevision + 1,
        evalCompletedCount: input.expectedTotal,
        evalPassCount,
        evalFailCount,
        evalErrorCount,
        evalNotEvaluatedCount,
        evaluationContextHash: input.evaluationContextHash,
        evaluationResultSetHash: input.resultSetHash
      }
    });
  }

  /** Return matching queried rows in frozen order. */
  public queryResults(query: PlatformEvalResultQuery): Promise<PlatformEvalResultPage> {
    return Promise.resolve({
      items: this.queryItems.filter(
        (item) => item.runId === query.runId && item.ordinal > (query.afterOrdinal ?? -1)
      ),
      nextCursor: null
    });
  }
}

/** In-memory Evaluation transaction boundary. */
export class MemoryPlatformEvalTransactions implements PlatformEvalTransactionManager {
  /** Evaluation repository. */
  readonly repository: PlatformEvalRepository;

  /** Bind one repository. */
  public constructor(repository: PlatformEvalRepository) {
    this.repository = repository;
  }

  /** Execute one fake short Evaluation transaction. */
  public execute<T>(work: Parameters<PlatformEvalTransactionManager["execute"]>[0]): Promise<T> {
    return work({ evaluations: this.repository }) as Promise<T>;
  }
}

/** In-memory safe Run business-event sink. */
export class MemoryRunEvents {
  /** Safe lifecycle events observed by tests. */
  readonly values: {
    readonly event: string;
    readonly runId: string;
    readonly timestamp: string;
  }[] = [];

  /** Record one safe lifecycle event. */
  public record(value: {
    readonly event: string;
    readonly runId: string;
    readonly timestamp: string;
  }): Promise<void> {
    this.values.push(value);
    return Promise.resolve();
  }
}

/** In-memory streaming Artifact Port for Run service tests. */
export class MemoryArtifacts implements RunArtifactStore {
  /** Artifact writes observed by the test. */
  readonly writes: PlatformRestArtifactInput[] = [];
  /** Streamed Case counts observed by each write. */
  readonly caseCounts: number[] = [];
  /** Uncommitted descriptors removed after a failed commit CAS. */
  readonly removed: RunArtifactDescriptor[] = [];
  /** Durable Manifest sets observed during orphan cleanup. */
  readonly cleanupInputs: (readonly RunArtifactManifest[])[] = [];
  /** Availability returned by inspection. */
  availability: readonly RunArtifactAvailability[] = [];

  /** Consume one stream and return deterministic integrity facts. */
  public async writeRestResults(
    input: PlatformRestArtifactInput
  ): Promise<PlatformRestArtifactWriteResult> {
    this.writes.push(input);
    const cases = [];
    for await (const item of input.cases) cases.push(item);
    this.caseCounts.push(cases.length);
    return {
      descriptor: {
        kind: "REST_RESULTS",
        path: `runs/${input.runId}/rest-results.json`,
        expectedSha256: "b".repeat(64),
        expectedSizeBytes: 100,
        contractVersion: "cortex.platform-rest-results.v1"
      },
      publicationIdentity: `memory:${input.runId}:rest`,
      resultSetHash: hashRestResultSet({
        contractVersion: "cortex.rest-result-set.v1",
        cases: cases.map((item) => ({
          caseKey: item.caseKey,
          ordinal: item.ordinal,
          resultHash: item.resultHash
        }))
      })
    };
  }

  /** Return deterministic raw Promptfoo integrity facts. */
  public writeRawPromptfooEvidence(
    input: PlatformRawPromptfooArtifactInput
  ): Promise<PublishedRunArtifact> {
    return Promise.resolve({
      descriptor: {
        kind: "RAW_PROMPTFOO_EVIDENCE",
        path: `runs/${input.runId}/promptfoo-raw.json`,
        expectedSha256: "c".repeat(64),
        expectedSizeBytes: 80,
        contractVersion: "cortex.platform-raw-promptfoo-evidence.v1"
      },
      publicationIdentity: `memory:${input.runId}:raw`
    });
  }

  /** Consume and return deterministic normalized Evaluation integrity facts. */
  public async writeNormalizedEvalResults(
    input: PlatformNormalizedEvalArtifactInput
  ): Promise<PublishedRunArtifact> {
    for await (const item of input.cases) {
      // Consume the single-use stream exactly once.
      void item;
    }
    return {
      descriptor: {
        kind: "NORMALIZED_EVAL_RESULTS",
        path: `runs/${input.runId}/normalized-eval.json`,
        expectedSha256: "d".repeat(64),
        expectedSizeBytes: 120,
        contractVersion: "cortex.platform-normalized-eval.v1"
      },
      publicationIdentity: `memory:${input.runId}:normalized`
    };
  }

  /** Consume and return deterministic Report pair integrity facts. */
  public async writeReport(
    input: PlatformReportArtifactInput
  ): Promise<PlatformReportArtifactWriteResult> {
    for await (const item of input.cases) void item;
    return {
      json: {
        descriptor: {
          kind: "REPORT_JSON",
          path: `runs/${input.run.id}/report.json`,
          expectedSha256: "e".repeat(64),
          expectedSizeBytes: 140,
          contractVersion: "cortex.report.v1"
        },
        publicationIdentity: `memory:${input.run.id}:report-json`
      },
      markdown: {
        descriptor: {
          kind: "REPORT_MARKDOWN",
          path: `runs/${input.run.id}/report.md`,
          expectedSha256: "f".repeat(64),
          expectedSizeBytes: 90,
          contractVersion: "cortex.report-markdown.v1"
        },
        publicationIdentity: `memory:${input.run.id}:report-markdown`
      }
    };
  }

  /** Record one uncommitted Artifact removal. */
  public removeUncommitted(artifact: PublishedRunArtifact): Promise<void> {
    this.removed.push(artifact.descriptor);
    return Promise.resolve();
  }

  /** Return configured availability facts. */
  public inspect(): Promise<readonly RunArtifactAvailability[]> {
    return Promise.resolve(this.availability);
  }

  /** Record one startup orphan-cleanup input. */
  public cleanupOrphans(manifests: readonly RunArtifactManifest[]): Promise<void> {
    this.cleanupInputs.push(manifests);
    return Promise.resolve();
  }
}

/** REST executor emitting one successful normalized result. */
export class SuccessfulRestExecutor implements RestExecutor {
  /** Concurrency value observed by the Adapter boundary. */
  concurrency = 0;

  /** Emit one valid result. */
  public async execute(input: RestExecutionInput): Promise<RestExecutionSummary> {
    this.concurrency = input.concurrency;
    await input.onResult({
      caseKey: "case-1",
      ordinal: 0,
      status: "SUCCEEDED",
      httpStatus: 200,
      providerOutput: { ok: false, errorMessage: "business" },
      errorType: undefined,
      durationMs: 12
    });
    return { dispatchedCount: 1 };
  }
}

/** REST executor emitting one selected normalized failure. */
export class ErrorRestExecutor implements RestExecutor {
  /** Stable REST failure emitted for the single frozen Case. */
  readonly #errorType: RestExecutionErrorType;

  /** Bind one error classification. */
  public constructor(errorType: RestExecutionErrorType) {
    this.#errorType = errorType;
  }

  /** Emit the configured normalized error. */
  public async execute(input: RestExecutionInput): Promise<RestExecutionSummary> {
    await input.onResult({
      caseKey: "case-1",
      ordinal: 0,
      status: "ERROR",
      httpStatus: this.#errorType === "HTTP_STATUS" ? 503 : null,
      providerOutput: undefined,
      errorType: this.#errorType,
      durationMs: 9
    });
    return { dispatchedCount: 1 };
  }
}

/** REST executor completing without the required Case result. */
export class SilentRestExecutor implements RestExecutor {
  /** Finish without emitting a result. */
  public execute(): Promise<RestExecutionSummary> {
    return Promise.resolve({ dispatchedCount: 0 });
  }
}

/** REST executor emitting a Case identity that is not frozen in the Run. */
export class MisalignedRestExecutor implements RestExecutor {
  /** Emit one invalid Case identity. */
  public async execute(input: RestExecutionInput): Promise<RestExecutionSummary> {
    await input.onResult({
      caseKey: "wrong-case",
      ordinal: 0,
      status: "ERROR",
      httpStatus: null,
      providerOutput: undefined,
      errorType: "NETWORK",
      durationMs: 1
    });
    return { dispatchedCount: 1 };
  }
}

/** REST executor rejecting before any normalized result. */
export class ThrowingRestExecutor implements RestExecutor {
  /** Reject the external Adapter call. */
  public execute(): Promise<RestExecutionSummary> {
    return Promise.reject(new Error("ADAPTER_FAILED"));
  }
}

class ArtifactWriteFailure extends Error {
  /** Stable Artifact failure classification. */
  readonly code = "ARTIFACT_WRITE_FAILED" as const;
}

/** Artifact Port that fails before exposing a descriptor. */
export class FailingArtifacts extends MemoryArtifacts {
  /** Reject one Artifact write with the stable classification. */
  public override writeRestResults(): Promise<PlatformRestArtifactWriteResult> {
    return Promise.reject(new ArtifactWriteFailure("ARTIFACT_WRITE_FAILED"));
  }
}

class Deferred<Value> {
  /** Promise observed by the code under test. */
  readonly promise: Promise<Value>;
  /** Resolve the deferred value exactly once. */
  readonly resolve: (value: Value) => void;

  /** Create one externally controlled Promise. */
  public constructor() {
    let resolveValue: ((value: Value) => void) | undefined;
    this.promise = new Promise<Value>((resolve) => {
      resolveValue = resolve;
    });
    if (resolveValue === undefined) throw new Error("TEST_DEFERRED_INVALID");
    this.resolve = resolveValue;
  }
}

/** Artifact Port that exposes the finalization race window. */
export class BlockingArtifactStore extends MemoryArtifacts {
  /** Signals that Artifact writing has begun. */
  readonly entered = new Deferred<void>();
  /** Releases the pending Artifact write. */
  readonly release = new Deferred<void>();

  /** Hold the write across runtime shutdown. */
  public override async writeRestResults(
    input: PlatformRestArtifactInput
  ): Promise<PlatformRestArtifactWriteResult> {
    this.entered.resolve();
    await this.release.promise;
    return super.writeRestResults(input);
  }
}

/** Run store that fails exactly one cancellation-poll projection read. */
export class PollReadFailureRunStore extends MemoryPlatformRunStore {
  /** Small projection read count. */
  #reads = 0;

  /** Fail the poll read, then allow failure settlement to reread state. */
  public override getPlatformRunProgress(runId: string): Promise<PlatformRunProgress | null> {
    this.#reads += 1;
    if (this.#reads === 2) return Promise.reject(new Error("POLL_READ_FAILED"));
    return super.getPlatformRunProgress(runId);
  }
}

/** Run store counting heavyweight full-snapshot reads. */
export class FullReadCountingRunStore extends MemoryPlatformRunStore {
  /** Complete aggregate read count. */
  fullReads = 0;

  /** Count the heavyweight Port without changing its behavior. */
  public override getPlatformRun(runId: string): Promise<PlatformRun | null> {
    this.fullReads += 1;
    return super.getPlatformRun(runId);
  }
}

/** Successful Executor delayed long enough to exercise one poll. */
export class DelayedSuccessfulRestExecutor implements RestExecutor {
  /** Emit one successful Case after one cancellation-poll interval. */
  public async execute(input: RestExecutionInput): Promise<RestExecutionSummary> {
    await new Promise<void>((resolve) => setTimeout(resolve, 35));
    await input.onResult({
      caseKey: "case-1",
      ordinal: 0,
      status: "SUCCEEDED",
      httpStatus: 200,
      providerOutput: { ok: false, errorMessage: "business" },
      errorType: undefined,
      durationMs: 12
    });
    return { dispatchedCount: 1 };
  }
}
