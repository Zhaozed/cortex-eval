import { appendFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CANONICAL_ENTITY_FILE_ORDER,
  CanonicalExportProjectionService,
  type CanonicalEntityType,
  type CanonicalSourceEntity,
  type CanonicalSnapshotReader
} from "@cortex-eval/application/src/features/canonical-export/canonical-export-projection-service.ts";
import type { CanonicalExportManifestV1 } from "@cortex-eval/contracts/src/canonical-export-contracts.ts";
import {
  canonicalJson,
  sha256CanonicalJson
} from "@cortex-eval/domain/src/domain-canonical-hash.ts";
import {
  CaseImportWorkspaceManager,
  type ProcessLiveness
} from "@cortex-eval/storage-sqlite/src/case-import-workspace.ts";
import { afterEach, describe, expect, it } from "vitest";

import { CanonicalExportWorkspace } from "../src/canonical-export-workspace.ts";

const ID = "018f1e2d-3c4b-7abc-8def-0123456789ab";
const NOW = "2026-07-15T00:00:00.000Z";
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
    nonce: (): string => "workspace-nonce",
    pid: process.pid,
    ttlMs: 60_000,
    workspacePrefix: "canonical-export-"
  });
}

function snapshot(): CanonicalSnapshotReader {
  return {
    stream: async function* (
      entityType: CanonicalEntityType
    ): AsyncGenerator<CanonicalSourceEntity> {
      await Promise.resolve();
      if (entityType === "TEST_SUITE") {
        yield {
          entityType,
          entityKey: { id: ID },
          payload: { id: ID, name: "Suite" },
          references: []
        };
      }
    }
  };
}

