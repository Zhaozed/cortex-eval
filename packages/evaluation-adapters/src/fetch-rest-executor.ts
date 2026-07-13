import type {
  FrozenRunCase,
  RestCaseExecutionResult,
  RestExecutionErrorType,
  RestExecutionInput,
  RestExecutionSummary,
  RestExecutor,
  RunProviderOutput
} from "@cortex-eval/application/src/features/runs/run-rest-models.ts";
import { ProviderOutputV1Schema } from "@cortex-eval/contracts/src/provider-contracts.ts";

import {
  prepareRestRequest,
  RestPreparationError,
  type SecretReader
} from "./rest-request-preparer.ts";

/** Exact maximum encoded REST response body size. */
export const MAX_REST_RESPONSE_BYTES = 10 * 1024 * 1024;

/** Fetch executor dependencies supplied by the infrastructure composition root. */
export interface FetchRestExecutorDependencies {
  /** Environment Secret expansion function. */
  readonly readSecret: SecretReader;
  /** Injectable Fetch implementation. */
  readonly fetch?: typeof fetch;
  /** Injectable monotonic millisecond source. */
  readonly now?: () => number;
}

type AbortReason = "PARENT" | "TIMEOUT" | null;

interface ResponseReadSuccess {
  /** Successful read discriminator. */
  readonly ok: true;
  /** Complete bounded response bytes. */
  readonly bytes: Uint8Array;
}

interface ResponseReadFailure {
  /** Failed read discriminator. */
  readonly ok: false;
}

type ResponseReadResult = ResponseReadSuccess | ResponseReadFailure;

// Return a stable nonnegative rounded duration.
function duration(now: () => number, startedAt: number): number {
  return Math.max(0, Math.round(now() - startedAt));
}

// Construct one normalized failure without attaching raw errors or response bodies.
function failure(
  testCase: FrozenRunCase,
  errorType: RestExecutionErrorType,
  httpStatus: number | null,
  durationMs: number
): RestCaseExecutionResult {
  return {
    caseKey: testCase.caseKey,
    ordinal: testCase.ordinal,
    status: "ERROR",
    httpStatus,
    errorType,
    providerOutput: undefined,
    durationMs
  };
}

// Read a 2xx body with an exact byte ceiling and no partial payload exposure.
async function readBoundedResponse(response: Response): Promise<ResponseReadResult> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > MAX_REST_RESPONSE_BYTES) {
      await response.body?.cancel();
      return { ok: false };
    }
  }
  if (response.body === null) return { ok: true, bytes: new Uint8Array() };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const read = await reader.read();
      if (read.done) break;
      total += read.value.byteLength;
      if (total > MAX_REST_RESPONSE_BYTES) {
        await reader.cancel();
        return { ok: false };
      }
      chunks.push(read.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

// Parse strict UTF-8 JSON and map the transport contract into clean Domain names.
function parseProviderOutput(
  bytes: Uint8Array
):
  | { readonly ok: true; readonly value: RunProviderOutput }
  | { readonly ok: false; readonly errorType: "RESPONSE_PARSE" | "PROVIDER_OUTPUT_INVALID" } {
  let dirty: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    dirty = JSON.parse(text);
  } catch {
    return { ok: false, errorType: "RESPONSE_PARSE" };
  }
  const parsed = ProviderOutputV1Schema.safeParse(dirty);
  if (!parsed.success) return { ok: false, errorType: "PROVIDER_OUTPUT_INVALID" };
  if (!parsed.data.ok) {
    return { ok: true, value: { ok: false, errorMessage: parsed.data.err_msg } };
  }
  return {
    ok: true,
    value: {
      ok: true,
      taskName: parsed.data.task_name,
      resolvedConfig: parsed.data.resolved_config,
      parsedOutput: parsed.data.parsed_output
    }
  };
}

/** Fetch-based implementation of the Application REST execution Port. */
export class FetchRestExecutor implements RestExecutor {
  /** Environment Secret expansion function. */
  readonly #readSecret: SecretReader;
  /** Fetch implementation used for all network requests. */
  readonly #fetch: typeof fetch;
  /** Monotonic time source used for durations. */
  readonly #now: () => number;

  /** Construct a REST executor with explicit edge dependencies. */
  constructor(dependencies: FetchRestExecutorDependencies) {
    this.#readSecret = dependencies.readSecret;
    this.#fetch = dependencies.fetch ?? globalThis.fetch;
    this.#now = dependencies.now ?? performance.now.bind(performance);
  }

