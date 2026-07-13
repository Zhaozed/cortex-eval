import zhCnMessages from "@cortex-eval/contracts/messages/zh-CN.json" with { type: "json" };
import {
  ApiErrorResponseV1Schema,
  AnalysisPromptPreviewV1Schema,
  CaseDetailV1Schema,
  CaseExportV1Schema,
  CaseImportSuccessV1Schema,
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
  ValidateLlmConfigRequestV1Schema,
  type ApiErrorResponseV1
} from "@cortex-eval/contracts/src/resource-api-contracts.ts";
import swagger from "@fastify/swagger";
import multipart from "@fastify/multipart";
import staticPlugin from "@fastify/static";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { ResilientBusinessLogger } from "./local-logger.ts";
import type { z } from "zod";
import type { FastifySchema } from "fastify";
import { projectRuntimeSchema } from "./contract-schema-projections.ts";

/** Validated data passed from one Fastify Route to its boundary handler. */
export interface LocalApiHandlerInput {
  /** Route parameters after Fastify path matching. */
  readonly params: Readonly<Record<string, string | undefined>>;
  /** Untrusted query object to be validated by Contracts. */
  readonly query: unknown;
  /** Untrusted parsed body to be validated by Contracts. */
  readonly body: unknown;
  /** Server-generated request correlation identity. */
  readonly requestId: string;
  /** Request/server-close cancellation signal. */
  readonly signal: AbortSignal;
}

/** Complete protocol response selected outside the thin Route layer. */
export interface LocalApiHandlerResponse {
  /** HTTP response status. */
  readonly statusCode: number;
  /** Strict response body, absent only for 204. */
  readonly body?: unknown;
  /** Safe response headers selected by the protocol mapper. */
  readonly headers?: Readonly<Record<string, string>>;
}

/** One bounded multipart file exposed to the import protocol handler. */
export interface LocalMultipartFile {
  /** Backpressure-aware file byte stream. */
  readonly stream: Readable;
  /** Client filename, used only for safe protocol validation. */
  readonly filename: string;
  /** Declared media type. */
  readonly mimetype: string;
  /** Whether the multipart parser observed bytes beyond the exact limit. */
  readonly truncated: () => boolean;
}

/** One multipart resource protocol handler. */
export type LocalMultipartApiHandler = (
  input: LocalApiHandlerInput,
  file: LocalMultipartFile
) => Promise<LocalApiHandlerResponse>;

/** One resource protocol handler. */
export type LocalApiHandler = (input: LocalApiHandlerInput) => Promise<LocalApiHandlerResponse>;

/** Current Configuration route family. */
export type LocalConfigurationKind =
  "ENDPOINT" | "LLM" | "LLM_RUBRIC_PROMPT" | "CASE_ANALYSIS_PROMPT";

/** One Configuration family protocol handler. */
export type LocalConfigurationApiHandler = (
  kind: LocalConfigurationKind,
  input: LocalApiHandlerInput
) => Promise<LocalApiHandlerResponse>;

