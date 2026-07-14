import { mkdirSync, rmSync } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WorkPackageDirectoryPublisher } from "../src/work-package-directory-publisher.ts";
import type { WorkPackageLockOwner } from "../src/secure-work-package-directory.ts";

const roots: string[] = [];
const NOW = "2026-07-14T07:00:00.000Z";

function owner(): WorkPackageLockOwner {
  return {
    pid: process.pid,
    processStartedAt: "Tue Jul 14 15:00:00 2026",
    executionId: null,
    acquiredAt: NOW
  };
}

async function parent(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "cortex-directory-publisher-"));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Work Package directory publisher", () => {
  it("rejects every unsafe target and nonce before opening its parent", async () => {
    const base = await parent();
    const cases = [
      ["relative-package", "valid_nonce"],
      [join(base, "bad name"), "valid_nonce"],
      [`${base}/.`, "valid_nonce"],
      [`${base}/..`, "valid_nonce"],
      [join(base, "x".repeat(256)), "valid_nonce"],
      [join(base, ".cortex-export-official01"), "valid_nonce"],
      [join(base, "package"), "short"]
    ] as const;
    for (const [target, nonce] of cases) {
      await expect(WorkPackageDirectoryPublisher.create(target, nonce, owner())).rejects.toThrow(
        "WORK_PACKAGE_TARGET_INVALID"
      );
    }
  });

  it("rejects duplicate staging and an existing final target", async () => {
    const base = await parent();
    const target = join(base, "package");
    const first = await WorkPackageDirectoryPublisher.create(target, "duplicate_nonce", owner());
    await expect(
      WorkPackageDirectoryPublisher.create(target, "duplicate_nonce", owner())
    ).rejects.toThrow("WORK_PACKAGE_STAGING_EXISTS");
    await first.abort();

    const publisher = await WorkPackageDirectoryPublisher.create(
      target,
      "existing_target",
      owner()
    );
    await mkdir(target, { mode: 0o700 });
    await expect(publisher.publish()).rejects.toThrow("WORK_PACKAGE_TARGET_EXISTS");
    expect(() => publisher.directory).toThrow("WORK_PACKAGE_PUBLISHER_CLOSED");
  });

  it("preserves target conflict when unpublished staging cleanup also fails", async () => {
    const base = await parent();
    const target = join(base, "package");
    const staging = join(base, ".cortex-export-target_cleanup");
    const cleanupFailures: string[] = [];
    const publisher = await WorkPackageDirectoryPublisher.create(
      target,
      "target_cleanup",
      owner(),
      {
        record: (failure): Promise<void> => {
          cleanupFailures.push(failure.code);
          return Promise.reject(new Error("TEST_CLEANUP_SINK_FAILED"));
        }
      }
    );
    await mkdir(target, { mode: 0o700 });
    await mkdir(join(staging, "blocked"), { mode: 0o700 });
    await chmod(join(staging, "blocked"), 0o000);
    try {
      await expect(publisher.publish()).rejects.toThrow("WORK_PACKAGE_TARGET_EXISTS");
      expect(cleanupFailures).toEqual(["TEMP_CLEANUP_FAILED"]);
    } finally {
      await chmod(join(staging, "blocked"), 0o700);
    }
  });

  it("moves a renamed target back to staging when the post-rename sync fails", async () => {
    const base = await parent();
    const target = join(base, "package");
    let syncCalls = 0;
    const publisher = await WorkPackageDirectoryPublisher.create(
      target,
      "rename_cleanup",
      owner(),
      undefined,
      (descriptor): void => {
        syncCalls += 1;
        if (syncCalls === 1) throw new Error(`TEST_POST_RENAME_SYNC_FAILED:${descriptor}`);
      }
    );
    await publisher.prepareForValidation();

    await expect(publisher.publish()).rejects.toThrow("ARTIFACT_WRITE_FAILED");
    await expect(access(target)).rejects.toThrow();
    expect(await readdir(base)).toEqual([]);
  });

  it("preserves the publish error when restore sync and cleanup reporting also fail", async () => {
    const base = await parent();
    const target = join(base, "package");
    const cleanupFailures: string[] = [];
    const publisher = await WorkPackageDirectoryPublisher.create(
      target,
      "restore_report",
      owner(),
      {
        record: (failure): Promise<void> => {
          cleanupFailures.push(failure.code);
          return Promise.reject(new Error("TEST_CLEANUP_REPORT_FAILED"));
        }
      },
      (): never => {
        throw new Error("TEST_DIRECTORY_SYNC_FAILED");
      }
    );
    await publisher.prepareForValidation();

    await expect(publisher.publish()).rejects.toThrow("ARTIFACT_WRITE_FAILED");
    await expect(access(target)).rejects.toThrow();
    expect(cleanupFailures).toEqual(["TEMP_CLEANUP_FAILED"]);
    expect(await readdir(base)).toEqual([]);
  });

  it("does not move or delete a replacement target during post-rename compensation", async () => {
    const base = await parent();
    const target = join(base, "package");
    const cleanupFailures: string[] = [];
    let syncCalls = 0;
    const publisher = await WorkPackageDirectoryPublisher.create(
      target,
      "replacement_target",
      owner(),
      {
        record: (failure): Promise<void> => {
          cleanupFailures.push(failure.code);
          return Promise.resolve();
        }
      },
      (): void => {
        syncCalls += 1;
        if (syncCalls !== 1) return;
        rmSync(target, { recursive: true });
        mkdirSync(target, { mode: 0o700 });
        throw new Error("TEST_POST_RENAME_SYNC_FAILED");
      }
    );
    await publisher.prepareForValidation();

    await expect(publisher.publish()).rejects.toThrow("ARTIFACT_WRITE_FAILED");
    await expect(access(target)).resolves.toBeUndefined();
    expect(cleanupFailures).toEqual(["TEMP_CLEANUP_FAILED"]);
    expect(await readdir(base)).toEqual(["package"]);
  });

  it("keeps prepare, publish and abort terminal operations idempotent", async () => {
    const base = await parent();
    const target = join(base, "package");
    const publisher = await WorkPackageDirectoryPublisher.create(target, "publish_nonce", owner());
    await publisher.prepareForValidation();
    await publisher.prepareForValidation();
    await publisher.publish();
    await publisher.abort();
    await expect(publisher.prepareForValidation()).rejects.toThrow("WORK_PACKAGE_PUBLISHER_CLOSED");
    await expect(publisher.publish()).rejects.toThrow("WORK_PACKAGE_PUBLISHER_CLOSED");
    expect(() => publisher.directory).toThrow("WORK_PACKAGE_PUBLISHER_CLOSED");
  });

  it("ignores an already removed staging directory and closes the publisher", async () => {
    const base = await parent();
    const publisher = await WorkPackageDirectoryPublisher.create(
      join(base, "package"),
      "missing_staging",
      owner()
    );
    await rm(join(base, ".cortex-export-missing_staging"), { recursive: true });
    await publisher.abort();
    await publisher.abort();
  });

  it("reports cleanup failure without following external paths", async () => {
    const base = await parent();
    const publisher = await WorkPackageDirectoryPublisher.create(
      join(base, "package"),
      "cleanup_failure",
      owner()
    );
    await chmod(base, 0o500);
    try {
      expect(() => publisher.abort()).toThrow("TEMP_CLEANUP_FAILED");
    } finally {
      await chmod(base, 0o700);
    }
  });
});
