import zhCnMessages from "@cortex-eval/contracts/messages/zh-CN.json" with { type: "json" };
import {
  CaseListQueryV1Schema,
  CaseRevisionQueryV1Schema,
  CopyCaseRequestV1Schema,
  CreateAnalysisPromptRequestV1Schema,
  CreateCaseRequestV1Schema,
  CreateEndpointConfigRequestV1Schema,
  CreateLlmConfigRequestV1Schema,
  CreateRubricPromptRequestV1Schema,
  CreateTestSuiteRequestV1Schema,
  PreviewAnalysisPromptRequestV1Schema,
  PreviewRubricPromptRequestV1Schema,
  ResourceListQueryV1Schema,
  RevisionQueryV1Schema,
  UpdateAnalysisPromptRequestV1Schema,
  UpdateCaseRequestV1Schema,
  UpdateEndpointConfigRequestV1Schema,
  UpdateLlmConfigRequestV1Schema,
  UpdateRubricPromptRequestV1Schema,
  UpdateTestSuiteRequestV1Schema,
  ValidateEndpointConfigRequestV1Schema,
  ValidateLlmConfigRequestV1Schema,
  ApiErrorResponseV1Schema,
  type ApiErrorResponseV1
} from "@cortex-eval/contracts/src/resource-api-contracts.ts";
import {
  decodeCaseCursorV1,
  encodeCaseCursorV1
} from "@cortex-eval/contracts/src/cursor-contracts.ts";
import {
  decodeResourceCursorV1,
  encodeResourceCursorV1
} from "@cortex-eval/contracts/src/resource-api-contracts.ts";
import type { CaseDefinitionWriter } from "@cortex-eval/application/src/features/test-suites/case-definition-writer.ts";
import {
  CaseExportError,
  type CaseExportService
} from "@cortex-eval/application/src/features/test-suites/case-export-service.ts";
import { CaseDefinitionV1Schema } from "@cortex-eval/contracts/src/case-contracts.ts";
import type { TestSuiteService } from "@cortex-eval/application/src/features/test-suites/test-suite-service.ts";
import type { ConfigurationService } from "@cortex-eval/application/src/features/configurations/configuration-service.ts";
import type {
  ConfigurationError,
  ConfigurationResourceKind
} from "@cortex-eval/application/src/features/configurations/configuration-models.ts";
import type { ConfigurationProbeFailure } from "@cortex-eval/application/src/features/configurations/configuration-service.ts";
import type { StreamingCaseImportService } from "@cortex-eval/application/src/features/test-suites/streaming-case-import-service.ts";
import type {
  CaseWriteError,
  StoredTestCase,
  TestSuite
} from "@cortex-eval/application/src/features/test-suites/test-suite-models.ts";
import type { TestSuiteResourceError } from "@cortex-eval/application/src/features/test-suites/test-suite-service.ts";
import type { z } from "zod";

import type {
  LocalApiHandlerInput,
  LocalApiHandlerResponse,
  LocalConfigurationKind,
  LocalMultipartFile,
  LocalResourceHandlers
} from "./local-server.ts";
import { CaseImportJsonError, parseCaseDefinitionStream } from "./case-import-json-stream.ts";
import type { CaseExportBodyPreparer } from "./case-export-staging.ts";
import {
  mapAnalysisPromptDefinitionFromV1,
  mapCaseDefinitionFromV1,
  mapCaseDefinitionToV1,
  mapConfigurationResourceToV1,
  mapEndpointDefinitionFromV1,
  mapLlmDefinitionFromV1,
  mapPromptDefinitionFromV1
} from "./resource-dto-mappers.ts";

/** Application services exposed through P3 resource protocol mappers. */
export interface ApplicationResourceServices {
  /** Test Suite CRUD and query use cases. */
  readonly testSuites: TestSuiteService;
  /** Shared Case write entry point. */
  readonly cases: CaseDefinitionWriter;
  /** Revision-consistent current Case exporter. */
  readonly caseExports: CaseExportService;
  /** Bounded pre-response export staging boundary. */
  readonly caseExportBodies: CaseExportBodyPreparer;
  /** Optional bounded streaming full-import service. */
  readonly caseImports?: StreamingCaseImportService | undefined;
  /** Current Configuration use cases. */
  readonly configurations: ConfigurationService;
}

