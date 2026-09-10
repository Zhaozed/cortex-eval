import type {
  CreatePlatformRerunRequestV1Schema,
  CreatePlatformRunRequestV1Schema,
  RunPreflightRequestV1Schema
} from "@cortex-eval/contracts/src/run-api-contracts.ts";
import type {
  AcceptAnalysisProposalRequestV1Schema,
  AnalysisProposalDecisionTargetV1Schema,
  StartCaseAnalysisRequestV1Schema
} from "@cortex-eval/contracts/src/analysis-contracts.ts";
import {
  CurrentCaseAnalysisV1Schema,
  StartCaseAnalysisResultV1Schema
} from "@cortex-eval/contracts/src/analysis-contracts.ts";
import {
  PlatformRerunCreatedV1Schema,
  PlatformRunDetailV1Schema,
  PlatformRunPageV1Schema,
  RunCaseDetailV1Schema,
  RunCasePageV1Schema,
  RunEvalPageV1Schema,
  RunPreflightV1Schema,
  RunProgressV1Schema,
  RunReportCasePageV1Schema,
  RunReportCaseV1Schema,
  RunReportOverviewV1Schema,
  RunStreamEnvelopeV1Schema
} from "@cortex-eval/contracts/src/run-api-contracts.ts";
import type { z } from "zod";

import { ApiClientError, apiRequestEmpty, apiRequestJson, buildApiSearch } from "./api-client.ts";

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
/** Validated normalized Evaluation result page. */
export type RunEvalPage = z.infer<typeof RunEvalPageV1Schema>;
/** Validated complete Report overview. */
export type RunReportOverview = z.infer<typeof RunReportOverviewV1Schema>;
/** Validated filtered Report Case page. */
export type RunReportCasePage = z.infer<typeof RunReportCasePageV1Schema>;
/** Validated complete Report Case detail. */
export type RunReportCase = z.infer<typeof RunReportCaseV1Schema>;
/** Validated newly created Retry/Force Run link. */
export type PlatformRerunCreated = z.infer<typeof PlatformRerunCreatedV1Schema>;
/** Validated Run progress returned by state mutations. */
export type RunProgress = z.infer<typeof RunProgressV1Schema>;
/** Validated snapshot-first SSE envelope. */
export type RunStreamEnvelope = z.infer<typeof RunStreamEnvelopeV1Schema>;
/** Validated current per-Case Analysis version. */
export type CurrentCaseAnalysis = z.infer<typeof CurrentCaseAnalysisV1Schema>;
/** Validated Analysis batch start input. */
export type StartCaseAnalysisInput = z.infer<typeof StartCaseAnalysisRequestV1Schema>;
/** Validated Analysis batch summary. */
export type StartCaseAnalysisResult = z.infer<typeof StartCaseAnalysisResultV1Schema>;
/** Optimistic Proposal rejection target. */
export type RejectAnalysisInput = z.infer<typeof AnalysisProposalDecisionTargetV1Schema>;
/** Complete Proposal acceptance input without edited payload. */
export type AcceptAnalysisInput = Omit<
  z.infer<typeof AcceptAnalysisProposalRequestV1Schema>,
  "editedProposal"
>;
/** Complete Proposal edit-and-accept input. */
export type EditAndAcceptAnalysisInput = z.infer<typeof AcceptAnalysisProposalRequestV1Schema> & {
  readonly editedProposal: NonNullable<
    z.infer<typeof AcceptAnalysisProposalRequestV1Schema>["editedProposal"]
  >;
};
/** Validated platform Run creation input. */
export type CreatePlatformRunInput = z.infer<typeof CreatePlatformRunRequestV1Schema>;
/** Validated Retry/Force mode. */
export type PlatformRerunMode = z.infer<typeof CreatePlatformRerunRequestV1Schema>["mode"];

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

