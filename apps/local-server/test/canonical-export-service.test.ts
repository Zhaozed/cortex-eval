import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  CanonicalExpectedArtifact,
  CanonicalSourceEntity,
  CanonicalEntityType
} from "@cortex-eval/application/src/features/canonical-export/canonical-export-projection-service.ts";
import type { CanonicalExportEventV1 } from "@cortex-eval/contracts/src/canonical-export-contracts.ts";
import {
  CaseImportWorkspaceManager,
  type ProcessLiveness
} from "@cortex-eval/storage-sqlite/src/case-import-workspace.ts";
import { afterEach, describe, expect, it } from "vitest";

import {
  CanonicalExportService,
  type CanonicalExportSnapshotSession
} from "../src/canonical-export-service.ts";

const EXPORT_ID = "018f1e2d-3c4b-7abc-8def-0123456789ab";
const roots: string[] = [];
const processLiveness: ProcessLiveness = {
  processStartedAt: () => Promise.resolve("Wed Jul 15 00:00:00 2026")
};

function manager(projectRoot: string): CaseImportWorkspaceManager {
  return new CaseImportWorkspaceManager({
    containmentRoot: projectRoot,
    temporaryRoot: join(projectRoot, ".cortex-eval", "tmp"),
    processLiveness,
    now: Date.now,
    nonce: (): string => "canonical-service-nonce",
    pid: process.pid,
    ttlMs: 60_000,
    workspacePrefix: "canonical-export-"
  });
}

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cortex-canonical-service-"));
  roots.push(root);
  await mkdir(join(root, ".cortex-eval", "tmp"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, ".cortex-eval", "artifacts"), { mode: 0o700 });
  return root;
}

async function* emptySources(): AsyncGenerator<CanonicalSourceEntity> {
  await Promise.resolve();
  const sources: CanonicalSourceEntity[] = [];
  yield* sources;
}

async function* emptyArtifacts(): AsyncGenerator<CanonicalExpectedArtifact> {
  await Promise.resolve();
  const artifacts: CanonicalExpectedArtifact[] = [];
  yield* artifacts;
}

async function* oneSource(source: CanonicalSourceEntity): AsyncGenerator<CanonicalSourceEntity> {
  await Promise.resolve();
  yield source;
}

function emptySession(onClose: () => void): CanonicalExportSnapshotSession {
  return {
    stream: (): AsyncIterable<CanonicalSourceEntity> => emptySources(),
    streamArtifacts: (): AsyncIterable<CanonicalExpectedArtifact> => emptyArtifacts(),
    close: (): Promise<void> => {
      onClose();
      return Promise.resolve();
    }
  };
}

async function events(body: AsyncIterable<Uint8Array>): Promise<CanonicalExportEventV1[]> {
  let pending = "";
  const result: CanonicalExportEventV1[] = [];
  for await (const chunk of body) pending += Buffer.from(chunk).toString("utf8");
  for (const line of pending.trimEnd().split("\n")) {
    result.push(JSON.parse(line) as CanonicalExportEventV1);
  }
  return result;
}