type BoundaryError =
  | TestSuiteResourceError
  | CaseWriteError
  | ConfigurationError
  | ConfigurationProbeFailure
  | { readonly code: "EXPORT_REVISION_CONFLICT" };
type ApiErrorCode = ApiErrorResponseV1["error"]["code"];
type ImportItemCauseCode = Extract<
  ApiErrorResponseV1["error"],
  { readonly code: "CASE_IMPORT_ITEM_INVALID" }
>["causeCode"];

// Return one externalized strict API error envelope.
function errorBody(
  input: Record<string, unknown> & { readonly code: ApiErrorCode; readonly requestId: string }
): ApiErrorResponseV1 {
  return ApiErrorResponseV1Schema.parse({
    error: { ...input, message: zhCnMessages[input.code] }
  });
}

// Return the first stable Zod issue path without exposing submitted values.
function issuePath(error: z.ZodError): string {
  const path = error.issues[0]?.path;
  return path === undefined || path.length === 0 ? "request" : path.join(".");
}

// Parse untrusted boundary data and map failures into the uniform API response.
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

// Map one closed Application failure into its stable HTTP representation.
function applicationError(error: BoundaryError, requestId: string): LocalApiHandlerResponse {
  if (error.code === "RESOURCE_REVISION_CONFLICT") {
    return {
      statusCode: 409,
      body: errorBody({
        code: error.code,
        requestId,
        expectedRevision: error.expectedRevision,
        actualRevision: error.actualRevision
      })
    };
  }
  if (error.code === "RESOURCE_UNIQUE_CONFLICT") {
    return {
      statusCode: 409,
      body: errorBody({ code: error.code, requestId, field: error.field })
    };
  }
  if (error.code === "RUBRIC_PROMPT_NOT_FOUND") {
    return {
      statusCode: 422,
      body: errorBody({ code: error.code, requestId, promptKey: error.promptKey })
    };
  }
  if (error.code === "RUBRIC_PROMPT_IN_USE") {
    return {
      statusCode: 409,
      body: errorBody({ code: error.code, requestId, promptKey: error.promptKey })
    };
  }
  if (error.code === "CONFIGURATION_PROBE_FAILED") {
    return {
      statusCode: 502,
      body: errorBody({ code: error.code, requestId, reason: error.reason })
    };
  }
  if (
    error.code === "CASE_DEFINITION_INVALID" ||
    error.code === "ENDPOINT_CONFIG_INVALID" ||
    error.code === "LLM_CONFIG_INVALID" ||
    error.code === "PROMPT_INVALID" ||
    error.code === "ANALYSIS_PROMPT_INVALID"
  ) {
    return {
      statusCode: 400,
      body: errorBody({ code: error.code, requestId, path: error.path })
    };
  }
  const statusCode =
    error.code === "SUITE_NOT_FOUND" ||
    error.code === "CASE_NOT_FOUND" ||
    error.code === "CONFIGURATION_NOT_FOUND"
      ? 404
      : error.code === "RESOURCE_IN_ACTIVE_RUN" || error.code === "EXPORT_REVISION_CONFLICT"
        ? 409
        : 422;
  return { statusCode, body: errorBody({ code: error.code, requestId }) };
}

// Convert the HTTP family discriminator to the Application resource kind.
function configurationKind(kind: LocalConfigurationKind): ConfigurationResourceKind {
  return kind;
}

// Parse the family-specific create DTO and return one Application create command.
function parseConfigurationCreate(
  kind: LocalConfigurationKind,
  input: LocalApiHandlerInput
):
  | { readonly ok: true; readonly command: Parameters<ConfigurationService["create"]>[0] }
  | { readonly ok: false; readonly response: LocalApiHandlerResponse } {
  if (kind === "ENDPOINT") {
    const body = parse(CreateEndpointConfigRequestV1Schema, input.body, input.requestId);
    return body.ok
      ? {
          ok: true,
          command: {
            kind,
            name: body.value.name,
            definition: mapEndpointDefinitionFromV1(body.value.definition)
          }
        }
      : body;
  }
  if (kind === "LLM") {
    const body = parse(CreateLlmConfigRequestV1Schema, input.body, input.requestId);
    return body.ok
      ? {
          ok: true,
          command: {
            kind,
            name: body.value.name,
            definition: mapLlmDefinitionFromV1(body.value.definition)
          }
        }
      : body;
  }
  if (kind === "LLM_RUBRIC_PROMPT") {
    const body = parse(CreateRubricPromptRequestV1Schema, input.body, input.requestId);
    return body.ok
      ? {
          ok: true,
          command: {
            kind,
            name: body.value.name,
            definition: mapPromptDefinitionFromV1(body.value.definition)
          }
        }
      : body;
  }
  const body = parse(CreateAnalysisPromptRequestV1Schema, input.body, input.requestId);
  return body.ok
    ? {
        ok: true,
        command: {
          kind,
          name: body.value.name,
          definition: mapAnalysisPromptDefinitionFromV1(body.value.definition)
        }
      }
    : body;
}