/** Bounded Report Case page arguments with server-side combination filters. */
export interface RunReportCasePageInput extends RunCasePageInput {
  /** Selected REST statuses with OR semantics. */
  readonly restStatus: readonly ("SUCCEEDED" | "ERROR")[];
  /** Selected Evaluation statuses with OR semantics. */
  readonly evalStatus: readonly ("PASS" | "FAIL" | "EVALUATION_ERROR" | "NOT_EVALUATED")[];
  /** Selected Metric keys with OR semantics. */
  readonly metrics: readonly string[];
  /** Selected business modules with OR semantics. */
  readonly businessModules: readonly string[];
  /** Selected scenario tags with OR semantics. */
  readonly scenarioTags: readonly string[];
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
  /** List durable normalized Evaluation results. */
  readonly listEvaluations: (input: RunCasePageInput, signal: AbortSignal) => Promise<RunEvalPage>;
  /** Read one durable real REST Case result. */
  readonly getCase: (runId: string, caseKey: string, signal: AbortSignal) => Promise<RunCaseDetail>;
  /** Read one complete committed platform or imported Report overview. */
  readonly getReport: (runId: string, signal: AbortSignal) => Promise<RunReportOverview>;
  /** List filtered complete Report Cases. */
  readonly listReportCases: (
    input: RunReportCasePageInput,
    signal: AbortSignal
  ) => Promise<RunReportCasePage>;
  /** Read one complete normalized Report Case. */
  readonly getReportCase: (
    runId: string,
    caseKey: string,
    signal: AbortSignal
  ) => Promise<RunReportCase>;
  /** Analyze the exact selected failed Report Case set. */
  readonly startAnalysis: (
    runId: string,
    input: StartCaseAnalysisInput,
    signal: AbortSignal
  ) => Promise<StartCaseAnalysisResult>;
  /** Read one current Run/Case Analysis version. */
  readonly getAnalysis: (
    runId: string,
    caseKey: string,
    signal: AbortSignal
  ) => Promise<CurrentCaseAnalysis>;
  /** Reject one current pending Proposal. */
  readonly rejectAnalysis: (
    runId: string,
    caseKey: string,
    input: RejectAnalysisInput,
    signal: AbortSignal
  ) => Promise<CurrentCaseAnalysis>;
  /** Accept one current Proposal against visible Case identities. */
  readonly acceptAnalysis: (
    runId: string,
    caseKey: string,
    input: AcceptAnalysisInput,
    signal: AbortSignal
  ) => Promise<CurrentCaseAnalysis>;
  /** Validate and accept a user-edited Proposal. */
  readonly editAndAcceptAnalysis: (
    runId: string,
    caseKey: string,
    input: EditAndAcceptAnalysisInput,
    signal: AbortSignal
  ) => Promise<CurrentCaseAnalysis>;
  /** Create a new single-case Run, optionally reusing frozen execution evidence. */
  readonly createCaseRerun?: (
    sourceRunId: string,
    caseKey: string,
    reevaluateOnly: boolean,
    signal: AbortSignal
  ) => Promise<z.infer<typeof PlatformRerunCreatedV1Schema>>;
  /** Create one new Retry/Force Run from an immutable platform source. */
  readonly createRerun: (
    sourceRunId: string,
    mode: PlatformRerunMode,
    signal: AbortSignal,
    metadata?: { readonly name: string; readonly description: string }
  ) => Promise<PlatformRerunCreated>;
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
  /** Delete one non-running, unreferenced Run. */
  readonly deleteRun: (runId: string, signal: AbortSignal) => Promise<void>;
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
    listEvaluations: (input, signal): Promise<RunEvalPage> => {
      const search = buildApiSearch({ limit: input.limit, cursor: input.cursor });
      return apiRequestJson(
        `/api/v1/runs/${encodeURIComponent(input.runId)}/evaluations?${search.toString()}`,
        RunEvalPageV1Schema,
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
    getReport: (runId, signal) =>
      apiRequestJson(
        `/api/v1/runs/${encodeURIComponent(runId)}/report`,
        RunReportOverviewV1Schema,
        { signal },
        fetcher,
        (output) => output.runId === runId
      ),
    listReportCases: (input, signal): Promise<RunReportCasePage> => {
      const search = buildApiSearch({
        limit: input.limit,
        cursor: input.cursor,
        restStatus: input.restStatus,
        evalStatus: input.evalStatus,
        metric: input.metrics,
        businessModule: input.businessModules,
        scenarioTag: input.scenarioTags
      });
      return apiRequestJson(
        `/api/v1/runs/${encodeURIComponent(input.runId)}/report/cases?${search.toString()}`,
        RunReportCasePageV1Schema,
        { signal },
        fetcher
      );
    },
    getReportCase: (runId, caseKey, signal) =>
      apiRequestJson(
        `/api/v1/runs/${encodeURIComponent(runId)}/report/cases/${encodeURIComponent(caseKey)}`,
        RunReportCaseV1Schema,
        { signal },
        fetcher,
        (output) => output.caseKey === caseKey
      ),
    startAnalysis: (runId, input, signal) =>
      apiRequestJson(
        `/api/v1/runs/${encodeURIComponent(runId)}/analyses`,
        StartCaseAnalysisResultV1Schema,
        jsonRequest(input, signal),
        fetcher,
        (output) => output.runId === runId && output.selector === input.selector
      ),
    getAnalysis: (runId, caseKey, signal) =>
      apiRequestJson(
        `/api/v1/runs/${encodeURIComponent(runId)}/analyses/${encodeURIComponent(caseKey)}`,
        CurrentCaseAnalysisV1Schema,
        { signal },
        fetcher,
        (output) => output.runId === runId && output.caseKey === caseKey
      ),
    rejectAnalysis: (runId, caseKey, input, signal) =>
      apiRequestJson(
        `/api/v1/runs/${encodeURIComponent(runId)}/analyses/${encodeURIComponent(caseKey)}/reject`,
        CurrentCaseAnalysisV1Schema,
        jsonRequest(input, signal),
        fetcher,
        (output) => output.runId === runId && output.caseKey === caseKey
      ),
    acceptAnalysis: (runId, caseKey, input, signal) =>
      apiRequestJson(
        `/api/v1/runs/${encodeURIComponent(runId)}/analyses/${encodeURIComponent(caseKey)}/accept`,
        CurrentCaseAnalysisV1Schema,
        jsonRequest(input, signal),
        fetcher,
        (output) => output.runId === runId && output.caseKey === caseKey
      ),
    editAndAcceptAnalysis: (runId, caseKey, input, signal) =>
      apiRequestJson(
        `/api/v1/runs/${encodeURIComponent(runId)}/analyses/${encodeURIComponent(caseKey)}/edit-and-accept`,
        CurrentCaseAnalysisV1Schema,
        jsonRequest(input, signal),
        fetcher,
        (output) => output.runId === runId && output.caseKey === caseKey
      ),
    createCaseRerun: (sourceRunId, caseKey, reevaluateOnly, signal) =>
      apiRequestJson(
        `/api/v1/runs/${encodeURIComponent(sourceRunId)}/reruns`,
        PlatformRerunCreatedV1Schema,
        jsonRequest({ mode: "FORCE", caseKey, reevaluateOnly }, signal),
        fetcher,
        (output) => output.sourceRunId === sourceRunId && output.rerunMode === "FORCE"
      ),
    createRerun: (sourceRunId, mode, signal, metadata) =>
      apiRequestJson(
        `/api/v1/runs/${encodeURIComponent(sourceRunId)}/reruns`,
        PlatformRerunCreatedV1Schema,
        jsonRequest({ mode, ...metadata }, signal),
        fetcher,
        (output) => output.sourceRunId === sourceRunId && output.rerunMode === mode
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
    deleteRun: (runId, signal) =>
      apiRequestEmpty(
        `/api/v1/runs/${encodeURIComponent(runId)}`,
        {
          method: "DELETE",
          signal
        },
        fetcher
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