function files(stream: readonly CanonicalExportEventV1[]): ReadonlyMap<string, string> {
  const chunks = new Map<string, string[]>();
  for (const event of stream) {
    if (event.type === "FILE_CHUNK") {
      const current = chunks.get(event.path) ?? [];
      current.push(Buffer.from(event.dataBase64, "base64").toString("utf8"));
      chunks.set(event.path, current);
    }
  }
  return new Map([...chunks].map(([path, parts]) => [path, parts.join("")]));
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Canonical Export 完整编排", () => {
  it("在成功响应前关闭快照并完成四类读回对账，流消费后回收工作区", async () => {
    const root = await project();
    let closed = 0;
    const service = new CanonicalExportService({
      snapshots: {
        create: (): Promise<CanonicalExportSnapshotSession> =>
          Promise.resolve(
            emptySession(() => {
              closed += 1;
            })
          )
      },
      workspaces: manager(root),
      artifactRoot: join(root, ".cortex-eval", "artifacts"),
      nextId: (): string => EXPORT_ID,
      now: (): string => "2026-07-15T00:00:00.000Z"
    });

    const body = await service.prepare(
      { rawEvidenceIncluded: false },
      new AbortController().signal
    );
    expect(closed).toBe(1);
    const stream = await events(body);
    const exportedFiles = files(stream);
    expect(stream[0]).toMatchObject({ type: "EXPORT_START", exportId: EXPORT_ID });
    expect(stream.at(-1)).toMatchObject({ type: "EXPORT_END", exportId: EXPORT_ID });

    const manifest = JSON.parse(exportedFiles.get("manifest.json") ?? "") as {
      entityFiles: unknown[];
      artifacts: unknown[];
    };
    expect(manifest.entityFiles).toHaveLength(10);
    expect(manifest.artifacts).toEqual([]);
    expect(JSON.parse(exportedFiles.get("reconciliation.json") ?? "")).toMatchObject({
      checks: {
        counts: { status: "PASS" },
        references: { status: "PASS" },
        entityHashes: { status: "PASS" },
        fileHashes: { status: "PASS" }
      }
    });
    expect(await readdir(join(root, ".cortex-eval", "tmp"))).toEqual([]);
  });

  it("投影失败时关闭快照并回收未发布工作区", async () => {
    const root = await project();
    let closed = 0;
    const invalid: CanonicalSourceEntity = {
      entityType: "TEST_CASE",
      entityKey: { id: EXPORT_ID },
      payload: {},
      references: []
    };
    const session = emptySession(() => {
      closed += 1;
    });
    const service = new CanonicalExportService({
      snapshots: {
        create: (): Promise<CanonicalExportSnapshotSession> =>
          Promise.resolve({
            ...session,
            stream: (entityType: CanonicalEntityType): AsyncIterable<CanonicalSourceEntity> =>
              entityType === "TEST_SUITE" ? oneSource(invalid) : emptySources()
          })
      },
      workspaces: manager(root),
      artifactRoot: join(root, ".cortex-eval", "artifacts"),
      nextId: (): string => EXPORT_ID,
      now: (): string => "2026-07-15T00:00:00.000Z"
    });

    await expect(
      service.prepare({ rawEvidenceIncluded: false }, new AbortController().signal)
    ).rejects.toThrow("CANONICAL_ENTITY_TYPE_INVALID");
    expect(closed).toBe(1);
    expect(await readdir(join(root, ".cortex-eval", "tmp"))).toEqual([]);
  });

  it("收集快照中的 Artifact 描述符并把源缺失显式写入 Manifest", async () => {
    const root = await project();
    const service = new CanonicalExportService({
      snapshots: {
        create: (): Promise<CanonicalExportSnapshotSession> =>
          Promise.resolve({
            ...emptySession(() => undefined),
            streamArtifacts: async function* (): AsyncGenerator<CanonicalExpectedArtifact> {
              await Promise.resolve();
              yield {
                owner: { type: "RUN", key: { id: EXPORT_ID } },
                kind: "REPORT_JSON",
                sourcePath: `runs/${EXPORT_ID}/missing-report.json`,
                expectedSha256: "a".repeat(64),
                expectedSizeBytes: 10
              };
            }
          })
      },
      workspaces: manager(root),
      artifactRoot: join(root, ".cortex-eval", "artifacts"),
      nextId: (): string => EXPORT_ID,
      now: (): string => "2026-07-15T00:00:00.000Z"
    });

    const stream = await events(
      await service.prepare({ rawEvidenceIncluded: false }, new AbortController().signal)
    );
    const manifest = JSON.parse(files(stream).get("manifest.json") ?? "") as {
      artifacts: readonly { present: boolean; included: boolean }[];
    };

    expect(manifest.artifacts).toEqual([
      expect.objectContaining({ present: false, included: false })
    ]);
    expect(await readdir(join(root, ".cortex-eval", "tmp"))).toEqual([]);
  });

  it("Artifact 描述符流中取消时关闭快照并回收工作区", async () => {
    const root = await project();
    const controller = new AbortController();
    let closed = 0;
    const service = new CanonicalExportService({
      snapshots: {
        create: (): Promise<CanonicalExportSnapshotSession> =>
          Promise.resolve({
            ...emptySession(() => {
              closed += 1;
            }),
            streamArtifacts: async function* (): AsyncGenerator<CanonicalExpectedArtifact> {
              await Promise.resolve();
              controller.abort();
              yield {
                owner: { type: "RUN", key: { id: EXPORT_ID } },
                kind: "REPORT_JSON",
                sourcePath: "unused.json",
                expectedSha256: "a".repeat(64),
                expectedSizeBytes: 1
              };
            }
          })
      },
      workspaces: manager(root),
      artifactRoot: join(root, ".cortex-eval", "artifacts"),
      nextId: (): string => EXPORT_ID,
      now: (): string => "2026-07-15T00:00:00.000Z"
    });

    await expect(
      service.prepare({ rawEvidenceIncluded: false }, controller.signal)
    ).rejects.toThrow("REQUEST_ABORTED");
    expect(closed).toBe(1);
    expect(await readdir(join(root, ".cortex-eval", "tmp"))).toEqual([]);
  });
});