/** P3 resource handlers registered only after their capability is closed. */
export interface LocalResourceHandlers {
  /** List current Test Suites without large Case definitions. */
  readonly listTestSuites: LocalApiHandler;
  /** Create one empty current Test Suite. */
  readonly createTestSuite?: LocalApiHandler | undefined;
  /** Read one current Test Suite detail. */
  readonly getTestSuite?: LocalApiHandler | undefined;
  /** Conditionally update one current Test Suite. */
  readonly updateTestSuite?: LocalApiHandler | undefined;
  /** Conditionally delete one current Test Suite. */
  readonly deleteTestSuite?: LocalApiHandler | undefined;
  /** Read current Suite deletion impact. */
  readonly getTestSuiteImpact?: LocalApiHandler | undefined;
  /** List small current Cases. */
  readonly listCases?: LocalApiHandler | undefined;
  /** Create one current Case. */
  readonly createCase?: LocalApiHandler | undefined;
  /** Read one current Case detail. */
  readonly getCase?: LocalApiHandler | undefined;
  /** Conditionally update one current Case. */
  readonly updateCase?: LocalApiHandler | undefined;
  /** Conditionally delete one current Case. */
  readonly deleteCase?: LocalApiHandler | undefined;
  /** Copy one current Case through the shared writer. */
  readonly copyCase?: LocalApiHandler | undefined;
  /** Stream one Revision-consistent Case Definition JSON array. */
  readonly exportCases?: LocalApiHandler | undefined;
  /** Atomically import one streamed Case Definition JSON array. */
  readonly importCases?: LocalMultipartApiHandler | undefined;
  /** List one current Configuration family. */
  readonly listConfigurations?: LocalConfigurationApiHandler | undefined;
  /** Create one current Configuration. */
  readonly createConfiguration?: LocalConfigurationApiHandler | undefined;
  /** Read one current Configuration detail. */
  readonly getConfiguration?: LocalConfigurationApiHandler | undefined;
  /** Conditionally update one current Configuration. */
  readonly updateConfiguration?: LocalConfigurationApiHandler | undefined;
  /** Conditionally delete one current Configuration. */
  readonly deleteConfiguration?: LocalConfigurationApiHandler | undefined;
  /** Probe one Endpoint definition. */
  readonly validateEndpoint?: LocalApiHandler | undefined;
  /** Probe one LLM definition. */
  readonly validateLlm?: LocalApiHandler | undefined;
  /** List current Case references to one Rubric Prompt. */
  readonly listRubricPromptReferences?: LocalApiHandler | undefined;
  /** Preview Rubric Prompt messages before saving. */
  readonly previewRubricPrompt?: LocalApiHandler | undefined;
  /** Preview Analysis Prompt variables before saving. */
  readonly previewAnalysisPrompt?: LocalApiHandler | undefined;
}

/** Boundary-generated request identity source. */
export interface RequestIdGenerator {
  /** Return one new UUIDv7 without trusting caller input. */
  readonly nextId: () => string;
}

/** Local Server construction options. */
export interface LocalServerOptions {
  /** Internal request identity source. */
  readonly requestIdGenerator: RequestIdGenerator;
  /** Closed P3 resource handler surface. */
  readonly resourceHandlers: LocalResourceHandlers;
  /** Exact loopback authorities accepted by Host validation. */
  readonly allowedHosts?: readonly string[] | undefined;
  /** Optional resilient request business logger. */
  readonly businessLogger?: ResilientBusinessLogger | undefined;
  /** Optional static Web root; defaults to the capability-neutral bundled shell. */
  readonly staticRoot?: string | undefined;
}

type ApiErrorCode = ApiErrorResponseV1["error"]["code"];

const DEFAULT_ALLOWED_HOSTS = ["127.0.0.1:4310", "localhost:4310", "[::1]:4310"] as const;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/** Exact maximum multipart Case JSON file bytes. */
export const MAX_CASE_IMPORT_BYTES = 200 * 1024 * 1024;

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
    previewAnalysisPrompt: PreviewAnalysisPromptRequestV1Schema
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
    previewAnalysisPrompt: AnalysisPromptPreviewV1Schema
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
    "listCASE_ANALYSIS_PROMPT"
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

// Compose one complete Fastify schema and stable error response set.
function operationSchema(
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
    method === "POST" && (operationId.startsWith("create") || operationId === "copyCase")
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

// Read all raw header values so duplicate Host/Origin headers cannot be collapsed safely.
function rawHeaderValues(request: FastifyRequest, headerName: string): readonly string[] {
  const result: string[] = [];
  const rawHeaders = request.raw.rawHeaders;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (name?.toLowerCase() === headerName && value !== undefined) result.push(value);
  }
  return result;
}

// Build one exact plain API error response from the externalized Chinese catalog.
function plainError(code: ApiErrorCode, requestId: string): ApiErrorResponseV1 {
  const message = zhCnMessages[code];
  return ApiErrorResponseV1Schema.parse({ error: { code, message, requestId } });
}