  /** Execute Cases with bounded workers and stop claiming after cancellation. */
  async execute(input: RestExecutionInput): Promise<RestExecutionSummary> {
    if (!Number.isInteger(input.concurrency) || input.concurrency < 1 || input.concurrency > 64) {
      throw new Error("REST_CONCURRENCY_INVALID");
    }
    const controller = new AbortController();
    const abortFromInput = (): void => controller.abort();
    input.signal.addEventListener("abort", abortFromInput, { once: true });
    if (input.signal.aborted) abortFromInput();
    let nextIndex = 0;
    let dispatchedCount = 0;
    const noWorkerFailure = Symbol("NO_REST_WORKER_FAILURE");
    const workerState: { failure: unknown } = { failure: noWorkerFailure };
    const claim = (): FrozenRunCase | null => {
      if (controller.signal.aborted || nextIndex >= input.cases.length) return null;
      const testCase = input.cases[nextIndex];
      if (testCase === undefined) return null;
      nextIndex += 1;
      dispatchedCount += 1;
      return testCase;
    };
    const worker = async (): Promise<void> => {
      for (;;) {
        const testCase = claim();
        if (testCase === null) return;
        try {
          const result = await this.#executeCase(testCase, input.endpoint, controller.signal);
          if (workerState.failure !== noWorkerFailure) return;
          await input.onResult(result);
        } catch (error) {
          if (workerState.failure === noWorkerFailure) workerState.failure = error;
          controller.abort();
          return;
        }
      }
    };
    const workerCount = Math.min(input.concurrency, input.cases.length);
    try {
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
      if (workerState.failure !== noWorkerFailure) {
        throw workerState.failure instanceof Error
          ? workerState.failure
          : new Error("REST_WORKER_FAILED", { cause: workerState.failure });
      }
      return { dispatchedCount };
    } finally {
      input.signal.removeEventListener("abort", abortFromInput);
    }
  }

  // Execute one Case and collapse all expected edge failures into stable facts.
  async #executeCase(
    testCase: FrozenRunCase,
    endpoint: RestExecutionInput["endpoint"],
    parentSignal: AbortSignal
  ): Promise<RestCaseExecutionResult> {
    const startedAt = this.#now();
    let prepared: ReturnType<typeof prepareRestRequest>;
    try {
      prepared = prepareRestRequest(testCase, endpoint, this.#readSecret);
    } catch (error) {
      if (error instanceof RestPreparationError) {
        return failure(testCase, "TEMPLATE_INPUT", null, duration(this.#now, startedAt));
      }
      throw error;
    }

    const controller = new AbortController();
    const abortState: { reason: AbortReason } = { reason: null };
    const abortFromParent = (): void => {
      if (abortState.reason !== null) return;
      abortState.reason = "PARENT";
      controller.abort();
    };
    parentSignal.addEventListener("abort", abortFromParent, { once: true });
    if (parentSignal.aborted) abortFromParent();
    const timeout = setTimeout(() => {
      if (abortState.reason !== null) return;
      abortState.reason = "TIMEOUT";
      controller.abort();
    }, prepared.timeoutMs);

    try {
      const response = await this.#fetch(prepared.url, {
        method: "POST",
        headers: prepared.headers,
        body: Buffer.from(prepared.body),
        redirect: "manual",
        signal: controller.signal
      });
      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel();
        return failure(testCase, "HTTP_STATUS", response.status, duration(this.#now, startedAt));
      }
      const bounded = await readBoundedResponse(response);
      if (!bounded.ok) {
        return failure(
          testCase,
          "PROVIDER_OUTPUT_INVALID",
          response.status,
          duration(this.#now, startedAt)
        );
      }
      const providerOutput = parseProviderOutput(bounded.bytes);
      if (!providerOutput.ok) {
        return failure(
          testCase,
          providerOutput.errorType,
          response.status,
          duration(this.#now, startedAt)
        );
      }
      return {
        caseKey: testCase.caseKey,
        ordinal: testCase.ordinal,
        status: "SUCCEEDED",
        httpStatus: response.status,
        providerOutput: providerOutput.value,
        errorType: undefined,
        durationMs: duration(this.#now, startedAt)
      };
    } catch {
      const errorType =
        abortState.reason === "PARENT"
          ? "CANCELLED"
          : abortState.reason === "TIMEOUT"
            ? "TIMEOUT"
            : "NETWORK";
      return failure(testCase, errorType, null, duration(this.#now, startedAt));
    } finally {
      clearTimeout(timeout);
      parentSignal.removeEventListener("abort", abortFromParent);
    }
  }
}
