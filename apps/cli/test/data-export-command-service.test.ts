import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import type {
  CanonicalExpectedArtifact,
  CanonicalSourceEntity
} from "@cortex-eval/application/src/features/canonical-export/canonical-export-projection-service.ts";
import {
  CaseImportWorkspaceManager,
  type ProcessLiveness
} from "../../../packages/storage-sqlite/src/case-import-workspace.ts";
import { afterEach, describe, expect, it } from "vitest";

import {
  CanonicalExportService,
  type CanonicalExportSnapshotSession
} from "../../local-server/src/canonical-export-service.ts";
import { HttpDataExportCommandService } from "../src/data-export-command-service.ts";

const ID = "018f1e2d-3c4b-7abc-8def-0123456789ab";
const roots: string[] = [];
const processLiveness: ProcessLiveness = {
  processStartedAt: () => Promise.resolve("process-start")
};

async function* emptySources(): AsyncGenerator<CanonicalSourceEntity> {
  await Promise.resolve();
  const values: CanonicalSourceEntity[] = [];
  yield* values;
}

async function* emptyArtifacts(): AsyncGenerator<CanonicalExpectedArtifact> {
  await Promise.resolve();
  const values: CanonicalExpectedArtifact[] = [];
  yield* values;
}

function manager(root: string): CaseImportWorkspaceManager {
  return new CaseImportWorkspaceManager({
    containmentRoot: root,
    temporaryRoot: join(root, ".cortex-eval", "tmp"),
    processLiveness,
    now: Date.now,
    nonce: (): string => "data-service-workspace",
    pid: process.pid,
    ttlMs: 60_000,
    workspacePrefix: "canonical-export-"
  });
}

function edgeService(
  fetchBoundary: typeof fetch,
  overrides: {
    readonly now?: () => string;
    readonly processStartedAt?: () => Promise<string | null>;
  } = {}
): HttpDataExportCommandService {
  return new HttpDataExportCommandService({
    nonce: (): string => "edge-receiver-nonce",
    now: overrides.now ?? ((): string => "2026-07-15T00:00:00.000Z"),
    processIdentity: {
      processStartedAt:
        overrides.processStartedAt ?? ((): Promise<string> => Promise.resolve("process-start"))
    },
    cleanupFailureSink: { record: (): Promise<void> => Promise.resolve() },
    fetch: fetchBoundary
  });
}

