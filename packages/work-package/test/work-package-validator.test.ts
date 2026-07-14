import { createHash } from "node:crypto";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExecutionV1 } from "../../contracts/src/work-package-contracts.ts";
import { afterEach, describe, expect, it } from "vitest";

import {
  materializeWorkPackageFixture,
  WORK_PACKAGE_FIXTURE_ID
} from "../test-support/work-package-fixture.ts";
import type { WorkPackageLockOwner } from "../src/secure-work-package-directory.ts";
import { validateWorkPackage } from "../src/work-package-validator.ts";

const roots: string[] = [];
const EXECUTION_ID = "018f22aa-33bb-7ccc-8ddd-ffffffffffff";

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cortex-package-validator-"));
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

function pendingExecution(): ExecutionV1 {
  const pending = {
    status: "PENDING" as const,
    startedAt: null,
    completedAt: null,
    errorCode: null,
    artifacts: []
  };
  return {
    contractVersion: "cortex.execution.v1",
    packageId: WORK_PACKAGE_FIXTURE_ID,
    executionId: EXECUTION_ID,
    createdAt: "2026-07-14T01:00:00.000Z",
    startedAt: null,
    completedAt: null,
    rerun: { mode: "NEW" },
    runExecutionLimits: {
      contractVersion: "cortex.run-execution-limits.v1",
      restConcurrency: 4,
      evalConcurrency: 2
    },
    analysisExecutionLimits: {
      contractVersion: "cortex.analysis-execution-limits.v1",
      analysisConcurrency: 1
    },
    executionContextHash: "b".repeat(64),
    stages: { REST: pending, EVALUATION: pending, REPORT: pending, ANALYSIS: pending }
  };
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Work Package validator", () => {
  it("validates the complete immutable input set and returns its Manifest hash", async () => {
    const root = await temporaryRoot();
    const manifest = await materializeWorkPackageFixture(root);
    const manifestBytes = await import("node:fs/promises").then(({ readFile }) =>
      readFile(join(root, "manifest.json"))
    );
    await expect(validateWorkPackage(root, owner())).resolves.toMatchObject({
      manifest,
      manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
      executions: []
    });
  });

  it("rejects an unknown file, symlink and corrupted registered input", async () => {
    const unknownRoot = await temporaryRoot();
    await materializeWorkPackageFixture(unknownRoot);
    await writeFile(join(unknownRoot, "unknown.json"), "{}", { mode: 0o600 });
    await expect(validateWorkPackage(unknownRoot, owner())).rejects.toThrow(
      "WORK_PACKAGE_UNKNOWN_FILE"
    );

    const symlinkRoot = await temporaryRoot();
    await materializeWorkPackageFixture(symlinkRoot);
    await symlink(join(symlinkRoot, "manifest.json"), join(symlinkRoot, "inputs", "escape"));
    await expect(validateWorkPackage(symlinkRoot, owner())).rejects.toThrow(
      "WORK_PACKAGE_PATH_INVALID"
    );

    const corruptRoot = await temporaryRoot();
    await materializeWorkPackageFixture(corruptRoot);
    await writeFile(join(corruptRoot, "inputs", "endpoint.json"), "corrupt", { mode: 0o600 });
    await expect(validateWorkPackage(corruptRoot, owner())).rejects.toThrow(
      "ARTIFACT_HASH_MISMATCH"
    );
  });

  it("accepts a pending Execution and rejects an unregistered future Artifact slot", async () => {
    const root = await temporaryRoot();
    await materializeWorkPackageFixture(root);
    await mkdir(join(root, "executions", EXECUTION_ID), { recursive: true, mode: 0o700 });
    await writeFile(
      join(root, "executions", EXECUTION_ID, "execution.json"),
      `${JSON.stringify(pendingExecution())}\n`,
      { mode: 0o600 }
    );
    await expect(validateWorkPackage(root, owner())).resolves.toMatchObject({
      executions: [{ executionId: EXECUTION_ID }]
    });
    await writeFile(join(root, "executions", EXECUTION_ID, "report.json"), "{}", {
      mode: 0o600
    });
    await expect(validateWorkPackage(root, owner())).rejects.toThrow(
      "WORK_PACKAGE_ARTIFACT_ORPHAN"
    );
  });
});
