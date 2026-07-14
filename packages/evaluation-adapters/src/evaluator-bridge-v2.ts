import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  EvaluatorBridgeCapabilityV2Schema,
  EvaluatorBridgeRequestV2Schema,
  EvaluatorBridgeResponseV2Schema,
  type EvaluatorBridgeCapabilityV2
} from "@cortex-eval/contracts/src/evaluator-bridge-contracts.ts";

import { EvaluatorModelError } from "./evaluator-model-errors.ts";

/** Maximum accepted Promptfoo grader request body. */
export const MAX_EVALUATOR_BRIDGE_REQUEST_BYTES = 10 * 1024 * 1024;

/** Clean model result returned by the frozen Evaluator Adapter. */
export interface EvaluatorModelResult {
  /** Required text output consumed by Promptfoo. */
  readonly text: string;
  /** Optional structured output retained for later Analyzer use. */
  readonly structured: unknown;
  /** Optional exact provider token usage. */
  readonly tokenUsage: {
    /** Input token count. */
    readonly inputTokens: number;
    /** Output token count. */
    readonly outputTokens: number;
    /** Total token count. */
    readonly totalTokens: number;
  } | null;
}

/** Frozen model boundary used by Evaluator Bridge v2. */
export interface EvaluatorModelClient {
  /** Generate one grading response without internal retry. */
  generate(input: {
    /** Fully rendered Promptfoo grading prompt. */
    readonly prompt: string;
    /** Bridge-owned timeout or cancellation signal. */
    readonly signal: AbortSignal;
  }): Promise<EvaluatorModelResult>;
}

/** Dependencies required to start one non-persistent Evaluation call lifetime. */
export interface StartEvaluatorBridgeV2Input {
  /** Raw bearer token injected only into the child environment. */
  readonly rawCapability: string;
  /** Server-side frozen grant. */
  readonly capability: EvaluatorBridgeCapabilityV2;
  /** Frozen Evaluator implementation. */
  readonly evaluator: EvaluatorModelClient;
  /** Wall-clock source used for TTL validation. */
  readonly now?: () => Date;
  /** UUIDv7 call identity source. */
  readonly createCallId: () => string;
}

/** Observable aggregate Bridge facts without Assertion identity. */
export interface EvaluatorBridgeV2Stats {
  /** Calls accepted against the Evaluation-wide budget. */
  readonly acceptedCalls: number;
  /** Calls that reached a terminal response. */
  readonly completedCalls: number;
  /** Calls currently inside the Evaluator. */
  readonly inFlight: number;
}

/** Running loopback-only Evaluator Bridge. */
export interface RunningEvaluatorBridgeV2 {
  /** Random loopback endpoint consumed by Promptfoo. */
  readonly url: string;
  /** Read aggregate non-sensitive accounting facts. */
  readonly stats: () => EvaluatorBridgeV2Stats;
  /** Revoke the call lifetime, cancel work and close the listener. */
  readonly close: () => Promise<void>;
}

type BridgeErrorCode =
  | "EVALUATOR_CAPABILITY_INVALID"
  | "EVALUATOR_BINDING_MISMATCH"
  | "EVALUATOR_BUDGET_EXCEEDED"
  | "EVALUATOR_TIMEOUT"
  | "EVALUATOR_CANCELLED"
  | "PROVIDER_CAPABILITY_UNSUPPORTED"
  | "PROVIDER_REQUEST_FAILED";

type EvaluatorCallOutcome =
  | { readonly kind: "SUCCESS"; readonly output: EvaluatorModelResult }
  | { readonly kind: "ERROR"; readonly error: unknown }
  | { readonly kind: "TIMEOUT" }
  | { readonly kind: "CANCELLED" };

// Normalize the untyped Node request iterator at the protocol boundary.
function requestChunk(value: unknown): Buffer<ArrayBuffer> {
  if (typeof value === "string") return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new Error("BRIDGE_REQUEST_CHUNK_INVALID");
}

// Read one bounded JSON request without retaining a partial oversized body.
async function readRequestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const dirtyChunk of request) {
    const chunk = requestChunk(dirtyChunk);
    size += chunk.byteLength;
    if (size > MAX_EVALUATOR_BRIDGE_REQUEST_BYTES) throw new Error("BRIDGE_REQUEST_TOO_LARGE");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("BRIDGE_REQUEST_JSON_INVALID");
  }
}

