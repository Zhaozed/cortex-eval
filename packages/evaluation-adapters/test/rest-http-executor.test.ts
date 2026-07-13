import { once } from "node:events";
import type { IncomingMessage } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import type {
  RestCaseExecutionResult,
  RestExecutionInput
} from "@cortex-eval/application/src/features/runs/run-rest-models.ts";

import { FetchRestExecutor, MAX_REST_RESPONSE_BYTES } from "../src/fetch-rest-executor.ts";
import { startRestStub, type RestStubServer } from "../test-support/rest-stub-server.ts";

const opened: RestStubServer[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((server) => server.close()));
});

const testCase = {
  caseKey: "case-1",
  ordinal: 0,
  definitionHash: "a".repeat(64),
  definition: {
    caseKey: "case-1",
    description: "case",
    threshold: 1,
    task: "route",
    requestBody: { input: "hello" },
    metadata: {
      requestId: "req-1",
      taskId: "task-1",
      businessModule: "module",
      scenarioTag: "scenario"
    },
    assertions: [{ type: "equals", metric: "quality", weight: 1 }]
  }
} as const;

function endpoint(origin: string, timeoutMs = 1_000): RestExecutionInput["endpoint"] {
  return {
    urlTemplate: `${origin}/run/{{vars.task}}`,
    method: "POST" as const,
    headers: { "Content-Type": { kind: "LITERAL" as const, value: "application/json" } },
    bodySelector: "/request_body",
    timeoutMs,
    defaultConcurrency: 4
  };
}

function providerOutputBytes(size: number): Uint8Array {
  const prefix = '{"ok":true,"task_name":"task","resolved_config":{},"parsed_output":{"pad":"';
  const suffix = '"}}';
  const fixed = new TextEncoder().encode(`${prefix}${suffix}`).byteLength;
  if (size < fixed) throw new Error("TEST_RESPONSE_SIZE_INVALID");
  return new TextEncoder().encode(`${prefix}${"x".repeat(size - fixed)}${suffix}`);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  await once(request, "end");
  return Buffer.concat(chunks).toString("utf8");
}

