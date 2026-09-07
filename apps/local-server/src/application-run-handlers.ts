import zhCnMessages from "@cortex-eval/contracts/messages/zh-CN.json" with { type: "json" };
import type {
  PlatformRunService,
  PlatformRunServiceError
} from "@cortex-eval/application/src/features/runs/platform-run-service.ts";
import type { PlatformEvaluationService } from "@cortex-eval/application/src/features/evaluation/platform-evaluation-service.ts";
import type { PlatformEvalCaseResult } from "@cortex-eval/application/src/features/evaluation/platform-eval-models.ts";
import type {
  PlatformReportService,
  PlatformReportStartResult
} from "@cortex-eval/application/src/features/reporting/platform-report-service.ts";
import type { PlatformRerunService } from "@cortex-eval/application/src/features/runs/platform-rerun-service.ts";
import {
  platformRunDetail,
  type PlatformRun,
  type PlatformRunDetail,
  type PlatformRunPageCursor,
  type PlatformRunProgress,
  type PlatformRunSummary,
  type StoredRestCaseResult
} from "@cortex-eval/application/src/features/runs/platform-run-models.ts";
import {
  ApiErrorResponseV1Schema,
  type ApiErrorResponseV1
} from "@cortex-eval/contracts/src/resource-api-contracts.ts";
import {
  CreatePlatformRunRequestV1Schema,
  CreatePlatformRerunRequestV1Schema,
  PlatformRerunCreatedV1Schema,
  PlatformRunDetailV1Schema,
  PlatformRunListQueryV1Schema,
  PlatformRunPageV1Schema,
  RunCaseDetailV1Schema,
  RunCaseListQueryV1Schema,
  RunCasePageV1Schema,
  RunEvalListQueryV1Schema,
  RunEvalPageV1Schema,
  RunPreflightRequestV1Schema,
  RunPreflightV1Schema,
  RunProgressV1Schema,
  RunReportCaseListQueryV1Schema,
  RunReportCasePageV1Schema,
  RunReportCaseV1Schema,
  RunReportOverviewV1Schema,
  RunRevisionRequestV1Schema,
  decodePlatformRunCursorV1,
  decodeRunCaseCursorV1,
  encodePlatformRunCursorV1,
  encodeRunCaseCursorV1
} from "@cortex-eval/contracts/src/run-api-contracts.ts";
import { UuidV7Schema } from "@cortex-eval/contracts/src/contracts-primitives.ts";
import {
  ExecutionReportImportRequestV1Schema,
  ExecutionReportImportResultV1Schema
} from "@cortex-eval/contracts/src/result-import-contracts.ts";
import type { Readable } from "node:stream";
import type { z } from "zod";

import type {
  LocalApiHandler,
  LocalApiHandlerInput,
  LocalApiHandlerResponse
} from "./local-server.ts";
import { mapCaseDefinitionToV1 } from "./resource-dto-mappers.ts";
import { mapPlatformReportCaseToV1, mapRunReportContextToV1 } from "./report-dto-mappers.ts";
import type { ExecutionReportImportService } from "./execution-report-import-service.ts";
import {
  createApplicationAnalysisHandlers,
  type ApplicationAnalysisServiceBoundary,
  type LocalAnalysisHandlers
} from "./application-analysis-handlers.ts";
import { openImportedReportExport } from "./imported-report-export.ts";

/** Narrow Run Application surface consumed by protocol handlers. */
export type ApplicationRunServiceBoundary = Pick<
  PlatformRunService,
  | "preflight"
  | "create"
  | "queryRuns"
  | "get"
  | "getProgress"
  | "inspectArtifacts"
  | "queryRestResults"
  | "getRestResult"
  | "start"
  | "cancel"
  | "deleteRun"
