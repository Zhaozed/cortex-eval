import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hashExecutionContext } from "../../domain/src/domain-hash-inputs.ts";
import type { OfflineRestCaseResult } from "../../application/src/features/runs/offline-rest-execution-service.ts";
import { afterEach, describe, expect, it } from "vitest";

import {
  materializeWorkPackageFixture,
  WORK_PACKAGE_FIXTURE_ID
} from "../test-support/work-package-fixture.ts";
import type { WorkPackageLockOwner } from "../src/secure-work-package-directory.ts";
import {
  openWorkPackageExecutionSession,
  type WorkPackageExecutionContextHashInput
} from "../src/work-package-execution-session.ts";
import { WorkPackageRestArtifactWriter } from "../src/work-package-rest-artifact-writer.ts";

const EXECUTION_ID = "018f22aa-33bb-7ccc-8ddd-fffffffffff1";
const CREATED_AT = "2026-07-14T07:00:00.000Z";
const STARTED_AT = "2026-07-14T07:01:00.000Z";
const COMPLETED_AT = "2026-07-14T07:02:00.000Z";
const RESULT_HASH = "a".repeat(64);
const roots: string[] = [];

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

function owner(): WorkPackageLockOwner {
  return {
    pid: process.pid,
    processStartedAt: "Tue Jul 14 15:00:00 2026",
    executionId: EXECUTION_ID,
    acquiredAt: CREATED_AT
  };
}

