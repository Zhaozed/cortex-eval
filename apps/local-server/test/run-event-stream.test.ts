import type { LocalRunHandlers } from "../src/application-run-handlers.ts";
import { buildLocalServer } from "../src/local-server.ts";
import type { LocalApiHandler, LocalApiHandlerResponse } from "../src/local-server.ts";
import type { FastifyInstance } from "fastify";
import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

const REQUEST_ID = "01900000-0000-7000-8000-000000000999";
const RUN_ID = "01900000-0000-7000-8000-000000000001";
const NOW = "2026-07-13T00:00:00.000Z";
const headers = { host: "127.0.0.1:4310" };

/** Mutable fields used to build consecutive valid progress snapshots. */
interface ProgressOverrides {
  /** Current lifecycle status. */
  readonly status?: "READY" | "RUNNING" | "FAILED" | "CANCELLED" | "INTERRUPTED";
  /** Current pipeline stage. */
  readonly stage?: "REST" | "EVALUATION" | "REPORT" | "DONE";
  /** Durable Revision and event sequence. */
  readonly lockRevision?: number;
  /** Durable cancellation request time. */
  readonly cancelRequestedAt?: string | null;
  /** Durable REST counters. */
  readonly rest?: Readonly<Record<string, number>>;
  /** Durable Evaluation counters. */
  readonly evaluation?: Readonly<Record<string, number>>;
}

// Build one schema-valid small progress response.
function progress(overrides: ProgressOverrides = {}): Readonly<Record<string, unknown>> {
  return {
    runId: RUN_ID,
    status: "READY",
    stage: "REST",
    lockRevision: 0,
    cancelRequestedAt: null,
    rest: { total: 1, completed: 0, succeeded: 0, error: 0 },
    evaluation: {
      total: 1,
      completed: 0,
      passed: 0,
      failed: 0,
      error: 0,
      notEvaluated: 0
    },
    updatedAt: NOW,
    ...overrides
  };
}

// Return one inert handler for Run routes not exercised by the stream test.
function inert(statusCode = 200): LocalApiHandler {
  return (): Promise<LocalApiHandlerResponse> => Promise.resolve({ statusCode, body: {} });
}

// Assemble the complete closed Run handler surface around one progress reader.
function runHandlers(getRunProgress: LocalApiHandler): LocalRunHandlers {
  return {
    preflightRun: inert(),
    createRun: inert(201),
    listRuns: inert(),
    getRun: inert(),
    createRunRerun: inert(201),
    listRunCases: inert(),
    getRunCase: inert(),
    listRunEvaluations: inert(),
    getRunReport: inert(),
    listRunReportCases: inert(),
    getRunReportCase: inert(),
    exportRunReport: inert(),
    importExecutionReport: inert(201),
    importExecutionAnalysis: inert(201),
    startCaseAnalysis: inert(),
    getCurrentCaseAnalysis: inert(),
    rejectAnalysisProposal: inert(),
    acceptAnalysisProposal: inert(),
    editAndAcceptAnalysisProposal: inert(),
    startRun: inert(202),
    cancelRun: inert(202),
    deleteRun: inert(204),
    getRunProgress
  };
}

