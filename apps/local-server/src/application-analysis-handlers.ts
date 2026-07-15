import { analysisProposalFromBoundary } from "@cortex-eval/application/src/features/case-analysis/case-analysis-model-boundary.ts";
import type {
  AnalysisDecisionResult,
  CaseAnalysisDecisionService
} from "@cortex-eval/application/src/features/case-analysis/case-analysis-decision-service.ts";
import type { PlatformCaseAnalysisService } from "@cortex-eval/application/src/features/case-analysis/platform-case-analysis-service.ts";
import {
  AcceptAnalysisProposalRequestV1Schema,
  AnalysisProposalDecisionTargetV1Schema,
  StartCaseAnalysisRequestV1Schema,
  StartCaseAnalysisResultV1Schema
} from "@cortex-eval/contracts/src/analysis-contracts.ts";
import { UuidV7Schema } from "@cortex-eval/contracts/src/contracts-primitives.ts";
import {
  ApiErrorResponseV1Schema,
  type ApiErrorResponseV1
} from "@cortex-eval/contracts/src/resource-api-contracts.ts";
import {
  ExecutionAnalysisImportRequestV1Schema,
  ExecutionAnalysisImportResultV1Schema
} from "@cortex-eval/contracts/src/result-import-contracts.ts";
import messages from "@cortex-eval/contracts/messages/zh-CN.json" with { type: "json" };
import type { z } from "zod";

import type { ExecutionAnalysisImportService } from "./execution-analysis-import-service.ts";
import { currentCaseAnalysisV1 } from "./analysis-dto-mappers.ts";
import type {
  LocalApiHandler,
  LocalApiHandlerInput,
  LocalApiHandlerResponse
} from "./local-server.ts";

/** Closed platform and offline Analysis Application surface. */
export interface ApplicationAnalysisServiceBoundary {
  readonly importExecutionAnalysis: ExecutionAnalysisImportService["importAnalysis"];
  readonly startCaseAnalysis: PlatformCaseAnalysisService["start"];
  readonly getCurrentCaseAnalysis: PlatformCaseAnalysisService["getCurrent"];
  readonly rejectAnalysisProposal: CaseAnalysisDecisionService["rejectProposal"];
  readonly acceptAnalysisProposal: CaseAnalysisDecisionService["acceptProposal"];
}

/** Closed Analysis protocol handlers registered together. */
export interface LocalAnalysisHandlers {
  readonly importExecutionAnalysis: LocalApiHandler;
  readonly startCaseAnalysis: LocalApiHandler;
  readonly getCurrentCaseAnalysis: LocalApiHandler;
  readonly rejectAnalysisProposal: LocalApiHandler;
  readonly acceptAnalysisProposal: LocalApiHandler;
  readonly editAndAcceptAnalysisProposal: LocalApiHandler;
}

function errorBody(
  input: Record<string, unknown> & {
    readonly code: ApiErrorResponseV1["error"]["code"];
    readonly requestId: string;
  }
): ApiErrorResponseV1 {
  return ApiErrorResponseV1Schema.parse({
    error: { ...input, message: messages[input.code] }
  });
}

function parse<T>(
  schema: z.ZodType<T>,
  value: unknown,
  requestId: string
):
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly response: LocalApiHandlerResponse } {
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, value: result.data };
  const path = result.error.issues[0]?.path;
  return {
    ok: false,
    response: {
      statusCode: 400,
      body: errorBody({
        code: "VALIDATION_FAILED",
        requestId,
        path: path === undefined || path.length === 0 ? "request" : path.join(".")
      })
    }
  };
}

function analysisTarget(
  input: LocalApiHandlerInput
):
  | { readonly ok: true; readonly runId: string; readonly caseKey: string }
  | { readonly ok: false; readonly response: LocalApiHandlerResponse } {
  const id = parse(UuidV7Schema, input.params.runId, input.requestId);
  if (!id.ok) return id;
  const caseKey = input.params.caseKey;
  if (caseKey === undefined || caseKey.trim() === "") {
    return {
      ok: false,
      response: {
        statusCode: 400,
        body: errorBody({ code: "VALIDATION_FAILED", requestId: input.requestId, path: "caseKey" })
      }
    };
  }
  return { ok: true, runId: id.value, caseKey };
}

function decisionResponse(
  result: AnalysisDecisionResult,
  requestId: string
): LocalApiHandlerResponse {
  if (result.ok) return { statusCode: 200, body: currentCaseAnalysisV1(result.analysis) };
  const code = result.error.code;
  if (code === "ANALYSIS_NOT_FOUND") {
    return { statusCode: 404, body: errorBody({ code, requestId }) };
  }
  if (code === "ANALYSIS_PROPOSAL_INVALID") {
    return { statusCode: 422, body: errorBody({ code, requestId, path: result.error.path }) };
  }
  if (code === "ANALYSIS_APPLY_CONFLICT") {
    return { statusCode: 409, body: errorBody({ code, requestId, reason: result.error.reason }) };
  }
  return {
    statusCode: 409,
    body: errorBody({
      code,
      requestId,
      ...(code === "ANALYSIS_REVISION_CONFLICT"
        ? { actualRevision: result.error.actualRevision }
        : {})
    })
  };
}

