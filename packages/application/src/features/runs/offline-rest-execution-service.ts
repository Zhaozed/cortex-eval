import type { ProviderOutput } from "@cortex-eval/domain/src/domain-evaluation.ts";
import {
  OrderedRestResultSetHasher,
  hashRestResult
} from "@cortex-eval/domain/src/domain-hash-inputs.ts";

import type { Clock } from "../../application-ports.ts";
import {
  restExecutionMessageCode,
  type FrozenRunCase,
  type RestCaseExecutionResult,
  type RestExecutionErrorType,
  type RestExecutionMessageCode,
  type RestExecutor
} from "./run-rest-models.ts";

/** Provenance copied into one reused offline REST fact. */
export interface OfflineRestReuseProvenance {
  /** Source owner kind. */
  readonly sourceKind: "EXECUTION";
  /** Source Execution identity. */
  readonly sourceId: string;
  /** Exact source REST result hash. */
  readonly sourceResultHash: string;
}

interface OfflineRestCaseCommon {
  /** Stable Case key. */
  readonly caseKey: string;
  /** Frozen zero-based Case order. */
  readonly ordinal: number;
  /** Frozen Case Definition hash. */
  readonly caseDefinitionHash: string;
  /** Observed HTTP status when present. */
  readonly httpStatus: number | null;
  /** Rounded request duration. */
  readonly durationMs: number;
  /** Completion time. */
  readonly completedAt: string;
  /** Stable semantic REST result hash. */
  readonly resultHash: string;
  /** Optional source result provenance. */
  readonly provenance: OfflineRestReuseProvenance | null;
}

/** Successful offline REST result ready for Artifact mapping. */
export interface OfflineRestSuccess extends OfflineRestCaseCommon {
  /** Stable success discriminator. */
  readonly status: "SUCCEEDED";
  /** Successful 2xx status. */
  readonly httpStatus: number;
  /** Clean Domain Provider Output. */
  readonly providerOutput: ProviderOutput;
  /** Failure type is absent. */
  readonly errorType: null;
  /** Failure message is absent. */
  readonly errorMessage: null;
}

/** Failed offline REST result ready for Artifact mapping. */
export interface OfflineRestFailure extends OfflineRestCaseCommon {
  /** Stable failure discriminator. */
  readonly status: "ERROR";
  /** Provider Output is absent on transport failure. */
  readonly providerOutput: null;
  /** Stable failure classification. */
  readonly errorType: RestExecutionErrorType;
  /** Externalized stable public message. */
  readonly errorMessage: string;
}

/** One normalized offline REST result. */
export type OfflineRestCaseResult = OfflineRestSuccess | OfflineRestFailure;

/** Safe REST message lookup Port. */
export interface OfflineRestMessageResolver {
  /** Resolve one stable code without exposing caught values. */
  readonly message: (code: RestExecutionMessageCode) => string;
}

/** Dependencies of the pure offline REST orchestration boundary. */
export interface OfflineRestExecutionServiceDependencies {
  /** Shared externally executed REST Port. */
  readonly restExecutor: RestExecutor;
  /** Application UTC clock. */
  readonly clock: Clock;
  /** Stable error message lookup. */
  readonly messageResolver: OfflineRestMessageResolver;
}

/** One offline REST stage invocation over a frozen Execution. */
export interface OfflineRestExecutionInput {
  /** Current immutable Execution identity. */
  readonly executionId: string;
  /** Complete frozen Cases. */
  readonly cases: AsyncIterable<FrozenRunCase> | Iterable<FrozenRunCase>;
  /** Exact Case count frozen in the Manifest. */
  readonly expectedCaseCount: number;
  /** Frozen Endpoint definition. */
  readonly endpoint: Parameters<RestExecutor["execute"]>[0]["endpoint"];
  /** Frozen REST maximum in-flight count. */
  readonly concurrency: number;
  /** Stage cancellation signal. */
  readonly signal: AbortSignal;
  /** Already validated source successes for retry-failed. */
  readonly reusedResults: AsyncIterable<OfflineRestCaseResult> | Iterable<OfflineRestCaseResult>;
  /** Backpressure-aware ordered durable result sink. */
  readonly onOrderedResult: (result: OfflineRestCaseResult) => Promise<void>;
}

/** Complete offline REST result-set identity. */
export interface OfflineRestExecutionResult {
  /** Number of aligned Case results. */
  readonly caseCount: number;
  /** Stable complete REST result-set hash. */
  readonly resultSetHash: string;
  /** Stage completion time. */
  readonly completedAt: string;
}

