import { Readable } from "node:stream";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildLocalServer,
  type LocalApiHandler,
  type LocalResourceHandlers
} from "../src/local-server.ts";
import { jsonObjectProperty, parseJsonObject } from "./test-support/json-test-values.ts";

const ID = "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeeee";
const request = {
  suiteId: ID,
  endpointConfigId: "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeee1",
  evaluatorConfigId: "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeee2",
  analyzerConfigId: "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeee3",
  analysisPromptId: "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeee4"
};

const resources: LocalResourceHandlers = {
  listTestSuites: (): Promise<{ readonly statusCode: 200; readonly body: object }> =>
    Promise.resolve({ statusCode: 200, body: { items: [], nextCursor: null } })
};

const exportHandler: LocalApiHandler = () =>
  Promise.resolve({
    statusCode: 200,
    headers: { "content-type": "application/x-ndjson; charset=utf-8" },
    body: Readable.from([`${JSON.stringify({ type: "PACKAGE_END", packageId: ID })}\n`])
  });

describe("P7 Work Package export API", () => {
  const server = buildLocalServer({
    requestIdGenerator: { nextId: (): string => ID },
    resourceHandlers: resources,
    workPackageExportHandler: exportHandler
  });

  beforeAll(async () => server.ready());
  afterAll(async () => server.close());

  it("registers only the closed NDJSON export capability", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/work-packages/export",
      headers: { host: "127.0.0.1:4310" },
      payload: request
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/x-ndjson");
    expect(response.body).toContain('"type":"PACKAGE_END"');
  });

  it("rejects an unknown request field before invoking the capability", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/work-packages/export",
      headers: { host: "127.0.0.1:4310" },
      payload: { ...request, resultImport: true }
    });
    expect(response.statusCode).toBe(400);
    expect(parseJsonObject(response)).toMatchObject({
      error: { code: "VALIDATION_FAILED" }
    });
  });

  it("publishes export in OpenAPI without result import or Web capabilities", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/api/v1/openapi.json",
      headers: { host: "127.0.0.1:4310" }
    });
    const paths = jsonObjectProperty(parseJsonObject(response), "paths");
    expect(paths).toHaveProperty("/api/v1/work-packages/export");
    expect(
      Object.keys(paths).some((path) => /result-import|work-packages\/import|reports/i.test(path))
    ).toBe(false);
    const operation = jsonObjectProperty(
      jsonObjectProperty(paths, "/api/v1/work-packages/export"),
      "post"
    );
    expect(operation.operationId).toBe("exportWorkPackage");
    const responses = jsonObjectProperty(operation, "responses");
    expect(jsonObjectProperty(jsonObjectProperty(responses, "200"), "content")).toHaveProperty(
      "application/x-ndjson"
    );
    expect(jsonObjectProperty(jsonObjectProperty(responses, "400"), "content")).toHaveProperty(
      "application/json"
    );
  });
});
