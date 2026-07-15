import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { HttpResultImportCommandService } from "../src/result-import-command-service.ts";

const ID = "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeeee";
const HASH = "a".repeat(64);

function input(signal: AbortSignal = new AbortController().signal): {
  readonly packagePath: string;
  readonly executionId: string;
  readonly signal: AbortSignal;
} {
  return { packagePath: "/tmp/package", executionId: ID, signal };
}

function success(status = 201): Response {
  return new Response(
    JSON.stringify({
      contractVersion: "cortex.execution-report-import-result.v1",
      runId: ID,
      packageId: ID,
      executionId: ID,
      idempotent: false,
      sourceType: "OFFLINE_IMPORT",
      status: "COMPLETED",
      stage: "DONE",
      restResultSetHash: HASH,
      evaluationContextHash: "b".repeat(64),
      evaluationResultSetHash: "c".repeat(64),
      reportResultSetHash: "d".repeat(64)
    }),
    { status, headers: { "content-type": "application/json; charset=utf-8" } }
  );
}

describe("P8 result import HTTP adapter", () => {
  it("posts one absolute local package path and strictly parses the imported version", async () => {
    const fetchStub = vi.fn<typeof fetch>().mockResolvedValue(success());
    const service = new HttpResultImportCommandService({ fetch: fetchStub });
    await expect(
      service.importReport({
        packagePath: "relative-package",
        executionId: ID,
        signal: new AbortController().signal
      })
    ).resolves.toMatchObject({ executionId: ID, evaluationContextHash: "b".repeat(64) });
    expect(fetchStub).toHaveBeenCalledOnce();
    const [url, init] = fetchStub.mock.calls[0] ?? [];
    if (!(url instanceof URL)) throw new Error("TEST_REQUEST_URL_INVALID");
    expect(url.href).toBe("http://127.0.0.1:4310/api/v1/execution-results/import");
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    if (typeof init?.body !== "string") throw new Error("TEST_REQUEST_BODY_INVALID");
    expect(JSON.parse(init.body) as unknown).toEqual({
      contractVersion: "cortex.execution-report-import-request.v1",
      packagePath: resolve("relative-package"),
      executionId: ID
    });
  });

  it("accepts only loopback HTTP and maps strict API errors, malformed success and cancellation", async () => {
    for (const baseUrl of [
      "https://127.0.0.1:4310",
      "http://example.com:4310",
      "http://user@127.0.0.1:4310",
      "http://127.0.0.1:4310/path"
    ]) {
      expect(() => new HttpResultImportCommandService({ baseUrl })).toThrow("VALIDATION_FAILED");
    }

    const conflict = new HttpResultImportCommandService({
      fetch: (): Promise<Response> =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                code: "EXECUTION_RESULT_CONFLICT",
                message: "remote prose",
                requestId: ID
              }
            }),
            { status: 409, headers: { "content-type": "application/json" } }
          )
        )
    });
    await expect(
      conflict.importReport({
        packagePath: "/tmp/package",
        executionId: ID,
        signal: new AbortController().signal
      })
    ).rejects.toThrow("EXECUTION_RESULT_CONFLICT");

    const malformed = new HttpResultImportCommandService({
      fetch: (): Promise<Response> =>
        Promise.resolve(
          new Response("{}", { status: 201, headers: { "content-type": "application/json" } })
        )
    });
    await expect(
      malformed.importReport({
        packagePath: "/tmp/package",
        executionId: ID,
        signal: new AbortController().signal
      })
    ).rejects.toThrow("PROVIDER_REQUEST_FAILED");

    const wrongStatus = new HttpResultImportCommandService({
      fetch: (): Promise<Response> => Promise.resolve(success(200))
    });
    await expect(
      wrongStatus.importReport({
        packagePath: "/tmp/package",
        executionId: ID,
        signal: new AbortController().signal
      })
    ).rejects.toThrow("PROVIDER_REQUEST_FAILED");

    const controller = new AbortController();
    controller.abort();
    const cancelledFetch = vi.fn<typeof fetch>();
    const cancelled = new HttpResultImportCommandService({ fetch: cancelledFetch });
    await expect(
      cancelled.importReport({
        packagePath: "/tmp/package",
        executionId: ID,
        signal: controller.signal
      })
    ).rejects.toThrow("REQUEST_ABORTED");
    expect(cancelledFetch).not.toHaveBeenCalled();
  });

  it("maps cancellation while reading a successful response body", async () => {
    const controller = new AbortController();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(stream): void {
          controller.abort();
          stream.error(new Error("transport cancelled"));
        }
      }),
      { status: 201, headers: { "content-type": "application/json" } }
    );
    const service = new HttpResultImportCommandService({
      fetch: (): Promise<Response> => Promise.resolve(response)
    });
    await expect(
      service.importReport({
        packagePath: "/tmp/package",
        executionId: ID,
        signal: controller.signal
      })
    ).rejects.toThrow("REQUEST_ABORTED");
  });

  it("拒绝非法 URL 细节并允许三种显式 loopback 地址", () => {
    for (const baseUrl of [
      "not a url",
      "http://user:secret@127.0.0.1:4310",
      "http://127.0.0.1:4310/?query=1",
      "http://127.0.0.1:4310/#fragment"
    ]) {
      expect(() => new HttpResultImportCommandService({ baseUrl })).toThrow("VALIDATION_FAILED");
    }
    for (const baseUrl of ["http://127.0.0.1:4310", "http://localhost:4310", "http://[::1]:4310"]) {
      expect(() => new HttpResultImportCommandService({ baseUrl })).not.toThrow();
    }
  });

  it("把 Fetch 失败区分为普通传输失败和异步取消", async () => {
    const failed = new HttpResultImportCommandService({
      fetch: (): Promise<Response> => Promise.reject(new Error("transport failed"))
    });
    await expect(failed.importReport(input())).rejects.toThrow("PROVIDER_REQUEST_FAILED");

    const controller = new AbortController();
    const cancelled = new HttpResultImportCommandService({
      fetch: (): Promise<Response> => {
        controller.abort();
        return Promise.reject(new Error("transport cancelled"));
      }
    });
    await expect(cancelled.importReport(input(controller.signal))).rejects.toThrow(
      "REQUEST_ABORTED"
    );
  });

  it("拒绝非 JSON、超限、空体、损坏体和未经契约化的错误响应", async () => {
    const oversizedChunk = new Uint8Array(64 * 1024 + 1);
    const responses = [
      new Response("plain", { status: 201, headers: { "content-type": "text/plain" } }),
      new Response("{}", {
        status: 201,
        headers: { "content-type": "application/json", "content-length": "65537" }
      }),
      new Response(null, { status: 201, headers: { "content-type": "application/json" } }),
      new Response(
        new ReadableStream<Uint8Array>({
          start(stream): void {
            stream.enqueue(oversizedChunk);
            stream.close();
          }
        }),
        { status: 201, headers: { "content-type": "application/json" } }
      ),
      new Response("{", { status: 201, headers: { "content-type": "application/json" } }),
      new Response("{}", { status: 500, headers: { "content-type": "application/json" } })
    ];
    for (const response of responses) {
      const service = new HttpResultImportCommandService({
        fetch: (): Promise<Response> => Promise.resolve(response)
      });
      await expect(service.importReport(input())).rejects.toThrow("PROVIDER_REQUEST_FAILED");
    }
  });

  it("把非取消的响应流错误收敛为传输失败", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(stream): void {
          stream.error(new Error("body failed"));
        }
      }),
      { status: 201, headers: { "content-type": "application/json" } }
    );
    const service = new HttpResultImportCommandService({
      fetch: (): Promise<Response> => Promise.resolve(response)
    });
    await expect(service.importReport(input())).rejects.toThrow("PROVIDER_REQUEST_FAILED");
  });
});
