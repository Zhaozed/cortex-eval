import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { materializeWorkPackageFixture } from "../test-support/work-package-fixture.ts";
import {
  SecureWorkPackageDirectory,
  type WorkPackageLockOwner
} from "../src/secure-work-package-directory.ts";
import { encodeWorkPackageExport } from "../src/work-package-export-encoder.ts";
import { receiveWorkPackageExport } from "../src/work-package-export-receiver.ts";
import { validateWorkPackageDirectory } from "../src/work-package-validator.ts";

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

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Work Package export encoder", () => {
  it("round-trips only immutable package inputs through canonical NDJSON events", async () => {
    const sourcePath = await temporaryRoot("cortex-encoder-source-");
    const targetParent = await temporaryRoot("cortex-encoder-target-");
    await materializeWorkPackageFixture(sourcePath);
    const source = await SecureWorkPackageDirectory.open(sourcePath);
    const validated = await validateWorkPackageDirectory(source, owner());
    const targetPath = join(targetParent, "package");
    await receiveWorkPackageExport(encodeWorkPackageExport(source, validated), targetPath, {
      nonce: "encoder-roundtrip",
      owner: owner()
    });
    source.close();

    const target = await SecureWorkPackageDirectory.open(targetPath);
    await expect(validateWorkPackageDirectory(target, owner())).resolves.toMatchObject({
      manifestSha256: validated.manifestSha256,
      executions: []
    });
    const paths = target.listTree().map((entry) => entry.path);
    target.close();
    expect(paths.some((path) => path.startsWith("executions/"))).toBe(false);
    expect(await readdir(targetParent)).toEqual(["package"]);
  });
});