// Send one stable plain error without exposing caught values.
function sendPlainError(
  reply: FastifyReply,
  statusCode: number,
  code: ApiErrorCode,
  requestId: string
): void {
  void reply.code(statusCode).send(plainError(code, requestId));
}

// Send one strict boundary validation error with no submitted value.
function sendValidationError(reply: FastifyReply, requestId: string, path: string): void {
  const body = ApiErrorResponseV1Schema.parse({
    error: {
      code: "VALIDATION_FAILED",
      message: zhCnMessages.VALIDATION_FAILED,
      requestId,
      path
    }
  });
  void reply.code(400).send(body);
}

// Validate one raw Host header against the configured loopback authorities.
function trustedHost(request: FastifyRequest, allowedHosts: ReadonlySet<string>): string | null {
  const values = rawHeaderValues(request, "host");
  if (values.length !== 1) return null;
  const value = values[0];
  return value !== undefined && allowedHosts.has(value.toLowerCase()) ? value.toLowerCase() : null;
}

// Accept an absent CLI Origin or the exact same HTTP loopback origin on unsafe methods.
function trustedOrigin(request: FastifyRequest, host: string): boolean {
  if (SAFE_METHODS.has(request.method)) return true;
  const values = rawHeaderValues(request, "origin");
  if (values.length === 0) return true;
  return values.length === 1 && values[0] === `http://${host}`;
}

