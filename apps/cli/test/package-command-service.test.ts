import { createServer, type Server } from "node:http";
import { access, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hashExecutionContext } from "@cortex-eval/domain/src/domain-hash-inputs.ts";
import { SecureWorkPackageDirectory } from "@cortex-eval/work-package/src/secure-work-package-directory.ts";
import type { WorkPackageLockOwner } from "@cortex-eval/work-package/src/secure-work-package-directory.ts";
import { encodeWorkPackageExport } from "@cortex-eval/work-package/src/work-package-export-encoder.ts";
import type { WorkPackageExecutionContextHashInput } from "@cortex-eval/work-package/src/work-package-execution-session.ts";
import { validateWorkPackage } from "@cortex-eval/work-package/src/work-package-validator.ts";
import {
  materializeWorkPackageFixture,
  WORK_PACKAGE_FIXTURE_ID
} from "@cortex-eval/work-package/test-support/work-package-fixture.ts";
import { afterEach, describe, expect, it } from "vitest";

import {
  HttpPackageCommandService,
  MacOsCliProcessIdentity,
  type HttpPackageCommandServiceOptions
} from "../src/package-command-service.ts";

const roots: string[] = [];
const servers: Server[] = [];
const exportRequest = {
  suiteId: WORK_PACKAGE_FIXTURE_ID,
  endpointConfigId: "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeee1",
  evaluatorConfigId: "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeee2",
  analyzerConfigId: "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeee3",
  analysisPromptId: "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeee4"
} as const;

function owner(): WorkPackageLockOwner {
  return {
    pid: process.pid,
    processStartedAt: "Tue Jul 14 15:00:00 2026",
    executionId: null,
    acquiredAt: "2026-07-14T07:00:00.000Z"
  };
}

const contextHasher = {
  hash: (input: WorkPackageExecutionContextHashInput): string =>
    hashExecutionContext({
      contractVersion: input.contractVersion,
      packageId: input.packageId,
      manifestHash: input.manifestHash,
      runExecutionLimits: input.runExecutionLimits,
      analysisExecutionLimits: input.analysisExecutionLimits
    })
};

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("TEST_SERVER_INVALID");
  return `http://127.0.0.1:${address.port}`;
}

function options(
  fetchStub?: typeof fetch,
  baseUrl = "http://127.0.0.1:4310"
): HttpPackageCommandServiceOptions {
  return {
    baseUrl,
    contextHasher,
    nonce: (): string => "cli_package_boundary_nonce",
    processIdentity: {
      processStartedAt: (): Promise<string | null> => Promise.resolve(owner().processStartedAt)
    },
    now: (): string => "2026-07-14T07:00:00.000Z",
    cleanupFailureSink: { record: (): Promise<void> => Promise.resolve() },
    ...(fetchStub === undefined ? {} : { fetch: fetchStub })
  };
}