interface PendingResult {
  /** Normalized result waiting for its ordinal. */
  readonly result: OfflineRestCaseResult;
  /** Resolve the originating REST worker after durable ordered consumption. */
  readonly resolve?: (() => void) | undefined;
  /** Reject the originating REST worker after sink failure. */
  readonly reject?: ((error: Error) => void) | undefined;
}

// Normalize synchronous and asynchronous ordered inputs behind one iterator shape.
async function* asyncValues<Value>(
  values: AsyncIterable<Value> | Iterable<Value>
): AsyncGenerator<Value> {
  for await (const value of values) yield value;
}

// Normalize one executor fact and bind it to its frozen Case identity.
function normalizeResult(
  result: RestCaseExecutionResult,
  frozen: FrozenRunCase,
  completedAt: string,
  messages: OfflineRestMessageResolver
): OfflineRestCaseResult {
  if (result.caseKey !== frozen.caseKey || result.ordinal !== frozen.ordinal) {
    throw new Error("ARTIFACT_WRITE_FAILED");
  }
  if (result.status === "SUCCEEDED") {
    const resultHash = hashRestResult({
      contractVersion: "cortex.rest-result.v1",
      caseKey: result.caseKey,
      caseDefinitionHash: frozen.definitionHash,
      result: {
        status: "SUCCEEDED",
        httpStatus: result.httpStatus,
        providerOutput: result.providerOutput
      }
    });
    return {
      caseKey: result.caseKey,
      ordinal: result.ordinal,
      caseDefinitionHash: frozen.definitionHash,
      status: "SUCCEEDED",
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
    caseDefinitionHash: frozen.definitionHash,
    result: {
      status: "ERROR",
      httpStatus: result.httpStatus,
      errorType: result.errorType
    }
  });
  return {
    caseKey: result.caseKey,
    ordinal: result.ordinal,
    caseDefinitionHash: frozen.definitionHash,
    status: "ERROR",
    httpStatus: result.httpStatus,
    providerOutput: null,
    errorType: result.errorType,
    errorMessage: messages.message(restExecutionMessageCode(result.errorType)),
    durationMs: result.durationMs,
    completedAt,
    resultHash,
    provenance: null
  };
}

// Bound out-of-order memory by keeping every executor worker blocked until ordered persistence.
class OrderedOfflineRestCollector {
  /** Ordered result sink. */
  readonly #sink: (result: OfflineRestCaseResult) => Promise<void>;
  /** Semantic result-set hasher. */
  readonly #hasher = new OrderedRestResultSetHasher();
  /** Pending unique ordinals. */
  readonly #pending = new Map<number, PendingResult>();
  /** Serialized drain chain. */
  #drainChain: Promise<void> = Promise.resolve();
  /** Next required ordinal. */
  #nextOrdinal = 0;
  /** First durable sink failure. */
  #failure: Error | null = null;

  /** Bind one backpressure-aware result sink. */
  public constructor(sink: (result: OfflineRestCaseResult) => Promise<void>) {
    this.#sink = sink;
  }

  /** Seed one already validated source fact without creating a blocked worker. */
  public seed(result: OfflineRestCaseResult): void {
    this.#insert({ result });
  }

  /** Accept one new result and resolve only after its ordered durable sink completes. */
  public accept(result: OfflineRestCaseResult): Promise<void> {
    if (this.#failure !== null) return Promise.reject(this.#failure);
    return new Promise<void>((resolve, reject) => {
      this.#insert({ result, resolve, reject });
    });
  }

  /** Finish only after exactly the expected aligned count has been consumed. */
  public async finish(expectedCount: number): Promise<string> {
    await this.#drainChain;
    if (this.#failure !== null) throw this.#failure;
    if (this.#nextOrdinal !== expectedCount || this.#pending.size !== 0) {
      throw new Error("ARTIFACT_WRITE_FAILED");
    }
    return this.#hasher.finish();
  }

  /** Wait until every currently contiguous seeded result has reached the sink. */
  public async settle(): Promise<void> {
    await this.#drainChain;
    if (this.#failure !== null) throw this.#failure;
  }

  // Insert one unique ordinal and schedule an ordered drain.
  #insert(entry: PendingResult): void {
    const ordinal = entry.result.ordinal;
    if (ordinal < this.#nextOrdinal || this.#pending.has(ordinal)) {
      throw new Error("ARTIFACT_WRITE_FAILED");
    }
    this.#pending.set(ordinal, entry);
    this.#drainChain = this.#drainChain.then(async () => this.#drain());
  }

  // Consume every contiguous result and release its originating worker.
  async #drain(): Promise<void> {
    if (this.#failure !== null) return;
    for (;;) {
      const entry = this.#pending.get(this.#nextOrdinal);
      if (entry === undefined) return;
      try {
        await this.#sink(entry.result);
        this.#hasher.add({
          caseKey: entry.result.caseKey,
          ordinal: entry.result.ordinal,
          resultHash: entry.result.resultHash
        });
        this.#pending.delete(this.#nextOrdinal);
        this.#nextOrdinal += 1;
        entry.resolve?.();
      } catch (error) {
        const failure =
          error instanceof Error ? error : new Error("ARTIFACT_WRITE_FAILED", { cause: error });
        this.#failure = failure;
        for (const pending of this.#pending.values()) pending.reject?.(failure);
        throw failure;
      }
    }
  }
}

/** Shared offline REST use case with ordered streaming and semantic hashing. */
export class OfflineRestExecutionService {
  /** External REST executor. */
  readonly #restExecutor: RestExecutor;
  /** Application UTC clock. */
  readonly #clock: Clock;
  /** Stable message lookup. */
  readonly #messages: OfflineRestMessageResolver;