async function targetPath(name: string): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), `cortex-data-command-${name}-`));
  roots.push(parent);
  return join(parent, "canonical-data");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("HTTP data export command service", () => {
  it("发送严格请求并把真实服务流二次对账后原子发布", async () => {
    const project = await mkdtemp(join(tmpdir(), "cortex-data-command-project-"));
    const targetParent = await mkdtemp(join(tmpdir(), "cortex-data-command-target-"));
    roots.push(project, targetParent);
    await mkdir(join(project, ".cortex-eval", "tmp"), { recursive: true, mode: 0o700 });
    await mkdir(join(project, ".cortex-eval", "artifacts"), { mode: 0o700 });
    const exportService = new CanonicalExportService({
      snapshots: {
        create: (): Promise<CanonicalExportSnapshotSession> =>
          Promise.resolve({
            stream: (): AsyncIterable<CanonicalSourceEntity> => emptySources(),
            streamArtifacts: (): AsyncIterable<CanonicalExpectedArtifact> => emptyArtifacts(),
            close: (): Promise<void> => Promise.resolve()
          })
      },
      workspaces: manager(project),
      artifactRoot: join(project, ".cortex-eval", "artifacts"),
      nextId: (): string => ID,
      now: (): string => "2026-07-15T00:00:00.000Z"
    });
    let observedUrl = "";
    let observedBody = "";
    const service = new HttpDataExportCommandService({
      baseUrl: "http://127.0.0.1:4310",
      nonce: (): string => "data-receiver-nonce",
      now: (): string => "2026-07-15T00:00:00.000Z",
      processIdentity: {
        processStartedAt: (): Promise<string> => Promise.resolve("process-start")
      },
      cleanupFailureSink: { record: (): Promise<void> => Promise.resolve() },
      fetch: async (input, init): Promise<Response> => {
        observedUrl =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        observedBody = typeof init?.body === "string" ? init.body : "";
        const body = await exportService.prepare(
          JSON.parse(observedBody) as { rawEvidenceIncluded: boolean },
          new AbortController().signal
        );
        return new Response(Readable.toWeb(body) as ReadableStream<Uint8Array>, {
          status: 200,
          headers: { "content-type": "application/x-ndjson; charset=utf-8" }
        });
      }
    });
    const target = join(targetParent, "canonical-data");

    await expect(
      service.exportData({ rawEvidenceIncluded: true }, target, new AbortController().signal)
    ).resolves.toMatchObject({ exportId: ID, targetPath: target });
    expect(observedUrl).toBe("http://127.0.0.1:4310/api/v1/data/export");
    expect(JSON.parse(observedBody)).toEqual({ rawEvidenceIncluded: true });
    expect(JSON.parse(await readFile(join(target, "manifest.json"), "utf8"))).toMatchObject({
      exportId: ID,
      rawEvidenceIncluded: true
    });
  });

  it("在发起 HTTP 前拒绝取消、非法请求和不可识别进程身份", async () => {
    let calls = 0;
    const fetchBoundary: typeof fetch = (): Promise<Response> => {
      calls += 1;
      return Promise.resolve(new Response());
    };
    const target = await targetPath("preflight");
    const cancelled = new AbortController();
    cancelled.abort();

    await expect(
      edgeService(fetchBoundary).exportData(
        { rawEvidenceIncluded: false },
        target,
        cancelled.signal
      )
    ).rejects.toThrow("REQUEST_ABORTED");
    await expect(
      edgeService(fetchBoundary).exportData(
        { rawEvidenceIncluded: "yes" } as never,
        target,
        new AbortController().signal
      )
    ).rejects.toThrow();
    await expect(
      edgeService(fetchBoundary, {
        processStartedAt: (): Promise<null> => Promise.resolve(null)
      }).exportData({ rawEvidenceIncluded: false }, target, new AbortController().signal)
    ).rejects.toThrow("INTERNAL_ERROR");
    expect(calls).toBe(0);
  });

  it("拒绝非法时钟、普通 Fetch 失败和取消期间的 Fetch 失败", async () => {
    const target = await targetPath("fetch-errors");
    await expect(
      edgeService(() => Promise.resolve(new Response()), {
        now: (): string => "not-a-time"
      }).exportData({ rawEvidenceIncluded: false }, target, new AbortController().signal)
    ).rejects.toThrow("INTERNAL_ERROR");

    await expect(
      edgeService(() => Promise.reject(new Error("network detail"))).exportData(
        { rawEvidenceIncluded: false },
        target,
        new AbortController().signal
      )
    ).rejects.toThrow("PROVIDER_REQUEST_FAILED");

    const cancelled = new AbortController();
    const abortingFetch: typeof fetch = (): Promise<Response> => {
      cancelled.abort();
      return Promise.reject(new Error("abort detail"));
    };
    await expect(
      edgeService(abortingFetch).exportData(
        { rawEvidenceIncluded: false },
        target,
        cancelled.signal
      )
    ).rejects.toThrow("REQUEST_ABORTED");
  });

  it("把非成功响应、错误媒体类型和空响应体收敛为稳定错误", async () => {
    const target = await targetPath("response-errors");
    await expect(
      edgeService(() => Promise.resolve(new Response("remote prose", { status: 503 }))).exportData(
        { rawEvidenceIncluded: false },
        target,
        new AbortController().signal
      )
    ).rejects.toThrow("PROVIDER_REQUEST_FAILED");

    let cancelled = false;
    const wrongMedia = new ReadableStream<Uint8Array>({
      cancel: (): void => {
        cancelled = true;
      },
      start: (): void => undefined
    });
    await expect(
      edgeService(() =>
        Promise.resolve(
          new Response(wrongMedia, { headers: { "content-type": "application/json" } })
        )
      ).exportData({ rawEvidenceIncluded: false }, target, new AbortController().signal)
    ).rejects.toThrow("PROVIDER_REQUEST_FAILED");
    expect(cancelled).toBe(true);

    await expect(
      edgeService(() =>
        Promise.resolve(
          new Response(null, {
            headers: { "content-type": "application/x-ndjson; charset=utf-8" }
          })
        )
      ).exportData({ rawEvidenceIncluded: false }, target, new AbortController().signal)
    ).rejects.toThrow("PROVIDER_REQUEST_FAILED");
  });

  it("接收端拒绝畸形事件时取消 Body、清理 staging 且不发布目标", async () => {
    const target = await targetPath("invalid-stream");
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel: (): void => {
        cancelled = true;
      },
      start(controller): void {
        controller.enqueue(Buffer.from("not-json\n"));
      }
    });
    await expect(
      edgeService(() =>
        Promise.resolve(
          new Response(stream, {
            headers: { "content-type": "application/x-ndjson; charset=utf-8" }
          })
        )
      ).exportData({ rawEvidenceIncluded: false }, target, new AbortController().signal)
    ).rejects.toThrow("CANONICAL_EXPORT_EVENT_INVALID");
    expect(cancelled).toBe(true);
    await expect(readFile(join(target, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await readdir(join(target, ".."))).some((name) => name.startsWith(".cortex-export-"))
    ).toBe(false);
  });
});
