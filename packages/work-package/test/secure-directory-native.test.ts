import { mkdtemp, mkdir, readFile, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  closeNativeFileDescriptor,
  duplicateNativeFileDescriptor,
  fsyncNativeFileDescriptor,
  linkFileExclusiveAt,
  lockFileExclusiveNonblocking,
  mkdirAt,
  openDirectoryAt,
  openFileAt,
  openSecureDirectory,
  readDirectoryNames,
  renameExclusiveAt,
  renameReplaceAt,
  statAt,
  unlockFile,
  unlinkAt
} from "../src/secure-directory-native.ts";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cortex-secure-directory-"));
  roots.push(root);
  return realpath(root);
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("macOS secure directory native boundary", () => {
  it("opens an absolute directory one no-follow component at a time", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "real"));
    await symlink(join(root, "real"), join(root, "link"));
    const descriptor = openSecureDirectory(join(root, "real"));
    expect(readDirectoryNames(descriptor)).toEqual([]);
    closeNativeFileDescriptor(descriptor);
    expect(() => openSecureDirectory(join(root, "link"))).toThrow(/ELOOP|ENOTDIR/);
  });

  it("keeps operations bound to the opened parent after its lexical ancestor is replaced", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await mkdir(join(root, "parent"));
    const parent = openSecureDirectory(join(root, "parent"));
    await rename(join(root, "parent"), join(root, "moved"));
    await symlink(outside, join(root, "parent"));
    const file = openFileAt(parent, "inside.txt", "CREATE_EXCLUSIVE", 0o600);
    closeNativeFileDescriptor(file);
    closeNativeFileDescriptor(parent);
    await expect(readFile(join(root, "moved", "inside.txt"), "utf8")).resolves.toBe("");
    await expect(readFile(join(outside, "inside.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("uses an independent directory cursor for every deterministic listing", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "one.txt"), "one", { mode: 0o600 });
    const descriptor = openSecureDirectory(root);
    try {
      expect(readDirectoryNames(descriptor)).toEqual(["one.txt"]);
      expect(readDirectoryNames(descriptor)).toEqual(["one.txt"]);
    } finally {
      closeNativeFileDescriptor(descriptor);
    }
  });

  it("publishes a complete directory exclusively without replacing any target type", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "staging"));
    await writeFile(join(root, "staging", "ready.txt"), "ready");
    const parent = openSecureDirectory(root);
    renameExclusiveAt(parent, "staging", parent, "package");
    expect(await readFile(join(root, "package", "ready.txt"), "utf8")).toBe("ready");

    for (const target of ["existing-file", "existing-directory", "existing-symlink"]) {
      await mkdir(join(root, `staging-${target}`));
      if (target === "existing-file") await writeFile(join(root, target), "existing");
      if (target === "existing-directory") await mkdir(join(root, target));
      if (target === "existing-symlink") await symlink(join(root, "package"), join(root, target));
      expect(() => renameExclusiveAt(parent, `staging-${target}`, parent, target)).toThrow(
        /EEXIST|ENOTEMPTY/
      );
    }
    closeNativeFileDescriptor(parent);
  });

  it("publishes immutable files with linkat and atomically replaces only mutable state", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "artifact.tmp"), "artifact", { mode: 0o600 });
    await writeFile(join(root, "state.old"), "old", { mode: 0o600 });
    await writeFile(join(root, "state.new"), "new", { mode: 0o600 });
    const parent = openSecureDirectory(root);
    linkFileExclusiveAt(parent, "artifact.tmp", parent, "artifact.json");
    expect(() => linkFileExclusiveAt(parent, "artifact.tmp", parent, "artifact.json")).toThrow(
      "EEXIST"
    );
    renameReplaceAt(parent, "state.new", parent, "state.old");
    fsyncNativeFileDescriptor(parent);
    closeNativeFileDescriptor(parent);
    expect(await readFile(join(root, "artifact.json"), "utf8")).toBe("artifact");
    expect(await readFile(join(root, "state.old"), "utf8")).toBe("new");
  });

  it("uses one stable lock inode and exposes safe directory primitives", async () => {
    const root = await temporaryRoot();
    const parent = openSecureDirectory(root);
    mkdirAt(parent, "nested", 0o700);
    const nested = openDirectoryAt(parent, "nested");
    const duplicate = duplicateNativeFileDescriptor(nested);
    closeNativeFileDescriptor(nested);
    expect(readDirectoryNames(duplicate)).toEqual([]);
    const first = openFileAt(duplicate, "lock", "CREATE_OR_OPEN", 0o600);
    const second = openFileAt(duplicate, "lock", "CREATE_OR_OPEN", 0o600);
    expect(lockFileExclusiveNonblocking(first)).toBe(true);
    expect(lockFileExclusiveNonblocking(second)).toBe(false);
    unlockFile(first);
    expect(lockFileExclusiveNonblocking(second)).toBe(true);
    unlockFile(second);
    expect(statAt(duplicate, "lock")).toMatchObject({
      kind: "FILE",
      mode: 0o600,
      sizeBytes: 0,
      linkCount: 1
    });
    closeNativeFileDescriptor(first);
    closeNativeFileDescriptor(second);
    unlinkAt(duplicate, "lock", "FILE");
    closeNativeFileDescriptor(duplicate);
    unlinkAt(parent, "nested", "DIRECTORY");
    expect(readDirectoryNames(parent)).toEqual([]);
    closeNativeFileDescriptor(parent);
  });
});
