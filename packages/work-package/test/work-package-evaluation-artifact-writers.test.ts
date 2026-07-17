import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type EvalCaseV1,
  RawPromptfooEvidenceArtifactV1Schema
} from "@cortex-eval/contracts/src/artifact-contracts.ts";
import { hashExecutionContext } from "../../domain/src/domain-hash-inputs.ts";
import { afterEach, describe, expect, it } from "vitest";

import type { WorkPackageLockOwner } from "../src/secure-work-package-directory.ts";
import {
  type WorkPackageExecutionSession,
  openWorkPackageExecutionSession,
  publishedStageArtifact,
  type WorkPackageExecutionContextHashInput
} from "../src/work-package-execution-session.ts";
import { WorkPackageNormalizedEvalArtifactWriter } from "../src/work-package-normalized-eval-artifact-writer.ts";
import { writeWorkPackageRawPromptfooArtifact } from "../src/work-package-raw-promptfoo-artifact-writer.ts";
import {
  materializeWorkPackageFixture,
  WORK_PACKAGE_FIXTURE_ID
} from "../test-support/work-package-fixture.ts";

const EXECUTION_ID = "018f22aa-33bb-7ccc-8ddd-fffffffffff1";
const CREATED_AT = "2026-07-14T07:00:00.000Z";
const REST_COMPLETED_AT = "2026-07-14T07:01:00.000Z";
const EVAL_STARTED_AT = "2026-07-14T07:02:00.000Z";
const EVAL_COMPLETED_AT = "2026-07-14T07:03:00.000Z";
const HASH = "a".repeat(64);
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

async function openEvaluationSession(
  prefix: string,
  expectedCaseCount = 1
): Promise<WorkPackageExecutionSession> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  const manifest = await materializeWorkPackageFixture(root);
  if (expectedCaseCount === 2) {
    await writeFile(
      join(root, "manifest.json"),
      `${JSON.stringify({
        ...manifest,
        cases: [
          ...manifest.cases,
          { caseKey: "case-2", ordinal: 1, baseDefinitionHash: "b".repeat(64) }
        ]
      })}\n`,
      { mode: 0o600 }
    );
  }
  let nonce = 0;
  const session = await openWorkPackageExecutionSession({
    rootPath: root,
    owner: owner(),
    contextHasher,
    nonce: (): string => `${prefix}${String(++nonce).padStart(2, "0")}`
  });
  await session.createExecution({
    executionId: EXECUTION_ID,
    createdAt: CREATED_AT,
    rerun: { mode: "NEW" }
  });
  await session.startStage(EXECUTION_ID, "REST", CREATED_AT);
  const restWriter = await session.createStageArtifactWriter(
    EXECUTION_ID,
    "REST_RESULTS",
    Number.MAX_SAFE_INTEGER
  );
  await restWriter.append(Buffer.from("{}\n", "utf8"));
  const restPublished = await restWriter.commit();
  await session.completeStage(EXECUTION_ID, "REST", REST_COMPLETED_AT, [
    publishedStageArtifact(restPublished, "REST_RESULTS", "cortex.rest-results-jsonl.v1")
  ]);
  await session.startStage(EXECUTION_ID, "EVALUATION", EVAL_STARTED_AT);
  return session;
}