> & {
  /** Claim the closed Evaluation stage. */
  readonly startEvaluation: PlatformEvaluationService["start"];
  /** Cancel one active Evaluation owner. */
  readonly cancelEvaluation: PlatformEvaluationService["cancel"];
  /** Query normalized Evaluation results. */
  readonly queryEvalResults: PlatformEvaluationService["queryResults"];
  /** Claim the closed Report stage. */
  readonly startReport: PlatformReportService["start"];
  /** Cancel one active Report owner. */
  readonly cancelReport: PlatformReportService["cancel"];
  /** Read one committed Report overview. */
  readonly getReport: PlatformReportService["get"];
  /** Check platform or imported Report Run existence. */
  readonly hasReportRun: PlatformReportService["exists"];
  /** Query committed complete Report Cases. */
  readonly queryReportCases: PlatformReportService["queryCases"];
  /** Read one committed complete Report Case. */
  readonly getReportCase: PlatformReportService["getCase"];
  /** Stream complete aligned normalized Report Cases. */
  readonly streamReportCases: PlatformReportService["streamCases"];
  /** Open one already integrity-verified immutable Report JSON stream. */
  readonly openReportExport: (
    manifest: PlatformRun["artifactManifest"],
    signal: AbortSignal
  ) => Promise<Readable | null>;
  /** Create one new Retry/Force execution version. */
  readonly createRerun: PlatformRerunService["create"];
  /** Validate and atomically import one completed offline Report Execution. */
  readonly importExecutionReport: ExecutionReportImportService["importReport"];
  /** Validate and atomically import one completed offline Analysis Artifact. */
} & ApplicationAnalysisServiceBoundary;

/** Closed P5 Run protocol handlers. */
export interface LocalRunHandlers extends LocalAnalysisHandlers {
  /** Read current Run prerequisites. */
  readonly preflightRun: LocalApiHandler;
  /** Create one frozen platform Run. */
  readonly createRun: LocalApiHandler;
  /** Create one Retry/Force Run from a terminal source version. */
  readonly createRunRerun: LocalApiHandler;
  /** List recent platform Runs. */
  readonly listRuns: LocalApiHandler;
  /** Read one bounded platform Run detail. */
  readonly getRun: LocalApiHandler;
  /** List real REST Case results. */
  readonly listRunCases: LocalApiHandler;
  /** Read one real REST Case result detail. */
  readonly getRunCase: LocalApiHandler;
  /** List normalized Evaluation results. */
  readonly listRunEvaluations: LocalApiHandler;
  /** Read one committed Report overview. */
  readonly getRunReport: LocalApiHandler;
  /** List filtered committed Report Cases. */
  readonly listRunReportCases: LocalApiHandler;
  /** Read one committed complete Report Case. */
  readonly getRunReportCase: LocalApiHandler;
  /** Stream the committed normalized Report JSON. */
  readonly exportRunReport: LocalApiHandler;
  /** Import one complete offline Report as an immutable Run. */
  readonly importExecutionReport: LocalApiHandler;
  /** Start only the closed REST stage. */
  readonly startRun: LocalApiHandler;
  /** Request cancellation. */
  readonly cancelRun: LocalApiHandler;
  /** Delete one non-running, unreferenced Run. */
  readonly deleteRun: LocalApiHandler;
  /** Read one small Run progress snapshot for SSE. */
  readonly getRunProgress: LocalApiHandler;
}

type ApiErrorCode = ApiErrorResponseV1["error"]["code"];

// Build one strict externalized API error.
function errorBody(
  input: Record<string, unknown> & { readonly code: ApiErrorCode; readonly requestId: string }
): ApiErrorResponseV1 {
  return ApiErrorResponseV1Schema.parse({
    error: { ...input, message: zhCnMessages[input.code] }
  });
}

// Return the first stable validation path without echoing input values.
function issuePath(error: z.ZodError): string {
  const path = error.issues[0]?.path;
  return path === undefined || path.length === 0 ? "request" : path.join(".");
}

// Validate one untrusted boundary value.
function parse<T>(
  schema: z.ZodType<T>,
  value: unknown,
  requestId: string
):
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly response: LocalApiHandlerResponse } {
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    response: {
      statusCode: 400,
      body: errorBody({
        code: "VALIDATION_FAILED",
        requestId,
        path: issuePath(result.error)
      })
    }
  };
}

// Validate one UUIDv7 route parameter.
function runId(
  input: LocalApiHandlerInput
):
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly response: LocalApiHandlerResponse } {
  return parse(UuidV7Schema, input.params.runId, input.requestId);
}

