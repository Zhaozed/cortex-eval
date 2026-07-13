import type {
  CreatePlatformRunRequestV1Schema,
  RunPreflightRequestV1Schema
} from "@cortex-eval/contracts/src/run-api-contracts.ts";
import {
  PlatformRunDetailV1Schema,
  PlatformRunPageV1Schema,
  RunCaseDetailV1Schema,
  RunCasePageV1Schema,
  RunPreflightV1Schema,
  RunProgressV1Schema,
  RunStreamEnvelopeV1Schema
} from "@cortex-eval/contracts/src/run-api-contracts.ts";
import type { z } from "zod";

import { ApiClientError, apiRequestJson, buildApiSearch } from "./api-client.ts";

/** Validated Run resource selection. */
export type RunSelection = z.infer<typeof RunPreflightRequestV1Schema>;
/** Validated platform Run preflight. */
export type RunPreflight = z.infer<typeof RunPreflightV1Schema>;
/** Validated platform Run detail. */
export type PlatformRunDetail = z.infer<typeof PlatformRunDetailV1Schema>;
/** Validated recent platform Run page. */
export type PlatformRunPage = z.infer<typeof PlatformRunPageV1Schema>;
/** Validated real REST Case result page. */
export type RunCasePage = z.infer<typeof RunCasePageV1Schema>;
/** Validated real REST Case result detail. */
export type RunCaseDetail = z.infer<typeof RunCaseDetailV1Schema>;
/** Validated Run progress returned by state mutations. */
export type RunProgress = z.infer<typeof RunProgressV1Schema>;
/** Validated snapshot-first SSE envelope. */
export type RunStreamEnvelope = z.infer<typeof RunStreamEnvelopeV1Schema>;
/** Validated platform Run creation input. */
export type CreatePlatformRunInput = z.infer<typeof CreatePlatformRunRequestV1Schema>;

/** Bounded recent Run page arguments. */
export interface RunPageInput {
  /** Maximum returned Runs. */
  readonly limit: number;
  /** Current opaque cursor. */
  readonly cursor: string | null;
}

/** Bounded real REST Case page arguments. */
export interface RunCasePageInput extends RunPageInput {
  /** Owning Run identity. */
  readonly runId: string;
}

/** Minimal named-event source used by the Run client. */
export interface RunEventSource {
  /** Register one named SSE or transport listener. */
  addEventListener(type: string, listener: (event: Event) => void): void;
  /** Release the browser subscription. */
  close(): void;
}

/** Browser EventSource construction boundary. */
export type RunEventSourceFactory = (path: string) => RunEventSource;

/** One releasable Run progress subscription. */
export interface RunSubscription {
  /** Stop reconnects and release all browser resources. */
  close(): void;
}

/** Boundary-validating operations exposed to the current Run Web feature. */
export interface RunApi {
  /** Read prerequisites and server-derived defaults. */
  readonly preflight: (input: RunSelection, signal: AbortSignal) => Promise<RunPreflight>;
  /** Create one immutable platform Run. */
  readonly create: (
    input: CreatePlatformRunInput,
    signal: AbortSignal
  ) => Promise<PlatformRunDetail>;
  /** List recent platform Runs. */
  readonly listRuns: (input: RunPageInput, signal: AbortSignal) => Promise<PlatformRunPage>;
  /** Read one bounded platform Run detail. */
  readonly getRun: (runId: string, signal: AbortSignal) => Promise<PlatformRunDetail>;
  /** List durable real REST Case results. */
  readonly listCases: (input: RunCasePageInput, signal: AbortSignal) => Promise<RunCasePage>;
  /** Read one durable real REST Case result. */
  readonly getCase: (runId: string, caseKey: string, signal: AbortSignal) => Promise<RunCaseDetail>;
  /** Start the currently registered REST stage. */
  readonly start: (
    runId: string,
    expectedRevision: number,
    signal: AbortSignal
  ) => Promise<RunProgress>;
  /** Request cancellation without predicting terminal state. */
  readonly cancel: (
    runId: string,
    expectedRevision: number,
    signal: AbortSignal
  ) => Promise<RunProgress>;
  /** Subscribe to finite snapshot-first SSE progress. */
  readonly subscribe: (
    runId: string,
    onEnvelope: (envelope: RunStreamEnvelope) => void,
    onError: (error: ApiClientError) => void
  ) => RunSubscription;
}

// Build one JSON mutation request with explicit cancellation.
function jsonRequest(body: unknown, signal: AbortSignal): Readonly<RequestInit> {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal
  };
}

// Construct a browser source behind the small testable EventSource boundary.
function browserEventSource(path: string): RunEventSource {
  const source = new EventSource(path);
  return {
    addEventListener: (type, listener): void => source.addEventListener(type, listener),
    close: (): void => source.close()
  };
}