function normalizedCase(): Extract<EvalCaseV1, { readonly status: "PASS" | "FAIL" }> {
  return {
    caseKey: "case-1",
    ordinal: 0,
    status: "PASS",
    promptfooSuccess: true,
    score: 1,
    reason: "matched",
    evaluationError: null,
    assertions: [
      {
        index: 0,
        definitionHash: HASH,
        type: "equals",
        metric: "exact",
        weight: 1,
        status: "PASS",
        score: 1,
        reason: "matched"
      }
    ],
    diffs: [],
    metrics: [{ metric: "exact", status: "PASS" }],
    latencyMs: 1,
    tokenUsage: null,
    cost: null,
    rawEvidence: {
      present: true,
      path: `executions/${EXECUTION_ID}/promptfoo-raw.json`,
      expectedSha256: HASH,
      expectedSizeBytes: 10
    },
    evalResultHash: HASH,
    finalCaseResultHash: HASH,
    provenance: null
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Work Package Evaluation Artifact writers", () => {
  it("rejects a Normalized prefix while the Manifest still contains another Case", async () => {
    const session = await openEvaluationSession("cortex-eval-prefix-", 2);
    try {
      const writer = await WorkPackageNormalizedEvalArtifactWriter.create(
        session,
        EXECUTION_ID,
        HASH
      );
      await writer.append(normalizedCase());
      await expect(writer.commit(EVAL_COMPLETED_AT, HASH)).rejects.toThrow(
        "EVALUATION_STAGE_FAILED"
      );
    } finally {
      await session.close();
    }
  });

  it("streams and atomically registers the exact Raw and Normalized Evaluation slots", async () => {
    const root = await mkdtemp(join(tmpdir(), "cortex-eval-artifacts-"));
    roots.push(root);
    await materializeWorkPackageFixture(root);
    let nonce = 0;
    const session = await openWorkPackageExecutionSession({
      rootPath: root,
      owner: owner(),
      contextHasher,
      nonce: (): string => `eval_artifact_nonce_${String(++nonce).padStart(2, "0")}`
    });
    try {
      await session.createExecution({
        executionId: EXECUTION_ID,
        createdAt: CREATED_AT,
        rerun: { mode: "NEW" }
      });
      await session.startStage(EXECUTION_ID, "REST", CREATED_AT);
      const restWriter = await session.createStageArtifactWriter(
        EXECUTION_ID,
        "REST_RESULTS",
        Number.MAX_SAFE_INTEGER
      );
      await restWriter.append(Buffer.from("{}\n", "utf8"));
      const restPublished = await restWriter.commit();
      await session.completeStage(EXECUTION_ID, "REST", REST_COMPLETED_AT, [
        publishedStageArtifact(restPublished, "REST_RESULTS", "cortex.rest-results-jsonl.v1")
      ]);
      await session.startStage(EXECUTION_ID, "EVALUATION", EVAL_STARTED_AT);

      const raw = await writeWorkPackageRawPromptfooArtifact(
        session,
        EXECUTION_ID,
        {
          promptfooVersion: "0.121.18",
          exitCode: 0,
          durationMs: 12,
          raw: { results: { version: 3, results: [] } },
          rubricPromptMaterializations: {},
          evaluationContextHash: HASH
        },
        new AbortController().signal
      );
      const normalizedWriter = await WorkPackageNormalizedEvalArtifactWriter.create(
        session,
        EXECUTION_ID,
        HASH
      );
      const item = normalizedCase();
      await normalizedWriter.append({
        ...item,
        rawEvidence: {
          present: true,
          path: raw.path,
          expectedSha256: raw.sha256,
          expectedSizeBytes: raw.sizeBytes
        }
      });
      const normalized = await normalizedWriter.commit(EVAL_COMPLETED_AT, HASH);
      await session.completeStage(EXECUTION_ID, "EVALUATION", EVAL_COMPLETED_AT, [raw, normalized]);

      const rawValue = RawPromptfooEvidenceArtifactV1Schema.parse(
        JSON.parse(
          await readFile(join(root, `executions/${EXECUTION_ID}/promptfoo-raw.json`), "utf8")
        ) as unknown
      );
      const normalizedRecords = (
        await readFile(join(root, `executions/${EXECUTION_ID}/normalized-eval.jsonl`), "utf8")
      )
        .trimEnd()
        .split("\n")
        .map(
          (line) => JSON.parse(line) as { readonly recordType: string; readonly value?: unknown }
        );
      expect(rawValue).toMatchObject({
        packageId: WORK_PACKAGE_FIXTURE_ID,
        executionId: EXECUTION_ID,
        evaluationContextHash: HASH
      });
      expect(normalizedRecords[0]).toMatchObject({
        packageId: WORK_PACKAGE_FIXTURE_ID,
        executionId: EXECUTION_ID,
        evaluationContextHash: HASH
      });
      expect(normalizedRecords[1]?.value).toMatchObject({
        caseKey: "case-1",
        ordinal: 0,
        status: "PASS"
      });
    } finally {
      await session.close();
    }
  });

  it("rejects out-of-order Normalized Cases before publishing the slot", async () => {
    const root = await mkdtemp(join(tmpdir(), "cortex-eval-artifact-order-"));
    roots.push(root);
    await materializeWorkPackageFixture(root);
    let nonce = 0;
    const session = await openWorkPackageExecutionSession({
      rootPath: root,
      owner: owner(),
      contextHasher,
      nonce: (): string => `eval_order_nonce_${String(++nonce).padStart(2, "0")}`
    });
    try {
      await session.createExecution({
        executionId: EXECUTION_ID,
        createdAt: CREATED_AT,
        rerun: { mode: "NEW" }
      });
      await session.startStage(EXECUTION_ID, "REST", CREATED_AT);
      const restWriter = await session.createStageArtifactWriter(
        EXECUTION_ID,
        "REST_RESULTS",
        Number.MAX_SAFE_INTEGER
      );
      await restWriter.append(Buffer.from("{}\n", "utf8"));
      const restPublished = await restWriter.commit();
      await session.completeStage(EXECUTION_ID, "REST", REST_COMPLETED_AT, [
        publishedStageArtifact(restPublished, "REST_RESULTS", "cortex.rest-results-jsonl.v1")
      ]);
      await session.startStage(EXECUTION_ID, "EVALUATION", EVAL_STARTED_AT);
      const writer = await WorkPackageNormalizedEvalArtifactWriter.create(
        session,
        EXECUTION_ID,
        HASH
      );
      await expect(writer.append({ ...normalizedCase(), ordinal: 1 })).rejects.toThrow(
        "EVALUATION_STAGE_FAILED"
      );
      await writer.abort();
    } finally {
      await session.close();
    }
  });

  it("rejects every malformed Promptfoo Raw envelope before publishing bytes", async () => {
    const session = await openEvaluationSession("cortex-eval-raw-errors-");
    const base = {
      promptfooVersion: "0.121.18" as const,
      exitCode: 0 as const,
      durationMs: 1,
      rubricPromptMaterializations: {},
      evaluationContextHash: HASH
    };
    try {
      for (const raw of [
        { results: null },
        { results: [] },
        { results: { version: 2, results: [] } },
        { results: { version: 3, results: {} } }
      ]) {
        await expect(
          writeWorkPackageRawPromptfooArtifact(
            session,
            EXECUTION_ID,
            { ...base, raw },
            new AbortController().signal
          )
        ).rejects.toThrow("PROMPTFOO_PROCESS_ERROR");
      }
      await expect(
        writeWorkPackageRawPromptfooArtifact(
          session,
          EXECUTION_ID,
          {
            ...base,
            exitCode: 1 as 0,
            raw: { results: { version: 3, results: [] } }
          },
          new AbortController().signal
        )
      ).rejects.toThrow("PROMPTFOO_PROCESS_ERROR");
    } finally {
      await session.close();
    }
  });

  it("aborts an uncommitted Raw Artifact when cancellation arrives during byte copy", async () => {
    const session = await openEvaluationSession("cortex-eval-raw-cancel-");
    const controller = new AbortController();
    try {
      await expect(
        writeWorkPackageRawPromptfooArtifact(
          session,
          EXECUTION_ID,
          {
            promptfooVersion: "0.121.18",
            exitCode: 0,
            durationMs: 1,
            raw: {
              kind: "PROMPTFOO_RAW_SOURCE",
              openBytes: async function* () {
                yield await Promise.resolve(
                  Buffer.from('{"results":{"version":3,"results":[', "utf8")
                );
                controller.abort();
                yield await Promise.resolve(Buffer.from("]}}", "utf8"));
              },
              openRows: async function* () {
                yield await Promise.resolve({});
              },
              dispose: (): Promise<void> => Promise.resolve()
            },
            rubricPromptMaterializations: {},
            evaluationContextHash: HASH
          },
          controller.signal
        )
      ).rejects.toThrow("REQUEST_ABORTED");
      expect(session.readExecution(EXECUTION_ID)).toMatchObject({
        stages: { EVALUATION: { status: "RUNNING", artifacts: [] } }
      });
    } finally {
      await session.close();
    }
  });

  it("closes Normalized writers on abort and commit errors", async () => {
    const session = await openEvaluationSession("cortex-eval-normalized-errors-");
    try {
      const empty = await WorkPackageNormalizedEvalArtifactWriter.create(
        session,
        EXECUTION_ID,
        HASH
      );
      await expect(empty.commit(EVAL_COMPLETED_AT, HASH)).rejects.toThrow(
        "EVALUATION_STAGE_FAILED"
      );
      await empty.abort();
      await empty.abort();
      await expect(empty.append(normalizedCase())).rejects.toThrow("ARTIFACT_WRITER_CLOSED");

      const invalid = await WorkPackageNormalizedEvalArtifactWriter.create(
        session,
        EXECUTION_ID,
        HASH
      );
      await expect(invalid.append({ ...normalizedCase(), caseKey: "" })).rejects.toThrow(
        "EVALUATION_STAGE_FAILED"
      );
      await invalid.abort();

      const duplicate = await WorkPackageNormalizedEvalArtifactWriter.create(
        session,
        EXECUTION_ID,
        HASH
      );
      await duplicate.append(normalizedCase());
      await expect(duplicate.append({ ...normalizedCase(), ordinal: 1 })).rejects.toThrow(
        "EVALUATION_STAGE_FAILED"
      );
      await duplicate.abort();

      const wrongFrozenIdentity = await WorkPackageNormalizedEvalArtifactWriter.create(
        session,
        EXECUTION_ID,
        HASH
      );
      await expect(
        wrongFrozenIdentity.append({ ...normalizedCase(), caseKey: "not-frozen" })
      ).rejects.toThrow("EVALUATION_STAGE_FAILED");
      await wrongFrozenIdentity.abort();

      const commitFailure = await WorkPackageNormalizedEvalArtifactWriter.create(
        session,
        EXECUTION_ID,
        HASH
      );
      await commitFailure.append(normalizedCase());
      await expect(commitFailure.commit("invalid", HASH)).rejects.toThrow(
        "EVALUATION_STAGE_FAILED"
      );
      await expect(commitFailure.commit(EVAL_COMPLETED_AT, HASH)).rejects.toThrow(
        "ARTIFACT_WRITER_CLOSED"
      );
    } finally {
      await session.close();
    }
  });
});