/** Map Analysis use cases into strict Local API handlers. */
export function createApplicationAnalysisHandlers(
  service: ApplicationAnalysisServiceBoundary
): LocalAnalysisHandlers {
  return {
    startCaseAnalysis: async (input): Promise<LocalApiHandlerResponse> => {
      const id = parse(UuidV7Schema, input.params.runId, input.requestId);
      if (!id.ok) return id.response;
      const body = parse(StartCaseAnalysisRequestV1Schema, input.body, input.requestId);
      if (!body.ok) return body.response;
      try {
        const result = await service.startCaseAnalysis({
          runId: id.value,
          analyzerConfigId: body.value.analyzerConfigId,
          analysisPromptId: body.value.analysisPromptId,
          selector: body.value.selector,
          analysisExecutionLimits: body.value.analysisExecutionLimits ?? {
            contractVersion: "cortex.analysis-execution-limits.v1",
            analysisConcurrency: 1
          },
          signal: input.signal
        });
        if (result.ok) {
          return {
            statusCode: 200,
            body: StartCaseAnalysisResultV1Schema.parse({
              contractVersion: "cortex.case-analysis-start-result.v1",
              runId: id.value,
              selector: body.value.selector,
              selectedCount: result.selectedCount,
              succeededCount: result.succeededCount,
              errorCount: result.errorCount,
              finalCaseResultSetHash: result.finalCaseResultSetHash
            })
          };
        }
        const code = result.error.code;
        if (code === "RUN_NOT_FOUND" || code === "CONFIGURATION_NOT_FOUND") {
          return { statusCode: 404, body: errorBody({ code, requestId: input.requestId }) };
        }
        if (code === "REPORT_RECONCILIATION_FAILED") {
          return { statusCode: 422, body: errorBody({ code, requestId: input.requestId }) };
        }
        return { statusCode: 409, body: errorBody({ code, requestId: input.requestId }) };
      } catch (error) {
        if (input.signal.aborted) {
          return {
            statusCode: 499,
            body: errorBody({ code: "REQUEST_ABORTED", requestId: input.requestId })
          };
        }
        throw error;
      }
    },
    getCurrentCaseAnalysis: async (input): Promise<LocalApiHandlerResponse> => {
      const target = analysisTarget(input);
      if (!target.ok) return target.response;
      const analysis = await service.getCurrentCaseAnalysis(target.runId, target.caseKey);
      return analysis === null
        ? {
            statusCode: 404,
            body: errorBody({ code: "ANALYSIS_NOT_FOUND", requestId: input.requestId })
          }
        : { statusCode: 200, body: currentCaseAnalysisV1(analysis) };
    },
    rejectAnalysisProposal: async (input): Promise<LocalApiHandlerResponse> => {
      const target = analysisTarget(input);
      if (!target.ok) return target.response;
      const body = parse(AnalysisProposalDecisionTargetV1Schema, input.body, input.requestId);
      if (!body.ok) return body.response;
      return decisionResponse(
        await service.rejectAnalysisProposal({
          runId: target.runId,
          caseKey: target.caseKey,
          ...body.value
        }),
        input.requestId
      );
    },
    acceptAnalysisProposal: async (input): Promise<LocalApiHandlerResponse> => {
      const target = analysisTarget(input);
      if (!target.ok) return target.response;
      const body = parse(AcceptAnalysisProposalRequestV1Schema, input.body, input.requestId);
      if (!body.ok) return body.response;
      if (body.value.editedProposal !== undefined) {
        return {
          statusCode: 400,
          body: errorBody({
            code: "VALIDATION_FAILED",
            requestId: input.requestId,
            path: "editedProposal"
          })
        };
      }
      return decisionResponse(
        await service.acceptAnalysisProposal({
          runId: target.runId,
          caseKey: target.caseKey,
          analysisId: body.value.analysisId,
          expectedAnalysisRevision: body.value.expectedAnalysisRevision,
          expectedFinalCaseResultHash: body.value.expectedFinalCaseResultHash,
          expectedAnalysisInputHash: body.value.expectedAnalysisInputHash,
          expectedPromptHash: body.value.expectedPromptHash,
          expectedAnalyzerConfigHash: body.value.expectedAnalyzerConfigHash,
          suiteId: body.value.suiteId,
          expectedSuiteRevision: body.value.expectedSuiteRevision,
          expectedCaseId: body.value.expectedCaseId,
          expectedCaseRevision: body.value.expectedCaseRevision
        }),
        input.requestId
      );
    },
    editAndAcceptAnalysisProposal: async (input): Promise<LocalApiHandlerResponse> => {
      const target = analysisTarget(input);
      if (!target.ok) return target.response;
      const body = parse(AcceptAnalysisProposalRequestV1Schema, input.body, input.requestId);
      if (!body.ok) return body.response;
      if (body.value.editedProposal === undefined) {
        return {
          statusCode: 400,
          body: errorBody({
            code: "VALIDATION_FAILED",
            requestId: input.requestId,
            path: "editedProposal"
          })
        };
      }
      return decisionResponse(
        await service.acceptAnalysisProposal({
          runId: target.runId,
          caseKey: target.caseKey,
          ...body.value,
          editedProposal: analysisProposalFromBoundary(body.value.editedProposal)
        }),
        input.requestId
      );
    },
    importExecutionAnalysis: async (input): Promise<LocalApiHandlerResponse> => {
      const body = parse(ExecutionAnalysisImportRequestV1Schema, input.body, input.requestId);
      if (!body.ok) return body.response;
      try {
        const result = await service.importExecutionAnalysis(body.value, input.signal);
        if (!result.ok) {
          return {
            statusCode: 409,
            body: errorBody({ code: "EXECUTION_RESULT_CONFLICT", requestId: input.requestId })
          };
        }
        return {
          statusCode: 201,
          body: ExecutionAnalysisImportResultV1Schema.parse({
            contractVersion: "cortex.execution-analysis-import-result.v1",
            ...result.value
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
          (error.message.startsWith("WORK_PACKAGE_") || error.message.startsWith("ARTIFACT_"))
        ) {
          return {
            statusCode: 422,
            body: errorBody({ code: "WORK_PACKAGE_INVALID", requestId: input.requestId })
          };
        }
        throw error;
      }
    }
  };
}