// Map one Application failure to the strict HTTP surface.
function applicationError(
  error:
    PlatformRunServiceError | Extract<PlatformReportStartResult, { readonly ok: false }>["error"],
  requestId: string
): LocalApiHandlerResponse {
  if (error.code === "RUN_STATE_CONFLICT") {
    return {
      statusCode: 409,
      body: errorBody({
        code: "RUN_STATE_CONFLICT",
        requestId,
        reason: error.reason
      })
    };
  }
  if (error.code === "VALIDATION_FAILED") {
    return {
      statusCode: 400,
      body: errorBody({ code: "VALIDATION_FAILED", requestId, path: error.path })
    };
  }
  if (error.code === "RUBRIC_PROMPT_NOT_FOUND") {
    return {
      statusCode: 422,
      body: errorBody({
        code: "RUBRIC_PROMPT_NOT_FOUND",
        requestId,
        promptKey: error.promptKey
      })
    };
  }
  if (error.code === "REPORT_RECONCILIATION_FAILED") {
    return {
      statusCode: 422,
      body: errorBody({ code: "REPORT_RECONCILIATION_FAILED", requestId })
    };
  }
  const code: ApiErrorCode = error.code;
  const statusCode =
    code === "RUN_NOT_FOUND" || code === "SUITE_NOT_FOUND" || code === "CONFIGURATION_NOT_FOUND"
      ? 404
      : 422;
  return { statusCode, body: errorBody({ code, requestId }) };
}

// Return the public state conflict used when a Run exists but has no committed Report.
function reportUnavailable(requestId: string): LocalApiHandlerResponse {
  return {
    statusCode: 409,
    body: errorBody({
      code: "RUN_STATE_CONFLICT",
      requestId,
      reason: "STAGE_UNAVAILABLE"
    })
  };
}

// Map clean Provider Output names to the strict transport contract.
function providerOutput(
  value: Extract<StoredRestCaseResult, { status: "SUCCEEDED" }>["providerOutput"]
): Record<string, unknown> {
  return value.ok
    ? {
        ok: true,
        task_name: value.taskName,
        resolved_config: value.resolvedConfig,
        parsed_output: value.parsedOutput
      }
    : { ok: false, err_msg: value.errorMessage };
}

// Build fields shared by REST Case list and detail projections.
function caseBase(value: StoredRestCaseResult): Record<string, unknown> {
  return {
    runId: value.runId,
    caseKey: value.caseKey,
    ordinal: value.ordinal,
    durationMs: value.durationMs,
    completedAt: value.completedAt,
    resultHash: value.resultHash
  };
}

// Build one small real REST Case summary.
function caseSummary(value: StoredRestCaseResult): Record<string, unknown> {
  return {
    ...caseBase(value),
    status: value.status,
    httpStatus: value.httpStatus,
    errorType: value.errorType
  };
}

// Build one complete real Case detail.
function caseDetail(value: StoredRestCaseResult): Record<string, unknown> {
  const common = {
    ...caseBase(value),
    caseDefinitionHash: value.caseDefinitionHash,
    definition: mapCaseDefinitionToV1(value.definition),
    status: value.status,
    httpStatus: value.httpStatus
  };
  return value.status === "SUCCEEDED"
    ? { ...common, providerOutput: providerOutput(value.providerOutput), error: null }
    : {
        ...common,
        providerOutput: null,
        error: { type: value.errorType, message: value.errorMessage }
      };
}

// Build one complete Eval API item without embedding raw Promptfoo content.
function evalItem(value: PlatformEvalCaseResult): Record<string, unknown> {
  const { runId: owner, createdAt, updatedAt, ...result } = value;
  return { runId: owner, createdAt, updatedAt, result };
}

// Build one recent Run summary DTO.
function runSummary(value: PlatformRunSummary): Record<string, unknown> {
  return {
    id: value.id,
    sourceType: value.sourceType,
    suiteId: value.suiteId,
    suiteName: value.suiteName,
    runMode: value.runMode,
    status: value.status,
    stage: value.stage,
    lockRevision: value.lockRevision,
    cancelRequestedAt: value.cancelRequestedAt,
    rest: {
      total: value.restTotalCount,
      completed: value.restCompletedCount,
      succeeded: value.restCompletedCount - value.restErrorCount,
      error: value.restErrorCount
    },
    evaluation: {
      total: value.restTotalCount,
      completed: value.evalCompletedCount,
      passed: value.evalPassCount,
      failed: value.evalFailCount,
      error: value.evalErrorCount,
      notEvaluated: value.evalNotEvaluatedCount
    },
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  };
}