describe("P6 Run 有限 SSE", () => {
  const servers: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(async (server) => server.close()));
  });

  it("先返回 Snapshot，再从连续事实推导全部闭合事件并在读取失败时结束", async () => {
    const responses: LocalApiHandlerResponse[] = [
      { statusCode: 200, body: progress() },
      { statusCode: 200, body: progress({ status: "RUNNING", lockRevision: 1 }) },
      { statusCode: 200, body: progress({ status: "RUNNING", lockRevision: 1 }) },
      {
        statusCode: 200,
        body: progress({ status: "RUNNING", lockRevision: 2, cancelRequestedAt: NOW })
      },
      {
        statusCode: 200,
        body: progress({ stage: "EVALUATION", lockRevision: 3, cancelRequestedAt: NOW })
      },
      {
        statusCode: 200,
        body: progress({ status: "RUNNING", stage: "EVALUATION", lockRevision: 4 })
      },
      { statusCode: 200, body: progress({ stage: "REPORT", lockRevision: 6 }) },
      { statusCode: 200, body: progress({ status: "CANCELLED", stage: "DONE", lockRevision: 7 }) },
      { statusCode: 200, body: progress({ status: "FAILED", stage: "DONE", lockRevision: 8 }) },
      {
        statusCode: 200,
        body: progress({ status: "INTERRUPTED", stage: "DONE", lockRevision: 9 })
      },
      { statusCode: 200, body: progress({ status: "RUNNING", lockRevision: 10 }) },
      { statusCode: 200, body: progress({ status: "RUNNING", lockRevision: 11 }) },
      { statusCode: 404, body: {} }
    ];
    const getRunProgress = vi.fn<LocalApiHandler>().mockImplementation(() => {
      const response = responses.shift();
      if (response === undefined) throw new Error("TEST_STREAM_RESPONSE_MISSING");
      return Promise.resolve(response);
    });
    const server = buildLocalServer({
      requestIdGenerator: { nextId: (): string => REQUEST_ID },
      resourceHandlers: {
        listTestSuites: () =>
          Promise.resolve({ statusCode: 200, body: { items: [], nextCursor: null } })
      },
      runHandlers: runHandlers(getRunProgress)
    });
    servers.push(server);

    const response = await server.inject({
      method: "GET",
      url: `/api/v1/runs/${RUN_ID}/events`,
      headers
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("retry: 1000");
    expect(response.body).toContain('"type":"SNAPSHOT"');
    for (const event of [
      "REST_STARTED",
      "CANCEL_REQUESTED",
      "REST_COMPLETED",
      "EVALUATION_STARTED",
      "EVALUATION_COMPLETED",
      "RUN_CANCELLED",
      "RUN_FAILED",
      "RUN_INTERRUPTED",
      "REST_PROGRESS"
    ]) {
      expect(response.body).toContain(`"event":"${event}"`);
    }
    expect(response.body.match(/"sequence":1,/g)).toHaveLength(1);
    expect(response.body).not.toContain('"event":"EVALUATION_PROGRESS"');
    expect(getRunProgress).toHaveBeenCalledTimes(13);
  });

  it("一次轮询跨过多个阶段时按流水线顺序补发所有可证明事件", async () => {
    const getRunProgress = vi
      .fn<LocalApiHandler>()
      .mockResolvedValueOnce({ statusCode: 200, body: progress() })
      .mockResolvedValueOnce({
        statusCode: 200,
        body: progress({
          stage: "REPORT",
          lockRevision: 5,
          rest: { total: 1, completed: 1, succeeded: 1, error: 0 }
        })
      })
      .mockResolvedValueOnce({ statusCode: 404, body: {} });
    const server = buildLocalServer({
      requestIdGenerator: { nextId: (): string => REQUEST_ID },
      resourceHandlers: {
        listTestSuites: () =>
          Promise.resolve({ statusCode: 200, body: { items: [], nextCursor: null } })
      },
      runHandlers: runHandlers(getRunProgress)
    });
    servers.push(server);

    const response = await server.inject({
      method: "GET",
      url: `/api/v1/runs/${RUN_ID}/events`,
      headers
    });
    const ordered = [
      "REST_STARTED",
      "REST_PROGRESS",
      "REST_COMPLETED",
      "EVALUATION_STARTED",
      "EVALUATION_COMPLETED"
    ];
    const positions = ordered.map((event) => response.body.indexOf(`"event":"${event}"`));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  it("初始参数错误在 Hijack 前保持普通 JSON 400", async () => {
    const getRunProgress: LocalApiHandler = () =>
      Promise.resolve({
        statusCode: 400,
        body: {
          error: {
            code: "VALIDATION_FAILED",
            message: "输入不符合当前契约。",
            requestId: REQUEST_ID,
            path: "request"
          }
        }
      });
    const server = buildLocalServer({
      requestIdGenerator: { nextId: (): string => REQUEST_ID },
      resourceHandlers: {
        listTestSuites: () =>
          Promise.resolve({ statusCode: 200, body: { items: [], nextCursor: null } })
      },
      runHandlers: runHandlers(getRunProgress)
    });
    servers.push(server);

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/runs/not-a-uuid/events",
      headers
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
  });

  it("初始读取在 Hijack 前保留 403、404 与 500 JSON 状态", async () => {
    const cases = [
      { handlerStatusCode: 403, expectedStatusCode: 403, code: "HOST_NOT_ALLOWED" },
      { handlerStatusCode: 404, expectedStatusCode: 404, code: "RUN_NOT_FOUND" },
      { handlerStatusCode: 500, expectedStatusCode: 500, code: "INTERNAL_ERROR" },
      { handlerStatusCode: 418, expectedStatusCode: 500, code: "INTERNAL_ERROR" }
    ] as const;
    for (const item of cases) {
      const getRunProgress: LocalApiHandler = () =>
        Promise.resolve({
          statusCode: item.handlerStatusCode,
          body: { error: { code: item.code, message: "安全错误", requestId: REQUEST_ID } }
        });
      const server = buildLocalServer({
        requestIdGenerator: { nextId: (): string => REQUEST_ID },
        resourceHandlers: {
          listTestSuites: () =>
            Promise.resolve({ statusCode: 200, body: { items: [], nextCursor: null } })
        },
        runHandlers: runHandlers(getRunProgress)
      });
      servers.push(server);

      const response = await server.inject({
        method: "GET",
        url: `/api/v1/runs/${RUN_ID}/events`,
        headers
      });
      expect(response.statusCode).toBe(item.expectedStatusCode);
      expect(response.headers["content-type"]).toContain("application/json");
    }
  });

  it("开流后的进度读取拒绝仍结束响应，不遗留悬挂连接", async () => {
    const getRunProgress = vi
      .fn<LocalApiHandler>()
      .mockResolvedValueOnce({ statusCode: 200, body: progress() })
      .mockRejectedValueOnce(new Error("PROGRESS_READ_FAILED"));
    const server = buildLocalServer({
      requestIdGenerator: { nextId: (): string => REQUEST_ID },
      resourceHandlers: {
        listTestSuites: () =>
          Promise.resolve({ statusCode: 200, body: { items: [], nextCursor: null } })
      },
      runHandlers: runHandlers(getRunProgress)
    });
    servers.push(server);

    const result = await Promise.race([
      server
        .inject({ method: "GET", url: `/api/v1/runs/${RUN_ID}/events`, headers })
        .then((response) => ({ kind: "response" as const, response })),
      new Promise<{ readonly kind: "timeout" }>((resolve) => {
        setTimeout(() => resolve({ kind: "timeout" }), 750);
      })
    ]);

    expect(result.kind).toBe("response");
    if (result.kind !== "response") return;
    expect(result.response.statusCode).toBe(200);
    expect(result.response.body).toContain('"type":"SNAPSHOT"');
    expect(getRunProgress).toHaveBeenCalledTimes(2);
  });

  it("响应写侧异步错误立即停止轮询并关闭连接", async () => {
    const getRunProgress = vi
      .fn<LocalApiHandler>()
      .mockResolvedValue({ statusCode: 200, body: progress() });
    const server = buildLocalServer({
      requestIdGenerator: { nextId: (): string => REQUEST_ID },
      resourceHandlers: {
        listTestSuites: () =>
          Promise.resolve({ statusCode: 200, body: { items: [], nextCursor: null } })
      },
      runHandlers: runHandlers(getRunProgress)
    });
    const rawResponse: { current: ServerResponse | null } = { current: null };
    server.addHook("onRequest", (request, reply, done) => {
      if (request.url.endsWith("/events")) rawResponse.current = reply.raw;
      done();
    });
    servers.push(server);

    const injection = server.inject({
      method: "GET",
      url: `/api/v1/runs/${RUN_ID}/events`,
      headers
    });
    await vi.waitFor(() => {
      expect(rawResponse.current).not.toBeNull();
      expect(getRunProgress).toHaveBeenCalledTimes(1);
    });
    let unhandled: unknown;
    try {
      rawResponse.current?.emit("error", new Error("STREAM_WRITE_FAILED"));
    } catch (error) {
      unhandled = error;
    }
    const result = await Promise.race([
      injection.then(
        (response) => ({ kind: "response" as const, response }),
        () => ({ kind: "closed" as const })
      ),
      new Promise<{ readonly kind: "timeout" }>((resolve) => {
        setTimeout(() => resolve({ kind: "timeout" }), 750);
      })
    ]);

    expect(unhandled).toBeUndefined();
    expect(result.kind).not.toBe("timeout");
    expect(getRunProgress).toHaveBeenCalledTimes(1);
  });
});
