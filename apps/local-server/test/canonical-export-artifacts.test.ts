import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CanonicalExpectedArtifact } from "@cortex-eval/application/src/features/canonical-export/canonical-export-projection-service.ts";
import {
  CaseImportWorkspaceManager,
  type ProcessLiveness
} from "@cortex-eval/storage-sqlite/src/case-import-workspace.ts";
import { afterEach, describe, expect, it } from "vitest";

import { collectCanonicalArtifacts } from "../src/canonical-export-artifacts.ts";
import { CanonicalExportWorkspace } from "../src/canonical-export-workspace.ts";

const ID = "018f1e2d-3c4b-7abc-8def-0123456789ab";
const OTHER_ID = "018f1e2d-3c4b-7abc-8def-0123456789ac";
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
    nonce: (): string => "artifact-nonce",
    pid: process.pid,
    ttlMs: 60_000,
    workspacePrefix: "canonical-export-"
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Canonical Export Artifact 状态", () => {
  it("分别记录源可用性和 Raw 是否复制，不把未选择复制误判为缺失", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-canonical-artifact-"));
    roots.push(projectRoot);
    const artifactRoot = join(projectRoot, ".cortex-eval", "artifacts");
    await mkdir(join(artifactRoot, "runs", ID), { recursive: true, mode: 0o700 });
    const bytes = Buffer.from("raw-evidence", "utf8");
    const sourcePath = `runs/${ID}/raw.jsonl`;
    await writeFile(join(artifactRoot, sourcePath), bytes, { mode: 0o600 });
    const expected: CanonicalExpectedArtifact = {
      owner: { type: "RUN", key: { id: ID } },
      kind: "RAW_PROMPTFOO_EVIDENCE",
      sourcePath,
      expectedSha256: createHash("sha256").update(bytes).digest("hex"),
      expectedSizeBytes: bytes.byteLength
    };
    const withoutRaw = await CanonicalExportWorkspace.create(manager(projectRoot));

    expect(await collectCanonicalArtifacts(artifactRoot, withoutRaw, [expected], false)).toEqual([
      {
        owner: { type: "RUN", key: { id: ID } },
        kind: "RAW_PROMPTFOO_EVIDENCE",
        sourcePath,
        included: false,
        exportPath: null,
        expectedSha256: expected.expectedSha256,
        expectedSizeBytes: bytes.byteLength,
        present: true,
        actualSha256: expected.expectedSha256,
        actualSizeBytes: bytes.byteLength
      }
    ]);
    await withoutRaw.close();

    const withRaw = await CanonicalExportWorkspace.create(manager(projectRoot));
    const included = await collectCanonicalArtifacts(artifactRoot, withRaw, [expected], true);
    expect(included[0]).toMatchObject({ present: true, included: true });
    expect(included[0]?.exportPath).toBe(`artifacts/runs/${ID}/raw-promptfoo-evidence.bin`);
    expect(
      await readFile(join(withRaw.path, `artifacts/runs/${ID}/raw-promptfoo-evidence.bin`))
    ).toEqual(bytes);
    await withRaw.close();
  });

  it("源缺失或 Hash 不符时保留预期元数据并标记不可用", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-canonical-artifact-"));
    roots.push(projectRoot);
    const artifactRoot = join(projectRoot, ".cortex-eval", "artifacts");
    await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
    const workspace = await CanonicalExportWorkspace.create(manager(projectRoot));
    const expected: CanonicalExpectedArtifact = {
      owner: { type: "RUN", key: { id: ID } },
      kind: "REPORT_JSON",
      sourcePath: `runs/${ID}/missing.json`,
      expectedSha256: "a".repeat(64),
      expectedSizeBytes: 10
    };

    expect(await collectCanonicalArtifacts(artifactRoot, workspace, [expected], true)).toEqual([
      {
        owner: expected.owner,
        kind: expected.kind,
        sourcePath: expected.sourcePath,
        included: false,
        exportPath: null,
        expectedSha256: expected.expectedSha256,
        expectedSizeBytes: expected.expectedSizeBytes,
        present: false,
        actualSha256: null,
        actualSizeBytes: null
      }
    ]);
    await workspace.close();
  });

  it("Artifact 根不可打开时按稳定顺序保留全部不可用元数据", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-canonical-artifact-"));
    roots.push(projectRoot);
    await mkdir(join(projectRoot, ".cortex-eval"), { mode: 0o700 });
    const workspace = await CanonicalExportWorkspace.create(manager(projectRoot));
    const artifacts: readonly CanonicalExpectedArtifact[] = [
      {
        owner: { type: "RUN", key: { id: OTHER_ID } },
        kind: "REPORT_JSON",
        sourcePath: `runs/${OTHER_ID}/report.json`,
        expectedSha256: "b".repeat(64),
        expectedSizeBytes: 20
      },
      {
        owner: { type: "RUN", key: { id: ID } },
        kind: "RAW_PROMPTFOO_EVIDENCE",
        sourcePath: `runs/${ID}/raw.jsonl`,
        expectedSha256: "a".repeat(64),
        expectedSizeBytes: 10
      }
    ];

    const result = await collectCanonicalArtifacts(
      join(projectRoot, ".cortex-eval", "missing-artifacts"),
      workspace,
      artifacts,
      true
    );

    expect(
      result.map((artifact) => ("id" in artifact.owner.key ? artifact.owner.key.id : "invalid"))
    ).toEqual([ID, OTHER_ID]);
    expect(result.every((artifact) => !artifact.present && !artifact.included)).toBe(true);
    await workspace.close();
  });

  it("拒绝重复 Artifact 身份", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-canonical-artifact-"));
    roots.push(projectRoot);
    await mkdir(join(projectRoot, ".cortex-eval"), { mode: 0o700 });
    const workspace = await CanonicalExportWorkspace.create(manager(projectRoot));
    const artifact: CanonicalExpectedArtifact = {
      owner: { type: "RUN", key: { id: ID } },
      kind: "REPORT_JSON",
      sourcePath: `runs/${ID}/report.json`,
      expectedSha256: "a".repeat(64),
      expectedSizeBytes: 10
    };

    await expect(
      collectCanonicalArtifacts(
        join(projectRoot, "missing"),
        workspace,
        [artifact, artifact],
        false
      )
    ).rejects.toThrow("CANONICAL_ARTIFACT_DUPLICATE");
    await workspace.close();
  });

  it("选择复制的 Raw 与预期不符时删除副本并降级为不可用", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-canonical-artifact-"));
    roots.push(projectRoot);
    const artifactRoot = join(projectRoot, ".cortex-eval", "artifacts");
    await mkdir(join(artifactRoot, "runs", ID), { recursive: true, mode: 0o700 });
    const sourcePath = `runs/${ID}/raw.jsonl`;
    await writeFile(join(artifactRoot, sourcePath), "changed", { mode: 0o600 });
    const workspace = await CanonicalExportWorkspace.create(manager(projectRoot));
    const expected: CanonicalExpectedArtifact = {
      owner: { type: "RUN", key: { id: ID } },
      kind: "RAW_PROMPTFOO_EVIDENCE",
      sourcePath,
      expectedSha256: "a".repeat(64),
      expectedSizeBytes: 7
    };

    await expect(
      collectCanonicalArtifacts(artifactRoot, workspace, [expected], true)
    ).resolves.toEqual([
      expect.objectContaining({ present: false, included: false, exportPath: null })
    ]);
    await expect(
      stat(join(workspace.path, `artifacts/runs/${ID}/raw-promptfoo-evidence.bin`))
    ).rejects.toMatchObject({ code: "ENOENT" });
    await workspace.close();
  });
});
