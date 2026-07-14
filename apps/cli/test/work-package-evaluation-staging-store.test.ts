import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ImportedEvalCase } from "@cortex-eval/application/src/features/evaluation/promptfoo-result-importer.ts";
import type { OfflineRestCaseResult } from "@cortex-eval/application/src/features/runs/offline-rest-execution-service.ts";
import type { FrozenRunCase } from "@cortex-eval/application/src/features/runs/run-rest-models.ts";
import type { EvalCaseV1 } from "@cortex-eval/contracts/src/artifact-contracts.ts";
import { afterEach, describe, expect, it } from "vitest";

import { WorkPackageEvaluationStagingStore } from "../src/work-package-evaluation-staging-store.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const roots: string[] = [];

function testCase(ordinal: number): FrozenRunCase {
  const caseKey = `case-${ordinal}`;
  return {
    caseKey,
    ordinal,
    definitionHash: HASH_A,
    definition: {
      caseKey,
      description: `Case ${ordinal}`,
      threshold: 1,
      task: "reply",
      requestBody: { ordinal },
      metadata: {
        requestId: `request-${ordinal}`,
        taskId: `task-${ordinal}`,
        businessModule: "staging",
        scenarioTag: "bounded"
      },
      assertions: [{ type: "equals", metric: "exact", weight: 1, value: ordinal }]
    }
  };
}

function restResult(ordinal: number, status: "SUCCEEDED" | "ERROR"): OfflineRestCaseResult {
  const common = {
    caseKey: `case-${ordinal}`,
    ordinal,
    caseDefinitionHash: HASH_A,
    durationMs: 1,
    completedAt: "2026-07-14T07:00:00.000Z",
    resultHash: HASH_B,
    provenance: null
  };
  return status === "SUCCEEDED"
    ? {
        ...common,
        status,
        httpStatus: 200,
        providerOutput: {
          ok: true,
          taskName: "reply",
          resolvedConfig: {},
          parsedOutput: { ordinal }
        },
        errorType: null,
        errorMessage: null
      }
    : {
        ...common,
        status,
        httpStatus: null,
        providerOutput: null,
        errorType: "NETWORK",
        errorMessage: "network"
      };
}

function failedProviderOutput(ordinal: number): OfflineRestCaseResult {
  const value = restResult(ordinal, "SUCCEEDED");
  if (value.status !== "SUCCEEDED") throw new Error("TEST_REST_RESULT_INVALID");
  return {
    ...value,
    providerOutput: { ok: false, errorMessage: "business failure" }
  };
}

function evalResult(
  ordinal: number,
  provenance: EvalCaseV1["provenance"]
): EvalCaseV1 | ImportedEvalCase {
  return {
    caseKey: `case-${ordinal}`,
    ordinal,
    status: "PASS",
    promptfooSuccess: true,
    score: 1,
    reason: "matched",
    evaluationError: null,
    assertions: [],
    diffs: [],
    metrics: [{ metric: "exact", status: "PASS" }],
    latencyMs: 1,
    tokenUsage: null,
    cost: null,
    rawEvidence: {
      present: true,
      path: "executions/018f22aa-33bb-7ccc-8ddd-fffffffffff1/promptfoo-raw.json",
      expectedSha256: HASH_A,
      expectedSizeBytes: 1
    },
    evalResultHash: HASH_A,
    finalCaseResultHash: HASH_B,
    provenance
  };
}

