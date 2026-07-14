import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WorkPackageExportEventV1 } from "../../contracts/src/work-package-runtime-contracts.ts";
import { afterEach, describe, expect, it } from "vitest";

import {
  materializeWorkPackageFixture,
  WORK_PACKAGE_FIXTURE_ID
} from "../test-support/work-package-fixture.ts";
import { receiveWorkPackageExport } from "../src/work-package-export-receiver.ts";
import type { WorkPackageLockOwner } from "../src/secure-work-package-directory.ts";
import { validateWorkPackage } from "../src/work-package-validator.ts";

const roots: string[] = [];

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function owner(): WorkPackageLockOwner {
  return {
    pid: process.pid,
    processStartedAt: "Tue Jul 14 14:00:00 2026",
    executionId: null,
    acquiredAt: "2026-07-14T06:00:00.000Z"
  } as const;
}

async function exportEvents(source: string): Promise<WorkPackageExportEventV1[]> {
  const manifestBytes = await readFile(join(source, "manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
    packageId: string;
    inputs: {
      tests: { path: string; sha256: string; sizeBytes: number };
      endpoint: { path: string; sha256: string; sizeBytes: number };
      evaluator: { path: string; sha256: string; sizeBytes: number };
      analyzer: { path: string; sha256: string; sizeBytes: number };
      analysisPrompt: { path: string; sha256: string; sizeBytes: number };
      envExample: { path: string; sha256: string; sizeBytes: number };
      rubricPrompts: { path: string; sha256: string; sizeBytes: number }[];
    };
  };
  const files = [
    manifest.inputs.tests,
    manifest.inputs.endpoint,
    manifest.inputs.evaluator,
    manifest.inputs.analyzer,
    manifest.inputs.analysisPrompt,
    manifest.inputs.envExample,
    ...manifest.inputs.rubricPrompts
  ];
  const events: WorkPackageExportEventV1[] = [
    {
      type: "PACKAGE_START",
      manifest: {
        path: "manifest.json",
        sha256: createHash("sha256").update(manifestBytes).digest("hex"),
        sizeBytes: manifestBytes.byteLength
      }
    },
    {
      type: "FILE_CHUNK",
      path: "manifest.json",
      sequence: 0,
      dataBase64: manifestBytes.toString("base64")
    },
    { type: "FILE_END", path: "manifest.json" }
  ];
  for (const file of files) {
    const bytes = await readFile(join(source, file.path));
    const descriptor = {
      path: file.path,
      sha256: file.sha256,
      sizeBytes: file.sizeBytes
    };
    events.push(
      { type: "FILE_START", file: descriptor },
      { type: "FILE_CHUNK", path: file.path, sequence: 0, dataBase64: bytes.toString("base64") },
      { type: "FILE_END", path: file.path }
    );
  }
  events.push({ type: "PACKAGE_END", packageId: manifest.packageId });
  return events;
}

async function* encodedEvents(
  events: readonly WorkPackageExportEventV1[]
): AsyncIterable<Uint8Array> {
  for (const event of events) {
    await Promise.resolve();
    const line = Buffer.from(`${JSON.stringify(event)}\n`);
    const middle = Math.floor(line.byteLength / 2);
    yield line.subarray(0, middle);
    yield line.subarray(middle);
  }
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Work Package export receiver", () => {
  it("receives manifest-first NDJSON and atomically publishes a validated package", async () => {
    const source = await temporaryRoot("cortex-export-source-");
    const parent = await temporaryRoot("cortex-export-target-");
    await materializeWorkPackageFixture(source);
    const target = join(parent, "package");
    await expect(
      receiveWorkPackageExport(encodedEvents(await exportEvents(source)), target, {
        nonce: "receiver-happy",
        owner: owner()
      })
    ).resolves.toMatchObject({ packageId: WORK_PACKAGE_FIXTURE_ID, targetPath: target });
    await expect(validateWorkPackage(target, owner())).resolves.toMatchObject({
      manifest: { packageId: WORK_PACKAGE_FIXTURE_ID }
    });
    expect((await readdir(parent)).sort()).toEqual(["package"]);
  });

  it("removes unpublished staging after a truncated stream", async () => {
    const source = await temporaryRoot("cortex-export-source-");
    const parent = await temporaryRoot("cortex-export-target-");
    await materializeWorkPackageFixture(source);
    const events = await exportEvents(source);
    await expect(
      receiveWorkPackageExport(encodedEvents(events.slice(0, -1)), join(parent, "package"), {
        nonce: "receiver-truncated",
        owner: owner()
      })
    ).rejects.toThrow("EXPORT_STREAM_TRUNCATED");
    expect(await readdir(parent)).toEqual([]);
  });

  it("preserves the stream error when staging cleanup also fails", async () => {
    const parent = await temporaryRoot("cortex-export-target-");
    const staging = join(parent, ".cortex-export-receiver_cleanup");
    const cleanupFailures: string[] = [];
    async function* invalidStream(): AsyncIterable<Uint8Array> {
      await mkdir(join(staging, "blocked"), { mode: 0o700 });
      await chmod(join(staging, "blocked"), 0o000);
      yield* encodedEvents([{ type: "PACKAGE_END", packageId: WORK_PACKAGE_FIXTURE_ID }]);
    }

    try {
      await expect(
        receiveWorkPackageExport(invalidStream(), join(parent, "package"), {
          nonce: "receiver_cleanup",
          owner: owner(),
          cleanupFailureSink: {
            record: (failure): Promise<void> => {
              cleanupFailures.push(failure.code);
              return Promise.reject(new Error("TEST_CLEANUP_SINK_FAILED"));
            }
          }
        })
      ).rejects.toThrow("EXPORT_EVENT_INVALID");
      expect(cleanupFailures).toEqual(["TEMP_CLEANUP_FAILED"]);
    } finally {
      await chmod(join(staging, "blocked"), 0o700);
    }
  });

  it("never replaces an existing target directory", async () => {
    const source = await temporaryRoot("cortex-export-source-");
    const parent = await temporaryRoot("cortex-export-target-");
    await materializeWorkPackageFixture(source);
    await mkdir(join(parent, "package"));
    await writeFile(join(parent, "package", "keep"), "keep");
    await expect(
      receiveWorkPackageExport(encodedEvents(await exportEvents(source)), join(parent, "package"), {
        nonce: "receiver-conflict",
        owner: owner()
      })
    ).rejects.toThrow("WORK_PACKAGE_TARGET_EXISTS");
    expect(await readFile(join(parent, "package", "keep"), "utf8")).toBe("keep");
    expect((await readdir(parent)).sort()).toEqual(["package"]);
  });
});
