import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { CaseDefinitionWriter } from "@cortex-eval/application/src/features/test-suites/case-definition-writer.ts";
import { CaseExportService } from "@cortex-eval/application/src/features/test-suites/case-export-service.ts";
import { StreamingCaseImportService } from "@cortex-eval/application/src/features/test-suites/streaming-case-import-service.ts";
import { TestSuiteService } from "@cortex-eval/application/src/features/test-suites/test-suite-service.ts";
import { ConfigurationService } from "@cortex-eval/application/src/features/configurations/configuration-service.ts";
import { InMemoryApplicationStore } from "@cortex-eval/application/test/test-support/in-memory-application-store.ts";
import type {
  ApplicationTransaction,
  TransactionManager
} from "@cortex-eval/application/src/application-ports.ts";

import { createApplicationResourceHandlers } from "../src/application-resource-handlers.ts";
import type {
  LocalApiHandler,
  LocalApiHandlerInput,
  LocalConfigurationApiHandler,
  LocalMultipartApiHandler,
  LocalMultipartFile,
  LocalResourceHandlers
} from "../src/local-server.ts";
import { InMemoryCaseStagingFactory } from "./test-support/in-memory-case-staging.ts";
import { InMemoryCaseExportBodyPreparer } from "./test-support/in-memory-case-export-staging.ts";

const requestId = "018f0c8e-9f79-7abc-8def-0123456789ab";

// Build one direct protocol handler harness over explicit Application substitutes.
function harness(withImports = true): {
  readonly store: InMemoryApplicationStore;
  readonly suites: TestSuiteService;
  readonly handlers: LocalResourceHandlers;
} {
  const store = new InMemoryApplicationStore();
  const suites = new TestSuiteService(store.dependencies());
  const services = {
    testSuites: suites,
    cases: new CaseDefinitionWriter(store.dependencies()),
    caseExports: new CaseExportService({ transactionManager: store }),
    caseExportBodies: new InMemoryCaseExportBodyPreparer(),
    configurations: new ConfigurationService(store.configurationDependencies()),
    ...(withImports
      ? {
          caseImports: new StreamingCaseImportService({
            ...store.dependencies(),
            stagingFactory: new InMemoryCaseStagingFactory(store)
          })
        }
      : {})
  };
  return { store, suites, handlers: createApplicationResourceHandlers(services) };
}

// Return one boundary input without trusting route defaults.
function input(
  options: {
    readonly body?: unknown;
    readonly query?: unknown;
    readonly params?: Readonly<Record<string, string | undefined>>;
    readonly signal?: AbortSignal;
  } = {}
): LocalApiHandlerInput {
  return {
    body: options.body,
    query: options.query ?? {},
    params: options.params ?? {},
    requestId,
    signal: options.signal ?? new AbortController().signal
  };
}

// Require one ordinary optional handler for direct boundary testing.
function apiHandler(value: LocalApiHandler | undefined): LocalApiHandler {
  if (value === undefined) throw new Error("API_HANDLER_EXPECTED");
  return value;
}

// Require one Configuration-family optional handler.
function configurationHandler(
  value: LocalConfigurationApiHandler | undefined
): LocalConfigurationApiHandler {
  if (value === undefined) throw new Error("CONFIGURATION_HANDLER_EXPECTED");
  return value;
}

// Require the staged multipart import handler.
function importHandler(value: LocalMultipartApiHandler | undefined): LocalMultipartApiHandler {
  if (value === undefined) throw new Error("IMPORT_HANDLER_EXPECTED");
  return value;
}

// Return one already-extracted JSON file part.
function file(value: unknown, truncated = false): LocalMultipartFile {
  const payload = typeof value === "string" ? value : JSON.stringify(value);
  return {
    stream: Readable.from([payload]),
    filename: "cases.json",
    mimetype: "application/json",
    truncated: () => truncated
  };
}