function stream<Value>(factory: () => Iterable<Value>): AsyncIterable<Value> {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<Value> {
      for (const value of factory()) yield await Promise.resolve(value);
    }
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Work Package Evaluation disk staging", () => {
  it("replays pending joins, merges reusable and imported results, and reclaims private storage", async () => {
    const root = await mkdtemp(join(tmpdir(), "cortex-eval-staging-test-"));
    roots.push(root);
    const parent = join(root, "staging");
    const staging = await WorkPackageEvaluationStagingStore.create(root, parent);
    await staging.stageInputs(
      stream(() => [testCase(0), testCase(1), testCase(2)]),
      stream(() => [
        restResult(0, "SUCCEEDED"),
        restResult(1, "SUCCEEDED"),
        restResult(2, "ERROR")
      ]),
      3,
      new AbortController().signal
    );
    await staging.stageReusable(
      stream(() => [
        evalResult(1, {
          sourceKind: "EXECUTION",
          sourceId: "018f22aa-33bb-7ccc-8ddd-fffffffffff1",
          sourceResultHash: HASH_A
        }) as EvalCaseV1
      ]),
      new AbortController().signal
    );

    const pendingOrdinals: number[] = [];
    for await (const item of staging.caseSource().open()) {
      pendingOrdinals.push(item.testCase.ordinal);
    }
    const preflightOrdinals: number[] = [];
    for await (const item of staging.openPreflightCases()) preflightOrdinals.push(item.ordinal);
    expect(pendingOrdinals).toEqual([0, 2]);
    expect(preflightOrdinals).toEqual([0]);

    const first = staging.findPendingImportCase("case-0");
    if (first === null) throw new Error("TEST_PENDING_CASE_MISSING");
    staging.storeImported(evalResult(first.ordinal, null) as ImportedEvalCase);
    const missing: number[] = [];
    for await (const item of staging.openMissingImportCases()) {
      missing.push(item.ordinal);
      staging.storeImported(evalResult(item.ordinal, null) as ImportedEvalCase);
    }
    const final: number[] = [];
    for await (const item of staging.openFinalResults()) final.push(item.ordinal);
    expect(missing).toEqual([2]);
    expect(final).toEqual([0, 1, 2]);

    await staging.dispose();
    expect(await readdir(parent)).toEqual([]);
  });

  it("accepts a replayable multi-batch source without materializing the complete collection", async () => {
    const root = await mkdtemp(join(tmpdir(), "cortex-eval-staging-scale-"));
    roots.push(root);
    const staging = await WorkPackageEvaluationStagingStore.create(root, join(root, "staging"));
    const count = 2_048;
    await staging.stageInputs(
      stream(function* () {
        for (let ordinal = 0; ordinal < count; ordinal += 1) yield testCase(ordinal);
      }),
      stream(function* () {
        for (let ordinal = 0; ordinal < count; ordinal += 1) {
          yield restResult(ordinal, "SUCCEEDED");
        }
      }),
      count,
      new AbortController().signal
    );

    let replayed = 0;
    for await (const item of staging.caseSource().open()) {
      expect(item.testCase.ordinal).toBe(replayed);
      replayed += 1;
    }
    expect(replayed).toBe(count);
    await staging.dispose();
  });

  it("rolls back the current reusable and imported result batches on failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "cortex-eval-staging-batch-rollback-"));
    roots.push(root);
    const staging = await WorkPackageEvaluationStagingStore.create(root, join(root, "staging"));
    await staging.stageInputs(
      stream(() => [testCase(0), testCase(1)]),
      stream(() => [restResult(0, "SUCCEEDED"), restResult(1, "SUCCEEDED")]),
      2,
      new AbortController().signal
    );

    await expect(
      staging.stageReusable(
        stream(() => [
          evalResult(0, null) as EvalCaseV1,
          { ...(evalResult(1, null) as EvalCaseV1), caseKey: "unknown" }
        ]),
        new AbortController().signal
      )
    ).rejects.toThrow("WORK_PACKAGE_INVALID");
    const pendingAfterReusable: number[] = [];
    for await (const item of staging.caseSource().open()) {
      pendingAfterReusable.push(item.testCase.ordinal);
    }
    expect(pendingAfterReusable).toEqual([0, 1]);

    const imported = evalResult(0, null) as ImportedEvalCase;
    staging.storeImported(imported);
    expect(() => staging.storeImported(imported)).toThrow("PROMPTFOO_IMPORT_CASE_DUPLICATE");
    staging.rollbackImportedBatch();
    const missingAfterImported: number[] = [];
    for await (const item of staging.openMissingImportCases()) {
      missingAfterImported.push(item.ordinal);
    }
    expect(missingAfterImported).toEqual([0, 1]);
    await staging.dispose();
  });

  it("commits reusable and imported results only at the 128-item batch boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "cortex-eval-staging-batch-boundary-"));
    roots.push(root);
    const count = 129;
    const reusable = await WorkPackageEvaluationStagingStore.create(root, join(root, "reusable"));
    await reusable.stageInputs(
      stream(function* () {
        for (let ordinal = 0; ordinal < count; ordinal += 1) yield testCase(ordinal);
      }),
      stream(function* () {
        for (let ordinal = 0; ordinal < count; ordinal += 1) {
          yield restResult(ordinal, "SUCCEEDED");
        }
      }),
      count,
      new AbortController().signal
    );
    await expect(
      reusable.stageReusable(
        stream(function* () {
          for (let ordinal = 0; ordinal < count; ordinal += 1) {
            yield evalResult(ordinal, null) as EvalCaseV1;
          }
          yield { ...(evalResult(count, null) as EvalCaseV1), caseKey: "unknown" };
        }),
        new AbortController().signal
      )
    ).rejects.toThrow("WORK_PACKAGE_INVALID");
    const reusablePending: number[] = [];
    for await (const item of reusable.caseSource().open()) {
      reusablePending.push(item.testCase.ordinal);
    }
    expect(reusablePending).toEqual([128]);
    await reusable.dispose();

    const imported = await WorkPackageEvaluationStagingStore.create(root, join(root, "imported"));
    await imported.stageInputs(
      stream(function* () {
        for (let ordinal = 0; ordinal < count; ordinal += 1) yield testCase(ordinal);
      }),
      stream(function* () {
        for (let ordinal = 0; ordinal < count; ordinal += 1) {
          yield restResult(ordinal, "SUCCEEDED");
        }
      }),
      count,
      new AbortController().signal
    );
    for (let ordinal = 0; ordinal < count; ordinal += 1) {
      imported.storeImported(evalResult(ordinal, null) as ImportedEvalCase);
    }
    imported.rollbackImportedBatch();
    const importedMissing: number[] = [];
    for await (const item of imported.openMissingImportCases()) {
      importedMissing.push(item.ordinal);
    }
    expect(importedMissing).toEqual([128]);
    await imported.dispose();
  });

  it("rolls back cancellation and rejects missing, duplicate, or closed staging facts", async () => {
    const root = await mkdtemp(join(tmpdir(), "cortex-eval-staging-errors-"));
    roots.push(root);
    const staging = await WorkPackageEvaluationStagingStore.create(root, join(root, "staging"));
    const cancelled = new AbortController();
    cancelled.abort();

    await expect(
      staging.stageInputs(
        stream(() => [testCase(0)]),
        stream(() => [failedProviderOutput(0)]),
        1,
        cancelled.signal
      )
    ).rejects.toThrow("REQUEST_ABORTED");
    await expect(
      staging.stageInputs(
        stream(() => [testCase(0)]),
        stream(() => []),
        1,
        new AbortController().signal
      )
    ).rejects.toThrow("WORK_PACKAGE_INVALID");
    await expect(
      staging.stageInputs(
        stream(() => [testCase(0)]),
        stream(() => [failedProviderOutput(1)]),
        1,
        new AbortController().signal
      )
    ).rejects.toThrow("WORK_PACKAGE_INVALID");

    await staging.stageInputs(
      stream(() => [testCase(0)]),
      stream(() => [failedProviderOutput(0)]),
      1,
      new AbortController().signal
    );
    expect(staging.findPendingImportCase("missing")).toBeNull();
    expect(staging.findPendingImportCase("case-0")).toMatchObject({
      restResult: {
        status: "SUCCEEDED",
        providerOutput: { ok: false, errorMessage: "business failure" }
      }
    });

    const reusableCancellation = new AbortController();
    reusableCancellation.abort();
    await expect(
      staging.stageReusable(
        stream(() => [evalResult(0, null) as EvalCaseV1]),
        reusableCancellation.signal
      )
    ).rejects.toThrow("REQUEST_ABORTED");

    const readMissingFinal = async (): Promise<void> => {
      for await (const unused of staging.openFinalResults()) void unused;
    };
    await expect(readMissingFinal()).rejects.toThrow("WORK_PACKAGE_INVALID");

    const imported = evalResult(0, null) as ImportedEvalCase;
    staging.storeImported(imported);
    staging.commitImportedBatch();
    expect(() => staging.storeImported(imported)).toThrow("PROMPTFOO_IMPORT_CASE_DUPLICATE");
    staging.rollbackImportedBatch();
    const conflictingReusable = evalResult(0, null) as EvalCaseV1;
    await expect(
      staging.stageReusable(
        stream(() => [conflictingReusable]),
        new AbortController().signal
      )
    ).rejects.toThrow("WORK_PACKAGE_INVALID");

    await staging.dispose();
    await staging.dispose();
    expect(() => staging.caseSource()).toThrow("EVALUATION_STAGING_CLOSED");

    const identityStaging = await WorkPackageEvaluationStagingStore.create(
      root,
      join(root, "identity-staging")
    );
    const divergentCase = { ...testCase(0), caseKey: "outer-case" };
    const divergentRest = { ...failedProviderOutput(0), caseKey: "outer-case" };
    await identityStaging.stageInputs(
      stream(() => [divergentCase]),
      stream(() => [divergentRest]),
      1,
      new AbortController().signal
    );
    const replayDivergent = async (): Promise<void> => {
      for await (const unused of identityStaging.caseSource().open()) void unused;
    };
    await expect(replayDivergent()).rejects.toThrow("WORK_PACKAGE_INVALID");
    await identityStaging.dispose();
  });
});
