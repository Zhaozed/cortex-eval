import type { CaseDefinition, ProviderOutput } from "@cortex-eval/domain/src/domain-evaluation.ts";
import type { EndpointConfigDefinition } from "@cortex-eval/domain/src/domain-resource-models.ts";

/** Frozen Endpoint configuration consumed by the REST execution Port. */
export type FrozenRunEndpoint = EndpointConfigDefinition;

/** Clean Provider Output emitted by the REST execution Port. */
export type RunProviderOutput = ProviderOutput;

/** One immutable Case captured by a platform Run. */
export interface FrozenRunCase {
  /** Suite-local stable Case key. */
  readonly caseKey: string;
  /** Frozen zero-based Case order. */
  readonly ordinal: number;
  /** SHA-256 of the frozen Case definition. */
  readonly definitionHash: string;
  /** Validated Domain Case definition. */
  readonly definition: CaseDefinition;
}

/** Stable REST failure classification persisted by the Run pipeline. */
export type RestExecutionErrorType =
  | "TIMEOUT"
  | "NETWORK"
  | "HTTP_STATUS"
  | "RESPONSE_PARSE"
  | "PROVIDER_OUTPUT_INVALID"
  | "TEMPLATE_INPUT"
  | "CANCELLED";

/** Successful normalized REST Case result. */
export interface RestExecutionSuccess {
  /** Frozen Case key. */
  readonly caseKey: string;
  /** Frozen Case ordinal. */
  readonly ordinal: number;
  /** Stable success status. */
  readonly status: "SUCCEEDED";
  /** Observed HTTP status. */
  readonly httpStatus: number;
  /** Validated and Domain-mapped Provider Output. */
  readonly providerOutput: RunProviderOutput;
  /** Transport error is explicitly absent for a successful response. */
  readonly errorType: undefined;
  /** Rounded nonnegative request duration. */
  readonly durationMs: number;
}

/** Failed normalized REST Case result. */
export interface RestExecutionFailure {
  /** Frozen Case key. */
  readonly caseKey: string;
  /** Frozen Case ordinal. */
  readonly ordinal: number;
  /** Stable failure status. */
  readonly status: "ERROR";
  /** HTTP status when a response was received. */
  readonly httpStatus: number | null;
  /** Stable failure classification. */
  readonly errorType: RestExecutionErrorType;
  /** Provider Output is explicitly absent for every transport failure. */
  readonly providerOutput: undefined;
  /** Rounded nonnegative request duration. */
  readonly durationMs: number;
}

/** One normalized REST Case execution fact. */
export type RestCaseExecutionResult = RestExecutionSuccess | RestExecutionFailure;

/** Input for one bounded REST batch execution. */
export interface RestExecutionInput {
  /** Frozen Cases in ordinal order. */
  readonly cases: readonly FrozenRunCase[];
  /** Frozen and validated Endpoint configuration. */
  readonly endpoint: FrozenRunEndpoint;
  /** Maximum number of simultaneously dispatched Cases. */
  readonly concurrency: number;
  /** Run-owned cancellation signal. */
  readonly signal: AbortSignal;
  /** Durable idempotent result sink invoked once per dispatched Case. */
  readonly onResult: (result: RestCaseExecutionResult) => Promise<void>;
}

/** Observable completion facts for one REST batch. */
export interface RestExecutionSummary {
  /** Number of Cases claimed before cancellation stopped dispatch. */
  readonly dispatchedCount: number;
}

/** Application Port for an externally executed REST batch. */
export interface RestExecutor {
  /** Execute frozen Cases with bounded concurrency and normalized outcomes. */
  execute(input: RestExecutionInput): Promise<RestExecutionSummary>;
}
