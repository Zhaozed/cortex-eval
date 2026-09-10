import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { CaseDefinitionWriter } from "@cortex-eval/application/src/features/test-suites/case-definition-writer.ts";
import { TestSuiteService } from "@cortex-eval/application/src/features/test-suites/test-suite-service.ts";
import { CaseExportService } from "@cortex-eval/application/src/features/test-suites/case-export-service.ts";
import { ConfigurationService } from "@cortex-eval/application/src/features/configurations/configuration-service.ts";
import { StreamingCaseImportService } from "@cortex-eval/application/src/features/test-suites/streaming-case-import-service.ts";
import { InMemoryApplicationStore } from "@cortex-eval/application/test/test-support/in-memory-application-store.ts";

import { createApplicationResourceHandlers } from "../src/application-resource-handlers.ts";
import { buildLocalServer } from "../src/local-server.ts";
import { InMemoryCaseStagingFactory } from "./test-support/in-memory-case-staging.ts";
import { InMemoryCaseExportBodyPreparer } from "./test-support/in-memory-case-export-staging.ts";
import { jsonStringProperty, parseJsonObject } from "./test-support/json-test-values.ts";

const requestId = "018f0c8e-9f79-7abc-8def-0123456789ab";
const hostHeaders = { host: "127.0.0.1:4310" };
const headers = { ...hostHeaders, "content-type": "application/json" };

const caseDefinition = {
  contractVersion: "cortex.case-definition.v1",
  description: "Route case",
  threshold: 0.8,
  vars: { task: "route", request_body: { text: "hello" } },
  metadata: {
    case_id: "CASE-1",
    req_id: "REQ-1",
    task_id: "TASK-1",
    business_module: "chat",
    scenario_tag: "smoke"
  },
  assert: [{ type: "contains", metric: "quality", value: "ok", weight: 1 }]
};