// Return one strict Case transport value with an optional missing Rubric reference.
function caseDto(caseKey: string, rubric = false): Readonly<Record<string, unknown>> {
  return {
    contractVersion: "cortex.case-definition.v1",
    description: caseKey,
    threshold: 1,
    vars: { task: "route", request_body: {} },
    metadata: {
      case_id: caseKey,
      req_id: `REQ-${caseKey}`,
      task_id: `TASK-${caseKey}`,
      business_module: "chat",
      scenario_tag: "smoke"
    },
    assert: [
      rubric
        ? {
            type: "llm-rubric",
            metric: "quality",
            rubricPrompt: "prompt://missing",
            weight: 1
          }
        : { type: "contains", metric: "quality", weight: 1 }
    ]
  };
}

describe("P3 Application resource protocol error branches", () => {
  it("导出在打开成功响应前完成 Revision 校验并返回闭合冲突", async () => {
    const store = new InMemoryApplicationStore();
    const suites = new TestSuiteService(store.dependencies());
    const cases = new CaseDefinitionWriter(store.dependencies());
    const created = await suites.create({ name: "Export", description: "Current" });
    if (!created.ok) throw new Error("SUITE_EXPECTED");
    let exportTransactionCount = 0;
    const exportTransactions: TransactionManager = {
      execute: async <T>(work: (transaction: ApplicationTransaction) => Promise<T>): Promise<T> => {
        exportTransactionCount += 1;
        if (exportTransactionCount === 2) {
          const mutation = await cases.createCase({
            suiteId: created.suite.id,
            expectedSuiteRevision: 0,
            definition: {
              caseKey: "CASE-CHANGED",
              description: "Changed during export",
              threshold: 1,
              task: "route",
              requestBody: {},
              metadata: {
                requestId: "REQ-CHANGED",
                taskId: "TASK-CHANGED",
                businessModule: "chat",
                scenarioTag: "race"
              },
              assertions: [{ type: "contains", metric: "quality", weight: 1 }]
            }
          });
          expect(mutation).toMatchObject({ ok: true });
        }
        return store.execute(work);
      }
    };
    const handlers = createApplicationResourceHandlers({
      testSuites: suites,
      cases,
      caseExports: new CaseExportService({ transactionManager: exportTransactions }),
      caseExportBodies: new InMemoryCaseExportBodyPreparer(),
      configurations: new ConfigurationService(store.configurationDependencies())
    });

    const response = await apiHandler(handlers.exportCases)(
      input({ params: { suiteId: created.suite.id } })
    );

    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({ error: { code: "EXPORT_REVISION_CONFLICT" } });
  });

  it("所有写入、分页和并发边界都拒绝脏 DTO", async () => {
    const { handlers } = harness();
    const ordinary: readonly LocalApiHandler[] = [
      handlers.listTestSuites,
      apiHandler(handlers.createTestSuite),
      apiHandler(handlers.updateTestSuite),
      apiHandler(handlers.deleteTestSuite),
      apiHandler(handlers.listCases),
      apiHandler(handlers.createCase),
      apiHandler(handlers.updateCase),
      apiHandler(handlers.deleteCase),
      apiHandler(handlers.copyCase),
      apiHandler(handlers.validateEndpoint),
      apiHandler(handlers.validateLlm),
      apiHandler(handlers.previewRubricPrompt),
      apiHandler(handlers.previewAnalysisPrompt)
    ];
    const responses = await Promise.all(
      ordinary.map((handler) => handler(input({ body: null, query: { limit: 0 } })))
    );
    expect(responses.every((response) => response.statusCode === 400)).toBe(true);

    const create = configurationHandler(handlers.createConfiguration);
    const update = configurationHandler(handlers.updateConfiguration);
    for (const kind of ["ENDPOINT", "LLM", "LLM_RUBRIC_PROMPT", "CASE_ANALYSIS_PROMPT"] as const) {
      expect((await create(kind, input({ body: null }))).statusCode).toBe(400);
      expect((await update(kind, input({ body: null }))).statusCode).toBe(400);
    }
    expect(
      (
        await configurationHandler(handlers.listConfigurations)(
          "ENDPOINT",
          input({ query: { limit: 0 } })
        )
      ).statusCode
    ).toBe(400);
    expect(
      (await configurationHandler(handlers.deleteConfiguration)("ENDPOINT", input())).statusCode
    ).toBe(400);
    expect((await importHandler(handlers.importCases)(input(), file([]))).statusCode).toBe(400);
    expect(harness(false).handlers.importCases).toBeUndefined();
  });

  it("缺失资源、非法 Cursor、领域校验和 Prompt 引用映射为稳定错误", async () => {
    const { handlers, suites } = harness();
    const missingSuite = { suiteId: "missing" };
    expect(
      (await apiHandler(handlers.getTestSuite)(input({ params: missingSuite }))).statusCode
    ).toBe(404);
    expect(
      (await apiHandler(handlers.getTestSuiteImpact)(input({ params: missingSuite }))).statusCode
    ).toBe(404);
    expect(
      (
        await apiHandler(handlers.updateTestSuite)(
          input({
            params: missingSuite,
            body: { name: "Missing", description: "Missing", expectedRevision: 0 }
          })
        )
      ).statusCode
    ).toBe(404);
    expect(
      (
        await apiHandler(handlers.deleteTestSuite)(
          input({ params: missingSuite, query: { expectedRevision: 0 } })
        )
      ).statusCode
    ).toBe(404);
    expect(
      (await apiHandler(handlers.exportCases)(input({ params: missingSuite }))).statusCode
    ).toBe(404);
    expect(
      (await handlers.listTestSuites(input({ query: { cursor: "res_v2_e30" } }))).statusCode
    ).toBe(400);
    expect(
      (
        await apiHandler(handlers.listCases)(
          input({ params: missingSuite, query: { cursor: "cur_v2_e30" } })
        )
      ).statusCode
    ).toBe(400);
    expect(
      (await apiHandler(handlers.listCases)(input({ params: missingSuite, query: { limit: 50 } })))
        .statusCode
    ).toBe(404);
    expect(
      (
        await configurationHandler(handlers.listConfigurations)(
          "ENDPOINT",
          input({ query: { cursor: "res_v1_invalid" } })
        )
      ).statusCode
    ).toBe(400);

    const created = await suites.create({ name: "Suite", description: "Current" });
    if (!created.ok) throw new Error("SUITE_EXPECTED");
    const suiteId = created.suite.id;
    expect(
      (
        await apiHandler(handlers.createCase)(
          input({
            params: { suiteId },
            body: { expectedSuiteRevision: 0, definition: caseDto("CASE-MISSING", true) }
          })
        )
      ).statusCode
    ).toBe(422);
    expect(
      (
        await apiHandler(handlers.copyCase)(
          input({
            params: { suiteId, caseKey: "MISSING" },
            body: { expectedSuiteRevision: 0, newCaseKey: "COPY" }
          })
        )
      ).statusCode
    ).toBe(404);

    const createConfiguration = configurationHandler(handlers.createConfiguration);
    expect(
      (
        await createConfiguration(
          "ENDPOINT",
          input({
            body: {
              name: "Unsafe Endpoint",
              definition: {
                contractVersion: "cortex.endpoint-config.v1",
                urlTemplate: "https://user:password@example.test",
                method: "POST",
                headers: {},
                bodySelector: "/request_body",
                timeoutMs: 1000,
                defaultConcurrency: 1
              }
            }
          })
        )
      ).statusCode
    ).toBe(400);
    expect(
      (
        await createConfiguration(
          "LLM",
          input({
            body: {
              name: "Unsafe LLM",
              definition: {
                contractVersion: "cortex.llm-config.v1",
                providerType: "OPENAI_COMPATIBLE",
                model: "model",
                baseUrl: "https://remote.example/v1",
                auth: { kind: "NONE" },
                thinkingLevel: "OFF",
                temperature: 0,
                topP: 1,
                maxOutputTokens: 64,
                timeoutMs: 1000,
                structuredOutput: "JSON_OBJECT"
              }
            }
          })
        )
      ).statusCode
    ).toBe(400);
    expect(
      (
        await createConfiguration(
          "LLM_RUBRIC_PROMPT",
          input({
            body: {
              name: "Blank Prompt",
              definition: {
                contractVersion: "cortex.prompt.v1",
                kind: "LLM_RUBRIC",
                promptKey: "quality",
                messages: [{ role: "SYSTEM", content: " " }]
              }
            }
          })
        )
      ).statusCode
    ).toBe(400);
    expect(
      (
        await createConfiguration(
          "CASE_ANALYSIS_PROMPT",
          input({
            body: {
              name: "Unknown Variable",
              definition: {
                contractVersion: "cortex.prompt.v1",
                kind: "CASE_ANALYSIS",
                promptKey: "analysis",
                messages: [{ role: "USER", content: "{{unknown}}" }]
              }
            }
          })
        )
      ).statusCode
    ).toBe(400);
    expect(
      (
        await configurationHandler(handlers.getConfiguration)(
          "ENDPOINT",
          input({ params: { configurationId: "missing" } })
        )
      ).statusCode
    ).toBe(404);
    expect(
      (
        await apiHandler(handlers.listRubricPromptReferences)(
          input({ params: { configurationId: "missing" } })
        )
      ).statusCode
    ).toBe(404);
  });

  it("流式导入覆盖重复、取消、缺失 Suite、解析失败和截断清理", async () => {
    const createImport = async (): Promise<{
      readonly handler: LocalMultipartApiHandler;
      readonly suiteId: string;
    }> => {
      const { handlers, suites } = harness();
      const created = await suites.create({ name: "Import", description: "Current" });
      if (!created.ok) throw new Error("SUITE_EXPECTED");
      return { handler: importHandler(handlers.importCases), suiteId: created.suite.id };
    };

    const duplicate = await createImport();
    expect(
      (
        await duplicate.handler(
          input({ params: { suiteId: duplicate.suiteId }, query: { expectedRevision: 0 } }),
          file([caseDto("CASE-1"), caseDto("CASE-1")])
        )
      ).statusCode
    ).toBe(422);

    const missingPrompt = await createImport();
    expect(
      (
        await missingPrompt.handler(
          input({ params: { suiteId: missingPrompt.suiteId }, query: { expectedRevision: 0 } }),
          file([caseDto("CASE-RUBRIC", true)])
        )
      ).statusCode
    ).toBe(422);

    const cancelled = await createImport();
    const controller = new AbortController();
    controller.abort();
    expect(
      (
        await cancelled.handler(
          input({
            params: { suiteId: cancelled.suiteId },
            query: { expectedRevision: 0 },
            signal: controller.signal
          }),
          file([caseDto("CASE-CANCELLED")])
        )
      ).statusCode
    ).toBe(499);

    const malformed = await createImport();
    expect(
      (
        await malformed.handler(
          input({ params: { suiteId: malformed.suiteId }, query: { expectedRevision: 0 } }),
          file("[{")
        )
      ).statusCode
    ).toBe(400);

    const invalidItem = await createImport();
    expect(
      (
        await invalidItem.handler(
          input({ params: { suiteId: invalidItem.suiteId }, query: { expectedRevision: 0 } }),
          file([{ ...caseDto("CASE-BAD"), threshold: 2 }])
        )
      ).statusCode
    ).toBe(422);

    const missingSuite = harness();
    expect(
      (
        await importHandler(missingSuite.handlers.importCases)(
          input({ params: { suiteId: "missing" }, query: { expectedRevision: 0 } }),
          file([])
        )
      ).statusCode
    ).toBe(404);

    const truncated = await createImport();
    expect(
      (
        await truncated.handler(
          input({ params: { suiteId: truncated.suiteId }, query: { expectedRevision: 0 } }),
          file([], true)
        )
      ).statusCode
    ).toBe(413);
  });
});