// Register Swagger before P3 routes inside one scope so onRoute sees every capability.
async function registerResourceRoutes(
  server: FastifyInstance,
  options: LocalServerOptions,
  controllers: Set<AbortController>
): Promise<void> {
  await server.register(swagger, {
    openapi: {
      openapi: "3.0.3",
      info: { title: "Cortex Eval Local API", version: "1.0.0" }
    }
  });
  await server.register(multipart, {
    throwFileSizeLimit: false,
    limits: { fileSize: MAX_CASE_IMPORT_BYTES, files: 1, fields: 0, parts: 1 }
  });
  await server.register(staticPlugin, {
    root: options.staticRoot ?? fileURLToPath(new URL("../public", import.meta.url)),
    prefix: "/",
    wildcard: false
  });

  registerHandlerRoute(
    server,
    controllers,
    "GET",
    "/api/v1/test-suites",
    "listTestSuites",
    options.resourceHandlers.listTestSuites
  );
  registerHandlerRoute(
    server,
    controllers,
    "POST",
    "/api/v1/test-suites",
    "createTestSuite",
    options.resourceHandlers.createTestSuite,
    64 * 1024
  );
  registerHandlerRoute(
    server,
    controllers,
    "GET",
    "/api/v1/test-suites/:suiteId",
    "getTestSuite",
    options.resourceHandlers.getTestSuite
  );
  registerHandlerRoute(
    server,
    controllers,
    "PUT",
    "/api/v1/test-suites/:suiteId",
    "updateTestSuite",
    options.resourceHandlers.updateTestSuite,
    64 * 1024
  );
  registerHandlerRoute(
    server,
    controllers,
    "DELETE",
    "/api/v1/test-suites/:suiteId",
    "deleteTestSuite",
    options.resourceHandlers.deleteTestSuite
  );
  registerHandlerRoute(
    server,
    controllers,
    "GET",
    "/api/v1/test-suites/:suiteId/impact",
    "getTestSuiteImpact",
    options.resourceHandlers.getTestSuiteImpact
  );
  registerHandlerRoute(
    server,
    controllers,
    "GET",
    "/api/v1/test-suites/:suiteId/cases",
    "listCases",
    options.resourceHandlers.listCases
  );
  registerHandlerRoute(
    server,
    controllers,
    "POST",
    "/api/v1/test-suites/:suiteId/cases",
    "createCase",
    options.resourceHandlers.createCase,
    200 * 1024 * 1024 + 64 * 1024
  );
  registerHandlerRoute(
    server,
    controllers,
    "GET",
    "/api/v1/test-suites/:suiteId/cases/:caseKey",
    "getCase",
    options.resourceHandlers.getCase
  );
  registerHandlerRoute(
    server,
    controllers,
    "PUT",
    "/api/v1/test-suites/:suiteId/cases/:caseKey",
    "updateCase",
    options.resourceHandlers.updateCase,
    200 * 1024 * 1024 + 64 * 1024
  );
  registerHandlerRoute(
    server,
    controllers,
    "DELETE",
    "/api/v1/test-suites/:suiteId/cases/:caseKey",
    "deleteCase",
    options.resourceHandlers.deleteCase
  );
  registerHandlerRoute(
    server,
    controllers,
    "POST",
    "/api/v1/test-suites/:suiteId/cases/:caseKey/copy",
    "copyCase",
    options.resourceHandlers.copyCase,
    64 * 1024
  );
  registerHandlerRoute(
    server,
    controllers,
    "GET",
    "/api/v1/test-suites/:suiteId/export",
    "exportCases",
    options.resourceHandlers.exportCases
  );
  registerMultipartImportRoute(server, controllers, options.resourceHandlers.importCases);

  registerConfigurationRoutes(
    server,
    controllers,
    options.resourceHandlers,
    "ENDPOINT",
    "/api/v1/endpoint-configs"
  );
  registerConfigurationRoutes(
    server,
    controllers,
    options.resourceHandlers,
    "LLM",
    "/api/v1/llm-configs"
  );
  registerConfigurationRoutes(
    server,
    controllers,
    options.resourceHandlers,
    "LLM_RUBRIC_PROMPT",
    "/api/v1/llm-rubric-prompts",
    2 * 1024 * 1024
  );
  registerConfigurationRoutes(
    server,
    controllers,
    options.resourceHandlers,
    "CASE_ANALYSIS_PROMPT",
    "/api/v1/case-analysis-prompts",
    2 * 1024 * 1024
  );
  registerHandlerRoute(
    server,
    controllers,
    "POST",
    "/api/v1/endpoint-configs/validate",
    "validateEndpointConfig",
    options.resourceHandlers.validateEndpoint,
    256 * 1024
  );
  registerHandlerRoute(
    server,
    controllers,
    "POST",
    "/api/v1/llm-configs/validate",
    "validateLlmConfig",
    options.resourceHandlers.validateLlm,
    256 * 1024
  );
  registerHandlerRoute(
    server,
    controllers,
    "GET",
    "/api/v1/llm-rubric-prompts/:configurationId/references",
    "listRubricPromptReferences",
    options.resourceHandlers.listRubricPromptReferences
  );
  registerHandlerRoute(
    server,
    controllers,
    "POST",
    "/api/v1/llm-rubric-prompts/preview",
    "previewRubricPrompt",
    options.resourceHandlers.previewRubricPrompt,
    2 * 1024 * 1024
  );
  registerHandlerRoute(
    server,
    controllers,
    "POST",
    "/api/v1/case-analysis-prompts/preview",
    "previewAnalysisPrompt",
    options.resourceHandlers.previewAnalysisPrompt,
    2 * 1024 * 1024
  );

  server.get("/api/v1/openapi.json", { schema: { hide: true } }, () => {
    const document = structuredClone(server.swagger()) as unknown as {
      paths?: Record<string, Record<string, Record<string, unknown>>>;
    };
    const operation = document.paths?.["/api/v1/test-suites/{suiteId}/import"]?.post;
    if (operation !== undefined) {
      operation.requestBody = {
        required: true,
        content: {
          "multipart/form-data": {
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["file"],
              properties: { file: { type: "string", format: "binary" } }
            }
          }
        }
      };
    }
    return document;
  });
}

