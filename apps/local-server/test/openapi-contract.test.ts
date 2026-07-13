import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildLocalServer, type LocalResourceHandlers } from "../src/local-server.ts";
import {
  jsonObjectProperty,
  parseJsonObject,
  requireJsonObject
} from "./test-support/json-test-values.ts";

const success = (): Promise<{ readonly statusCode: 200; readonly body: object }> =>
  Promise.resolve({ statusCode: 200, body: {} });
const handlers: LocalResourceHandlers = {
  listTestSuites: success,
  createTestSuite: success,
  getTestSuite: success,
  updateTestSuite: success,
  deleteTestSuite: success,
  getTestSuiteImpact: success,
  listCases: success,
  createCase: success,
  getCase: success,
  updateCase: success,
  deleteCase: success,
  copyCase: success,
  exportCases: success,
  importCases: success,
  listConfigurations: () => success(),
  createConfiguration: () => success(),
  getConfiguration: () => success(),
  updateConfiguration: () => success(),
  deleteConfiguration: () => success(),
  validateEndpoint: success,
  validateLlm: success,
  listRubricPromptReferences: success,
  previewRubricPrompt: success,
  previewAnalysisPrompt: success
};

describe("P3 OpenAPI contract", () => {
  const server = buildLocalServer({
    requestIdGenerator: { nextId: () => "018f0c8e-9f79-7abc-8def-0123456789ab" },
    resourceHandlers: handlers
  });

  beforeAll(async () => server.ready());
  afterAll(async () => server.close());

  it("路径严格等于 P3 资源能力 allowlist", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/api/v1/openapi.json",
      headers: { host: "127.0.0.1:4310" }
    });
    const document = parseJsonObject(response);
    const paths = jsonObjectProperty(document, "paths");
    expect(Object.keys(paths).sort()).toEqual(
      [
        "/api/v1/case-analysis-prompts",
        "/api/v1/case-analysis-prompts/preview",
        "/api/v1/case-analysis-prompts/{configurationId}",
        "/api/v1/endpoint-configs",
        "/api/v1/endpoint-configs/validate",
        "/api/v1/endpoint-configs/{configurationId}",
        "/api/v1/llm-configs",
        "/api/v1/llm-configs/validate",
        "/api/v1/llm-configs/{configurationId}",
        "/api/v1/llm-rubric-prompts",
        "/api/v1/llm-rubric-prompts/preview",
        "/api/v1/llm-rubric-prompts/{configurationId}",
        "/api/v1/llm-rubric-prompts/{configurationId}/references",
        "/api/v1/test-suites",
        "/api/v1/test-suites/{suiteId}",
        "/api/v1/test-suites/{suiteId}/cases",
        "/api/v1/test-suites/{suiteId}/cases/{caseKey}",
        "/api/v1/test-suites/{suiteId}/cases/{caseKey}/copy",
        "/api/v1/test-suites/{suiteId}/export",
        "/api/v1/test-suites/{suiteId}/impact",
        "/api/v1/test-suites/{suiteId}/import"
      ].sort()
    );
    expect(JSON.stringify(document)).not.toMatch(/\/runs|execution|report|event-stream/i);
  });

  it("每个操作都有响应 Schema，严格写 DTO 拒绝未知键", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/api/v1/openapi.json",
      headers: { host: "127.0.0.1:4310" }
    });
    const document = parseJsonObject(response);
    const paths = jsonObjectProperty(document, "paths");
    for (const dirtyPath of Object.values(paths)) {
      const path = requireJsonObject(dirtyPath);
      for (const dirtyOperation of Object.values(path)) {
        const operation = requireJsonObject(dirtyOperation);
        expect(operation.operationId).toBeTruthy();
        const responseStatuses = Object.keys(jsonObjectProperty(operation, "responses"));
        expect(responseStatuses).not.toHaveLength(0);
        expect(responseStatuses).toContain("403");
      }
    }
    const suitesPost = jsonObjectProperty(jsonObjectProperty(paths, "/api/v1/test-suites"), "post");
    const suitesSchema = jsonObjectProperty(
      jsonObjectProperty(
        jsonObjectProperty(jsonObjectProperty(suitesPost, "requestBody"), "content"),
        "application/json"
      ),
      "schema"
    );
    expect(suitesSchema.additionalProperties).toBe(false);

    const importPost = jsonObjectProperty(
      jsonObjectProperty(paths, "/api/v1/test-suites/{suiteId}/import"),
      "post"
    );
    const importContent = jsonObjectProperty(
      jsonObjectProperty(importPost, "requestBody"),
      "content"
    );
    expect(importContent["multipart/form-data"]).toBeDefined();

    const suiteListResponse = jsonObjectProperty(
      jsonObjectProperty(suitesPost, "responses"),
      "201"
    );
    const suiteListContent = jsonObjectProperty(suiteListResponse, "content");
    const suiteListSchema = jsonObjectProperty(
      jsonObjectProperty(suiteListContent, "application/json"),
      "schema"
    );
    expect(suiteListSchema.additionalProperties).toBe(false);
  });

  it("只为真正的资源列表暴露 Cursor 参数，引用查询不伪装成分页列表", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/api/v1/openapi.json",
      headers: { host: "127.0.0.1:4310" }
    });
    const paths = jsonObjectProperty(parseJsonObject(response), "paths");
    const referenceGet = jsonObjectProperty(
      jsonObjectProperty(paths, "/api/v1/llm-rubric-prompts/{configurationId}/references"),
      "get"
    );
    expect(JSON.stringify(referenceGet)).not.toMatch(/"name":"(?:limit|cursor)"/);
  });

  it("声明 Probe 与 multipart 导入的全部真实状态响应", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/api/v1/openapi.json",
      headers: { host: "127.0.0.1:4310" }
    });
    const paths = jsonObjectProperty(parseJsonObject(response), "paths");
    const probe = jsonObjectProperty(
      jsonObjectProperty(paths, "/api/v1/endpoint-configs/validate"),
      "post"
    );
    expect(Object.keys(jsonObjectProperty(probe, "responses"))).toContain("502");

    const importOperation = jsonObjectProperty(
      jsonObjectProperty(paths, "/api/v1/test-suites/{suiteId}/import"),
      "post"
    );
    expect(Object.keys(jsonObjectProperty(importOperation, "responses"))).toEqual(
      expect.arrayContaining(["200", "400", "404", "409", "413", "422", "499", "500"])
    );
  });
});