  /** Bind the shared REST execution and presentation-free Port set. */
  public constructor(dependencies: OfflineRestExecutionServiceDependencies) {
    this.#restExecutor = dependencies.restExecutor;
    this.#clock = dependencies.clock;
    this.#messages = dependencies.messageResolver;
  }

  /** Execute or reuse every frozen Case and stream one complete ordered result set. */
  public async execute(input: OfflineRestExecutionInput): Promise<OfflineRestExecutionResult> {
    if (
      input.executionId.trim() === "" ||
      !Number.isSafeInteger(input.expectedCaseCount) ||
      input.expectedCaseCount < 1 ||
      !Number.isInteger(input.concurrency) ||
      input.concurrency < 1 ||
      input.concurrency > 64
    ) {
      throw new Error("WORK_PACKAGE_INVALID");
    }
    const collector = new OrderedOfflineRestCollector(input.onOrderedResult);
    const reusedIterator = asyncValues(input.reusedResults);
    let reusedEntry = await reusedIterator.next();
    let caseCount = 0;
    let pending: FrozenRunCase[] = [];

    const executePending = async (): Promise<void> => {
      if (pending.length === 0) return;
      const batch = pending;
      pending = [];
      const frozenByOrdinal = new Map(batch.map((item) => [item.ordinal, item] as const));
      const summary = await this.#restExecutor.execute({
        cases: batch,
        endpoint: input.endpoint,
        concurrency: input.concurrency,
        signal: input.signal,
        onResult: (result): Promise<void> => {
          const frozen = frozenByOrdinal.get(result.ordinal);
          if (frozen === undefined) return Promise.reject(new Error("ARTIFACT_WRITE_FAILED"));
          const normalized = normalizeResult(result, frozen, this.#clock.now(), this.#messages);
          return collector.accept(normalized);
        }
      });
      if (input.signal.aborted) throw new Error("REST_CANCELLED");
      if (summary.dispatchedCount !== batch.length) throw new Error("ARTIFACT_WRITE_FAILED");
      await collector.settle();
    };

    for await (const frozen of input.cases) {
      if (frozen.ordinal !== caseCount) throw new Error("WORK_PACKAGE_INVALID");
      const reused = reusedEntry.done ? undefined : reusedEntry.value;
      if (reused !== undefined && reused.ordinal < frozen.ordinal) {
        throw new Error("WORK_PACKAGE_INVALID");
      }
      if (reused?.ordinal === frozen.ordinal) {
        await executePending();
        if (
          reused.caseKey !== frozen.caseKey ||
          reused.caseDefinitionHash !== frozen.definitionHash ||
          reused.provenance === null ||
          reused.status !== "SUCCEEDED"
        ) {
          throw new Error("WORK_PACKAGE_INVALID");
        }
        collector.seed(reused);
        await collector.settle();
        reusedEntry = await reusedIterator.next();
      } else {
        pending.push(frozen);
        if (pending.length === input.concurrency) await executePending();
      }
      caseCount += 1;
    }
    await executePending();
    if (!reusedEntry.done || caseCount !== input.expectedCaseCount) {
      throw new Error("WORK_PACKAGE_INVALID");
    }
    const resultSetHash = await collector.finish(caseCount);
    return {
      caseCount,
      resultSetHash,
      completedAt: this.#clock.now()
    };
  }
}
