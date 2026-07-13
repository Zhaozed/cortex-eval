import type {
  PlatformRestArtifactInput,
  PlatformRestArtifactWriteResult,
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
  RestExecutionInput,
  RestExecutionSummary,
  RestExecutor
} from "../src/features/runs/run-rest-models.ts";
import { hashRestResultSet } from "@cortex-eval/domain/src/domain-hash-inputs.ts";

import { MemoryPlatformRunStore } from "./in-memory-platform-run-store.ts";

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

  /** Record one uncommitted Artifact removal. */
  public removeUncommitted(artifact: RunArtifactDescriptor): Promise<void> {
    this.removed.push(artifact);
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
