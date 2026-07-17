import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SecureWorkPackageDirectory } from "../src/secure-work-package-directory.ts";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cortex-stream-writer-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("immutable file stream writer", () => {
  it("computes exact integrity while streaming content whose hash is initially unknown", async () => {
    const root = await temporaryRoot();
    const directory = await SecureWorkPackageDirectory.open(root);
    const value = Buffer.from("computed-stream");
    const writer = await directory.createComputedFileWriter(
      "inputs/tests.jsonl",
      value.byteLength,
      "writer-computed"
    );
    await writer.append(value.subarray(0, 4));
    await writer.append(value.subarray(4));
    const published = await writer.commit();
    expect(published.integrity).toEqual({
      path: "inputs/tests.jsonl",
      sha256: createHash("sha256").update(value).digest("hex"),
      sizeBytes: value.byteLength
    });
    expect(published.publicationIdentity.device).toMatch(/^\d+$/);
    expect(published.publicationIdentity.inode).toMatch(/^\d+$/);
    directory.close();
    expect(await readFile(join(root, "inputs/tests.jsonl"), "utf8")).toBe("computed-stream");
  });

  it("rejects a computed stream over its role limit and leaves no target", async () => {
    const root = await temporaryRoot();
    const directory = await SecureWorkPackageDirectory.open(root);
    const writer = await directory.createComputedFileWriter("value.json", 2, "writer-limit");
    await expect(writer.append(Buffer.from("abc"))).rejects.toThrow("WORK_PACKAGE_INPUT_TOO_LARGE");
    await writer.abort();
    expect(directory.listTree()).toEqual([]);
    directory.close();
  });

  it("publishes streamed chunks only after exact size and hash validation", async () => {
    const root = await temporaryRoot();
    const directory = await SecureWorkPackageDirectory.open(root);
    const value = Buffer.from("complete-stream");
    const writer = await directory.createImmutableFileWriter(
      {
        path: "inputs/tests.jsonl",
        sha256: createHash("sha256").update(value).digest("hex"),
        sizeBytes: value.byteLength
      },
      "writer-ok"
    );
    await writer.append(value.subarray(0, 5));
    await writer.append(value.subarray(5));
    await writer.commit();
    directory.close();
    expect(await readFile(join(root, "inputs/tests.jsonl"), "utf8")).toBe("complete-stream");
  });

  it("rejects overrun before writing and removes the unpublished temporary file", async () => {
    const root = await temporaryRoot();
    const directory = await SecureWorkPackageDirectory.open(root);
    const writer = await directory.createImmutableFileWriter(
      { path: "value.json", sha256: "0".repeat(64), sizeBytes: 2 },
      "writer-overrun"
    );
    await expect(writer.append(Buffer.from("abc"))).rejects.toThrow("ARTIFACT_HASH_MISMATCH");
    await writer.abort();
    expect(directory.listTree()).toEqual([]);
    directory.close();
  });

  it("rejects incomplete/hash-mismatched content and never exposes the target", async () => {
    const root = await temporaryRoot();
    const directory = await SecureWorkPackageDirectory.open(root);
    const writer = await directory.createImmutableFileWriter(
      { path: "value.json", sha256: "0".repeat(64), sizeBytes: 3 },
      "writer-mismatch"
    );
    await writer.append(Buffer.from("abc"));
    await expect(writer.commit()).rejects.toThrow("ARTIFACT_HASH_MISMATCH");
    expect(directory.listTree()).toEqual([]);
    directory.close();
  });

  it("removes a linked target when the post-link directory sync fails", async () => {
    const root = await temporaryRoot();
    let syncCalls = 0;
    const directory = await SecureWorkPackageDirectory.open(root, {
      syncDirectoryDescriptor: (descriptor): void => {
        syncCalls += 1;
        if (syncCalls === 1) throw new Error(`TEST_POST_LINK_SYNC_FAILED:${descriptor}`);
      }
    });
    const writer = await directory.createComputedFileWriter("value.json", 3, "writer-post-link");
    await writer.append(Buffer.from("abc"));

    await expect(writer.commit()).rejects.toThrow("ARTIFACT_WRITE_FAILED");
    expect(directory.listTree()).toEqual([]);
    directory.close();
  });

  it("preserves the post-link sync error when compensation reporting also fails", async () => {
    const root = await temporaryRoot();
    let cleanupReports = 0;
    const directory = await SecureWorkPackageDirectory.open(root, {
      syncDirectoryDescriptor: (): never => {
        throw new Error("TEST_DIRECTORY_SYNC_FAILED");
      },
      onCleanupFailure: (): Promise<void> => {
        cleanupReports += 1;
        return Promise.reject(new Error("TEST_CLEANUP_REPORT_FAILED"));
      }
    });
    const writer = await directory.createComputedFileWriter("value.json", 3, "writer-report-fail");
    await writer.append(Buffer.from("abc"));

    await expect(writer.commit()).rejects.toThrow("ARTIFACT_WRITE_FAILED");
    expect(cleanupReports).toBe(1);
    expect(directory.listTree()).toEqual([]);
    directory.close();
  });
});