// Return a capability token from the only accepted authorization shape.
function bearerToken(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (header === undefined || Array.isArray(header) || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length);
  return /^[A-Za-z0-9_-]{43,128}$/.test(token) ? token : null;
}

// Compare a raw token to the frozen hash without variable-time string equality.
function tokenMatches(token: string, capabilityHash: string): boolean {
  const actual = createHash("sha256").update(token).digest();
  const expected = Buffer.from(capabilityHash, "hex");
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

// Compare the closed execution binding without accepting extra fields.
function sameBinding(
  actual: EvaluatorBridgeCapabilityV2["binding"],
  expected: EvaluatorBridgeCapabilityV2["binding"]
): boolean {
  if (actual.kind !== expected.kind) return false;
  return actual.kind === "RUN"
    ? actual.runId === (expected as { readonly kind: "RUN"; readonly runId: string }).runId
    : actual.executionId ===
        (expected as { readonly kind: "EXECUTION"; readonly executionId: string }).executionId;
}

// Write one strict stable error response without provider payloads.
function writeFailure(
  response: ServerResponse,
  statusCode: number,
  callId: string,
  code: BridgeErrorCode
): void {
  const payload = {
    contractVersion: "cortex.evaluator-bridge-response.v2",
    callId,
    status: "ERROR",
    error: { code, retryable: false, message: code }
  };
  const parsed = EvaluatorBridgeResponseV2Schema.parse(payload);
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(parsed));
}

