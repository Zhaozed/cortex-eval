import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EvalCaseV1 } from "@cortex-eval/contracts/src/artifact-contracts.ts";
import { caseDefinitionJson } from "../../domain/src/domain-case-projection.ts";
import {
  hashCaseDefinition,
  hashEvalResult,
  hashEvalResultSet,
  hashExecutionContext,
  hashFinalCaseResult,
  hashRestResult,
  hashRestResultSet,
  OrderedEvalResultSetHasher,
  OrderedRestResultSetHasher
} from "../../domain/src/domain-hash-inputs.ts";
import type { OfflineRestCaseResult } from "../../application/src/features/runs/offline-rest-execution-service.ts";
import { afterEach, describe, expect, it } from "vitest";

import type { WorkPackageEvalSemanticHashing } from "../src/work-package-evaluation-retry-reader.ts";
import {
  openWorkPackageExecutionSession,
  type WorkPackageExecutionContextHashInput
} from "../src/work-package-execution-session.ts";
import type { WorkPackageCaseDefinitionHashInput } from "../src/work-package-input-reader.ts";
import { WorkPackageNormalizedEvalArtifactWriter } from "../src/work-package-normalized-eval-artifact-writer.ts";
import { writeWorkPackageRawPromptfooArtifact } from "../src/work-package-raw-promptfoo-artifact-writer.ts";
import { WorkPackageRestArtifactWriter } from "../src/work-package-rest-artifact-writer.ts";
import type { WorkPackageRestSemanticHashing } from "../src/work-package-rest-retry-reader.ts";
import { materializeWorkPackageFixture } from "../test-support/work-package-fixture.ts";

const SOURCE_ID = "018f22aa-33bb-7ccc-8ddd-fffffffffff1";
const TARGET_ID = "018f22aa-33bb-7ccc-8ddd-fffffffffff2";
const PENDING_SOURCE_ID = "018f22aa-33bb-7ccc-8ddd-fffffffffff4";
const PENDING_SOURCE_TARGET_ID = "018f22aa-33bb-7ccc-8ddd-fffffffffff5";
const CREATED_AT = "2026-07-14T07:00:00.000Z";
const HASH = "a".repeat(64);
const roots: string[] = [];

const definition = {
  caseKey: "case-1",
  description: "fixture",
  threshold: 1,
  task: "reply",
  requestBody: { text: "hello" },
  metadata: {
    requestId: "req-1",
    taskId: "task-1",
    businessModule: "fixture",
    scenarioTag: "fixture"
  },
  assertions: [{ type: "equals", metric: "exact", weight: 1, value: "hello" }]
} as const;

const caseHasher = {
  hash: (input: WorkPackageCaseDefinitionHashInput): string =>
    hashCaseDefinition({
      contractVersion: input.contractVersion,
      caseKey: input.caseKey,
      definition: caseDefinitionJson(input.definition)
    })
};

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

const restHashing: WorkPackageRestSemanticHashing = {
  hashResult: (value): string =>
    hashRestResult({
      contractVersion: "cortex.rest-result.v1",
      caseKey: value.caseKey,
      caseDefinitionHash: value.caseDefinitionHash,
      result:
        value.status === "SUCCEEDED"
          ? {
              status: value.status,
              httpStatus: value.httpStatus,
              providerOutput: value.providerOutput
            }
          : { status: value.status, httpStatus: value.httpStatus, errorType: value.errorType }
    }),
  createResultSetHasher: (): OrderedRestResultSetHasher => new OrderedRestResultSetHasher()
};

const evalHashing: WorkPackageEvalSemanticHashing = {
  hashResult: (value): string =>
    hashEvalResult({
      contractVersion: "cortex.eval-result.v1",
      caseKey: value.caseKey,
      status: value.status,
      promptfooSuccess: value.promptfooSuccess,
      score: value.score,
      reason: value.reason,
      evaluationError: value.evaluationError,
      assertions: value.assertions,
      diffs: value.diffs,
      metrics: value.metrics
    }),
  hashFinalResult: (value): string =>
    hashFinalCaseResult({
      contractVersion: "cortex.final-case-result.v1",
      caseDefinitionHash: value.caseDefinitionHash,
      restResultHash: value.restResultHash,
      evalResultHash: value.evalResultHash
    }),
  createResultSetHasher: (expectedCaseKey): OrderedEvalResultSetHasher =>
    new OrderedEvalResultSetHasher(expectedCaseKey)
};

