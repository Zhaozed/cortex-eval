import { Readable } from "node:stream";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildLocalServer,
  type LocalApiHandler,
  type LocalResourceHandlers
} from "../src/local-server.ts";
import { jsonObjectProperty, parseJsonObject } from "./test-support/json-test-values.ts";

const ID = "018f1e2d-3c4b-7abc-8def-0123456789ab";
const resources: LocalResourceHandlers = {
  listTestSuites: (): Promise<{ readonly statusCode: 200; readonly body: object }> =>
    Promise.resolve({ statusCode: 200, body: { items: [], nextCursor: null } })
};
const canonicalExportHandler: LocalApiHandler = () =>
  Promise.resolve({
    statusCode: 200,
    headers: { "content-type": "application/x-ndjson; charset=utf-8" },
    body: Readable.from([`${JSON.stringify({ type: "EXPORT_END", exportId: ID })}\n`])
  });

describe("Canonical Export API 注册", () => {
  const server = buildLocalServer({
    requestIdGenerator: { nextId: (): string => ID },
    resourceHandlers: resources,
    canonicalExportHandler
  });

  beforeAll(async () => server.ready());
  afterAll(async () => server.close());

  it("只在能力闭环后注册严格请求与 NDJSON 响应", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/data/export",
      headers: { host: "127.0.0.1:4310" },
      payload: {}
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/x-ndjson");
    expect(response.body).toContain('"type":"EXPORT_END"');

    const rejected = await server.inject({
      method: "POST",
      url: "/api/v1/data/export",
      headers: { host: "127.0.0.1:4310" },
      payload: { unknown: true }
    });
    expect(rejected.statusCode).toBe(400);
  });

  it("OpenAPI 声明独立 operation 和媒体类型", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/api/v1/openapi.json",
      headers: { host: "127.0.0.1:4310" }
    });
    const paths = jsonObjectProperty(parseJsonObject(response), "paths");
    const operation = jsonObjectProperty(jsonObjectProperty(paths, "/api/v1/data/export"), "post");
    expect(operation.operationId).toBe("exportCanonicalData");
    const responses = jsonObjectProperty(operation, "responses");
    expect(jsonObjectProperty(jsonObjectProperty(responses, "200"), "content")).toHaveProperty(
      "application/x-ndjson"
    );
  });
});