// Register the one bounded multipart import capability after its handler is closed.
function registerMultipartImportRoute(
  server: FastifyInstance,
  controllers: Set<AbortController>,
  handler: LocalMultipartApiHandler | undefined
): void {
  if (handler === undefined) return;
  server.post(
    "/api/v1/test-suites/:suiteId/import",
    {
      schema: {
        operationId: "importCases",
        consumes: ["multipart/form-data"],
        querystring: {
          type: "object",
          additionalProperties: false,
          required: ["expectedRevision"],
          properties: { expectedRevision: { type: "integer", minimum: 0 } }
        },
        params: {
          type: "object",
          additionalProperties: false,
          required: ["suiteId"],
          properties: { suiteId: { type: "string", minLength: 1 } }
        },
        response: {
          200: projectRuntimeSchema(CaseImportSuccessV1Schema),
          400: projectRuntimeSchema(ApiErrorResponseV1Schema),
          403: projectRuntimeSchema(ApiErrorResponseV1Schema),
          404: projectRuntimeSchema(ApiErrorResponseV1Schema),
          409: projectRuntimeSchema(ApiErrorResponseV1Schema),
          413: projectRuntimeSchema(ApiErrorResponseV1Schema),
          422: projectRuntimeSchema(ApiErrorResponseV1Schema),
          499: projectRuntimeSchema(ApiErrorResponseV1Schema),
          500: projectRuntimeSchema(ApiErrorResponseV1Schema)
        }
      },
      bodyLimit: MAX_CASE_IMPORT_BYTES + 64 * 1024
    },
    async (request, reply) => {
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      controllers.add(controller);
      request.raw.once("aborted", abort);
      try {
        const part = await request.file({
          limits: { fileSize: MAX_CASE_IMPORT_BYTES, files: 1, fields: 0, parts: 1 }
        });
        if (part?.fieldname !== "file" || part.mimetype !== "application/json") {
          sendValidationError(reply, request.id, "file");
          return;
        }
        const response = await handler(
          {
            params: routeParams(request.params),
            query: request.query,
            body: undefined,
            requestId: request.id,
            signal: controller.signal
          },
          {
            stream: part.file,
            filename: part.filename,
            mimetype: part.mimetype,
            truncated: () => part.file.truncated
          }
        );
        for (const [name, value] of Object.entries(response.headers ?? {})) {
          reply.header(name, value);
        }
        reply.statusCode = response.statusCode;
        if (response.body === undefined) return await reply.send();
        return await reply.send(response.body);
      } finally {
        request.raw.off("aborted", abort);
        controllers.delete(controller);
      }
    }
  );
}

// Bind one Configuration family to the shared resource handlers and fixed route matrix.
function registerConfigurationRoutes(
  server: FastifyInstance,
  controllers: Set<AbortController>,
  handlers: LocalResourceHandlers,
  kind: LocalConfigurationKind,
  baseUrl: string,
  bodyLimit = 256 * 1024
): void {
  const bind = (handler: LocalConfigurationApiHandler | undefined): LocalApiHandler | undefined =>
    handler === undefined
      ? undefined
      : (input): Promise<LocalApiHandlerResponse> => handler(kind, input);
  registerHandlerRoute(
    server,
    controllers,
    "GET",
    baseUrl,
    `list${kind}`,
    bind(handlers.listConfigurations)
  );
  registerHandlerRoute(
    server,
    controllers,
    "POST",
    baseUrl,
    `create${kind}`,
    bind(handlers.createConfiguration),
    bodyLimit
  );
  registerHandlerRoute(
    server,
    controllers,
    "GET",
    `${baseUrl}/:configurationId`,
    `get${kind}`,
    bind(handlers.getConfiguration)
  );
  registerHandlerRoute(
    server,
    controllers,
    "PUT",
    `${baseUrl}/:configurationId`,
    `update${kind}`,
    bind(handlers.updateConfiguration),
    bodyLimit
  );
  registerHandlerRoute(
    server,
    controllers,
    "DELETE",
    `${baseUrl}/:configurationId`,
    `delete${kind}`,
    bind(handlers.deleteConfiguration)
  );
}

// Normalize Fastify route params before the Contracts-backed handler validates their values.
function routeParams(value: unknown): Readonly<Record<string, string | undefined>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string | undefined> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = typeof item === "string" ? item : undefined;
  }
  return result;
}

