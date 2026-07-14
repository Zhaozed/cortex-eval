import { createHash } from "node:crypto";
import { chmod, link, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SecureWorkPackageDirectory } from "../src/secure-work-package-directory.ts";
import { validateFileIntegrity } from "../src/work-package-file-integrity.ts";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cortex-file-integrity-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Work Package file integrity", () => {
  it("streams one owner-only file and validates its registered hash and size", async () => {
    const root = await temporaryRoot();
    const value = Buffer.from("streamed-value");
    await writeFile(join(root, "value.json"), value, { mode: 0o600 });
    const directory = await SecureWorkPackageDirectory.open(root);
    await expect(
      validateFileIntegrity(directory, {
        path: "value.json",
        sha256: createHash("sha256").update(value).digest("hex"),
        sizeBytes: value.byteLength
      })
    ).resolves.toEqual({ sha256: createHash("sha256").update(value).digest("hex"), sizeBytes: 14 });
    directory.close();
  });

  it.each([
    ["hash", "ARTIFACT_HASH_MISMATCH"],
    ["size", "ARTIFACT_HASH_MISMATCH"]
  ])("rejects registered %s mismatch", async (kind, code) => {
    const root = await temporaryRoot();
    const value = Buffer.from("value");
    await writeFile(join(root, "value.json"), value, { mode: 0o600 });
    const directory = await SecureWorkPackageDirectory.open(root);
    const expected = {
      path: "value.json",
      sha256: kind === "hash" ? "0".repeat(64) : createHash("sha256").update(value).digest("hex"),
      sizeBytes: kind === "size" ? value.byteLength + 1 : value.byteLength
    };
    await expect(validateFileIntegrity(directory, expected)).rejects.toThrow(code);
    directory.close();
  });

  it("rejects a file beyond its role-specific limit before reading", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "value.json"), "value", { mode: 0o600 });
    const directory = await SecureWorkPackageDirectory.open(root);
    await expect(
      validateFileIntegrity(
        directory,
        { path: "value.json", sha256: "0".repeat(64), sizeBytes: 5 },
        4
      )
    ).rejects.toThrow("WORK_PACKAGE_INPUT_TOO_LARGE");
    directory.close();
  });

  it("rejects symlinks, hard links and non-owner-only files", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "source"), "value", { mode: 0o600 });
    await link(join(root, "source"), join(root, "hard-link"));
    await symlink(join(root, "source"), join(root, "symbolic-link"));
    await writeFile(join(root, "wide"), "value", { mode: 0o600 });
    await chmod(join(root, "wide"), 0o644);
    const directory = await SecureWorkPackageDirectory.open(root);
    for (const path of ["source", "hard-link", "symbolic-link", "wide"]) {
      await expect(
        validateFileIntegrity(directory, { path, sha256: "0".repeat(64), sizeBytes: 5 })
      ).rejects.toThrow("WORK_PACKAGE_FILE_INVALID");
    }
    directory.close();
  });
});
