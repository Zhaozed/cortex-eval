import {
  ApiErrorResponseV1Schema,
  AnalysisPromptPreviewV1Schema,
  CaseDetailV1Schema,
  CaseExportV1Schema,
  CaseMutationV1Schema,
  CasePageV1Schema,
  ConfigurationPageV1Schema,
  ConfigurationProbeSuccessV1Schema,
  ConfigurationResourceV1Schema,
  CopyCaseRequestV1Schema,
  CreateAnalysisPromptRequestV1Schema,
  CreateCaseRequestV1Schema,
  CreateEndpointConfigRequestV1Schema,
  CreateLlmConfigRequestV1Schema,
  CreateRubricPromptRequestV1Schema,
  CreateTestSuiteRequestV1Schema,
  PreviewAnalysisPromptRequestV1Schema,
  PreviewRubricPromptRequestV1Schema,
  RubricPromptPreviewV1Schema,
  RubricPromptReferencesV1Schema,
  TestSuiteDetailV1Schema,
  TestSuiteImpactV1Schema,
  TestSuitePageV1Schema,
  UpdateAnalysisPromptRequestV1Schema,
  UpdateCaseRequestV1Schema,
  UpdateEndpointConfigRequestV1Schema,
  UpdateLlmConfigRequestV1Schema,
  UpdateRubricPromptRequestV1Schema,
  UpdateTestSuiteRequestV1Schema,
  ValidateEndpointConfigRequestV1Schema,
  ValidateLlmConfigRequestV1Schema
} from "@cortex-eval/contracts/src/resource-api-contracts.ts";
import {
  CreatePlatformRunRequestV1Schema,
  PlatformRunDetailV1Schema,
  PlatformRunPageV1Schema,
  RunCaseDetailV1Schema,
  RunCasePageV1Schema,
  RunEvalPageV1Schema,
  RunPreflightRequestV1Schema,
  RunPreflightV1Schema,
  RunProgressV1Schema,
  RunRevisionRequestV1Schema
} from "@cortex-eval/contracts/src/run-api-contracts.ts";
import type { FastifySchema } from "fastify";
import type { z } from "zod";

import { projectRuntimeSchema } from "./contract-schema-projections.ts";

const EmptyResponseSchema = { type: "null" } as const;
const IdentifierParamsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    suiteId: { type: "string", minLength: 1 },
    caseKey: { type: "string", minLength: 1 },
    configurationId: { type: "string", minLength: 1 }
  }
} as const;

// Return the strict body contract for one closed operation.
function operationBodySchema(operationId: string): Record<string, unknown> | undefined {
  const schemas: Readonly<Record<string, z.ZodType>> = {
    createTestSuite: CreateTestSuiteRequestV1Schema,
    updateTestSuite: UpdateTestSuiteRequestV1Schema,
    createCase: CreateCaseRequestV1Schema,
    updateCase: UpdateCaseRequestV1Schema,
    copyCase: CopyCaseRequestV1Schema,
    createENDPOINT: CreateEndpointConfigRequestV1Schema,
    updateENDPOINT: UpdateEndpointConfigRequestV1Schema,
    createLLM: CreateLlmConfigRequestV1Schema,
    updateLLM: UpdateLlmConfigRequestV1Schema,
    createLLM_RUBRIC_PROMPT: CreateRubricPromptRequestV1Schema,
    updateLLM_RUBRIC_PROMPT: UpdateRubricPromptRequestV1Schema,
    createCASE_ANALYSIS_PROMPT: CreateAnalysisPromptRequestV1Schema,
    updateCASE_ANALYSIS_PROMPT: UpdateAnalysisPromptRequestV1Schema,
    validateEndpointConfig: ValidateEndpointConfigRequestV1Schema,
    validateLlmConfig: ValidateLlmConfigRequestV1Schema,
    previewRubricPrompt: PreviewRubricPromptRequestV1Schema,
    previewAnalysisPrompt: PreviewAnalysisPromptRequestV1Schema,
    preflightRun: RunPreflightRequestV1Schema,
    createRun: CreatePlatformRunRequestV1Schema,
    startRun: RunRevisionRequestV1Schema,
    cancelRun: RunRevisionRequestV1Schema
  };
  const schema = schemas[operationId];
  return schema === undefined ? undefined : projectRuntimeSchema(schema);
}