function result(): Extract<OfflineRestCaseResult, { readonly status: "SUCCEEDED" }> {
  return {
    caseKey: "case-1",
    ordinal: 0,
    caseDefinitionHash: "a".repeat(64),
    status: "SUCCEEDED",
    httpStatus: 200,
    providerOutput: {
      ok: true,
      taskName: "reply",
      resolvedConfig: {},
      parsedOutput: { text: "hello" }
    },
    errorType: null,
    errorMessage: null,
    durationMs: 10,
    completedAt: COMPLETED_AT,
    resultHash: RESULT_HASH,
    provenance: null
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Work Package REST Artifact writer", () => {
  it("rejects a Case key outside the frozen Manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "cortex-rest-artifact-key-"));
    roots.push(root);
    await materializeWorkPackageFixture(root);
    const session = await openWorkPackageExecutionSession({
      rootPath: root,
      owner: owner(),
      contextHasher,
      nonce: (): string => "rest_key_nonce_01"
    });
    try {
      await session.createExecution({
        executionId: EXECUTION_ID,
        createdAt: CREATED_AT,
        rerun: { mode: "NEW" }
      });
      await session.startStage(EXECUTION_ID, "REST", STARTED_AT);
      const writer = await WorkPackageRestArtifactWriter.create(session, EXECUTION_ID);
      await expect(writer.append({ ...result(), caseKey: "unknown-case" })).rejects.toThrow(
        "ARTIFACT_WRITE_FAILED"
      );
      await writer.abort();
    } finally {
      await session.close();
    }
  });

  it("rejects a REST prefix while the Manifest still contains another Case", async () => {
    const root = await mkdtemp(join(tmpdir(), "cortex-rest-artifact-prefix-"));
    roots.push(root);
    const manifest = await materializeWorkPackageFixture(root);
    await writeFile(
      join(root, "manifest.json"),
      `${JSON.stringify({
        ...manifest,
        cases: [
          ...manifest.cases,
          { caseKey: "case-2", ordinal: 1, baseDefinitionHash: RESULT_HASH }
        ]
      })}\n`,
      { mode: 0o600 }
    );
    const session = await openWorkPackageExecutionSession({
      rootPath: root,
      owner: owner(),
      contextHasher,
      nonce: (): string => "rest_prefix_nonce_01"
    });
    try {
      await session.createExecution({
        executionId: EXECUTION_ID,
        createdAt: CREATED_AT,
        rerun: { mode: "NEW" }
      });
      await session.startStage(EXECUTION_ID, "REST", STARTED_AT);
      const writer = await WorkPackageRestArtifactWriter.create(session, EXECUTION_ID);
      await writer.append(result());
      await expect(writer.commit(COMPLETED_AT, RESULT_HASH)).rejects.toThrow(
        "ARTIFACT_WRITE_FAILED"
      );
    } finally {
      await session.close();
    }
  });

  it("streams ordered Cases into the fixed immutable slot and returns exact integrity", async () => {
    const root = await mkdtemp(join(tmpdir(), "cortex-rest-artifact-"));
    roots.push(root);
    await materializeWorkPackageFixture(root);
    let nonce = 0;
    const session = await openWorkPackageExecutionSession({
      rootPath: root,
      owner: owner(),
      contextHasher,
      nonce: (): string => `rest_artifact_nonce_${String(++nonce).padStart(2, "0")}`
    });
    try {
      await session.createExecution({
        executionId: EXECUTION_ID,
        createdAt: CREATED_AT,
        rerun: { mode: "NEW" }
      });
      await session.startStage(EXECUTION_ID, "REST", STARTED_AT);
      const writer = await WorkPackageRestArtifactWriter.create(session, EXECUTION_ID);
      await writer.append(result());
      const artifact = await writer.commit(COMPLETED_AT, RESULT_HASH);
      await session.completeStage(EXECUTION_ID, "REST", COMPLETED_AT, [artifact]);

      const bytes = await readFile(join(root, `executions/${EXECUTION_ID}/rest-results.jsonl`));
      const [header, caseRecord, footer] = bytes
        .toString("utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as unknown);
      expect(header).toMatchObject({
        packageId: WORK_PACKAGE_FIXTURE_ID,
        executionId: EXECUTION_ID
      });
      expect(caseRecord).toMatchObject({ value: { caseKey: "case-1", status: "SUCCEEDED" } });
      expect(footer).toMatchObject({ resultSetHash: RESULT_HASH });
      expect(artifact).toMatchObject({
        kind: "REST_RESULTS",
        contractVersion: "cortex.rest-results-jsonl.v1",
        path: `executions/${EXECUTION_ID}/rest-results.jsonl`
      });
    } finally {
      await session.close();
    }
  });

  it("rejects duplicate or out-of-order Case facts before publishing the file", async () => {
    const root = await mkdtemp(join(tmpdir(), "cortex-rest-artifact-order-"));
    roots.push(root);
    await materializeWorkPackageFixture(root);
    let nonce = 0;
    const session = await openWorkPackageExecutionSession({
      rootPath: root,
      owner: owner(),
      contextHasher,
      nonce: (): string => `rest_order_nonce_${String(++nonce).padStart(2, "0")}`
    });
    try {
      await session.createExecution({
        executionId: EXECUTION_ID,
        createdAt: CREATED_AT,
        rerun: { mode: "NEW" }
      });
      await session.startStage(EXECUTION_ID, "REST", STARTED_AT);
      const writer = await WorkPackageRestArtifactWriter.create(session, EXECUTION_ID);
      await expect(writer.append({ ...result(), ordinal: 1 })).rejects.toThrow(
        "ARTIFACT_WRITE_FAILED"
      );
      await writer.abort();
    } finally {
      await session.close();
    }
  });

  it("covers REST failure, business failure, provenance and writer terminal paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "cortex-rest-artifact-boundaries-"));
    roots.push(root);
    const manifest = await materializeWorkPackageFixture(root);
    await writeFile(
      join(root, "manifest.json"),
      `${JSON.stringify({
        ...manifest,
        cases: [
          ...manifest.cases,
          { caseKey: "case-2", ordinal: 1, baseDefinitionHash: RESULT_HASH }
        ]
      })}\n`,
      { mode: 0o600 }
    );
    let nonce = 0;
    const session = await openWorkPackageExecutionSession({
      rootPath: root,
      owner: owner(),
      contextHasher,
      nonce: (): string => `rest_boundary_nonce_${String(++nonce).padStart(2, "0")}`
    });
    try {
      await session.createExecution({
        executionId: EXECUTION_ID,
        createdAt: CREATED_AT,
        rerun: { mode: "NEW" }
      });
      await session.startStage(EXECUTION_ID, "REST", STARTED_AT);

      const empty = await WorkPackageRestArtifactWriter.create(session, EXECUTION_ID);
      await expect(empty.commit(COMPLETED_AT, RESULT_HASH)).rejects.toThrow(
        "ARTIFACT_WRITE_FAILED"
      );
      await empty.abort();
      await empty.abort();
      await expect(empty.append(result())).rejects.toThrow("ARTIFACT_WRITER_CLOSED");

      const invalid = await WorkPackageRestArtifactWriter.create(session, EXECUTION_ID);
      await expect(invalid.append({ ...result(), caseKey: "" })).rejects.toThrow(
        "ARTIFACT_WRITE_FAILED"
      );
      await invalid.abort();

      const invalidCommit = await WorkPackageRestArtifactWriter.create(session, EXECUTION_ID);
      await invalidCommit.append(result());
      await expect(invalidCommit.commit("invalid", RESULT_HASH)).rejects.toThrow();
      await invalidCommit.abort();

      const writer = await WorkPackageRestArtifactWriter.create(session, EXECUTION_ID);
      await writer.append({
        ...result(),
        providerOutput: { ok: false, errorMessage: "business failure" },
        provenance: {
          sourceKind: "EXECUTION",
          sourceId: "018f22aa-33bb-7ccc-8ddd-fffffffffff2",
          sourceResultHash: RESULT_HASH
        }
      });
      await writer.append({
        caseKey: "case-2",
        ordinal: 1,
        caseDefinitionHash: RESULT_HASH,
        status: "ERROR",
        httpStatus: null,
        providerOutput: null,
        errorType: "NETWORK",
        errorMessage: "network failed",
        durationMs: 2,
        completedAt: COMPLETED_AT,
        resultHash: RESULT_HASH,
        provenance: null
      });
      await writer.commit(COMPLETED_AT, RESULT_HASH);
      await writer.abort();
      await expect(writer.append(result())).rejects.toThrow("ARTIFACT_WRITER_CLOSED");
      const records = (
        await readFile(join(root, `executions/${EXECUTION_ID}/rest-results.jsonl`), "utf8")
      )
        .trimEnd()
        .split("\n")
        .map(
          (line) => JSON.parse(line) as { readonly recordType: string; readonly value?: unknown }
        );
      expect(
        records.filter((record) => record.recordType === "CASE").map((record) => record.value)
      ).toMatchObject([
        { status: "SUCCEEDED", providerOutput: { ok: false, err_msg: "business failure" } },
        { status: "ERROR", error: { type: "NETWORK" } }
      ]);
    } finally {
      await session.close();
    }
  });
});