// Register only one closed capability and keep its Fastify Route free of business rules.
function registerHandlerRoute(
  server: FastifyInstance,
  controllers: Set<AbortController>,
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  operationId: string,
  handler: LocalApiHandler | undefined,
  bodyLimit?: number
): void {
  if (handler === undefined) return;
  server.route({
    method,
    url,
    ...(bodyLimit === undefined ? {} : { bodyLimit }),
    schema: operationSchema(operationId, url, method),
    handler: async (request, reply) => {
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      controllers.add(controller);
      request.raw.once("aborted", abort);
      try {
        const response = await handler({
          params: routeParams(request.params),
          query: request.query,
          body: request.body,
          requestId: request.id,
          signal: controller.signal
        });
        for (const [name, value] of Object.entries(response.headers ?? {})) {
          reply.header(name, value);
        }
        if (response.body === undefined) return await reply.code(response.statusCode).send();
        return await reply.code(response.statusCode).send(response.body);
      } finally {
        request.raw.off("aborted", abort);
        controllers.delete(controller);
      }
    }
  });
}

/** Build one non-listening Fastify instance for lifecycle composition or injection tests. */
export function buildLocalServer(options: LocalServerOptions): FastifyInstance {
  const allowedHosts = new Set(
    (options.allowedHosts ?? DEFAULT_ALLOWED_HOSTS).map((value) => value.toLowerCase())
  );
  const server = Fastify({
    logger: false,
    genReqId: () => options.requestIdGenerator.nextId(),
    requestIdHeader: false,
    bodyLimit: 200 * 1024 * 1024 + 64 * 1024
  });
  const requestControllers = new Set<AbortController>();
  const requestStartedAt = new WeakMap<FastifyRequest["raw"], number>();

  server.addHook("onRequest", (request, reply, done) => {
    requestStartedAt.set(request.raw, performance.now());
    reply.header("x-request-id", request.id);
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header(
      "content-security-policy",
      "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    );
    const host = trustedHost(request, allowedHosts);
    if (host === null) {
      sendPlainError(reply, 403, "HOST_NOT_ALLOWED", request.id);
      done();
      return;
    }
    if (!trustedOrigin(request, host)) {
      sendPlainError(reply, 403, "ORIGIN_NOT_ALLOWED", request.id);
      done();
      return;
    }
    done();
  });

  server.addHook("onResponse", async (request, reply) => {
    const startedAt = requestStartedAt.get(request.raw) ?? performance.now();
    requestStartedAt.delete(request.raw);
    await options.businessLogger?.record({
      event: "REQUEST_COMPLETED",
      timestamp: new Date().toISOString(),
      requestId: request.id,
      errorCode: reply.statusCode >= 400 ? String(reply.statusCode) : undefined,
      durationMs: performance.now() - startedAt
    });
  });

  void server.register(async (scope) => registerResourceRoutes(scope, options, requestControllers));

  server.addHook("onClose", (_instance, done) => {
    for (const controller of requestControllers) controller.abort();
    requestControllers.clear();
    done();
  });

  server.setNotFoundHandler((request, reply) => {
    sendPlainError(reply, 404, "ROUTE_NOT_FOUND", request.id);
  });

  server.setErrorHandler((error, request, reply) => {
    if (reply.sent) return;
    const code =
      error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
    const statusCode =
      error !== null && typeof error === "object" && "statusCode" in error
        ? error.statusCode
        : undefined;
    if (code === "FST_ERR_CTP_BODY_TOO_LARGE" || code === "FST_REQ_FILE_TOO_LARGE") {
      sendPlainError(reply, 413, "REQUEST_BODY_TOO_LARGE", request.id);
      return;
    }
    if (code === "STORAGE_TRANSACTION_CONFLICT") {
      sendPlainError(reply, 409, "STORAGE_TRANSACTION_CONFLICT", request.id);
      return;
    }
    if (statusCode === 400) {
      sendValidationError(reply, request.id, "body");
      return;
    }
    sendPlainError(reply, 500, "INTERNAL_ERROR", request.id);
  });

  return server;
}