// Parse the family-specific update DTO and return one Application update command.
function parseConfigurationUpdate(
  kind: LocalConfigurationKind,
  input: LocalApiHandlerInput
):
  | { readonly ok: true; readonly command: Parameters<ConfigurationService["update"]>[0] }
  | { readonly ok: false; readonly response: LocalApiHandlerResponse } {
  const id = parameter(input, "configurationId");
  if (kind === "ENDPOINT") {
    const body = parse(UpdateEndpointConfigRequestV1Schema, input.body, input.requestId);
    return body.ok
      ? {
          ok: true,
          command: {
            kind,
            id,
            name: body.value.name,
            expectedRevision: body.value.expectedRevision,
            definition: mapEndpointDefinitionFromV1(body.value.definition)
          }
        }
      : body;
  }
  if (kind === "LLM") {
    const body = parse(UpdateLlmConfigRequestV1Schema, input.body, input.requestId);
    return body.ok
      ? {
          ok: true,
          command: {
            kind,
            id,
            name: body.value.name,
            expectedRevision: body.value.expectedRevision,
            definition: mapLlmDefinitionFromV1(body.value.definition)
          }
        }
      : body;
  }
  if (kind === "LLM_RUBRIC_PROMPT") {
    const body = parse(UpdateRubricPromptRequestV1Schema, input.body, input.requestId);
    return body.ok
      ? {
          ok: true,
          command: {
            kind,
            id,
            name: body.value.name,
            expectedRevision: body.value.expectedRevision,
            definition: mapPromptDefinitionFromV1(body.value.definition)
          }
        }
      : body;
  }
  const body = parse(UpdateAnalysisPromptRequestV1Schema, input.body, input.requestId);
  return body.ok
    ? {
        ok: true,
        command: {
          kind,
          id,
          name: body.value.name,
          expectedRevision: body.value.expectedRevision,
          definition: mapAnalysisPromptDefinitionFromV1(body.value.definition)
        }
      }
    : body;
}

// Read one required path parameter after the Router has matched its shape.
function parameter(input: LocalApiHandlerInput, name: string): string {
  return input.params[name] ?? "";
}

// Map one stored Case to the small list projection.
function caseSummary(value: StoredTestCase): Record<string, unknown> {
  return {
    id: value.id,
    suiteId: value.suiteId,
    caseKey: value.caseKey,
    ordinal: value.ordinal,
    description: value.description,
    businessModule: value.businessModule,
    scenarioTag: value.scenarioTag,
    assertionTypes: value.assertionTypes,
    metrics: value.metrics,
    revision: value.revision,
    updatedAt: value.updatedAt
  };
}

// Map one stored Case to the detail projection with the complete definition.
function caseDetail(value: StoredTestCase): Record<string, unknown> {
  return {
    ...caseSummary(value),
    definition: mapCaseDefinitionToV1(value.definition),
    definitionHash: value.definitionHash,
    rubricPromptKeys: value.rubricPromptKeys,
    createdAt: value.createdAt
  };
}

// Map one Case mutation success without duplicating business decisions in Routes.
function caseMutation(value: {
  readonly case: StoredTestCase;
  readonly suite: TestSuite;
}): Record<string, unknown> {
  return { case: caseDetail(value.case), suite: value.suite };
}

// Map one batch import error while preserving only safe item identity and field facts.
function importItemError(
  index: number,
  caseKey: string,
  causeCode: ImportItemCauseCode,
  path: string | undefined,
  requestId: string
): LocalApiHandlerResponse {
  return {
    statusCode: 422,
    body: errorBody({
      code: "CASE_IMPORT_ITEM_INVALID",
      requestId,
      index,
      caseKey,
      causeCode,
      ...(path === undefined ? {} : { path })
    })
  };
}