/** Start one loopback-only Bridge bound to a single Evaluation call lifetime. */
export async function startEvaluatorBridgeV2(
  input: StartEvaluatorBridgeV2Input
): Promise<RunningEvaluatorBridgeV2> {
  const capability = EvaluatorBridgeCapabilityV2Schema.parse(input.capability);
  const now = input.now ?? ((): Date => new Date());
  let acceptedCalls = 0;
  let completedCalls = 0;
  let inFlight = 0;
  let closed = false;
  let expectedHost: string | null = null;
  const activeCancellers = new Set<() => void>();
  const activeTasks = new Set<Promise<void>>();
  const concurrencyQueue: {
    readonly resolve: () => void;
    readonly reject: () => void;
  }[] = [];

  // Recheck revocation and TTL at every asynchronous authorization boundary.
  const capabilityExpired = (): boolean =>
    closed || now().getTime() >= Date.parse(capability.expiresAt);

  // Reserve one actual Evaluator slot while allowing Promptfoo to submit calls concurrently.
  const acquireConcurrency = async (): Promise<void> => {
    if (closed) throw new Error("EVALUATOR_BRIDGE_CLOSED");
    if (inFlight < capability.maxConcurrency) {
      inFlight += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      concurrencyQueue.push({
        resolve: () => {
          inFlight += 1;
          resolve();
        },
        reject: () => reject(new Error("EVALUATOR_BRIDGE_CLOSED"))
      });
    });
  };

  // Release one slot and wake exactly one accepted call in FIFO order.
  const releaseConcurrency = (): void => {
    inFlight -= 1;
    const next = concurrencyQueue.shift();
    if (next !== undefined && !closed) next.resolve();
    else if (next !== undefined) next.reject();
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const callId = input.createCallId();
    if (request.method !== "POST" || request.url !== "/evaluate") {
      writeFailure(response, 404, callId, "EVALUATOR_CAPABILITY_INVALID");
      return;
    }
    if (expectedHost === null || request.headers.host !== expectedHost) {
      writeFailure(response, 400, callId, "EVALUATOR_CAPABILITY_INVALID");
      return;
    }
    const token = bearerToken(request);
    if (token === null || !tokenMatches(token, capability.capabilityHash)) {
      writeFailure(response, 401, callId, "EVALUATOR_CAPABILITY_INVALID");
      return;
    }
    if (capabilityExpired()) {
      writeFailure(response, 401, callId, "EVALUATOR_CAPABILITY_INVALID");
      return;
    }

    let dirtyBody: unknown;
    try {
      dirtyBody = await readRequestBody(request);
    } catch {
      writeFailure(response, 400, callId, "EVALUATOR_CAPABILITY_INVALID");
      return;
    }
    const parsed = EvaluatorBridgeRequestV2Schema.safeParse({
      ...(typeof dirtyBody === "object" && dirtyBody !== null ? dirtyBody : {}),
      capability: token
    });
    if (!parsed.success) {
      writeFailure(response, 400, callId, "EVALUATOR_CAPABILITY_INVALID");
      return;
    }
    if (
      !sameBinding(parsed.data.binding, capability.binding) ||
      parsed.data.evaluationContextHash !== capability.evaluationContextHash
    ) {
      writeFailure(response, 403, callId, "EVALUATOR_BINDING_MISMATCH");
      return;
    }
    const prompt =
      typeof parsed.data.prompt === "string"
        ? parsed.data.prompt
        : JSON.stringify(parsed.data.prompt);
    if (prompt.trim() === "") {
      writeFailure(response, 400, callId, "EVALUATOR_CAPABILITY_INVALID");
      return;
    }
    if (acceptedCalls >= capability.maxCalls) {
      writeFailure(response, 429, callId, "EVALUATOR_BUDGET_EXCEEDED");
      return;
    }

    acceptedCalls += 1;
    try {
      await acquireConcurrency();
    } catch {
      completedCalls += 1;
      writeFailure(response, 499, callId, "EVALUATOR_CANCELLED");
      return;
    }
    if (capabilityExpired()) {
      releaseConcurrency();
      completedCalls += 1;
      writeFailure(response, 401, callId, "EVALUATOR_CAPABILITY_INVALID");
      return;
    }
    const controller = new AbortController();
    let resolveTerminal: (outcome: EvaluatorCallOutcome) => void = () => undefined;
    const terminal = new Promise<EvaluatorCallOutcome>((resolve) => {
      resolveTerminal = resolve;
    });
    const cancel = (): void => {
      controller.abort();
      resolveTerminal({ kind: "CANCELLED" });
    };
    activeCancellers.add(cancel);
    const timeout = setTimeout(() => {
      controller.abort();
      resolveTerminal({ kind: "TIMEOUT" });
    }, capability.timeoutMs);
    try {
      const evaluatorTask = Promise.resolve()
        .then(() => input.evaluator.generate({ prompt, signal: controller.signal }))
        .then(
          (output): EvaluatorCallOutcome => ({ kind: "SUCCESS", output }),
          (error: unknown): EvaluatorCallOutcome => ({ kind: "ERROR", error })
        );
      // A timed-out non-cooperative SDK call still owns its real upstream concurrency slot.
      void evaluatorTask.then(() => releaseConcurrency());
      const outcome = await Promise.race([evaluatorTask, terminal]);
      if (outcome.kind === "TIMEOUT") {
        writeFailure(response, 504, callId, "EVALUATOR_TIMEOUT");
        return;
      }
      if (outcome.kind === "CANCELLED") {
        writeFailure(response, 499, callId, "EVALUATOR_CANCELLED");
        return;
      }
      if (outcome.kind === "ERROR") {
        if (
          outcome.error instanceof EvaluatorModelError &&
          outcome.error.code === "PROVIDER_CAPABILITY_UNSUPPORTED"
        ) {
          writeFailure(response, 422, callId, "PROVIDER_CAPABILITY_UNSUPPORTED");
        } else {
          writeFailure(response, 502, callId, "PROVIDER_REQUEST_FAILED");
        }
        return;
      }
      const success = EvaluatorBridgeResponseV2Schema.safeParse({
        contractVersion: "cortex.evaluator-bridge-response.v2",
        callId,
        status: "SUCCESS",
        output: outcome.output
      });
      if (!success.success) {
        writeFailure(response, 502, callId, "PROVIDER_REQUEST_FAILED");
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(success.data));
    } finally {
      clearTimeout(timeout);
      activeCancellers.delete(cancel);
      completedCalls += 1;
    }
  };

  const server = createServer((request, response) => {
    const task = handle(request, response).finally(() => activeTasks.delete(task));
    activeTasks.add(task);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("EVALUATOR_BRIDGE_ADDRESS_INVALID");
  }
  expectedHost = `127.0.0.1:${address.port}`;

  return {
    url: `http://127.0.0.1:${address.port}/evaluate`,
    stats: (): EvaluatorBridgeV2Stats => ({ acceptedCalls, completedCalls, inFlight }),
    close: async (): Promise<void> => {
      if (closed) return;
      closed = true;
      for (const waiting of concurrencyQueue.splice(0)) waiting.reject();
      for (const cancel of activeCancellers) cancel();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error)))
      );
      await Promise.allSettled([...activeTasks]);
    }
  };
}