// Return the exact success response contract for one closed operation.
function operationResponseSchema(operationId: string): Record<string, unknown> {
  const schemas: Readonly<Record<string, z.ZodType>> = {
    listTestSuites: TestSuitePageV1Schema,
    createTestSuite: TestSuiteDetailV1Schema,
    getTestSuite: TestSuiteDetailV1Schema,
    updateTestSuite: TestSuiteDetailV1Schema,
    getTestSuiteImpact: TestSuiteImpactV1Schema,
    listCases: CasePageV1Schema,
    createCase: CaseMutationV1Schema,
    getCase: CaseDetailV1Schema,
    updateCase: CaseMutationV1Schema,
    copyCase: CaseMutationV1Schema,
    exportCases: CaseExportV1Schema,
    listENDPOINT: ConfigurationPageV1Schema,
    listLLM: ConfigurationPageV1Schema,
    listLLM_RUBRIC_PROMPT: ConfigurationPageV1Schema,
    listCASE_ANALYSIS_PROMPT: ConfigurationPageV1Schema,
    createENDPOINT: ConfigurationResourceV1Schema,
    createLLM: ConfigurationResourceV1Schema,
    createLLM_RUBRIC_PROMPT: ConfigurationResourceV1Schema,
    createCASE_ANALYSIS_PROMPT: ConfigurationResourceV1Schema,
    getENDPOINT: ConfigurationResourceV1Schema,
    getLLM: ConfigurationResourceV1Schema,
    getLLM_RUBRIC_PROMPT: ConfigurationResourceV1Schema,
    getCASE_ANALYSIS_PROMPT: ConfigurationResourceV1Schema,
    updateENDPOINT: ConfigurationResourceV1Schema,
    updateLLM: ConfigurationResourceV1Schema,
    updateLLM_RUBRIC_PROMPT: ConfigurationResourceV1Schema,
    updateCASE_ANALYSIS_PROMPT: ConfigurationResourceV1Schema,
    validateEndpointConfig: ConfigurationProbeSuccessV1Schema,
    validateLlmConfig: ConfigurationProbeSuccessV1Schema,
    listRubricPromptReferences: RubricPromptReferencesV1Schema,
    previewRubricPrompt: RubricPromptPreviewV1Schema,
    previewAnalysisPrompt: AnalysisPromptPreviewV1Schema,
    preflightRun: RunPreflightV1Schema,
    createRun: PlatformRunDetailV1Schema,
    listRuns: PlatformRunPageV1Schema,
    getRun: PlatformRunDetailV1Schema,
    listRunCases: RunCasePageV1Schema,
    listRunEvaluations: RunEvalPageV1Schema,
    getRunCase: RunCaseDetailV1Schema,
    startRun: RunProgressV1Schema,
    cancelRun: RunProgressV1Schema,
    getRunProgress: RunProgressV1Schema
  };
  const schema = schemas[operationId];
  return schema === undefined ? EmptyResponseSchema : projectRuntimeSchema(schema);
}

// Return the transport query schema for paging or optimistic concurrency.
function operationQuerySchema(operationId: string): Record<string, unknown> | undefined {
  const pageableOperations = new Set([
    "listTestSuites",
    "listCases",
    "listENDPOINT",
    "listLLM",
    "listLLM_RUBRIC_PROMPT",
    "listCASE_ANALYSIS_PROMPT",
    "listRuns",
    "listRunCases",
    "listRunEvaluations"
  ]);
  if (pageableOperations.has(operationId)) {
    const properties: Record<string, unknown> = {
      limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
      cursor: { type: "string", minLength: 1 }
    };
    if (operationId === "listCases") {
      const oneOrMany = {
        anyOf: [{ type: "string" }, { type: "array", items: { type: "string" }, maxItems: 50 }]
      };
      Object.assign(properties, {
        caseKey: { type: "string" },
        description: { type: "string" },
        businessModule: oneOrMany,
        scenarioTag: oneOrMany,
        assertionType: oneOrMany,
        metric: oneOrMany
      });
    }
    if (operationId === "listRunCases" || operationId === "listRunEvaluations") {
      properties.limit = { type: "integer", minimum: 1, maximum: 100, default: 20 };
    }
    return { type: "object", additionalProperties: false, properties };
  }
  if (operationId === "deleteCase") {
    return {
      type: "object",
      additionalProperties: false,
      required: ["expectedSuiteRevision", "expectedCaseRevision"],
      properties: {
        expectedSuiteRevision: { type: "integer", minimum: 0 },
        expectedCaseRevision: { type: "integer", minimum: 0 }
      }
    };
  }
  if (operationId.startsWith("delete")) {
    return {
      type: "object",
      additionalProperties: false,
      required: ["expectedRevision"],
      properties: { expectedRevision: { type: "integer", minimum: 0 } }
    };
  }
  return undefined;
}

/** Compose one complete Fastify schema and stable error response set. */
export function localOperationSchema(
  operationId: string,
  url: string,
  method: "GET" | "POST" | "PUT" | "DELETE"
): FastifySchema {
  const body = operationBodySchema(operationId);
  const querystring = operationQuerySchema(operationId);
  const parameterNames = [...url.matchAll(/:([A-Za-z][A-Za-z0-9]*)/g)]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined);
  const successStatus =
    operationId === "startRun" || operationId === "cancelRun"
      ? 202
      : method === "POST" && (operationId.startsWith("create") || operationId === "copyCase")
        ? 201
        : method === "DELETE"
          ? 204
          : 200;
  return {
    operationId,
    ...(body === undefined ? {} : { body }),
    ...(querystring === undefined ? {} : { querystring }),
    ...(parameterNames.length === 0
      ? {}
      : {
          params: {
            ...IdentifierParamsSchema,
            required: parameterNames,
            properties: Object.fromEntries(
              parameterNames.map((name) => [name, { type: "string", minLength: 1 }])
            )
          }
        }),
    response: {
      [successStatus]: operationResponseSchema(operationId),
      400: projectRuntimeSchema(ApiErrorResponseV1Schema),
      403: projectRuntimeSchema(ApiErrorResponseV1Schema),
      404: projectRuntimeSchema(ApiErrorResponseV1Schema),
      409: projectRuntimeSchema(ApiErrorResponseV1Schema),
      413: projectRuntimeSchema(ApiErrorResponseV1Schema),
      422: projectRuntimeSchema(ApiErrorResponseV1Schema),
      ...(operationId === "validateEndpointConfig" || operationId === "validateLlmConfig"
        ? { 502: projectRuntimeSchema(ApiErrorResponseV1Schema) }
        : {}),
      500: projectRuntimeSchema(ApiErrorResponseV1Schema)
    }
  };
}
