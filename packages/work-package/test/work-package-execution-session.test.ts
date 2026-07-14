import { access, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { hashExecutionContext } from "../../domain/src/domain-hash-inputs.ts";
import type { WorkPackageLockOwner } from "../src/secure-work-package-directory.ts";
import {
  materializeWorkPackageFixture,
  WORK_PACKAGE_FIXTURE_ID
} from "../test-support/work-package-fixture.ts";
import {
  openWorkPackageExecutionSession,
  publishedStageArtifact,
  type WorkPackageExecutionContextHashInput
} from "../src/work-package-execution-session.ts";

const EXECUTION_ID = "018f22aa-33bb-7ccc-8ddd-fffffffffff1";
const SOURCE_EXECUTION_ID = "018f22aa-33bb-7ccc-8ddd-fffffffffff2";
const CREATED_AT = "2026-07-14T07:00:00.000Z";
const STARTED_AT = "2026-07-14T07:01:00.000Z";
const COMPLETED_AT = "2026-07-14T07:02:00.000Z";
const roots: string[] = [];

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cortex-execution-session-"));
  roots.push(root);
  await materializeWorkPackageFixture(root);
  return root;
}

function owner(executionId: string): WorkPackageLockOwner {
  return {
    pid: process.pid,
    processStartedAt: "Tue Jul 14 15:00:00 2026",
    executionId,
    acquiredAt: CREATED_AT
  };
}