// Build one small durable Run progress snapshot.
function runProgress(value: PlatformRun | PlatformRunProgress): Record<string, unknown> {
  const total = "restTotalCount" in value ? value.restTotalCount : value.suite.cases.length;
  return {
    runId: value.id,
    status: value.status,
    stage: value.stage,
    lockRevision: value.lockRevision,
    cancelRequestedAt: value.cancelRequestedAt,
    rest: {
      total,
      completed: value.restCompletedCount,
      succeeded: value.restCompletedCount - value.restErrorCount,
      error: value.restErrorCount
    },
    evaluation: {
      total,
      completed: value.evalCompletedCount,
      passed: value.evalPassCount,
      failed: value.evalFailCount,
      error: value.evalErrorCount,
      notEvaluated: value.evalNotEvaluatedCount
    },
    updatedAt: value.updatedAt
  };
}

// Build one bounded Run detail without Case arrays or Prompt bodies.
async function runDetail(
  service: ApplicationRunServiceBoundary,
  value: PlatformRunDetail
): Promise<Record<string, unknown>> {
  const availability = (await service.inspectArtifacts(value.id)) ?? [];
  return {
    id: value.id,
    sourceType: value.sourceType,
    sourceRunId: value.sourceRunId,
    rerunMode: value.rerunMode,
    suite: {
      id: value.suite.id,
      name: value.suite.name,
      hash: value.suite.suiteHash,
      caseCount: value.suite.caseCount
    },
    endpoint: {
      sourceId: value.endpoint.sourceId,
      name: value.endpoint.name,
      configHash: value.endpoint.configHash,
      config: {
        contractVersion: "cortex.endpoint-config.v1",
        ...value.endpoint.definition
      }
    },
    evaluator: {
      sourceId: value.evaluator.sourceId,
      name: value.evaluator.name,
      configHash: value.evaluator.configHash,
      config: {
        contractVersion: "cortex.llm-config.v1",
        ...value.evaluator.definition
      }
    },
    rubricPrompts: value.rubricPrompts.map((item) => ({
      promptKey: item.promptKey,
      name: item.name,
      promptHash: item.promptHash
    })),
    promptfooVersion: value.promptfooVersion,
    contractVersions: value.contractVersions,
    runContextHash: value.runContextHash,
    runExecutionLimits: value.runExecutionLimits,
    runMode: value.runMode,
    status: value.status,
    stage: value.stage,
    lockRevision: value.lockRevision,
    cancelRequestedAt: value.cancelRequestedAt,
    rest: {
      total: value.restTotalCount,
      completed: value.restCompletedCount,
      succeeded: value.restCompletedCount - value.restErrorCount,
      error: value.restErrorCount
    },
    evaluation: {
      total: value.restTotalCount,
      completed: value.evalCompletedCount,
      passed: value.evalPassCount,
      failed: value.evalFailCount,
      error: value.evalErrorCount,
      notEvaluated: value.evalNotEvaluatedCount
    },
    artifactManifest: value.artifactManifest,
    artifactAvailability: availability.map((item) => ({
      kind: item.artifact.kind,
      path: item.artifact.path,
      status: item.status
    })),
    errorCode: value.errorCode,
    startedAt: value.startedAt,
    completedAt: value.completedAt,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  };
}

