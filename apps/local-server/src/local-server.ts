import zhCnMessages from "@cortex-eval/contracts/messages/zh-CN.json" with { type: "json" };
import {
  ApiErrorResponseV1Schema,
  CaseImportSuccessV1Schema,
  type ApiErrorResponseV1
} from "@cortex-eval/contracts/src/resource-api-contracts.ts";
import swagger from "@fastify/swagger";
import fastJsonStringifyCompiler from "@fastify/fast-json-stringify-compiler";
import multipart from "@fastify/multipart";
import staticPlugin from "@fastify/static";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { ResilientBusinessLogger } from "./local-logger.ts";
import type { LocalRunHandlers } from "./application-run-handlers.ts";
import { localOperationSchema } from "./local-operation-schemas.ts";
import { registerRunRoutes } from "./run-api-routes.ts";
import {
  projectRuntimeSchema,
  sanitizeRuntimeSerializerSchema
} from "./contract-schema-projections.ts";

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

const requestBodySnapshots = new WeakMap<FastifyRequest["raw"], unknown>();

function cloneJsonValue(
  value: unknown
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return { ok: true, value };
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? { ok: true, value } : { ok: false };
  }
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value) {
      const cloned = cloneJsonValue(item);
      if (!cloned.ok) return cloned;
      items.push(cloned.value);
    }
    return { ok: true, value: items };
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const cloned = cloneJsonValue(item);
      if (!cloned.ok) return cloned;
      result[key] = cloned.value;
    }
    return { ok: true, value: result };
  }
  return { ok: false };
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
  /** Closed P5 Run handlers, absent until the full capability is composed. */
  readonly runHandlers?: LocalRunHandlers | undefined;
  /** Closed P7 Work Package export handler, absent until fully composed. */
  readonly workPackageExportHandler?: LocalApiHandler | undefined;
  /** Closed P10 Canonical Export handler, absent until fully reconciled. */
  readonly canonicalExportHandler?: LocalApiHandler | undefined;
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

const CASE_IMPORT_JSON_MEDIA_TYPES = new Set([
  "application/json",
  "application/x-ndjson",
  "application/ndjson",
  "application/jsonl"
]);

// Accept generic browser file media types only when the filename identifies JSONL.
function caseImportFileIsSupported(filename: string, mimetype: string): boolean {
  if (CASE_IMPORT_JSON_MEDIA_TYPES.has(mimetype)) return true;
  if (!filename.toLowerCase().endsWith(".jsonl")) return false;
  return mimetype === "application/octet-stream" || mimetype === "text/plain";
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
  registerClosedWebRoutes(server);

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
    "POST",
    "/api/v1/data/export",
    "exportCanonicalData",
    options.canonicalExportHandler,
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

  if (options.runHandlers !== undefined)
    registerRunRoutes(server, controllers, options.runHandlers);
  registerHandlerRoute(
    server,
    controllers,
    "POST",
    "/api/v1/work-packages/export",
    "exportWorkPackage",
    options.workPackageExportHandler,
    64 * 1024
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

// Serve the same SPA entry only for Web capabilities closed through P5.
function registerClosedWebRoutes(server: FastifyInstance): void {
  const routes = [
    "/test-suites",
    "/test-suites/:suiteId",
    "/runs",
    "/runs/:runId",
    "/endpoint-configs",
    "/llm-configs",
    "/rubric-prompts",
    "/analysis-prompts"
  ] as const;
  for (const url of routes) {
    server.get(url, { schema: { hide: true } }, (_request, reply) => {
      return reply.type("text/html; charset=utf-8").sendFile("index.html");
    });
  }
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
        if (
          part?.fieldname !== "file" ||
          !caseImportFileIsSupported(part.filename, part.mimetype)
        ) {
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
export function registerHandlerRoute(
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
    schema: localOperationSchema(operationId, url, method),
    handler: async (request, reply) => {
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      controllers.add(controller);
      request.raw.once("aborted", abort);
      try {
        const body = requestBodySnapshots.has(request.raw)
          ? requestBodySnapshots.get(request.raw)
          : request.body;
        const response = await handler({
          params: routeParams(request.params),
          query: request.query,
          body,
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
        requestBodySnapshots.delete(request.raw);
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
    ajv: { customOptions: { removeAdditional: false } },
    genReqId: () => options.requestIdGenerator.nextId(),
    requestIdHeader: false,
    bodyLimit: 200 * 1024 * 1024 + 64 * 1024,
    schemaController: {
      compilersFactory: {
        buildSerializer: (
          externalSchemas,
          serializerOptions
        ): ReturnType<ReturnType<typeof fastJsonStringifyCompiler>> => {
          const compile = fastJsonStringifyCompiler()(externalSchemas, serializerOptions);
          return (route) => {
            const schema = sanitizeRuntimeSerializerSchema(route.schema);
            return compile({ ...route, schema });
          };
        }
      }
    }
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
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
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
  server.addHook("preValidation", (request, _reply, done) => {
    const cloned = cloneJsonValue(request.body);
    if (cloned.ok) requestBodySnapshots.set(request.raw, cloned.value);
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