const contextHasher = {
  hash: (input: WorkPackageExecutionContextHashInput): string =>
    hashExecutionContext({
      contractVersion: input.contractVersion,
      packageId: input.packageId,
      manifestHash: input.manifestHash,
      runExecutionLimits: input.runExecutionLimits,
      analysisExecutionLimits: input.analysisExecutionLimits
    })
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Work Package Execution session", () => {
  it("preserves a replacement when discarding an unregistered fixed-slot Artifact", async () => {
    const root = await fixtureRoot();
    const session = await openWorkPackageExecutionSession({
      rootPath: root,
      owner: owner(EXECUTION_ID),
      contextHasher,
      nonce: () => "execution_discard_01"
    });
    try {
      await session.createExecution({
        executionId: EXECUTION_ID,
        createdAt: CREATED_AT,
        rerun: { mode: "NEW" }
      });
      await session.startStage(EXECUTION_ID, "REST", STARTED_AT);
      const writer = await session.createStageArtifactWriter(
        EXECUTION_ID,
        "REST_RESULTS",
        Number.MAX_SAFE_INTEGER
      );
      const original = Buffer.from("original\n", "utf8");
      await writer.append(original);
      const artifact = publishedStageArtifact(
        await writer.commit(),
        "REST_RESULTS",
        "cortex.rest-results.v1"
      );
      const path = join(root, artifact.path);
      await unlink(path);
      await writeFile(path, original, { mode: 0o600 });
      await expect(
        session.discardUnregisteredStageArtifact(EXECUTION_ID, "REST", artifact)
      ).rejects.toThrow("TEMP_CLEANUP_FAILED");
      await expect(readFile(path)).resolves.toEqual(original);
    } finally {
      await session.close();
    }
  });

  it("creates one new Execution with frozen defaults and a bound context hash", async () => {
    const root = await fixtureRoot();
    const session = await openWorkPackageExecutionSession({
      rootPath: root,
      owner: owner(EXECUTION_ID),
      contextHasher,
      nonce: () => "execution_nonce_01"
    });
    try {
      expect(session.packageSummary).toMatchObject({
        packageId: WORK_PACKAGE_FIXTURE_ID,
        executionCount: 0
      });
      const execution = await session.createExecution({
        executionId: EXECUTION_ID,
        createdAt: CREATED_AT,
        rerun: { mode: "NEW" }
      });
      expect(execution).toMatchObject({
        packageId: WORK_PACKAGE_FIXTURE_ID,
        executionId: EXECUTION_ID,
        runExecutionLimits: { restConcurrency: 4, evalConcurrency: 2 },
        analysisExecutionLimits: { analysisConcurrency: 1 },
        stages: {
          REST: { status: "PENDING" },
          EVALUATION: { status: "PENDING" },
          REPORT: { status: "PENDING" },
          ANALYSIS: { status: "PENDING" }
        }
      });
      expect(execution.executionContextHash).toMatch(/^[a-f0-9]{64}$/);
      expect(session.readExecution(EXECUTION_ID)).toEqual(execution);
      expect(session.packageSummary.executionCount).toBe(1);
      await expect(
        session.createExecution({
          executionId: EXECUTION_ID,
          createdAt: CREATED_AT,
          rerun: { mode: "NEW" }
        })
      ).rejects.toThrow("EXECUTION_RESULT_CONFLICT");
    } finally {
      await session.close();
    }
  });

  it("enforces stage dependencies and atomically registers the fixed REST Artifact slot", async () => {
    const root = await fixtureRoot();
    let nonce = 0;
    const session = await openWorkPackageExecutionSession({
      rootPath: root,
      owner: owner(EXECUTION_ID),
      contextHasher,
      nonce: () => `execution_nonce_${String(++nonce).padStart(2, "0")}`
    });
    try {
      await session.createExecution({
        executionId: EXECUTION_ID,
        createdAt: CREATED_AT,
        rerun: { mode: "NEW" }
      });
      await expect(session.startStage(EXECUTION_ID, "EVALUATION", STARTED_AT)).rejects.toThrow(
        "RUN_STATE_CONFLICT"
      );

      await session.startStage(EXECUTION_ID, "REST", STARTED_AT);
      const writer = await session.createStageArtifactWriter(
        EXECUTION_ID,
        "REST_RESULTS",
        Number.MAX_SAFE_INTEGER
      );
      await writer.append(Buffer.from("{}\n", "utf8"));
      const artifact = publishedStageArtifact(
        await writer.commit(),
        "REST_RESULTS",
        "cortex.rest-results.v1"
      );
      const completed = await session.completeStage(EXECUTION_ID, "REST", COMPLETED_AT, [artifact]);
      expect(completed.stages.REST).toMatchObject({
        status: "SUCCEEDED",
        startedAt: STARTED_AT,
        completedAt: COMPLETED_AT,
        artifacts: [{ path: `executions/${EXECUTION_ID}/rest-results.json` }]
      });
      await expect(session.startStage(EXECUTION_ID, "REST", STARTED_AT)).rejects.toThrow(
        "ARTIFACT_ALREADY_COMMITTED"
      );
      await expect(
        session.discardUnregisteredStageArtifact(EXECUTION_ID, "REST", artifact)
      ).rejects.toThrow("ARTIFACT_ALREADY_COMMITTED");
      await expect(access(join(root, artifact.path))).resolves.toBeUndefined();
    } finally {
      await session.close();
    }
  });

  it("requires an existing source Execution for retry and force identities", async () => {
    const root = await fixtureRoot();
    let nonce = 0;
    const session = await openWorkPackageExecutionSession({
      rootPath: root,
      owner: owner(EXECUTION_ID),
      contextHasher,
      nonce: () => `execution_source_${String(++nonce).padStart(2, "0")}`
    });
    try {
      await expect(
        session.createExecution({
          executionId: EXECUTION_ID,
          createdAt: CREATED_AT,
          rerun: { mode: "RETRY_FAILED", sourceExecutionId: SOURCE_EXECUTION_ID }
        })
      ).rejects.toThrow("WORK_PACKAGE_INVALID");
      await session.createExecution({
        executionId: SOURCE_EXECUTION_ID,
        createdAt: CREATED_AT,
        rerun: { mode: "NEW" }
      });
      const retry = await session.createExecution({
        executionId: EXECUTION_ID,
        createdAt: CREATED_AT,
        rerun: { mode: "RETRY_FAILED", sourceExecutionId: SOURCE_EXECUTION_ID }
      });
      expect(retry.rerun).toEqual({
        mode: "RETRY_FAILED",
        sourceExecutionId: SOURCE_EXECUTION_ID
      });
    } finally {
      await session.close();
    }
  });

  it("preserves and reports an unregistered Artifact when recovery has no publication identity", async () => {
    const root = await fixtureRoot();
    let nonce = 0;
    const interrupted = await openWorkPackageExecutionSession({
      rootPath: root,
      owner: owner(EXECUTION_ID),
      contextHasher,
      nonce: () => `execution_recovery_${String(++nonce).padStart(2, "0")}`
    });
    await interrupted.createExecution({
      executionId: EXECUTION_ID,
      createdAt: CREATED_AT,
      rerun: { mode: "NEW" }
    });
    await interrupted.startStage(EXECUTION_ID, "REST", STARTED_AT);
    const writer = await interrupted.createStageArtifactWriter(
      EXECUTION_ID,
      "REST_RESULTS",
      Number.MAX_SAFE_INTEGER
    );
    await writer.append(Buffer.from("{}\n", "utf8"));
    await writer.commit();
    await interrupted.close();

    await expect(
      openWorkPackageExecutionSession({
        rootPath: root,
        owner: { ...owner(EXECUTION_ID), acquiredAt: COMPLETED_AT },
        contextHasher,
        nonce: () => `execution_recovery_${String(++nonce).padStart(2, "0")}`
      })
    ).rejects.toThrow("TEMP_CLEANUP_FAILED");
    await expect(access(join(root, "executions", EXECUTION_ID, "rest-results.json"))).resolves.toBe(
      undefined
    );
  });

  it("recovers a running stage with no published Artifact to an empty error state", async () => {
    const root = await fixtureRoot();
    let nonce = 0;
    const interrupted = await openWorkPackageExecutionSession({
      rootPath: root,
      owner: owner(EXECUTION_ID),
      contextHasher,
      nonce: () => `execution_empty_recovery_${String(++nonce).padStart(2, "0")}`
    });
    await interrupted.createExecution({
      executionId: EXECUTION_ID,
      createdAt: CREATED_AT,
      rerun: { mode: "NEW" }
    });
    await interrupted.startStage(EXECUTION_ID, "REST", STARTED_AT);
    await interrupted.close();

    const recovered = await openWorkPackageExecutionSession({
      rootPath: root,
      owner: { ...owner(EXECUTION_ID), acquiredAt: COMPLETED_AT },
      contextHasher,
      nonce: () => `execution_empty_recovery_${String(++nonce).padStart(2, "0")}`
    });
    try {
      expect(recovered.readExecution(EXECUTION_ID)?.stages.REST).toEqual({
        status: "ERROR",
        startedAt: STARTED_AT,
        completedAt: COMPLETED_AT,
        errorCode: "REQUEST_ABORTED",
        artifacts: []
      });
    } finally {
      await recovered.close();
    }
  });
});