function fetching(response: Response): typeof fetch {
  return (): Promise<Response> => Promise.resolve(response);
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("P7 package command adapter", () => {
  it("streams the Local API export into an atomically published package and validates it", async () => {
    const sourceRoot = await temporaryRoot("cortex-cli-package-source-");
    await materializeWorkPackageFixture(sourceRoot);
    const validated = await validateWorkPackage(sourceRoot, owner());
    const directory = await SecureWorkPackageDirectory.open(sourceRoot);
    let requestBody: unknown;
    const server = createServer((request, response) => {
      const serve = async (): Promise<void> => {
        const chunks: Uint8Array[] = [];
        for await (const untrustedChunk of request) {
          const chunk: unknown = untrustedChunk;
          if (!(chunk instanceof Uint8Array)) throw new Error("TEST_REQUEST_CHUNK_INVALID");
          chunks.push(chunk);
        }
        requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        response.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8" });
        for await (const chunk of encodeWorkPackageExport(directory, validated)) {
          response.write(chunk);
        }
        response.end();
      };
      void serve().catch(() => response.destroy());
    });
    const baseUrl = await listen(server);
    const parent = await temporaryRoot("cortex-cli-package-target-");
    const targetPath = join(parent, "package");
    const service = new HttpPackageCommandService({
      baseUrl,
      contextHasher,
      nonce: (): string => "cli_package_nonce_01",
      processIdentity: {
        processStartedAt: (): Promise<string | null> => Promise.resolve(owner().processStartedAt)
      },
      now: (): string => "2026-07-14T07:00:00.000Z",
      cleanupFailureSink: { record: (): Promise<void> => Promise.resolve() }
    });
    try {
      const exported = await service.exportPackage(
        exportRequest,
        targetPath,
        new AbortController().signal
      );
      expect(exported).toMatchObject({ packageId: WORK_PACKAGE_FIXTURE_ID, targetPath });
      expect(requestBody).toMatchObject({ suiteId: WORK_PACKAGE_FIXTURE_ID });
      await expect(
        service.validatePackage(targetPath, new AbortController().signal)
      ).resolves.toMatchObject({ packageId: WORK_PACKAGE_FIXTURE_ID, executionCount: 0 });
    } finally {
      directory.close();
    }
  });

  it("recovers only stale inactive export staging before the platform request", async () => {
    const parent = await temporaryRoot("cortex-cli-package-recovery-");
    const createdAt = "2026-07-12T07:00:00.000Z";
    const oldTime = new Date(createdAt);
    const stages = [
      { nonce: "dead_owner", pid: 900_001, startedAt: "DEAD", owner: true },
      { nonce: "live_owner", pid: 900_002, startedAt: "LIVE", owner: true },
      { nonce: "reused_pid", pid: 900_003, startedAt: "OLD", owner: true },
      { nonce: "ownerless", pid: 0, startedAt: "", owner: false }
    ] as const;
    for (const stage of stages) {
      const path = join(parent, `.cortex-export-${stage.nonce}`);
      await mkdir(path, { mode: 0o700 });
      if (stage.owner) {
        await writeFile(
          join(path, ".cortex-export-owner.json"),
          `${JSON.stringify({
            nonce: stage.nonce,
            pid: stage.pid,
            processStartedAt: stage.startedAt,
            createdAt,
            targetName: "package"
          })}\n`,
          { mode: 0o600 }
        );
      }
      await utimes(path, oldTime, oldTime);
    }
    const presentAtFetch: Record<string, boolean> = {};
    const fetchStub: typeof fetch = async (): Promise<Response> => {
      for (const stage of stages) {
        presentAtFetch[stage.nonce] = await access(
          join(parent, `.cortex-export-${stage.nonce}`)
        ).then(
          () => true,
          () => false
        );
      }
      return new Response("unavailable", { status: 503 });
    };
    const service = new HttpPackageCommandService({
      ...options(fetchStub),
      processIdentity: {
        processStartedAt: (pid): Promise<string | null> => {
          if (pid === process.pid) return Promise.resolve(owner().processStartedAt);
          if (pid === 900_002) return Promise.resolve("LIVE");
          if (pid === 900_003) return Promise.resolve("NEW");
          return Promise.resolve(null);
        }
      }
    });

    await expect(
      service.exportPackage(exportRequest, join(parent, "package"), new AbortController().signal)
    ).rejects.toThrow("PROVIDER_REQUEST_FAILED");
    expect(presentAtFetch).toEqual({
      dead_owner: false,
      live_owner: true,
      reused_pid: false,
      ownerless: false
    });
  });

  it("maps only a strict Local API error code and hides malformed remote responses", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(409, { "content-type": "application/json; charset=utf-8" });
      response.end(
        JSON.stringify({
          error: {
            code: "EXPORT_REVISION_CONFLICT",
            message: "remote prose",
            requestId: "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeeee"
          }
        })
      );
    });
    const baseUrl = await listen(server);
    const target = join(await temporaryRoot("cortex-cli-package-api-error-"), "package");
    const service = new HttpPackageCommandService({
      baseUrl,
      contextHasher,
      nonce: (): string => "cli_package_nonce_02",
      processIdentity: {
        processStartedAt: (): Promise<string | null> => Promise.resolve(owner().processStartedAt)
      },
      now: (): string => "2026-07-14T07:00:00.000Z",
      cleanupFailureSink: { record: (): Promise<void> => Promise.resolve() }
    });
    await expect(
      service.exportPackage(exportRequest, target, new AbortController().signal)
    ).rejects.toThrow("EXPORT_REVISION_CONFLICT");
  });

  it("accepts only plain loopback HTTP API origins", () => {
    for (const baseUrl of [
      "not-a-url",
      "https://127.0.0.1:4310",
      "http://example.com:4310",
      "http://user@127.0.0.1:4310",
      "http://user:secret@127.0.0.1:4310",
      "http://127.0.0.1:4310/path",
      "http://127.0.0.1:4310?query=1",
      "http://127.0.0.1:4310#fragment"
    ]) {
      expect(() => new HttpPackageCommandService(options(undefined, baseUrl))).toThrow(
        "VALIDATION_FAILED"
      );
    }
    expect(
      () => new HttpPackageCommandService(options(undefined, "http://localhost:4310"))
    ).not.toThrow();
    expect(
      () => new HttpPackageCommandService(options(undefined, "http://[::1]:4310"))
    ).not.toThrow();
  });

  it("rejects cancellation and unavailable process identity before external work", async () => {
    const cancelled = new AbortController();
    cancelled.abort();
    const service = new HttpPackageCommandService(options(fetching(new Response())));
    await expect(
      service.exportPackage(exportRequest, "/tmp/unused", cancelled.signal)
    ).rejects.toThrow("REQUEST_ABORTED");
    await expect(service.validatePackage("/tmp/unused", cancelled.signal)).rejects.toThrow(
      "REQUEST_ABORTED"
    );

    const unavailable = new HttpPackageCommandService({
      ...options(fetching(new Response())),
      processIdentity: {
        processStartedAt: (): Promise<null> => Promise.resolve(null)
      }
    });
    const unavailableTarget = join(
      await temporaryRoot("cortex-cli-package-identity-error-"),
      "package"
    );
    await expect(
      unavailable.exportPackage(exportRequest, unavailableTarget, new AbortController().signal)
    ).rejects.toThrow("INTERNAL_ERROR");
  });

  it("distinguishes transport cancellation from an ordinary fetch failure", async () => {
    const target = join(await temporaryRoot("cortex-cli-package-transport-"), "package");
    const failure: typeof fetch = (): Promise<Response> => Promise.reject(new Error("network"));
    const service = new HttpPackageCommandService(options(failure));
    await expect(
      service.exportPackage(exportRequest, target, new AbortController().signal)
    ).rejects.toThrow("PROVIDER_REQUEST_FAILED");

    const controller = new AbortController();
    const cancelledFetch: typeof fetch = (): Promise<Response> => {
      controller.abort();
      return Promise.reject(new Error("cancelled"));
    };
    const cancelledService = new HttpPackageCommandService(options(cancelledFetch));
    await expect(
      cancelledService.exportPackage(exportRequest, target, controller.signal)
    ).rejects.toThrow("REQUEST_ABORTED");
  });

  it("bounds and strictly validates Local API error bodies", async () => {
    const target = join(await temporaryRoot("cortex-cli-package-error-body-"), "package");
    const responses = [
      new Response("plain", { status: 500, headers: { "content-type": "text/plain" } }),
      new Response(null, {
        status: 500,
        headers: { "content-type": "application/json", "content-length": "65537" }
      }),
      new Response(null, { status: 500, headers: { "content-type": "application/json" } }),
      new Response("{", { status: 500, headers: { "content-type": "application/json" } }),
      new Response(JSON.stringify({ error: { code: "UNKNOWN" } }), {
        status: 500,
        headers: { "content-type": "application/json" }
      }),
      new Response("x".repeat(65_537), {
        status: 500,
        headers: { "content-type": "application/json" }
      })
    ];
    for (const response of responses) {
      const service = new HttpPackageCommandService(options(fetching(response)));
      await expect(
        service.exportPackage(exportRequest, target, new AbortController().signal)
      ).rejects.toThrow("PROVIDER_REQUEST_FAILED");
    }
  });

  it("rejects successful responses without a usable NDJSON body", async () => {
    const target = join(await temporaryRoot("cortex-cli-package-response-"), "package");
    const responses = [
      new Response("not ndjson", { status: 200, headers: { "content-type": "text/plain" } }),
      new Response(null, {
        status: 200,
        headers: { "content-type": "application/x-ndjson" }
      })
    ];
    for (const response of responses) {
      const service = new HttpPackageCommandService(options(fetching(response)));
      await expect(
        service.exportPackage(exportRequest, target, new AbortController().signal)
      ).rejects.toThrow("PROVIDER_REQUEST_FAILED");
    }
  });

  it("cancels an unread successful response body after malformed export data", async () => {
    const target = join(await temporaryRoot("cortex-cli-package-malformed-stream-"), "package");
    let cancelCount = 0;
    const body = new ReadableStream<Uint8Array>({
      start: (stream): void => {
        stream.enqueue(Buffer.from("not-json\n", "utf8"));
      },
      cancel: (): void => {
        cancelCount += 1;
      }
    });
    const response = new Response(body, {
      status: 200,
      headers: { "content-type": "application/x-ndjson" }
    });
    const service = new HttpPackageCommandService(options(fetching(response)));

    await expect(
      service.exportPackage(exportRequest, target, new AbortController().signal)
    ).rejects.toThrow("EXPORT_EVENT_INVALID");
    expect(cancelCount).toBe(1);
  });

  it("preserves the export error when unread response body cancellation fails", async () => {
    const target = join(await temporaryRoot("cortex-cli-package-cancel-failure-"), "package");
    const body = new ReadableStream<Uint8Array>({
      start: (stream): void => {
        stream.enqueue(Buffer.from("not-json\n", "utf8"));
      },
      cancel: (): Promise<never> => Promise.reject(new Error("TEST_BODY_CANCEL_FAILED"))
    });
    const response = new Response(body, {
      status: 200,
      headers: { "content-type": "application/x-ndjson" }
    });
    const service = new HttpPackageCommandService(options(fetching(response)));

    await expect(
      service.exportPackage(exportRequest, target, new AbortController().signal)
    ).rejects.toThrow("EXPORT_EVENT_INVALID");
  });

  it("cancels an unread successful response body when export is aborted", async () => {
    const sourceRoot = await temporaryRoot("cortex-cli-package-abort-source-");
    await materializeWorkPackageFixture(sourceRoot);
    const validated = await validateWorkPackage(sourceRoot, owner());
    const directory = await SecureWorkPackageDirectory.open(sourceRoot);
    const encoded = encodeWorkPackageExport(directory, validated)[Symbol.asyncIterator]();
    const first = await encoded.next();
    if (first.done) throw new Error("TEST_EXPORT_HEADER_MISSING");
    const controller = new AbortController();
    let cancelCount = 0;
    const fetchStub: typeof fetch = (): Promise<Response> => {
      const body = new ReadableStream<Uint8Array>({
        start: (stream): void => {
          stream.enqueue(first.value);
          controller.abort();
        },
        cancel: (): void => {
          cancelCount += 1;
        }
      });
      return Promise.resolve(
        new Response(body, {
          status: 200,
          headers: { "content-type": "application/x-ndjson" }
        })
      );
    };
    const target = join(await temporaryRoot("cortex-cli-package-abort-target-"), "package");
    const service = new HttpPackageCommandService(options(fetchStub));
    try {
      await expect(service.exportPackage(exportRequest, target, controller.signal)).rejects.toThrow(
        "REQUEST_ABORTED"
      );
      expect(cancelCount).toBe(1);
    } finally {
      await encoded.return(undefined);
      directory.close();
    }
  });

  it("cancels the response body when export is aborted during stream consumption", async () => {
    const sourceRoot = await temporaryRoot("cortex-cli-package-stream-abort-source-");
    await materializeWorkPackageFixture(sourceRoot);
    const validated = await validateWorkPackage(sourceRoot, owner());
    const directory = await SecureWorkPackageDirectory.open(sourceRoot);
    const encoded = encodeWorkPackageExport(directory, validated)[Symbol.asyncIterator]();
    const first = await encoded.next();
    if (first.done) throw new Error("TEST_EXPORT_HEADER_MISSING");
    const controller = new AbortController();
    let cancelCount = 0;
    const body = new ReadableStream<Uint8Array>({
      start: (stream): void => {
        stream.enqueue(first.value);
      },
      pull: (): void => {
        controller.abort();
      },
      cancel: (): void => {
        cancelCount += 1;
      }
    });
    const response = new Response(body, {
      status: 200,
      headers: { "content-type": "application/x-ndjson" }
    });
    const target = join(await temporaryRoot("cortex-cli-package-stream-abort-target-"), "package");
    const service = new HttpPackageCommandService(options(fetching(response)));
    try {
      await expect(service.exportPackage(exportRequest, target, controller.signal)).rejects.toThrow(
        "REQUEST_ABORTED"
      );
      expect(cancelCount).toBe(1);
    } finally {
      await encoded.return(undefined);
      directory.close();
    }
  });

  it("reads the current macOS process identity and returns null for a missing process", async () => {
    const identity = new MacOsCliProcessIdentity();
    await expect(identity.processStartedAt(process.pid)).resolves.toMatch(/\w/);
    await expect(identity.processStartedAt(2_147_483_647)).resolves.toBeNull();
  });
});
