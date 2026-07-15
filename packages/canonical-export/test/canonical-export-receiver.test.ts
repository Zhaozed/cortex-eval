import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CANONICAL_ENTITY_FILES_V1,
  CanonicalExportEventV1Schema,
  type CanonicalExportEventV1,
  type CanonicalExportManifestV1,
  type CanonicalExportReconciliationV1
} from "@cortex-eval/contracts/src/canonical-export-contracts.ts";
import { canonicalJson } from "@cortex-eval/domain/src/domain-canonical-hash.ts";
import { afterEach, describe, expect, it } from "vitest";

import { receiveCanonicalExport } from "../src/canonical-export-receiver.ts";

const EXPORT_ID = "018f1e2d-3c4b-7abc-8def-0123456789ab";
const OTHER_EXPORT_ID = "018f1e2d-3c4b-7abc-8def-0123456789ac";
const EMPTY_HASH = createHash("sha256").update("").digest("hex");
const roots: string[] = [];

function descriptor(
  path: string,
  bytes: Buffer
): {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
} {
  return {
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.byteLength
  };
}

function fixture(): {
  readonly events: CanonicalExportEventV1[];
  readonly manifest: CanonicalExportManifestV1;
} {
  const manifest: CanonicalExportManifestV1 = {
    contractVersion: "cortex.canonical-export-manifest.v1",
    exportId: EXPORT_ID,
    createdAt: "2026-07-15T00:00:00.000Z",
    rawEvidenceIncluded: false,
    contractVersions: { canonicalExport: "cortex.canonical-export-manifest.v1" },
    entityFiles: CANONICAL_ENTITY_FILES_V1.map((file) => ({
      ...file,
      count: 0,
      sha256: EMPTY_HASH,
      sizeBytes: 0
    })),
    artifacts: []
  };
  const reconciliation: CanonicalExportReconciliationV1 = {
    contractVersion: "cortex.canonical-export-reconciliation.v1",
    exportId: EXPORT_ID,
    checks: {
      counts: { status: "PASS", checked: 0 },
      references: { status: "PASS", checked: 0 },
      entityHashes: { status: "PASS", checked: 0 },
      fileHashes: { status: "PASS", checked: 10 }
    }
  };
  const manifestBytes = Buffer.from(canonicalJson(manifest), "utf8");
  const reconciliationBytes = Buffer.from(canonicalJson(reconciliation), "utf8");
  const manifestFile = descriptor("manifest.json", manifestBytes);
  const reconciliationFile = descriptor("reconciliation.json", reconciliationBytes);
  const events: CanonicalExportEventV1[] = [
    {
      type: "EXPORT_START",
      exportId: EXPORT_ID,
      manifest: { ...manifestFile, path: "manifest.json" }
    },
    {
      type: "FILE_CHUNK",
      path: "manifest.json",
      sequence: 0,
      dataBase64: manifestBytes.toString("base64")
    },
    { type: "FILE_END", path: "manifest.json" }
  ];
  for (const file of manifest.entityFiles) {
    events.push(
      {
        type: "FILE_START",
        file: { path: file.path, sha256: file.sha256, sizeBytes: file.sizeBytes }
      },
      { type: "FILE_END", path: file.path }
    );
  }
  events.push(
    { type: "FILE_START", file: reconciliationFile },
    {
      type: "FILE_CHUNK",
      path: "reconciliation.json",
      sequence: 0,
      dataBase64: reconciliationBytes.toString("base64")
    },
    { type: "FILE_END", path: "reconciliation.json" },
    {
      type: "EXPORT_END",
      exportId: EXPORT_ID,
      reconciliation: { ...reconciliationFile, path: "reconciliation.json" }
    }
  );
  for (const event of events) CanonicalExportEventV1Schema.parse(event);
  return { events, manifest };
}

async function* encode(events: readonly CanonicalExportEventV1[]): AsyncGenerator<Buffer> {
  await Promise.resolve();
  for (const event of events) yield Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
}

function owner(): {
  readonly pid: number;
  readonly processStartedAt: string;
  readonly executionId: null;
  readonly acquiredAt: string;
} {
  return {
    pid: process.pid,
    processStartedAt: "process-start",
    executionId: null,
    acquiredAt: "2026-07-15T00:00:00.000Z"
  };
}

