import { createHash } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SecureWorkPackageDirectory } from "../src/secure-work-package-directory.ts";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cortex-work-package-fs-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Secure Work Package directory", () => {
  it("removes only the immutable file matching the complete descriptor", async () => {
    const root = await temporaryRoot();
    const directory = await SecureWorkPackageDirectory.open(root);
    const path = "executions/one/rest-results.jsonl";
    const value = Buffer.from("result\n", "utf8");
    const writer = await directory.createComputedFileWriter(
      path,
      value.byteLength,
      "matching-file"
    );
    await writer.append(value);
    const published = await writer.commit();

    await expect(directory.removeFileIfMatches(published)).resolves.toBe(true);
    await expect(lstat(join(root, path))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(directory.removeFileIfMatches(published)).resolves.toBe(true);
    directory.close();
  });

  it("preserves an immutable file whose size or hash does not match", async () => {
    const root = await temporaryRoot();
    const directory = await SecureWorkPackageDirectory.open(root);
    const path = "executions/one/rest-results.jsonl";
    const value = Buffer.from("actual\n", "utf8");
    const writer = await directory.createComputedFileWriter(
      path,
      value.byteLength,
      "mismatched-file"
    );
    await writer.append(value);
    const published = await writer.commit();

    await expect(
      directory.removeFileIfMatches({
        ...published,
        integrity: {
          ...published.integrity,
          sha256: createHash("sha256").update("expected\n").digest("hex")
        }
      })
    ).resolves.toBe(false);
    await expect(
      directory.removeFileIfMatches({
        ...published,
        integrity: {
          ...published.integrity,
          sizeBytes: value.byteLength + 1
        }
      })
    ).resolves.toBe(false);
    await expect(readFile(join(root, path))).resolves.toEqual(value);
    directory.close();
  });

  it("creates owner-only directories and immutable files without replacement", async () => {
    const root = await temporaryRoot();
    const directory = await SecureWorkPackageDirectory.open(root);
    await directory.writeImmutableFile(
      "executions/one/rest-results.jsonl",
      Buffer.from("first"),
      "nonce-one"
    );
    await expect(
      directory.writeImmutableFile(
        "executions/one/rest-results.jsonl",
        Buffer.from("second"),
        "nonce-two"
      )
    ).rejects.toThrow("ARTIFACT_ALREADY_COMMITTED");
    directory.close();

    expect(await readFile(join(root, "executions/one/rest-results.jsonl"), "utf8")).toBe("first");
    expect((await stat(join(root, "executions"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, "executions/one/rest-results.jsonl"))).mode & 0o777).toBe(0o600);
  });

  it("atomically replaces only mutable state and enforces bounded reads", async () => {
    const root = await temporaryRoot();
    const directory = await SecureWorkPackageDirectory.open(root);
    await directory.replaceMutableFile(
      "executions/one/execution.json",
      Buffer.from("old"),
      "nonce-old"
    );
    await directory.replaceMutableFile(
      "executions/one/execution.json",
      Buffer.from("new"),
      "nonce-new"
    );
    await expect(directory.readFileBounded("executions/one/execution.json", 2)).rejects.toThrow(
      "WORK_PACKAGE_FILE_TOO_LARGE"
    );
    await expect(directory.readFileBounded("executions/one/execution.json", 3)).resolves.toEqual(
      Buffer.from("new")
    );
    directory.close();
  });

  it("holds a stable package lock and writes only diagnostic owner metadata", async () => {
    const root = await temporaryRoot();
    const firstDirectory = await SecureWorkPackageDirectory.open(root);
    const secondDirectory = await SecureWorkPackageDirectory.open(root);
    const owner = {
      pid: process.pid,
      processStartedAt: "Tue Jul 14 14:00:00 2026",
      executionId: null,
      acquiredAt: "2026-07-14T06:00:00.000Z"
    } as const;
    const first = await firstDirectory.acquireLock(owner);
    await expect(secondDirectory.acquireLock(owner)).rejects.toThrow("WORK_PACKAGE_LOCKED");
    await first.release();
    const second = await secondDirectory.acquireLock(owner);
    await second.release();
    firstDirectory.close();
    secondDirectory.close();

    expect(JSON.parse(await readFile(join(root, ".cortex-work-package.lock"), "utf8"))).toEqual(
      owner
    );
    expect((await stat(join(root, ".cortex-work-package.lock"))).mode & 0o777).toBe(0o600);
  });

  it("recursively cleans controlled files without following a symbolic link", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await writeFile(join(outside, "keep.txt"), "keep");
    await mkdir(join(root, "safe", "nested"), { recursive: true });
    await writeFile(join(root, "safe", "nested", "file.txt"), "value");
    const directory = await SecureWorkPackageDirectory.open(root);
    await directory.removeTree("safe");
    await expect(lstat(join(root, "safe"))).rejects.toMatchObject({ code: "ENOENT" });

    await mkdir(join(root, "unsafe"));
    await symlink(outside, join(root, "unsafe", "escape"));
    await expect(directory.removeTree("unsafe")).rejects.toThrow("TEMP_CONTAINMENT_REJECTED");
    directory.close();
    expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("keep");
  });

  it("rejects a forged hard-linked package lock", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await writeFile(join(outside, "shared"), "shared", { mode: 0o600 });
    const { link } = await import("node:fs/promises");
    await link(join(outside, "shared"), join(root, ".cortex-work-package.lock"));
    const directory = await SecureWorkPackageDirectory.open(root);
    await expect(
      directory.acquireLock({
        pid: process.pid,
        processStartedAt: "start",
        executionId: null,
        acquiredAt: "2026-07-14T06:00:00.000Z"
      })
    ).rejects.toThrow("WORK_PACKAGE_LOCK_INVALID");
    directory.close();
  });
});