/** Map the Run Application use cases into strict Local API handlers. */
export function createApplicationRunHandlers(
  service: ApplicationRunServiceBoundary
): LocalRunHandlers {
  return {
    ...createApplicationAnalysisHandlers(service),
    preflightRun: async (input): Promise<LocalApiHandlerResponse> => {
      const body = parse(RunPreflightRequestV1Schema, input.body, input.requestId);
      if (!body.ok) return body.response;
      const result = await service.preflight(body.value);
      return result.ok
        ? { statusCode: 200, body: RunPreflightV1Schema.parse(result.preflight) }
        : applicationError(result.error, input.requestId);
    },
    createRun: async (input): Promise<LocalApiHandlerResponse> => {
      const body = parse(CreatePlatformRunRequestV1Schema, input.body, input.requestId);
      if (!body.ok) return body.response;
      const result = await service.create(body.value);
      return result.ok
        ? {
            statusCode: 201,
            body: PlatformRunDetailV1Schema.parse(
              await runDetail(service, platformRunDetail(result.run))
            )
          }
        : applicationError(result.error, input.requestId);
    },
    createRunRerun: async (input): Promise<LocalApiHandlerResponse> => {
      const sourceRunId = runId(input);
      if (!sourceRunId.ok) return sourceRunId.response;
      const body = parse(CreatePlatformRerunRequestV1Schema, input.body, input.requestId);
      if (!body.ok) return body.response;
      const result = await service.createRerun({
        sourceRunId: sourceRunId.value,
        mode: body.value.mode
      });
      if (!result.ok) {
        const code = result.error.code;
        return {
          statusCode: code === "RUN_NOT_FOUND" ? 404 : 422,
          body: errorBody({ code, requestId: input.requestId })
        };
      }
      return {
        statusCode: 201,
        body: PlatformRerunCreatedV1Schema.parse({
          runId: result.run.id,
          sourceRunId: result.run.sourceRunId,
          rerunMode: result.run.rerunMode,
          status: result.run.status,
          stage: result.run.stage,
          lockRevision: result.run.lockRevision,
          counts: result.plan.counts
        })
      };
    },
    listRuns: async (input): Promise<LocalApiHandlerResponse> => {
      const query = parse(PlatformRunListQueryV1Schema, input.query, input.requestId);
      if (!query.ok) return query.response;
      let afterCursor: PlatformRunPageCursor | undefined;
      try {
        if (query.value.cursor !== undefined) {
          const decoded = decodePlatformRunCursorV1(query.value.cursor);
          afterCursor = { createdAt: decoded.createdAt, id: decoded.id };
        }
      } catch (error) {
        const code =
          error instanceof Error && error.message === "CURSOR_VERSION_UNSUPPORTED"
            ? "CURSOR_VERSION_UNSUPPORTED"
            : "CURSOR_INVALID";
        return { statusCode: 400, body: errorBody({ code, requestId: input.requestId }) };
      }
      const page = await service.queryRuns({
        limit: query.value.limit,
        ...(afterCursor === undefined ? {} : { afterCursor })
      });
      return {
        statusCode: 200,
        body: PlatformRunPageV1Schema.parse({
          items: page.items.map(runSummary),
          nextCursor:
            page.nextCursor === null
              ? null
              : encodePlatformRunCursorV1({ version: 1, ...page.nextCursor })
        })
      };
    },
    getRun: async (input): Promise<LocalApiHandlerResponse> => {
      const id = runId(input);
      if (!id.ok) return id.response;
      const value = await service.get(id.value);
      return value === null
        ? {
            statusCode: 404,
            body: errorBody({ code: "RUN_NOT_FOUND", requestId: input.requestId })
          }
        : {
            statusCode: 200,
            body: PlatformRunDetailV1Schema.parse(await runDetail(service, value))
          };
    },
    listRunCases: async (input): Promise<LocalApiHandlerResponse> => {
      const id = runId(input);
      if (!id.ok) return id.response;
      if ((await service.getProgress(id.value)) === null) {
        return {
          statusCode: 404,
          body: errorBody({ code: "RUN_NOT_FOUND", requestId: input.requestId })
        };
      }
      const query = parse(RunCaseListQueryV1Schema, input.query, input.requestId);
      if (!query.ok) return query.response;
      let afterOrdinal;
      try {
        afterOrdinal =
          query.value.cursor === undefined
            ? undefined
            : decodeRunCaseCursorV1(query.value.cursor).ordinal;
      } catch (error) {
        const code =
          error instanceof Error && error.message === "CURSOR_VERSION_UNSUPPORTED"
            ? "CURSOR_VERSION_UNSUPPORTED"
            : "CURSOR_INVALID";
        return { statusCode: 400, body: errorBody({ code, requestId: input.requestId }) };
      }
      const page = await service.queryRestResults({
        runId: id.value,
        limit: query.value.limit,
        ...(afterOrdinal === undefined ? {} : { afterOrdinal })
      });
      return {
        statusCode: 200,
        body: RunCasePageV1Schema.parse({
          items: page.items.map(caseSummary),
          nextCursor:
            page.nextCursor === null
              ? null
              : encodeRunCaseCursorV1({ version: 1, ordinal: page.nextCursor })
        })
      };
    },
    getRunCase: async (input): Promise<LocalApiHandlerResponse> => {
      const id = runId(input);
      if (!id.ok) return id.response;
      if ((await service.getProgress(id.value)) === null) {
        return {
          statusCode: 404,
          body: errorBody({ code: "RUN_NOT_FOUND", requestId: input.requestId })
        };
      }
      const caseKey = input.params.caseKey;
      if (caseKey === undefined || caseKey.trim() === "") {
        return {
          statusCode: 400,
          body: errorBody({
            code: "VALIDATION_FAILED",
            requestId: input.requestId,
            path: "caseKey"
          })
        };
      }
      const value = await service.getRestResult(id.value, caseKey);
      return value === null
        ? {
            statusCode: 404,
            body: errorBody({ code: "RUN_CASE_RESULT_NOT_FOUND", requestId: input.requestId })
          }
        : { statusCode: 200, body: RunCaseDetailV1Schema.parse(caseDetail(value)) };
    },
    listRunEvaluations: async (input): Promise<LocalApiHandlerResponse> => {
      const id = runId(input);
      if (!id.ok) return id.response;
      if ((await service.getProgress(id.value)) === null) {
        return {
          statusCode: 404,
          body: errorBody({ code: "RUN_NOT_FOUND", requestId: input.requestId })
        };
      }
      const query = parse(RunEvalListQueryV1Schema, input.query, input.requestId);
      if (!query.ok) return query.response;
      let afterOrdinal;
      try {
        afterOrdinal =
          query.value.cursor === undefined
            ? undefined
            : decodeRunCaseCursorV1(query.value.cursor).ordinal;
      } catch (error) {
        const code =
          error instanceof Error && error.message === "CURSOR_VERSION_UNSUPPORTED"
            ? "CURSOR_VERSION_UNSUPPORTED"
            : "CURSOR_INVALID";
        return { statusCode: 400, body: errorBody({ code, requestId: input.requestId }) };
      }
      const page = await service.queryEvalResults({
        runId: id.value,
        limit: query.value.limit,
        ...(afterOrdinal === undefined ? {} : { afterOrdinal })
      });
      return {
        statusCode: 200,
        body: RunEvalPageV1Schema.parse({
          items: page.items.map(evalItem),
          nextCursor:
            page.nextCursor === null
              ? null
              : encodeRunCaseCursorV1({ version: 1, ordinal: page.nextCursor })
        })
      };
    },
    getRunReport: async (input): Promise<LocalApiHandlerResponse> => {
      const id = runId(input);
      if (!id.ok) return id.response;
      if (!(await service.hasReportRun(id.value))) {
        return {
          statusCode: 404,
          body: errorBody({ code: "RUN_NOT_FOUND", requestId: input.requestId })
        };
      }
      const overview = await service.getReport(id.value);
      if (overview === null) return reportUnavailable(input.requestId);
      const { run, report, artifactAvailability } = overview;
      if (
        run.completedAt === null ||
        run.evaluationContextHash === null ||
        run.evaluationResultSetHash === null ||
        run.reportResultSetHash === null
      ) {
        return reportUnavailable(input.requestId);
      }
      return {
        statusCode: 200,
        body: RunReportOverviewV1Schema.parse({
          runId: run.id,
          sourceType: run.sourceType,
          sourceRunId: run.sourceRunId,
          rerunMode: run.rerunMode,
          completedAt: run.completedAt,
          context: mapRunReportContextToV1(run),
          evaluationContextHash: run.evaluationContextHash,
          evaluationResultSetHash: run.evaluationResultSetHash,
          reportResultSetHash: run.reportResultSetHash,
          summary: report.summary,
          byMetric: report.byMetric,
          artifactAvailability: artifactAvailability.map((item) => ({
            kind: item.artifact.kind,
            path: item.artifact.path,
            status: item.status
          }))
        })
      };
    },
    listRunReportCases: async (input): Promise<LocalApiHandlerResponse> => {
      const id = runId(input);
      if (!id.ok) return id.response;
      if (!(await service.hasReportRun(id.value))) {
        return {
          statusCode: 404,
          body: errorBody({ code: "RUN_NOT_FOUND", requestId: input.requestId })
        };
      }
      const query = parse(RunReportCaseListQueryV1Schema, input.query, input.requestId);
      if (!query.ok) return query.response;
      let afterOrdinal;
      try {
        afterOrdinal =
          query.value.cursor === undefined
            ? undefined
            : decodeRunCaseCursorV1(query.value.cursor).ordinal;
      } catch (error) {
        const code =
          error instanceof Error && error.message === "CURSOR_VERSION_UNSUPPORTED"
            ? "CURSOR_VERSION_UNSUPPORTED"
            : "CURSOR_INVALID";
        return { statusCode: 400, body: errorBody({ code, requestId: input.requestId }) };
      }
      const page = await service.queryReportCases({
        runId: id.value,
        limit: query.value.limit,
        ...(afterOrdinal === undefined ? {} : { afterOrdinal }),
        ...(query.value.restStatus === undefined ? {} : { restStatuses: query.value.restStatus }),
        ...(query.value.evalStatus === undefined ? {} : { evalStatuses: query.value.evalStatus }),
        ...(query.value.metric === undefined ? {} : { metrics: query.value.metric }),
        ...(query.value.businessModule === undefined
          ? {}
          : { businessModules: query.value.businessModule }),
        ...(query.value.scenarioTag === undefined ? {} : { scenarioTags: query.value.scenarioTag })
      });
      if (page === null) return reportUnavailable(input.requestId);
      return {
        statusCode: 200,
        body: RunReportCasePageV1Schema.parse({
          items: page.items.map(mapPlatformReportCaseToV1),
          nextCursor:
            page.nextCursor === null
              ? null
              : encodeRunCaseCursorV1({ version: 1, ordinal: page.nextCursor })
        })
      };
    },
    getRunReportCase: async (input): Promise<LocalApiHandlerResponse> => {
      const id = runId(input);
      if (!id.ok) return id.response;
      if (!(await service.hasReportRun(id.value))) {
        return {
          statusCode: 404,
          body: errorBody({ code: "RUN_NOT_FOUND", requestId: input.requestId })
        };
      }
      const caseKey = input.params.caseKey;
      if (caseKey === undefined || caseKey.trim() === "") {
        return {
          statusCode: 400,
          body: errorBody({
            code: "VALIDATION_FAILED",
            requestId: input.requestId,
            path: "caseKey"
          })
        };
      }
      if ((await service.getReport(id.value)) === null) return reportUnavailable(input.requestId);
      const value = await service.getReportCase(id.value, caseKey);
      return value === null
        ? {
            statusCode: 404,
            body: errorBody({ code: "RUN_CASE_RESULT_NOT_FOUND", requestId: input.requestId })
          }
        : { statusCode: 200, body: RunReportCaseV1Schema.parse(mapPlatformReportCaseToV1(value)) };
    },
    exportRunReport: async (input): Promise<LocalApiHandlerResponse> => {
      const id = runId(input);
      if (!id.ok) return id.response;
      if (!(await service.hasReportRun(id.value))) {
        return {
          statusCode: 404,
          body: errorBody({ code: "RUN_NOT_FOUND", requestId: input.requestId })
        };
      }
      const overview = await service.getReport(id.value);
      if (overview === null) return reportUnavailable(input.requestId);
      try {
        if (overview.run.sourceType === "OFFLINE_IMPORT") {
          return {
            statusCode: 200,
            headers: {
              "content-type": "application/json; charset=utf-8",
              "content-disposition": `attachment; filename="cortex-report-${id.value}.json"`
            },
            body: openImportedReportExport({
              run: overview.run,
              cases: service.streamReportCases(id.value),
              signal: input.signal
            })
          };
        }
        const body = await service.openReportExport(overview.run.artifactManifest, input.signal);
        if (body === null) {
          return {
            statusCode: 422,
            body: errorBody({ code: "REPORT_RECONCILIATION_FAILED", requestId: input.requestId })
          };
        }
        return {
          statusCode: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "content-disposition": `attachment; filename="cortex-report-${id.value}.json"`
          },
          body
        };
      } catch (error) {
        if (error instanceof Error && error.message === "REQUEST_ABORTED") {
          return {
            statusCode: 499,
            body: errorBody({ code: "REQUEST_ABORTED", requestId: input.requestId })
          };
        }
        throw error;
      }
    },
    importExecutionReport: async (input): Promise<LocalApiHandlerResponse> => {
      const body = parse(ExecutionReportImportRequestV1Schema, input.body, input.requestId);
      if (!body.ok) return body.response;
      try {
        const result = await service.importExecutionReport(body.value, input.signal);
        if (!result.ok) {
          return {
            statusCode: 409,
            body: errorBody({
              code: "EXECUTION_RESULT_CONFLICT",
              requestId: input.requestId
            })
          };
        }
        return {
          statusCode: 201,
          body: ExecutionReportImportResultV1Schema.parse({
            contractVersion: "cortex.execution-report-import-result.v1",
            ...result.value,
            sourceType: "OFFLINE_IMPORT",
            stage: "DONE"
          })
        };
      } catch (error) {
        if (error instanceof Error && error.message === "REQUEST_ABORTED") {
          return {
            statusCode: 499,
            body: errorBody({ code: "REQUEST_ABORTED", requestId: input.requestId })
          };
        }
        if (error instanceof Error && error.message === "WORK_PACKAGE_LOCKED") {
          return {
            statusCode: 409,
            body: errorBody({ code: "WORK_PACKAGE_LOCKED", requestId: input.requestId })
          };
        }
        if (
          error instanceof Error &&
          (error.message.startsWith("WORK_PACKAGE_") ||
            error.message.startsWith("ARTIFACT_") ||
            error.message === "REPORT_RECONCILIATION_FAILED")
        ) {
          return {
            statusCode: 422,
            body: errorBody({ code: "WORK_PACKAGE_INVALID", requestId: input.requestId })
          };
        }
        throw error;
      }
    },
    startRun: async (input): Promise<LocalApiHandlerResponse> => {
      const id = runId(input);
      if (!id.ok) return id.response;
      const body = parse(RunRevisionRequestV1Schema, input.body, input.requestId);
      if (!body.ok) return body.response;
      const current = await service.getProgress(id.value);
      if (current === null) {
        return {
          statusCode: 404,
          body: errorBody({ code: "RUN_NOT_FOUND", requestId: input.requestId })
        };
      }
      const result =
        current.stage === "REPORT"
          ? await service.startReport({ runId: id.value, ...body.value })
          : current.stage === "EVALUATION"
            ? await service.startEvaluation({ runId: id.value, ...body.value })
            : await service.start({ runId: id.value, ...body.value });
      return result.ok
        ? { statusCode: 202, body: RunProgressV1Schema.parse(runProgress(result.run)) }
        : applicationError(result.error, input.requestId);
    },
    cancelRun: async (input): Promise<LocalApiHandlerResponse> => {
      const id = runId(input);
      if (!id.ok) return id.response;
      const body = parse(RunRevisionRequestV1Schema, input.body, input.requestId);
      if (!body.ok) return body.response;
      const current = await service.getProgress(id.value);
      if (current === null) {
        return {
          statusCode: 404,
          body: errorBody({ code: "RUN_NOT_FOUND", requestId: input.requestId })
        };
      }
      const result =
        current.stage === "REPORT"
          ? await service.cancelReport({ runId: id.value, ...body.value })
          : current.stage === "EVALUATION"
            ? await service.cancelEvaluation({ runId: id.value, ...body.value })
            : await service.cancel({ runId: id.value, ...body.value });
      return result.ok
        ? { statusCode: 202, body: RunProgressV1Schema.parse(runProgress(result.run)) }
        : applicationError(result.error, input.requestId);
    },
    deleteRun: async (input): Promise<LocalApiHandlerResponse> => {
      const id = runId(input);
      if (!id.ok) return id.response;
      const result = await service.deleteRun({ runId: id.value });
      if (!result.ok) {
        return result.error.code === "RUN_NOT_FOUND"
          ? {
              statusCode: 404,
              body: errorBody({ code: "RUN_NOT_FOUND", requestId: input.requestId })
            }
          : {
              statusCode: 409,
              body: errorBody({
                code: result.error.code,
                requestId: input.requestId
              })
            };
      }
      return { statusCode: 204 };
    },
    getRunProgress: async (input): Promise<LocalApiHandlerResponse> => {
      const id = runId(input);
      if (!id.ok) return id.response;
      const value = await service.getProgress(id.value);
      return value === null
        ? {
            statusCode: 404,
            body: errorBody({ code: "RUN_NOT_FOUND", requestId: input.requestId })
          }
        : { statusCode: 200, body: RunProgressV1Schema.parse(runProgress(value)) };
    }
  };
}