describe("Fetch REST Executor", () => {
  it("结果持久化失败后停止领取 Case，等待其他 Worker 收口再拒绝", async () => {
    let resolveIgnoredAbort: ((response: Response) => void) | undefined;
    const ignoredAbort = new Promise<Response>((resolve) => {
      resolveIgnoredAbort = resolve;
    });
    let fetchCount = 0;
    const fetcher = ((): Promise<Response> => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return Promise.resolve(
          new Response('{"ok":false,"err_msg":"first"}', {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        );
      }
      return ignoredAbort;
    }) as typeof fetch;
    const onResultCalls: RestCaseExecutionResult[] = [];
    let settled = false;
    const execution = new FetchRestExecutor({
      readSecret: (): undefined => undefined,
      fetch: fetcher
    })
      .execute({
        cases: [
          testCase,
          { ...testCase, caseKey: "case-2", ordinal: 1 },
          { ...testCase, caseKey: "case-3", ordinal: 2 }
        ],
        endpoint: endpoint("http://127.0.0.1:4319"),
        concurrency: 2,
        signal: new AbortController().signal,
        onResult: (result) => {
          onResultCalls.push(result);
          return Promise.reject(new Error("RESULT_PERSISTENCE_FAILED"));
        }
      })
      .finally(() => {
        settled = true;
      });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(resolveIgnoredAbort).toBeDefined();
    resolveIgnoredAbort?.(
      new Response('{"ok":false,"err_msg":"ignored abort"}', {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    await expect(execution).rejects.toThrow("RESULT_PERSISTENCE_FAILED");
    expect(fetchCount).toBe(2);
    expect(onResultCalls).toHaveLength(1);
  });

  it.each([
    [MAX_REST_RESPONSE_BYTES - 1, "SUCCEEDED"],
    [MAX_REST_RESPONSE_BYTES, "SUCCEEDED"],
    [MAX_REST_RESPONSE_BYTES + 1, "ERROR"]
  ] as const)("响应 %i 字节得到 %s", async (size, expectedStatus) => {
    const stub = await startRestStub((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(providerOutputBytes(size));
    });
    opened.push(stub);
    const results: unknown[] = [];
    await new FetchRestExecutor({ readSecret: (): undefined => undefined }).execute({
      cases: [testCase],
      endpoint: endpoint(stub.origin),
      concurrency: 1,
      signal: new AbortController().signal,
      onResult: (result) => {
        results.push(result);
        return Promise.resolve();
      }
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(expect.objectContaining({ status: expectedStatus }));
    if (expectedStatus === "ERROR") {
      expect(results[0]).toEqual(
        expect.objectContaining({ errorType: "PROVIDER_OUTPUT_INVALID", providerOutput: undefined })
      );
    }
  });

  it("合法 ok=false 仍成功，非法 JSON 与联合结构分别归类", async () => {
    const bodies = [
      '{"ok":false,"err_msg":"business"}',
      "not-json",
      '{"ok":true,"task_name":"","resolved_config":{},"parsed_output":{}}'
    ];
    const stub = await startRestStub((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(bodies.shift());
    });
    opened.push(stub);
    const results: RestCaseExecutionResult[] = [];
    await new FetchRestExecutor({ readSecret: (): undefined => undefined }).execute({
      cases: [
        testCase,
        { ...testCase, caseKey: "case-2", ordinal: 1 },
        { ...testCase, caseKey: "case-3", ordinal: 2 }
      ],
      endpoint: endpoint(stub.origin),
      concurrency: 1,
      signal: new AbortController().signal,
      onResult: (result) => {
        results.push(result);
        return Promise.resolve();
      }
    });
    expect(results.map((result) => [result.status, result.errorType ?? null])).toEqual([
      ["SUCCEEDED", null],
      ["ERROR", "RESPONSE_PARSE"],
      ["ERROR", "PROVIDER_OUTPUT_INVALID"]
    ]);
  });

  it("非 2xx 和 Redirect 始终归 HTTP_STATUS且不读取超大正文", async () => {
    const statuses = [302, 503];
    const stub = await startRestStub((_request, response) => {
      const status = statuses.shift() ?? 500;
      response.writeHead(status, { location: "/redirect" });
      response.end(Buffer.alloc(MAX_REST_RESPONSE_BYTES + 1, 120));
    });
    opened.push(stub);
    const results: RestCaseExecutionResult[] = [];
    await new FetchRestExecutor({ readSecret: (): undefined => undefined }).execute({
      cases: [testCase, { ...testCase, caseKey: "case-2", ordinal: 1 }],
      endpoint: endpoint(stub.origin),
      concurrency: 1,
      signal: new AbortController().signal,
      onResult: (result) => {
        results.push(result);
        return Promise.resolve();
      }
    });
    expect(results).toEqual([
      expect.objectContaining({ errorType: "HTTP_STATUS", httpStatus: 302 }),
      expect.objectContaining({ errorType: "HTTP_STATUS", httpStatus: 503 })
    ]);
  });

  it("100ms timeout 与用户 Abort 使用确定分类", async () => {
    const stub = await startRestStub(async (request, response) => {
      await readBody(request);
      await new Promise((resolve) => setTimeout(resolve, 300));
      response.end('{"ok":false,"err_msg":"late"}');
    });
    opened.push(stub);
    const executor = new FetchRestExecutor({ readSecret: (): undefined => undefined });
    const timeoutResults: RestCaseExecutionResult[] = [];
    await executor.execute({
      cases: [testCase],
      endpoint: endpoint(stub.origin, 100),
      concurrency: 1,
      signal: new AbortController().signal,
      onResult: (result) => {
        timeoutResults.push(result);
        return Promise.resolve();
      }
    });
    expect(timeoutResults[0]?.errorType).toBe("TIMEOUT");

    const controller = new AbortController();
    const cancelled: RestCaseExecutionResult[] = [];
    const execution = executor.execute({
      cases: [testCase],
      endpoint: endpoint(stub.origin, 1_000),
      concurrency: 1,
      signal: controller.signal,
      onResult: (result) => {
        cancelled.push(result);
        return Promise.resolve();
      }
    });
    setTimeout(() => controller.abort(), 20);
    await execution;
    expect(cancelled[0]?.errorType).toBe("CANCELLED");
  });

  it("限制最大在途数并在 Abort 后停止派发新 Case", async () => {
    let inFlight = 0;
    let maximumInFlight = 0;
    const stub = await startRestStub(async (request, response) => {
      inFlight += 1;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      await readBody(request);
      await new Promise((resolve) => setTimeout(resolve, 80));
      inFlight -= 1;
      response.end('{"ok":false,"err_msg":"done"}');
    });
    opened.push(stub);
    const cases = Array.from({ length: 12 }, (_, ordinal) => ({
      ...testCase,
      caseKey: `case-${ordinal}`,
      ordinal
    }));
    const controller = new AbortController();
    const results: unknown[] = [];
    const execution = new FetchRestExecutor({ readSecret: (): undefined => undefined }).execute({
      cases,
      endpoint: endpoint(stub.origin),
      concurrency: 2,
      signal: controller.signal,
      onResult: (result) => {
        results.push(result);
        return Promise.resolve();
      }
    });
    setTimeout(() => controller.abort(), 20);
    await execution;
    expect(maximumInFlight).toBe(2);
    expect(results.length).toBeLessThanOrEqual(2);
    expect(results).toEqual(
      expect.arrayContaining([expect.objectContaining({ errorType: "CANCELLED" })])
    );
  });
});