function replaceControl(
  events: CanonicalExportEventV1[],
  path: "manifest.json" | "reconciliation.json",
  bytes: Buffer
): void {
  const facts = descriptor(path, bytes);
  const chunkIndex = events.findIndex(
    (event) => event.type === "FILE_CHUNK" && event.path === path
  );
  const chunk = events[chunkIndex];
  if (chunk?.type !== "FILE_CHUNK") throw new Error("TEST_FIXTURE_INVALID");
  events[chunkIndex] = { ...chunk, dataBase64: bytes.toString("base64") };
  if (path === "manifest.json") {
    events[0] = {
      type: "EXPORT_START",
      exportId: EXPORT_ID,
      manifest: { ...facts, path: "manifest.json" }
    };
    return;
  }
  const startIndex = events.findIndex(
    (event) => event.type === "FILE_START" && event.file.path === path
  );
  events[startIndex] = { type: "FILE_START", file: facts };
  events[events.length - 1] = {
    type: "EXPORT_END",
    exportId: EXPORT_ID,
    reconciliation: { ...facts, path: "reconciliation.json" }
  };
}

async function expectRejected(
  parent: string,
  name: string,
  events: readonly CanonicalExportEventV1[],
  code: string
): Promise<void> {
  await expect(
    receiveCanonicalExport(encode(events), join(parent, name), {
      nonce: `canonical-${name}-nonce`,
      owner: owner(),
      rawEvidenceIncluded: false
    })
  ).rejects.toThrow(code);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Canonical Export 接收端", () => {
  it("重新校验完整导出并原子发布目录", async () => {
    const parent = await mkdtemp(join(tmpdir(), "cortex-canonical-receiver-"));
    roots.push(parent);
    const target = join(parent, "migration-export");
    const { events, manifest } = fixture();

    await expect(
      receiveCanonicalExport(encode(events), target, {
        nonce: "canonical-receiver-nonce",
        owner: owner(),
        rawEvidenceIncluded: false
      })
    ).resolves.toEqual({
      exportId: EXPORT_ID,
      manifestSha256: descriptor("manifest.json", Buffer.from(canonicalJson(manifest))).sha256,
      targetPath: target
    });
    expect(JSON.parse(await readFile(join(target, "manifest.json"), "utf8"))).toMatchObject({
      exportId: EXPORT_ID
    });
  });

  it("截断或伪造四类对账时拒绝发布并清理暂存目录", async () => {
    const parent = await mkdtemp(join(tmpdir(), "cortex-canonical-receiver-"));
    roots.push(parent);
    const first = fixture();
    await expect(
      receiveCanonicalExport(encode(first.events.slice(0, -1)), join(parent, "truncated"), {
        nonce: "canonical-truncated-nonce",
        owner: owner(),
        rawEvidenceIncluded: false
      })
    ).rejects.toThrow("CANONICAL_EXPORT_STREAM_TRUNCATED");

    const forged = fixture();
    const chunkIndex = forged.events.findIndex(
      (event) => event.type === "FILE_CHUNK" && event.path === "reconciliation.json"
    );
    const chunk = forged.events[chunkIndex];
    if (chunk?.type !== "FILE_CHUNK") throw new Error("TEST_FIXTURE_INVALID");
    const dirty = JSON.parse(Buffer.from(chunk.dataBase64, "base64").toString("utf8")) as {
      checks: { fileHashes: { checked: number } };
    };
    dirty.checks.fileHashes.checked = 0;
    const bytes = Buffer.from(canonicalJson(dirty), "utf8");
    const facts = descriptor("reconciliation.json", bytes);
    forged.events[chunkIndex] = { ...chunk, dataBase64: bytes.toString("base64") };
    const startIndex = forged.events.findIndex(
      (event) => event.type === "FILE_START" && event.file.path === "reconciliation.json"
    );
    forged.events[startIndex] = { type: "FILE_START", file: facts };
    forged.events[forged.events.length - 1] = {
      type: "EXPORT_END",
      exportId: EXPORT_ID,
      reconciliation: { ...facts, path: "reconciliation.json" }
    };
    await expect(
      receiveCanonicalExport(encode(forged.events), join(parent, "forged"), {
        nonce: "canonical-forged-nonce",
        owner: owner(),
        rawEvidenceIncluded: false
      })
    ).rejects.toThrow("CANONICAL_EXPORT_RECONCILIATION_FAILED");
    expect((await readdir(parent)).filter((name) => name.startsWith(".cortex-export-"))).toEqual(
      []
    );
  });

  it("拒绝状态机中的起始、开放文件、文件顺序和结束身份漂移", async () => {
    const parent = await mkdtemp(join(tmpdir(), "cortex-canonical-receiver-state-"));
    roots.push(parent);

    const beforeStart = fixture().events;
    beforeStart[0] = { type: "FILE_END", path: "manifest.json" };
    await expectRejected(parent, "before-start", beforeStart, "CANONICAL_EXPORT_EVENT_INVALID");

    const wrongSequence = fixture().events;
    const firstChunk = wrongSequence[1];
    if (firstChunk?.type !== "FILE_CHUNK") throw new Error("TEST_FIXTURE_INVALID");
    wrongSequence[1] = { ...firstChunk, sequence: 1 };
    await expectRejected(parent, "wrong-sequence", wrongSequence, "CANONICAL_EXPORT_EVENT_INVALID");

    const wrongOpenEvent = fixture().events;
    wrongOpenEvent[1] = {
      type: "FILE_START",
      file: { path: "entities/test-suites.jsonl", sha256: EMPTY_HASH, sizeBytes: 0 }
    };
    await expectRejected(parent, "wrong-open", wrongOpenEvent, "CANONICAL_EXPORT_EVENT_INVALID");

    const wrongFile = fixture().events;
    const fileIndex = wrongFile.findIndex((event) => event.type === "FILE_START");
    const fileStart = wrongFile[fileIndex];
    if (fileStart?.type !== "FILE_START") throw new Error("TEST_FIXTURE_INVALID");
    wrongFile[fileIndex] = {
      ...fileStart,
      file: { ...fileStart.file, sha256: "b".repeat(64) }
    };
    await expectRejected(parent, "wrong-file", wrongFile, "CANONICAL_EXPORT_EVENT_INVALID");

    const wrongEnd = fixture().events;
    const end = wrongEnd.at(-1);
    if (end?.type !== "EXPORT_END") throw new Error("TEST_FIXTURE_INVALID");
    wrongEnd[wrongEnd.length - 1] = { ...end, exportId: OTHER_EXPORT_ID };
    await expectRejected(parent, "wrong-end", wrongEnd, "CANONICAL_EXPORT_EVENT_INVALID");

    const afterDone = fixture().events;
    afterDone.push({ ...afterDone[0] } as CanonicalExportEventV1);
    await expectRejected(parent, "after-done", afterDone, "CANONICAL_EXPORT_EVENT_INVALID");
  });

  it("拒绝 Manifest/Reconciliation 控制文档的编码、Schema 和 Export 身份漂移", async () => {
    const parent = await mkdtemp(join(tmpdir(), "cortex-canonical-receiver-control-"));
    roots.push(parent);

    const invalidJson = fixture().events;
    replaceControl(invalidJson, "manifest.json", Buffer.from("{"));
    await expectRejected(parent, "invalid-json", invalidJson, "CANONICAL_EXPORT_EVENT_INVALID");

    const invalidSchema = fixture().events;
    replaceControl(invalidSchema, "manifest.json", Buffer.from(canonicalJson({ invalid: true })));
    await expectRejected(parent, "invalid-schema", invalidSchema, "CANONICAL_EXPORT_EVENT_INVALID");

    const wrongManifestIdentity = fixture();
    replaceControl(
      wrongManifestIdentity.events,
      "manifest.json",
      Buffer.from(canonicalJson({ ...wrongManifestIdentity.manifest, exportId: OTHER_EXPORT_ID }))
    );
    await expectRejected(
      parent,
      "wrong-manifest-id",
      wrongManifestIdentity.events,
      "CANONICAL_EXPORT_EVENT_INVALID"
    );

    const wrongReconciliationIdentity = fixture().events;
    const reconciliationChunk = wrongReconciliationIdentity.find(
      (event) => event.type === "FILE_CHUNK" && event.path === "reconciliation.json"
    );
    if (reconciliationChunk?.type !== "FILE_CHUNK") throw new Error("TEST_FIXTURE_INVALID");
    const reconciliation = JSON.parse(
      Buffer.from(reconciliationChunk.dataBase64, "base64").toString("utf8")
    ) as CanonicalExportReconciliationV1;
    replaceControl(
      wrongReconciliationIdentity,
      "reconciliation.json",
      Buffer.from(canonicalJson({ ...reconciliation, exportId: OTHER_EXPORT_ID }))
    );
    await expectRejected(
      parent,
      "wrong-reconciliation-id",
      wrongReconciliationIdentity,
      "CANONICAL_EXPORT_EVENT_INVALID"
    );
  });

  it("把本次 Raw Evidence 授权绑定到 Manifest", async () => {
    const parent = await mkdtemp(join(tmpdir(), "cortex-canonical-receiver-consent-"));
    roots.push(parent);
    const response = fixture();
    replaceControl(
      response.events,
      "manifest.json",
      Buffer.from(canonicalJson({ ...response.manifest, rawEvidenceIncluded: true }))
    );

    await expectRejected(
      parent,
      "raw-consent-mismatch",
      response.events,
      "CANONICAL_EXPORT_EVENT_INVALID"
    );
  });
});