// Execute the complete multipart import and normalize transport/Application failures.
async function importCases(
  service: StreamingCaseImportService,
  input: LocalApiHandlerInput,
  file: LocalMultipartFile
): Promise<LocalApiHandlerResponse> {
  const query = parse(RevisionQueryV1Schema, input.query, input.requestId);
  if (!query.ok) return query.response;
  try {
    const result = await service.importCases({
      suiteId: parameter(input, "suiteId"),
      expectedSuiteRevision: query.value.expectedRevision,
      definitions: parseBoundedCaseDefinitionStream(file, input.signal),
      signal: input.signal
    });
    if (file.truncated()) {
      return {
        statusCode: 413,
        body: errorBody({ code: "CASE_IMPORT_TOO_LARGE", requestId: input.requestId })
      };
    }
    if (result.ok) return { statusCode: 200, body: { count: result.count, suite: result.suite } };
    if (result.error.code === "CASE_IMPORT_ITEM_INVALID") {
      return importItemError(
        result.error.index,
        result.error.caseKey,
        result.error.cause.code,
        "path" in result.error.cause ? result.error.cause.path : undefined,
        input.requestId
      );
    }
    if (result.error.code === "CASE_IMPORT_CANCELLED") {
      return {
        statusCode: 499,
        body: errorBody({ code: result.error.code, requestId: input.requestId })
      };
    }
    return applicationError(result.error, input.requestId);
  } catch (error) {
    if (file.truncated()) {
      return {
        statusCode: 413,
        body: errorBody({ code: "CASE_IMPORT_TOO_LARGE", requestId: input.requestId })
      };
    }
    if (error instanceof CaseImportJsonError) {
      if (error.code === "CASE_IMPORT_TOO_LARGE") {
        return {
          statusCode: 413,
          body: errorBody({ code: error.code, requestId: input.requestId })
        };
      }
      if (error.code === "CASE_IMPORT_ITEM_INVALID" && error.index !== null) {
        return importItemError(
          error.index,
          error.caseKey,
          "CASE_DEFINITION_INVALID",
          error.path,
          input.requestId
        );
      }
      return {
        statusCode: error.code === "CASE_IMPORT_CANCELLED" ? 499 : 400,
        body: errorBody({
          code: error.code,
          requestId: input.requestId,
          ...(error.code === "VALIDATION_FAILED" ? { path: error.path } : {})
        })
      };
    }
    throw error;
  }
}

// Keep the multipart limit inside the consumed definition stream so no transaction can commit first.
async function* parseBoundedCaseDefinitionStream(
  file: LocalMultipartFile,
  signal: AbortSignal
): AsyncGenerator<ReturnType<typeof mapCaseDefinitionFromV1>, void, void> {
  if (file.truncated()) throw new CaseImportJsonError("CASE_IMPORT_TOO_LARGE");
  yield* parseCaseDefinitionStream(file.stream, signal);
  if (file.truncated()) throw new CaseImportJsonError("CASE_IMPORT_TOO_LARGE");
}

// Serialize one validated Case stream as a bounded-memory JSON array.
async function* exportJson(
  definitions: AsyncIterable<Parameters<typeof mapCaseDefinitionToV1>[0]>
): AsyncGenerator<string, void, void> {
  yield "[";
  let first = true;
  for await (const definition of definitions) {
    const dto = CaseDefinitionV1Schema.parse(mapCaseDefinitionToV1(definition));
    yield `${first ? "" : ","}${JSON.stringify(dto)}`;
    first = false;
  }
  yield "]";
}