async function appendRest(
  session: Awaited<ReturnType<typeof openWorkPackageExecutionSession>>,
  executionId: string,
  caseDefinitionHash: string,
  provenance: OfflineRestCaseResult["provenance"]
): Promise<string> {
  await session.startStage(executionId, "REST", "2026-07-14T07:01:00.000Z");
  const partial: OfflineRestCaseResult = {
    caseKey: "case-1",
    ordinal: 0,
    caseDefinitionHash,
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
    durationMs: 1,
    completedAt: "2026-07-14T07:02:00.000Z",
    resultHash: "",
    provenance
  };
  const resultHash = restHashing.hashResult(partial);
  const writer = await WorkPackageRestArtifactWriter.create(session, executionId);
  await writer.append({ ...partial, resultHash });
  const resultSetHash = hashRestResultSet({
    contractVersion: "cortex.rest-result-set.v1",
    cases: [{ caseKey: "case-1", ordinal: 0, resultHash }]
  });
  const artifact = await writer.commit("2026-07-14T07:02:00.000Z", resultSetHash);
  await session.completeStage(executionId, "REST", "2026-07-14T07:02:00.000Z", [artifact]);
  return resultHash;
}

async function collect<Value>(values: AsyncIterable<Value>): Promise<readonly Value[]> {
  const results: Value[] = [];
  for await (const value of values) results.push(value);
  return results;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Work Package Evaluation retry reader", () => {
  it("reuses only an aligned PASS/FAIL fact backed by its registered ancestor Raw file", async () => {
    const root = await mkdtemp(join(tmpdir(), "cortex-eval-retry-"));
    roots.push(root);
    const caseDefinitionHash = caseHasher.hash({
      contractVersion: "cortex.case-definition.v1",
      caseKey: definition.caseKey,
      definition
    });
    await materializeWorkPackageFixture(root, { baseDefinitionHash: caseDefinitionHash });
    let nonce = 0;
    const session = await openWorkPackageExecutionSession({
      rootPath: root,
      owner: {
        pid: process.pid,
        processStartedAt: "Tue Jul 14 15:00:00 2026",
        executionId: TARGET_ID,
        acquiredAt: CREATED_AT
      },
      contextHasher,
      nonce: (): string => `eval_retry_nonce_${String(++nonce).padStart(2, "0")}`
    });
    try {
      await session.createExecution({
        executionId: SOURCE_ID,
        createdAt: CREATED_AT,
        rerun: { mode: "NEW" }
      });
      const sourceRestHash = await appendRest(session, SOURCE_ID, caseDefinitionHash, null);
      await session.startStage(SOURCE_ID, "EVALUATION", "2026-07-14T07:03:00.000Z");
      const raw = await writeWorkPackageRawPromptfooArtifact(
        session,
        SOURCE_ID,
        {
          promptfooVersion: "0.121.18",
          exitCode: 0,
          durationMs: 1,
          raw: { results: { version: 3, results: [] } },
          rubricPromptMaterializations: {},
          evaluationContextHash: HASH
        },
        new AbortController().signal
      );
      const baseCase = {
        caseKey: "case-1",
        ordinal: 0,
        status: "PASS" as const,
        promptfooSuccess: true,
        score: 1,
        reason: "matched",
        evaluationError: null,
        assertions: [],
        diffs: [],
        metrics: [{ metric: "exact", status: "PASS" as const }],
        latencyMs: 1,
        tokenUsage: null,
        cost: null,
        rawEvidence: {
          present: true,
          path: raw.path,
          expectedSha256: raw.sha256,
          expectedSizeBytes: raw.sizeBytes
        },
        evalResultHash: "",
        finalCaseResultHash: "",
        provenance: null
      };
      const evalResultHash = evalHashing.hashResult(baseCase);
      const finalCaseResultHash = evalHashing.hashFinalResult({
        caseDefinitionHash,
        restResultHash: sourceRestHash,
        evalResultHash
      });
      const sourceCase: EvalCaseV1 = { ...baseCase, evalResultHash, finalCaseResultHash };
      const normalizedWriter = await WorkPackageNormalizedEvalArtifactWriter.create(
        session,
        SOURCE_ID,
        HASH
      );
      await normalizedWriter.append(sourceCase);
      const resultSetHash = hashEvalResultSet({
        contractVersion: "cortex.eval-result-set.v1",
        owner: { kind: "EXECUTION", id: SOURCE_ID },
        evaluationContextHash: HASH,
        cases: [{ caseKey: "case-1", ordinal: 0, evalResultHash }]
      });
      const normalized = await normalizedWriter.commit("2026-07-14T07:04:00.000Z", resultSetHash);
      await session.completeStage(SOURCE_ID, "EVALUATION", "2026-07-14T07:04:00.000Z", [
        raw,
        normalized
      ]);

      const preparedEvaluation = await session.prepareEvaluationResults(
        SOURCE_ID,
        restHashing,
        evalHashing,
        new AbortController().signal
      );
      const importedCases: EvalCaseV1[] = [];
      for await (const item of preparedEvaluation.results) importedCases.push(item);
      expect(preparedEvaluation).toMatchObject({
        evaluationContextHash: HASH,
        resultSetHash,
        rawArtifact: { path: raw.path, sha256: raw.sha256, sizeBytes: raw.sizeBytes }
      });
      expect(importedCases).toMatchObject([
        { caseKey: "case-1", ordinal: 0, status: "PASS", evalResultHash }
      ]);

      expect(
        await collect(
          await session.prepareEvaluationRetryResults(
            SOURCE_ID,
            restHashing,
            evalHashing,
            new AbortController().signal
          )
        )
      ).toEqual([]);

      await session.createExecution({
        executionId: PENDING_SOURCE_ID,
        createdAt: "2026-07-14T07:04:20.000Z",
        rerun: { mode: "NEW" }
      });
      await session.createExecution({
        executionId: PENDING_SOURCE_TARGET_ID,
        createdAt: "2026-07-14T07:04:30.000Z",
        rerun: { mode: "RETRY_FAILED", sourceExecutionId: PENDING_SOURCE_ID }
      });
      expect(
        await collect(
          await session.prepareEvaluationRetryResults(
            PENDING_SOURCE_TARGET_ID,
            restHashing,
            evalHashing,
            new AbortController().signal
          )
        )
      ).toEqual([]);

      await session.createExecution({
        executionId: TARGET_ID,
        createdAt: "2026-07-14T07:05:00.000Z",
        rerun: { mode: "RETRY_FAILED", sourceExecutionId: SOURCE_ID }
      });
      await appendRest(session, TARGET_ID, caseDefinitionHash, {
        sourceKind: "EXECUTION",
        sourceId: SOURCE_ID,
        sourceResultHash: sourceRestHash
      });

      const cancelled = new AbortController();
      cancelled.abort();
      await expect(
        session.prepareEvaluationRetryResults(TARGET_ID, restHashing, evalHashing, cancelled.signal)
      ).rejects.toThrow("REQUEST_ABORTED");

      const reusable = await session.prepareEvaluationRetryResults(
        TARGET_ID,
        restHashing,
        evalHashing,
        new AbortController().signal
      );
      expect(await collect(reusable)).toMatchObject([
        {
          caseKey: "case-1",
          status: "PASS",
          evalResultHash,
          rawEvidence: { path: raw.path },
          provenance: {
            sourceKind: "EXECUTION",
            sourceId: SOURCE_ID,
            sourceResultHash: evalResultHash
          }
        }
      ]);

      const normalizedPath = join(root, normalized.path);
      const normalizedBytes = await readFile(normalizedPath);
      await unlink(normalizedPath);
      expect(
        await collect(
          await session.prepareEvaluationRetryResults(
            TARGET_ID,
            restHashing,
            evalHashing,
            new AbortController().signal
          )
        )
      ).toEqual([]);

      await writeFile(normalizedPath, normalizedBytes, { mode: 0o600, flag: "wx" });
      expect(
        await collect(
          await session.prepareEvaluationRetryResults(
            TARGET_ID,
            restHashing,
            evalHashing,
            new AbortController().signal
          )
        )
      ).toHaveLength(1);

      await writeFile(join(root, raw.path), "corrupt", { mode: 0o600 });
      expect(
        await collect(
          await session.prepareEvaluationRetryResults(
            TARGET_ID,
            restHashing,
            evalHashing,
            new AbortController().signal
          )
        )
      ).toEqual([]);
      await expect(
        session.prepareEvaluationResults(
          SOURCE_ID,
          restHashing,
          evalHashing,
          new AbortController().signal
        )
      ).rejects.toThrow("WORK_PACKAGE_INVALID");
      const reportResults = await session.prepareEvaluationResultsForReport(
        SOURCE_ID,
        restHashing,
        evalHashing,
        new AbortController().signal
      );
      await expect(collect(reportResults.results)).resolves.toHaveLength(1);
    } finally {
      await session.close();
    }
  });
});