describe("P3 资源 API", () => {
  const servers: { close(): Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(async (server) => server.close()));
  });

  function setup(): FastifyInstance {
    const store = new InMemoryApplicationStore();
    const server = buildLocalServer({
      requestIdGenerator: { nextId: () => requestId },
      resourceHandlers: createApplicationResourceHandlers({
        testSuites: new TestSuiteService(store.dependencies()),
        cases: new CaseDefinitionWriter(store.dependencies()),
        caseExports: new CaseExportService({ transactionManager: store }),
        caseExportBodies: new InMemoryCaseExportBodyPreparer(),
        caseImports: new StreamingCaseImportService({
          ...store.dependencies(),
          stagingFactory: new InMemoryCaseStagingFactory(store)
        }),
        configurations: new ConfigurationService(store.configurationDependencies())
      })
    });
    servers.push(server);
    return server;
  }

  it("通过 HTTP 完成 Test Suite CRUD、分页和 Revision 冲突", async () => {
    const server = setup();
    const created = await server.inject({
      method: "POST",
      url: "/api/v1/test-suites",
      headers,
      payload: { name: "Suite", description: "Current" }
    });
    expect(created.statusCode).toBe(201);
    const suite = parseJsonObject(created);
    const suiteId = jsonStringProperty(suite, "id");
    expect(suite).toMatchObject({ name: "Suite", caseCount: 0, revision: 0 });

    const listed = await server.inject({
      method: "GET",
      url: "/api/v1/test-suites?limit=1",
      headers: hostHeaders
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      items: [{ id: suiteId, name: "Suite" }],
      nextCursor: null
    });
    expect(JSON.stringify(listed.json())).not.toContain("suiteHash");

    const detail = await server.inject({
      method: "GET",
      url: `/api/v1/test-suites/${suiteId}`,
      headers: hostHeaders
    });
    expect(detail.statusCode).toBe(200);
    const detailBody = parseJsonObject(detail);
    expect(detailBody.id).toBe(suiteId);
    expect(typeof detailBody.suiteHash).toBe("string");

    const impact = await server.inject({
      method: "GET",
      url: `/api/v1/test-suites/${suiteId}/impact`,
      headers: hostHeaders
    });
    expect(impact.statusCode).toBe(200);
    expect(impact.json()).toEqual({ caseCount: 0, activeRunReference: false });

    const updated = await server.inject({
      method: "PUT",
      url: `/api/v1/test-suites/${suiteId}`,
      headers,
      payload: { name: "Renamed", description: "Updated", expectedRevision: 0 }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ name: "Renamed", revision: 1 });

    const stale = await server.inject({
      method: "DELETE",
      url: `/api/v1/test-suites/${suiteId}?expectedRevision=0`,
      headers: hostHeaders
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      error: {
        code: "RESOURCE_REVISION_CONFLICT",
        expectedRevision: 0,
        actualRevision: 1
      }
    });
  });

  it("通过 HTTP 完成 Case CRUD、复制、组合过滤与不透明 Cursor", async () => {
    const server = setup();
    const suiteResponse = await server.inject({
      method: "POST",
      url: "/api/v1/test-suites",
      headers,
      payload: { name: "Suite", description: "Current" }
    });
    const suiteId = jsonStringProperty(parseJsonObject(suiteResponse), "id");

    const created = await server.inject({
      method: "POST",
      url: `/api/v1/test-suites/${suiteId}/cases`,
      headers,
      payload: { expectedSuiteRevision: 0, definition: caseDefinition }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      case: { caseKey: "CASE-1", revision: 0 },
      suite: { revision: 1 }
    });

    const copied = await server.inject({
      method: "POST",
      url: `/api/v1/test-suites/${suiteId}/cases/CASE-1/copy`,
      headers,
      payload: { expectedSuiteRevision: 1, newCaseKey: "CASE-2" }
    });
    expect(copied.statusCode).toBe(201);

    const listed = await server.inject({
      method: "GET",
      url:
        `/api/v1/test-suites/${suiteId}/cases?limit=1` +
        "&businessModule=chat&businessModule=search&metric=quality",
      headers: hostHeaders
    });
    expect(listed.statusCode).toBe(200);
    const listedBody = parseJsonObject(listed);
    expect(listedBody).toMatchObject({ items: [{ caseKey: "CASE-1" }] });
    expect(jsonStringProperty(listedBody, "nextCursor")).toMatch(/^cur_v1_/);
    expect(JSON.stringify(listed.json())).not.toContain("request_body");

    const exported = await server.inject({
      method: "GET",
      url: `/api/v1/test-suites/${suiteId}/export`,
      headers: hostHeaders
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["content-type"]).toContain("application/json");
    expect(exported.json()).toMatchObject([
      { metadata: { case_id: "CASE-1" } },
      { metadata: { case_id: "CASE-2" } }
    ]);

    const detail = await server.inject({
      method: "GET",
      url: `/api/v1/test-suites/${suiteId}/cases/CASE-1`,
      headers
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ definition: caseDefinition });

    const deleted = await server.inject({
      method: "DELETE",
      url:
        `/api/v1/test-suites/${suiteId}/cases/CASE-1` +
        "?expectedSuiteRevision=2&expectedCaseRevision=0",
      headers: hostHeaders
    });
    expect(deleted.statusCode).toBe(204);
  });

  it("通过 HTTP 写入 Case 时不改写任意 JSON 值类型", async () => {
    const server = setup();
    const suiteResponse = await server.inject({
      method: "POST",
      url: "/api/v1/test-suites",
      headers,
      payload: { name: "Suite", description: "Current" }
    });
    const suiteId = jsonStringProperty(parseJsonObject(suiteResponse), "id");
    const exactDefinition = {
      ...caseDefinition,
      description: "Exact JSON case",
      vars: {
        task: "route",
        request_body: {
          uid: { __cortex_eval_int64: "2075490654049271808" },
          verbose: 0,
          task_history: [{ step_idx: 1 }]
        }
      },
      metadata: { ...caseDefinition.metadata, case_id: "CASE-EXACT" },
      assert: [
        {
          type: "is-json",
          metric: "exact user id",
          value: {
            properties: {
              parsed_output: {
                properties: {
                  tools: {
                    contains: {
                      properties: {
                        args_json: {
                          properties: { user_id: { const: "2075490654049271808" } }
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          weight: 1
        }
      ]
    };

    const created = await server.inject({
      method: "POST",
      url: `/api/v1/test-suites/${suiteId}/cases`,
      headers,
      payload: { expectedSuiteRevision: 0, definition: exactDefinition }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ case: { definition: exactDefinition } });

    const updatedDefinition = { ...exactDefinition, description: "Exact JSON case updated" };
    const updated = await server.inject({
      method: "PUT",
      url: `/api/v1/test-suites/${suiteId}/cases/CASE-EXACT`,
      headers,
      payload: {
        expectedSuiteRevision: 1,
        expectedCaseRevision: 0,
        definition: updatedDefinition
      }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ case: { definition: updatedDefinition } });
  });

  it("通过 HTTP 管理四类配置，并完成 Probe、引用与变量预览", async () => {
    const server = setup();
    const endpointDefinition = {
      contractVersion: "cortex.endpoint-config.v1",
      urlTemplate: "https://example.test/{{vars.task}}",
      method: "POST",
      headers: { Authorization: { kind: "ENV_SECRET", envKey: "ENDPOINT_TOKEN" } },
      bodySelector: "/request_body",
      timeoutMs: 1000,
      defaultConcurrency: 4
    };
    const endpoint = await server.inject({
      method: "POST",
      url: "/api/v1/endpoint-configs",
      headers,
      payload: { name: "Endpoint", definition: endpointDefinition }
    });
    expect(endpoint.statusCode).toBe(201);
    const endpointId = jsonStringProperty(parseJsonObject(endpoint), "id");
    expect(endpoint.body).toContain("ENDPOINT_TOKEN");
    expect(endpoint.body).not.toContain("expanded-secret");

    const endpointList = await server.inject({
      method: "GET",
      url: "/api/v1/endpoint-configs",
      headers: hostHeaders
    });
    expect(endpointList.statusCode).toBe(200);
    expect(endpointList.json()).toMatchObject({ items: [{ name: "Endpoint" }] });
    expect(endpointList.body).not.toContain("urlTemplate");

    const probe = await server.inject({
      method: "POST",
      url: "/api/v1/endpoint-configs/validate",
      headers,
      payload: { definition: endpointDefinition }
    });
    expect(probe.statusCode).toBe(200);
    expect(probe.json()).toEqual({ ok: true });

    const rubric = await server.inject({
      method: "POST",
      url: "/api/v1/llm-rubric-prompts",
      headers,
      payload: {
        name: "Quality",
        definition: {
          contractVersion: "cortex.prompt.v1",
          kind: "LLM_RUBRIC",
          promptKey: "quality",
          messages: [{ role: "SYSTEM", content: "Evaluate" }]
        }
      }
    });
    expect(rubric.statusCode).toBe(201);
    const rubricId = jsonStringProperty(parseJsonObject(rubric), "id");
    const rubricPreview = await server.inject({
      method: "POST",
      url: "/api/v1/llm-rubric-prompts/preview",
      headers,
      payload: {
        definition: {
          contractVersion: "cortex.prompt.v1",
          kind: "LLM_RUBRIC",
          promptKey: "quality",
          messages: [{ role: "SYSTEM", content: "Evaluate" }]
        }
      }
    });
    expect(rubricPreview.statusCode).toBe(200);
    expect(rubricPreview.json()).toEqual({
      promptKey: "quality",
      messages: [{ role: "SYSTEM", content: "Evaluate" }]
    });

    const suite = await server.inject({
      method: "POST",
      url: "/api/v1/test-suites",
      headers,
      payload: { name: "Referenced Suite", description: "Current" }
    });
    const suiteId = jsonStringProperty(parseJsonObject(suite), "id");
    const referencingCase = {
      ...caseDefinition,
      assert: [
        {
          type: "llm-rubric",
          metric: "quality",
          rubricPrompt: "prompt://quality",
          weight: 1
        }
      ]
    };
    expect(
      (
        await server.inject({
          method: "POST",
          url: `/api/v1/test-suites/${suiteId}/cases`,
          headers,
          payload: { expectedSuiteRevision: 0, definition: referencingCase }
        })
      ).statusCode
    ).toBe(201);
    const references = await server.inject({
      method: "GET",
      url: `/api/v1/llm-rubric-prompts/${rubricId}/references`,
      headers: hostHeaders
    });
    expect(references.statusCode).toBe(200);
    expect(references.json()).toEqual({ items: [{ suiteId, caseKey: "CASE-1" }] });

    const preview = await server.inject({
      method: "POST",
      url: "/api/v1/case-analysis-prompts/preview",
      headers,
      payload: {
        definition: {
          contractVersion: "cortex.prompt.v1",
          kind: "CASE_ANALYSIS",
          promptKey: "analysis",
          messages: [{ role: "USER", content: "{{case_definition}} {{run_context}}" }]
        }
      }
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toEqual({ variables: ["case_definition", "run_context"] });

    const deleted = await server.inject({
      method: "DELETE",
      url: `/api/v1/endpoint-configs/${endpointId}?expectedRevision=0`,
      headers: hostHeaders
    });
    expect(deleted.statusCode).toBe(204);
  });

  it("通过 multipart JSON 流整体替换 Cases，非法项不产生部分提交", async () => {
    const server = setup();
    const suiteResponse = await server.inject({
      method: "POST",
      url: "/api/v1/test-suites",
      headers,
      payload: { name: "Import Suite", description: "Current" }
    });
    const suiteId = jsonStringProperty(parseJsonObject(suiteResponse), "id");
    const boundary = "cortex-import-boundary";
    const multipart = (
      value: unknown,
      filename = "cases.json",
      mediaType = "application/json"
    ): Buffer =>
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
          `Content-Type: ${mediaType}\r\n\r\n` +
          `${typeof value === "string" ? value : JSON.stringify(value)}\r\n` +
          `--${boundary}--\r\n`
      );
    const preview = await server.inject({
      method: "POST",
      url: `/api/v1/test-suites/${suiteId}/import?expectedRevision=0&dryRun=true`,
      headers: { ...hostHeaders, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: multipart([caseDefinition])
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      count: 1,
      suite: { revision: 0, caseCount: 0 },
      preview: { added: 1, modified: 0, removed: 0, unchanged: 0, reordered: 0 }
    });
    const invalidPreview = await server.inject({
      method: "POST",
      url: `/api/v1/test-suites/${suiteId}/import?expectedRevision=0&dryRun=true`,
      headers: { ...hostHeaders, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: multipart([{ ...caseDefinition, assert: [{ type: "bad-name", metric: "x" }] }])
    });
    expect(invalidPreview.statusCode).toBe(422);
    expect(invalidPreview.json()).toMatchObject({
      error: { issueCode: "UNKNOWN_TYPE", path: "assert.0.type" }
    });
    const imported = await server.inject({
      method: "POST",
      url: `/api/v1/test-suites/${suiteId}/import?expectedRevision=0`,
      headers: {
        ...hostHeaders,
        "content-type": `multipart/form-data; boundary=${boundary}`
      },
      payload: multipart([{ ...caseDefinition, contractVersion: undefined }])
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.json()).toMatchObject({ count: 1, suite: { revision: 1 } });

    const jsonlImported = await server.inject({
      method: "POST",
      url: `/api/v1/test-suites/${suiteId}/import?expectedRevision=1`,
      headers: {
        ...hostHeaders,
        "content-type": `multipart/form-data; boundary=${boundary}`
      },
      payload: multipart(JSON.stringify(caseDefinition), "cases.jsonl", "application/x-ndjson")
    });
    expect(jsonlImported.statusCode).toBe(200);
    expect(jsonlImported.json()).toMatchObject({ count: 1, suite: { revision: 2 } });

    const invalid = await server.inject({
      method: "POST",
      url: `/api/v1/test-suites/${suiteId}/import?expectedRevision=2`,
      headers: {
        ...hostHeaders,
        "content-type": `multipart/form-data; boundary=${boundary}`
      },
      payload: multipart([{ ...caseDefinition, threshold: 2 }])
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json()).toMatchObject({
      error: { code: "CASE_IMPORT_ITEM_INVALID", index: 0, caseKey: "CASE-1", path: "threshold" }
    });
    const cases = await server.inject({
      method: "GET",
      url: `/api/v1/test-suites/${suiteId}/cases`,
      headers: hostHeaders
    });
    expect(cases.json()).toMatchObject({ items: [{ caseKey: "CASE-1" }] });
  });
});