/** Create the complete P3 Suite and Case resource handler set. */
export function createApplicationResourceHandlers(
  services: ApplicationResourceServices
): LocalResourceHandlers {
  const handlers: LocalResourceHandlers = {
    listTestSuites: async (input) => {
      const query = parse(ResourceListQueryV1Schema, input.query, input.requestId);
      if (!query.ok) return query.response;
      let afterCursor;
      try {
        afterCursor =
          query.value.cursor === undefined ? undefined : decodeResourceCursorV1(query.value.cursor);
      } catch (error) {
        const code =
          error instanceof Error && error.message === "CURSOR_VERSION_UNSUPPORTED"
            ? "CURSOR_VERSION_UNSUPPORTED"
            : "CURSOR_INVALID";
        return { statusCode: 400, body: errorBody({ code, requestId: input.requestId }) };
      }
      const result = await services.testSuites.query({
        limit: query.value.limit,
        ...(afterCursor === undefined
          ? {}
          : { afterCursor: { name: afterCursor.name, id: afterCursor.id } })
      });
      if (!result.ok) {
        return {
          statusCode: 400,
          body: errorBody({
            code: "VALIDATION_FAILED",
            requestId: input.requestId,
            path: result.error.path
          })
        };
      }
      return {
        statusCode: 200,
        body: {
          items: result.page.items,
          nextCursor:
            result.page.nextCursor === null
              ? null
              : encodeResourceCursorV1({ version: 1, ...result.page.nextCursor })
        }
      };
    },
    createTestSuite: async (input) => {
      const body = parse(CreateTestSuiteRequestV1Schema, input.body, input.requestId);
      if (!body.ok) return Promise.resolve(body.response);
      const result = await services.testSuites.create(body.value);
      return result.ok
        ? { statusCode: 201, body: result.suite }
        : applicationError(result.error, input.requestId);
    },
    getTestSuite: async (input) => {
      const suite = await services.testSuites.get(parameter(input, "suiteId"));
      return suite === null
        ? applicationError({ code: "SUITE_NOT_FOUND" }, input.requestId)
        : { statusCode: 200, body: suite };
    },
    updateTestSuite: async (input) => {
      const body = parse(UpdateTestSuiteRequestV1Schema, input.body, input.requestId);
      if (!body.ok) return Promise.resolve(body.response);
      const result = await services.testSuites.update({
        id: parameter(input, "suiteId"),
        ...body.value
      });
      return result.ok
        ? { statusCode: 200, body: result.suite }
        : applicationError(result.error, input.requestId);
    },
    deleteTestSuite: async (input) => {
      const query = parse(RevisionQueryV1Schema, input.query, input.requestId);
      if (!query.ok) return query.response;
      const result = await services.testSuites.delete({
        id: parameter(input, "suiteId"),
        expectedRevision: query.value.expectedRevision
      });
      return result.ok ? { statusCode: 204 } : applicationError(result.error, input.requestId);
    },
    getTestSuiteImpact: async (input) => {
      const result = await services.testSuites.impact(parameter(input, "suiteId"));
      return result.ok
        ? { statusCode: 200, body: result.impact }
        : applicationError(result.error, input.requestId);
    },
    listCases: async (input) => {
      const query = parse(CaseListQueryV1Schema, input.query, input.requestId);
      if (!query.ok) return query.response;
      let afterCursor;
      try {
        afterCursor =
          query.value.cursor === undefined ? undefined : decodeCaseCursorV1(query.value.cursor);
      } catch (error) {
        const code =
          error instanceof Error && error.message === "CURSOR_VERSION_UNSUPPORTED"
            ? "CURSOR_VERSION_UNSUPPORTED"
            : "CURSOR_INVALID";
        return { statusCode: 400, body: errorBody({ code, requestId: input.requestId }) };
      }
      const result = await services.testSuites.queryCases({
        suiteId: parameter(input, "suiteId"),
        limit: query.value.limit,
        ...(afterCursor === undefined ? {} : { afterCursor }),
        ...(query.value.caseKey === undefined ? {} : { caseKeyContains: query.value.caseKey }),
        ...(query.value.description === undefined
          ? {}
          : { descriptionContains: query.value.description }),
        ...(query.value.businessModule === undefined
          ? {}
          : { businessModules: query.value.businessModule }),
        ...(query.value.scenarioTag === undefined ? {} : { scenarioTags: query.value.scenarioTag }),
        ...(query.value.assertionType === undefined
          ? {}
          : { assertionTypes: query.value.assertionType }),
        ...(query.value.metric === undefined ? {} : { metrics: query.value.metric })
      });
      if (!result.ok) {
        if (result.error.code === "SUITE_NOT_FOUND") {
          return applicationError(result.error, input.requestId);
        }
        return {
          statusCode: 400,
          body: errorBody({
            code: "VALIDATION_FAILED",
            requestId: input.requestId,
            path: result.error.path
          })
        };
      }
      return {
        statusCode: 200,
        body: {
          items: result.page.items.map(caseSummary),
          nextCursor:
            result.page.nextCursor === null
              ? null
              : encodeCaseCursorV1({ version: 1, ...result.page.nextCursor })
        }
      };
    },
    createCase: async (input) => {
      const body = parse(CreateCaseRequestV1Schema, input.body, input.requestId);
      if (!body.ok) return body.response;
      const result = await services.cases.createCase({
        suiteId: parameter(input, "suiteId"),
        expectedSuiteRevision: body.value.expectedSuiteRevision,
        definition: mapCaseDefinitionFromV1(body.value.definition)
      });
      return result.ok
        ? { statusCode: 201, body: caseMutation(result) }
        : applicationError(result.error, input.requestId);
    },
    getCase: async (input) => {
      const value = await services.testSuites.getCase(
        parameter(input, "suiteId"),
        parameter(input, "caseKey")
      );
      return value === null
        ? applicationError(
            { code: "CASE_NOT_FOUND", caseKey: parameter(input, "caseKey") },
            input.requestId
          )
        : { statusCode: 200, body: caseDetail(value) };
    },
    updateCase: async (input) => {
      const body = parse(UpdateCaseRequestV1Schema, input.body, input.requestId);
      if (!body.ok) return body.response;
      const result = await services.cases.editCase({
        suiteId: parameter(input, "suiteId"),
        caseKey: parameter(input, "caseKey"),
        expectedSuiteRevision: body.value.expectedSuiteRevision,
        expectedCaseRevision: body.value.expectedCaseRevision,
        definition: mapCaseDefinitionFromV1(body.value.definition)
      });
      return result.ok
        ? { statusCode: 200, body: caseMutation(result) }
        : applicationError(result.error, input.requestId);
    },
    deleteCase: async (input) => {
      const query = parse(CaseRevisionQueryV1Schema, input.query, input.requestId);
      if (!query.ok) return query.response;
      const result = await services.cases.deleteCase({
        suiteId: parameter(input, "suiteId"),
        caseKey: parameter(input, "caseKey"),
        expectedSuiteRevision: query.value.expectedSuiteRevision,
        expectedCaseRevision: query.value.expectedCaseRevision
      });
      return result.ok ? { statusCode: 204 } : applicationError(result.error, input.requestId);
    },
    copyCase: async (input) => {
      const body = parse(CopyCaseRequestV1Schema, input.body, input.requestId);
      if (!body.ok) return body.response;
      const current = await services.testSuites.getCase(
        parameter(input, "suiteId"),
        parameter(input, "caseKey")
      );
      if (current === null) {
        return applicationError(
          { code: "CASE_NOT_FOUND", caseKey: parameter(input, "caseKey") },
          input.requestId
        );
      }
      const result = await services.cases.copyCase({
        suiteId: parameter(input, "suiteId"),
        expectedSuiteRevision: body.value.expectedSuiteRevision,
        definition: { ...current.definition, caseKey: body.value.newCaseKey }
      });
      return result.ok
        ? { statusCode: 201, body: caseMutation(result) }
        : applicationError(result.error, input.requestId);
    },
    exportCases: async (input) => {
      try {
        const session = await services.caseExports.begin(parameter(input, "suiteId"));
        const body = await services.caseExportBodies.prepare(
          exportJson(services.caseExports.streamSession(session))
        );
        return {
          statusCode: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
          body
        };
      } catch (error) {
        if (error instanceof CaseExportError) {
          return applicationError({ code: error.code }, input.requestId);
        }
        throw error;
      }
    },
    listConfigurations: async (kind, input) => {
      const query = parse(ResourceListQueryV1Schema, input.query, input.requestId);
      if (!query.ok) return query.response;
      let afterCursor;
      try {
        afterCursor =
          query.value.cursor === undefined ? undefined : decodeResourceCursorV1(query.value.cursor);
      } catch (error) {
        const code =
          error instanceof Error && error.message === "CURSOR_VERSION_UNSUPPORTED"
            ? "CURSOR_VERSION_UNSUPPORTED"
            : "CURSOR_INVALID";
        return { statusCode: 400, body: errorBody({ code, requestId: input.requestId }) };
      }
      const result = await services.configurations.query({
        kind: configurationKind(kind),
        limit: query.value.limit,
        ...(afterCursor === undefined
          ? {}
          : { afterCursor: { name: afterCursor.name, id: afterCursor.id } })
      });
      if (!result.ok) {
        return {
          statusCode: 400,
          body: errorBody({
            code: "VALIDATION_FAILED",
            requestId: input.requestId,
            path: result.error.path
          })
        };
      }
      return {
        statusCode: 200,
        body: {
          items: result.page.items,
          nextCursor:
            result.page.nextCursor === null
              ? null
              : encodeResourceCursorV1({ version: 1, ...result.page.nextCursor })
        }
      };
    },
    createConfiguration: async (kind, input) => {
      const parsed = parseConfigurationCreate(kind, input);
      if (!parsed.ok) return parsed.response;
      const result = await services.configurations.create(parsed.command);
      return result.ok
        ? { statusCode: 201, body: mapConfigurationResourceToV1(result.resource) }
        : applicationError(result.error, input.requestId);
    },
    getConfiguration: async (kind, input) => {
      const resource = await services.configurations.get(
        configurationKind(kind),
        parameter(input, "configurationId")
      );
      return resource === null
        ? applicationError({ code: "CONFIGURATION_NOT_FOUND" }, input.requestId)
        : { statusCode: 200, body: mapConfigurationResourceToV1(resource) };
    },
    updateConfiguration: async (kind, input) => {
      const parsed = parseConfigurationUpdate(kind, input);
      if (!parsed.ok) return parsed.response;
      const result = await services.configurations.update(parsed.command);
      return result.ok
        ? { statusCode: 200, body: mapConfigurationResourceToV1(result.resource) }
        : applicationError(result.error, input.requestId);
    },
    deleteConfiguration: async (kind, input) => {
      const query = parse(RevisionQueryV1Schema, input.query, input.requestId);
      if (!query.ok) return query.response;
      const result = await services.configurations.delete({
        kind: configurationKind(kind),
        id: parameter(input, "configurationId"),
        expectedRevision: query.value.expectedRevision
      });
      return result.ok ? { statusCode: 204 } : applicationError(result.error, input.requestId);
    },
    validateEndpoint: async (input) => {
      const body = parse(ValidateEndpointConfigRequestV1Schema, input.body, input.requestId);
      if (!body.ok) return body.response;
      const result = await services.configurations.validateEndpoint(
        mapEndpointDefinitionFromV1(body.value.definition),
        input.signal
      );
      return result.ok
        ? { statusCode: 200, body: { ok: true } }
        : applicationError(result.error, input.requestId);
    },
    validateLlm: async (input) => {
      const body = parse(ValidateLlmConfigRequestV1Schema, input.body, input.requestId);
      if (!body.ok) return body.response;
      const result = await services.configurations.validateLlm(
        mapLlmDefinitionFromV1(body.value.definition),
        input.signal
      );
      return result.ok
        ? { statusCode: 200, body: { ok: true } }
        : applicationError(result.error, input.requestId);
    },
    listRubricPromptReferences: async (input) => {
      const result = await services.configurations.listRubricPromptReferences(
        parameter(input, "configurationId")
      );
      return result.ok
        ? { statusCode: 200, body: { items: result.items } }
        : applicationError(result.error, input.requestId);
    },
    previewRubricPrompt: (input) => {
      const body = parse(PreviewRubricPromptRequestV1Schema, input.body, input.requestId);
      if (!body.ok) return Promise.resolve(body.response);
      const result = services.configurations.previewRubricPrompt(
        mapPromptDefinitionFromV1(body.value.definition)
      );
      return Promise.resolve(
        result.ok
          ? {
              statusCode: 200,
              body: { promptKey: result.promptKey, messages: result.messages }
            }
          : applicationError(result.error, input.requestId)
      );
    },
    previewAnalysisPrompt: (input) => {
      const body = parse(PreviewAnalysisPromptRequestV1Schema, input.body, input.requestId);
      if (!body.ok) return Promise.resolve(body.response);
      const result = services.configurations.previewAnalysisPrompt(
        mapAnalysisPromptDefinitionFromV1(body.value.definition)
      );
      return Promise.resolve(
        result.ok
          ? { statusCode: 200, body: { variables: result.variables } }
          : applicationError(result.error, input.requestId)
      );
    }
  };
  const caseImports = services.caseImports;
  return caseImports === undefined
    ? handlers
    : { ...handlers, importCases: (input, file) => importCases(caseImports, input, file) };
}
