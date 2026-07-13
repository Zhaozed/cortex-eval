import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildLocalServer } from "../src/local-server.ts";
import { jsonObjectProperty, parseJsonObject } from "./test-support/json-test-values.ts";

const generatedRequestId = "018f0c8e-9f79-7abc-8def-0123456789ab";

describe("P3 Local Server 安全入口", () => {
  const servers: { close(): Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(async (server) => server.close()));
  });

  function server(): FastifyInstance {
    const instance = buildLocalServer({
      requestIdGenerator: { nextId: () => generatedRequestId },
      resourceHandlers: {
        listTestSuites: () =>
          Promise.resolve({ statusCode: 200, body: { items: [], nextCursor: null } }),
        createTestSuite: () => Promise.resolve({ statusCode: 201, body: {} })
      }
    });
    servers.push(instance);
    return instance;
  }

  it("拒绝不可信原始 Host，且错误不泄露堆栈、SQL 或来访 Request ID", async () => {
    const response = await server().inject({
      method: "GET",
      url: "/api/v1/test-suites",
      headers: {
        host: "attacker.example:4310",
        "x-request-id": "caller-controlled"
      }
    });

    expect(response.statusCode).toBe(403);
    expect(response.headers["x-request-id"]).toBe(generatedRequestId);
    const error = jsonObjectProperty(parseJsonObject(response), "error");
    expect(error.code).toBe("HOST_NOT_ALLOWED");
    expect(typeof error.message).toBe("string");
    expect(error.requestId).toBe(generatedRequestId);
    expect(response.body).not.toMatch(/stack|select |sqlite|caller-controlled/i);
  });

  it("允许受信任 Host，拒绝跨源状态修改，同时允许无 Origin 的本地 CLI", async () => {
    const valid = await server().inject({
      method: "GET",
      url: "/api/v1/test-suites",
      headers: { host: "127.0.0.1:4310" }
    });
    expect(valid.statusCode).toBe(200);

    const crossOrigin = await server().inject({
      method: "POST",
      url: "/api/v1/test-suites",
      headers: {
        host: "127.0.0.1:4310",
        origin: "https://attacker.example",
        "content-type": "application/json"
      },
      payload: { name: "Suite", description: "Description" }
    });
    expect(crossOrigin.statusCode).toBe(403);
    expect(crossOrigin.json()).toMatchObject({ error: { code: "ORIGIN_NOT_ALLOWED" } });
  });

  it("未注入 P5 Run 处理器时 OpenAPI 不注册 Run、Execution、Report 或 SSE 路径", async () => {
    const response = await server().inject({
      method: "GET",
      url: "/api/v1/openapi.json",
      headers: { host: "localhost:4310" }
    });
    expect(response.statusCode).toBe(200);
    const document = parseJsonObject(response);
    const paths = jsonObjectProperty(document, "paths");
    expect(Object.keys(paths)).toContain("/api/v1/test-suites");
    expect(Object.keys(paths)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/\/runs|execution|report|event-stream/i)])
    );

    const future = await server().inject({
      method: "GET",
      url: "/api/v1/runs",
      headers: { host: "localhost:4310" }
    });
    expect(future.statusCode).toBe(404);
  });

  it("畸形 JSON 返回 400，Route 正文超限返回 413，不误报内部错误", async () => {
    const malformed = await server().inject({
      method: "POST",
      url: "/api/v1/test-suites",
      headers: {
        host: "127.0.0.1:4310",
        "content-type": "application/json"
      },
      payload: "{"
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({
      error: { code: "VALIDATION_FAILED", path: "body" }
    });

    const oversized = await server().inject({
      method: "POST",
      url: "/api/v1/test-suites",
      headers: {
        host: "127.0.0.1:4310",
        "content-type": "application/json"
      },
      payload: { name: "Suite", description: "x".repeat(70 * 1024) }
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json()).toMatchObject({ error: { code: "REQUEST_BODY_TOO_LARGE" } });
  });

  it("SQLite Busy 重试耗尽映射为稳定存储冲突", async () => {
    const conflict = Object.assign(new Error("private sqlite detail"), {
      code: "STORAGE_TRANSACTION_CONFLICT"
    });
    const instance = buildLocalServer({
      requestIdGenerator: { nextId: () => generatedRequestId },
      resourceHandlers: { listTestSuites: () => Promise.reject(conflict) }
    });
    servers.push(instance);
    const response = await instance.inject({
      method: "GET",
      url: "/api/v1/test-suites",
      headers: { host: "127.0.0.1:4310" }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: "STORAGE_TRANSACTION_CONFLICT", requestId: generatedRequestId }
    });
    expect(response.body).not.toContain("private sqlite detail");
  });

  it("同源静态壳可用且不提前暴露资源 Web 能力", async () => {
    const response = await server().inject({
      method: "GET",
      url: "/",
      headers: { host: "127.0.0.1:4310" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.body).toContain("本地服务已启动");
    expect(response.body).not.toMatch(/测试集管理|新建运行|Dashboard/i);
  });

  it("关闭服务先取消活动请求，再等待 Fastify 收口", async () => {
    let started: (() => void) | undefined;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    const instance = buildLocalServer({
      requestIdGenerator: { nextId: () => generatedRequestId },
      resourceHandlers: {
        listTestSuites: async (input) => {
          observedSignal = input.signal;
          started?.();
          await new Promise<void>((resolve) =>
            input.signal.addEventListener("abort", () => resolve(), { once: true })
          );
          return { statusCode: 499, body: { cancelled: true } };
        }
      }
    });
    servers.push(instance);
    const pending = instance.inject({
      method: "GET",
      url: "/api/v1/test-suites",
      headers: { host: "127.0.0.1:4310" }
    });
    await didStart;
    await expect(instance.close()).resolves.toBeUndefined();
    expect(observedSignal?.aborted).toBe(true);
    expect((await pending).statusCode).toBe(499);
  });
});