async function* values<T>(...items: readonly T[]): AsyncGenerator<T> {
  await Promise.resolve();
  yield* items;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Canonical Export Workspace", () => {
  it("以 0600 文件写出十类实体并完成四类磁盘读回对账", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-canonical-workspace-"));
    roots.push(projectRoot);
    await mkdir(join(projectRoot, ".cortex-eval"), { mode: 0o700 });
    const workspace = await CanonicalExportWorkspace.create(manager(projectRoot));
    const projection = await new CanonicalExportProjectionService().project(snapshot(), workspace);
    const manifest: CanonicalExportManifestV1 = {
      contractVersion: "cortex.canonical-export-manifest.v1",
      exportId: ID,
      createdAt: NOW,
      rawEvidenceIncluded: false,
      contractVersions: {
        canonicalExport: "cortex.canonical-export-manifest.v1",
        canonicalEntity: "cortex.canonical-entity-record.v1"
      },
      entityFiles: [...projection.entityFiles],
      artifacts: []
    };

    const reconciliation = await workspace.reconcile(manifest);

    expect(reconciliation.checks).toEqual({
      counts: { status: "PASS", checked: 1 },
      references: { status: "PASS", checked: 0 },
      entityHashes: { status: "PASS", checked: 1 },
      fileHashes: { status: "PASS", checked: 10 }
    });
    expect((await stat(join(workspace.path, "entities", "test-suites.jsonl"))).mode & 0o777).toBe(
      0o600
    );
    await workspace.close();
  });

  it("文件在生成后被追加时对账失败，不能以旧 Manifest 发布", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-canonical-workspace-"));
    roots.push(projectRoot);
    await mkdir(join(projectRoot, ".cortex-eval"), { mode: 0o700 });
    const workspace = await CanonicalExportWorkspace.create(manager(projectRoot));
    const projection = await new CanonicalExportProjectionService().project(snapshot(), workspace);
    const manifest: CanonicalExportManifestV1 = {
      contractVersion: "cortex.canonical-export-manifest.v1",
      exportId: ID,
      createdAt: NOW,
      rawEvidenceIncluded: false,
      contractVersions: { canonicalExport: "cortex.canonical-export-manifest.v1" },
      entityFiles: [...projection.entityFiles],
      artifacts: []
    };
    await appendFile(join(workspace.path, "entities", "test-suites.jsonl"), "{}\n");

    const reconciliation = await workspace.reconcile(manifest);

    expect(reconciliation.checks.fileHashes.status).toBe("FAIL");
    expect(reconciliation.checks.counts.status).toBe("FAIL");
    await workspace.close();
  });

  it("拒绝未知实体、非 Artifact 路径、重复文件和关闭后写入", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-canonical-workspace-"));
    roots.push(projectRoot);
    await mkdir(join(projectRoot, ".cortex-eval"), { mode: 0o700 });
    const workspace = await CanonicalExportWorkspace.create(manager(projectRoot));

    await expect(
      workspace.write("UNKNOWN" as CanonicalEntityType, values<string>())
    ).rejects.toThrow("CANONICAL_ENTITY_TYPE_INVALID");
    await expect(workspace.writeBinary("control.bin", values<Uint8Array>())).rejects.toThrow(
      "CANONICAL_ARTIFACT_PATH_INVALID"
    );
    await expect(workspace.remove("control.bin")).rejects.toThrow(
      "CANONICAL_ARTIFACT_PATH_INVALID"
    );
    await workspace.writeJson("manifest.json", {});
    await expect(workspace.writeJson("manifest.json", {})).rejects.toThrow(
      "CANONICAL_EXPORT_FILE_EXISTS"
    );
    await workspace.close();
    await workspace.close();
    await expect(workspace.writeJson("reconciliation.json", {})).rejects.toThrow(
      "CANONICAL_EXPORT_WORKSPACE_CLOSED"
    );
  });

  it("写入遇到非法二进制 Chunk 或来源异常时删除半文件", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-canonical-workspace-"));
    roots.push(projectRoot);
    await mkdir(join(projectRoot, ".cortex-eval"), { mode: 0o700 });
    const workspace = await CanonicalExportWorkspace.create(manager(projectRoot));
    const invalidParts = (async function* (): AsyncGenerator<number> {
      await Promise.resolve();
      yield 42;
    })() as unknown as AsyncIterable<Uint8Array>;

    await expect(workspace.writeBinary("artifacts/invalid.bin", invalidParts)).rejects.toThrow(
      "CANONICAL_EXPORT_STREAM_INVALID"
    );
    await expect(stat(join(workspace.path, "artifacts", "invalid.bin"))).rejects.toMatchObject({
      code: "ENOENT"
    });

    const failingParts = async function* (): AsyncGenerator<Uint8Array> {
      await Promise.resolve();
      yield Buffer.from("prefix");
      throw new Error("SOURCE_FAILED");
    };
    await expect(
      workspace.writeBinary("artifacts/source-failed.bin", failingParts())
    ).rejects.toThrow("SOURCE_FAILED");
    await expect(
      stat(join(workspace.path, "artifacts", "source-failed.bin"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    await workspace.close();
  });

  it("把纳入的 Raw 文件计入独立文件 Hash 对账并拒绝后续篡改", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-canonical-workspace-"));
    roots.push(projectRoot);
    await mkdir(join(projectRoot, ".cortex-eval"), { mode: 0o700 });
    const workspace = await CanonicalExportWorkspace.create(manager(projectRoot));
    const projection = await new CanonicalExportProjectionService().project(snapshot(), workspace);
    const bytes = Buffer.from("raw-evidence");
    const artifactFacts = await workspace.writeBinary(
      `artifacts/runs/${ID}/raw-promptfoo-evidence.bin`,
      values(bytes)
    );
    const manifest: CanonicalExportManifestV1 = {
      contractVersion: "cortex.canonical-export-manifest.v1",
      exportId: ID,
      createdAt: NOW,
      rawEvidenceIncluded: true,
      contractVersions: { canonicalExport: "cortex.canonical-export-manifest.v1" },
      entityFiles: [...projection.entityFiles],
      artifacts: [
        {
          owner: { type: "RUN", key: { id: ID } },
          kind: "RAW_PROMPTFOO_EVIDENCE",
          sourcePath: `runs/${ID}/raw.jsonl`,
          included: true,
          exportPath: `artifacts/runs/${ID}/raw-promptfoo-evidence.bin`,
          expectedSha256: artifactFacts.sha256,
          expectedSizeBytes: artifactFacts.sizeBytes,
          present: true,
          actualSha256: artifactFacts.sha256,
          actualSizeBytes: artifactFacts.sizeBytes
        }
      ]
    };

    await expect(workspace.reconcile(manifest)).resolves.toMatchObject({
      checks: { fileHashes: { status: "PASS", checked: 11 } }
    });
    await appendFile(
      join(workspace.path, `artifacts/runs/${ID}/raw-promptfoo-evidence.bin`),
      "tampered"
    );
    await expect(workspace.reconcile(manifest)).resolves.toMatchObject({
      checks: { fileHashes: { status: "FAIL", checked: 11 } }
    });
    await workspace.close();
  });

  it("实体 Hash 可通过但强引用缺失时只让引用对账失败", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-canonical-workspace-"));
    roots.push(projectRoot);
    await mkdir(join(projectRoot, ".cortex-eval"), { mode: 0o700 });
    const workspace = await CanonicalExportWorkspace.create(manager(projectRoot));
    const entityKey = { id: ID };
    const references = [{ entityType: "TEST_SUITE" as const, entityKey: { id: ID } }];
    const payload = { id: ID, name: "Orphan" };
    const entityHash = sha256CanonicalJson({
      entityType: "TEST_CASE",
      entityKey,
      payload,
      references
    });
    const line = `${canonicalJson({
      contractVersion: "cortex.canonical-entity-record.v1",
      entityType: "TEST_CASE",
      entityKey,
      entityHash,
      payload,
      references
    })}\n`;
    const entityFiles = [];
    for (const file of CANONICAL_ENTITY_FILE_ORDER) {
      const facts = await workspace.write(
        file.entityType,
        values(...(file.entityType === "TEST_CASE" ? [line] : []))
      );
      entityFiles.push({
        ...file,
        count: file.entityType === "TEST_CASE" ? 1 : 0,
        ...facts
      });
    }
    const manifest: CanonicalExportManifestV1 = {
      contractVersion: "cortex.canonical-export-manifest.v1",
      exportId: ID,
      createdAt: NOW,
      rawEvidenceIncluded: false,
      contractVersions: { canonicalExport: "cortex.canonical-export-manifest.v1" },
      entityFiles,
      artifacts: []
    };

    await expect(workspace.reconcile(manifest)).resolves.toMatchObject({
      checks: {
        counts: { status: "PASS" },
        references: { status: "FAIL", checked: 1 },
        entityHashes: { status: "PASS" },
        fileHashes: { status: "PASS" }
      }
    });
    await workspace.close();
  });
});