// Decode one untrusted named SSE event and bind it to the requested Run identity.
function parseRunEvent(event: Event, runId: string): RunStreamEnvelope {
  if (!(event instanceof MessageEvent) || typeof event.data !== "string") {
    throw new ApiClientError("CLIENT_RESPONSE_INVALID");
  }
  let dirty: unknown;
  try {
    dirty = JSON.parse(event.data) as unknown;
  } catch {
    throw new ApiClientError("CLIENT_RESPONSE_INVALID");
  }
  const parsed = RunStreamEnvelopeV1Schema.safeParse(dirty);
  if (!parsed.success || parsed.data.progress.runId !== runId) {
    throw new ApiClientError("CLIENT_RESPONSE_INVALID");
  }
  return parsed.data;
}

/** Create the strict same-origin Run API Client. */
export function createRunApi(
  fetcher: typeof fetch = fetch,
  eventSourceFactory: RunEventSourceFactory = browserEventSource
): RunApi {
  return {
    preflight: (input, signal) =>
      apiRequestJson(
        "/api/v1/runs/preflight",
        RunPreflightV1Schema,
        jsonRequest(input, signal),
        fetcher,
        (output) =>
          output.suiteId === input.suiteId &&
          output.endpointConfigId === input.endpointConfigId &&
          output.evaluatorConfigId === input.evaluatorConfigId
      ),
    create: (input, signal) =>
      apiRequestJson(
        "/api/v1/runs",
        PlatformRunDetailV1Schema,
        jsonRequest(input, signal),
        fetcher,
        (output) =>
          output.suite.id === input.suiteId &&
          output.endpoint.sourceId === input.endpointConfigId &&
          output.evaluator.sourceId === input.evaluatorConfigId &&
          output.runMode === input.runMode &&
          (input.runExecutionLimits === undefined ||
            (output.runExecutionLimits.restConcurrency ===
              input.runExecutionLimits.restConcurrency &&
              output.runExecutionLimits.evalConcurrency ===
                input.runExecutionLimits.evalConcurrency))
      ),
    listRuns: (input, signal): Promise<PlatformRunPage> => {
      const search = buildApiSearch({ limit: input.limit, cursor: input.cursor });
      return apiRequestJson(
        `/api/v1/runs?${search.toString()}`,
        PlatformRunPageV1Schema,
        { signal },
        fetcher
      );
    },
    getRun: (runId, signal) =>
      apiRequestJson(
        `/api/v1/runs/${encodeURIComponent(runId)}`,
        PlatformRunDetailV1Schema,
        { signal },
        fetcher,
        (output) => output.id === runId
      ),
    listCases: (input, signal): Promise<RunCasePage> => {
      const search = buildApiSearch({ limit: input.limit, cursor: input.cursor });
      return apiRequestJson(
        `/api/v1/runs/${encodeURIComponent(input.runId)}/cases?${search.toString()}`,
        RunCasePageV1Schema,
        { signal },
        fetcher,
        (output) => output.items.every((item) => item.runId === input.runId)
      );
    },
    getCase: (runId, caseKey, signal) =>
      apiRequestJson(
        `/api/v1/runs/${encodeURIComponent(runId)}/cases/${encodeURIComponent(caseKey)}`,
        RunCaseDetailV1Schema,
        { signal },
        fetcher,
        (output) => output.runId === runId && output.caseKey === caseKey
      ),
    start: (runId, expectedRevision, signal) =>
      apiRequestJson(
        `/api/v1/runs/${encodeURIComponent(runId)}/start`,
        RunProgressV1Schema,
        jsonRequest({ expectedRevision }, signal),
        fetcher,
        (output) => output.runId === runId
      ),
    cancel: (runId, expectedRevision, signal) =>
      apiRequestJson(
        `/api/v1/runs/${encodeURIComponent(runId)}/cancel`,
        RunProgressV1Schema,
        jsonRequest({ expectedRevision }, signal),
        fetcher,
        (output) => output.runId === runId
      ),
    subscribe: (runId, onEnvelope, onError): RunSubscription => {
      const source = eventSourceFactory(`/api/v1/runs/${encodeURIComponent(runId)}/events`);
      const receive = (event: Event): void => {
        try {
          onEnvelope(parseRunEvent(event, runId));
        } catch (error) {
          onError(
            error instanceof ApiClientError ? error : new ApiClientError("CLIENT_RESPONSE_INVALID")
          );
        }
      };
      source.addEventListener("snapshot", receive);
      source.addEventListener("progress", receive);
      source.addEventListener("error", () => onError(new ApiClientError("CLIENT_REQUEST_FAILED")));
      return { close: (): void => source.close() };
    }
  };
}
