import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OfflineRestCaseResult } from "@cortex-eval/application/src/features/runs/offline-rest-execution-service.ts";
import {
  EvalCaseV1Schema,
  type EvalCaseV1
} from "@cortex-eval/contracts/src/artifact-contracts.ts";
import {
  ExecutionV2Schema,
  type ExecutionV2
} from "@cortex-eval/contracts/src/work-package-contracts.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ports = vi.hoisted(() => ({
  prepareEvaluation: vi.fn(),
  prepareRest: vi.fn(),
  validateIntegrity: vi.fn()
}));

vi.mock("../src/work-package-evaluation-result-reader.ts", () => ({
  prepareWorkPackageEvaluationResults: ports.prepareEvaluation
}));
vi.mock("../src/work-package-rest-retry-reader.ts", () => ({
  prepareWorkPackageRestResults: ports.prepareRest
}));
vi.mock("../src/work-package-file-integrity.ts", () => ({
  validateFileIntegrity: ports.validateIntegrity
}));

import { SecureWorkPackageDirectory } from "../src/secure-work-package-directory.ts";
import {
  prepareWorkPackageEvaluationRetryResults,
  type WorkPackageEvalSemanticHashing
} from "../src/work-package-evaluation-retry-reader.ts";
import type { WorkPackageRestSemanticHashing } from "../src/work-package-rest-retry-reader.ts";
import {
  materializeWorkPackageFixture,
  WORK_PACKAGE_FIXTURE_ID
} from "../test-support/work-package-fixture.ts";

const SOURCE_ID = "018f22aa-33bb-7ccc-8ddd-fffffffffff1";
const TARGET_ID = "018f22aa-33bb-7ccc-8ddd-fffffffffff2";
const ANCESTOR_ID = "018f22aa-33bb-7ccc-8ddd-fffffffffff3";
const EMPTY_ANCESTOR_ID = "018f22aa-33bb-7ccc-8ddd-fffffffffff4";
const MISSING_ANCESTOR_ID = "018f22aa-33bb-7ccc-8ddd-fffffffffff5";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const roots: string[] = [];

type EvaluationArtifact = ExecutionV2["stages"]["EVALUATION"]["artifacts"][number];

const sourceRaw: EvaluationArtifact = {
  kind: "RAW_PROMPTFOO_EVIDENCE",
  path: `executions/${SOURCE_ID}/promptfoo-raw.json`,
  sha256: HASH_A,
  sizeBytes: 10,
  contractVersion: "promptfoo.0.121.18"
};
const ancestorRaw: EvaluationArtifact = {
  kind: "RAW_PROMPTFOO_EVIDENCE",
  path: `executions/${ANCESTOR_ID}/promptfoo-raw.json`,
  sha256: HASH_B,
  sizeBytes: 20,
  contractVersion: "promptfoo.0.121.18"
};

function execution(
  executionId: string,
  rerun:
    { readonly mode: "NEW" } | { readonly mode: "RETRY_FAILED"; readonly sourceExecutionId: string }
): ExecutionV2 {
  return ExecutionV2Schema.parse({
    contractVersion: "cortex.execution.v2",
    packageId: WORK_PACKAGE_FIXTURE_ID,
    executionId,
    createdAt: "2026-07-14T07:00:00.000Z",
    startedAt: null,
    completedAt: null,
    rerun,
    runExecutionLimits: {
      contractVersion: "cortex.run-execution-limits.v1",
      restConcurrency: 4,
      evalConcurrency: 2
    },
    analysisExecutionLimits: {
      contractVersion: "cortex.analysis-execution-limits.v1",
      analysisConcurrency: 1
    },
    executionContextHash: HASH_A,
    stages: {
      REST: {
        status: "PENDING",
        startedAt: null,
        completedAt: null,
        errorCode: null,
        artifacts: []
      },
      EVALUATION: {
        status: "PENDING",
        startedAt: null,
        completedAt: null,
        errorCode: null,
        artifacts: []
      },
      REPORT: {
        status: "PENDING",
        startedAt: null,
        completedAt: null,
        errorCode: null,
        artifacts: []
      },
      ANALYSIS: {
        status: "PENDING",
        startedAt: null,
        completedAt: null,
        errorCode: null,
        artifacts: []
      }
    }
  });
}

function evidence(artifact: EvaluationArtifact): NonNullable<EvalCaseV1["rawEvidence"]> {
  return {
    present: true,
    path: artifact.path,
    expectedSha256: artifact.sha256,
    expectedSizeBytes: artifact.sizeBytes
  };
}

function evalCase(ordinal: number, options: Partial<EvalCaseV1> = {}): EvalCaseV1 {
  return EvalCaseV1Schema.parse({
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
    rawEvidence: evidence(sourceRaw),
    evalResultHash: HASH_A,
    finalCaseResultHash: HASH_A,
    provenance: null,
    ...options
  });
}

function restCase(ordinal: number, caseKey = `case-${ordinal}`): OfflineRestCaseResult {
  return {
    caseKey,
    ordinal,
    caseDefinitionHash: HASH_A,
    status: "SUCCEEDED",
    httpStatus: 200,
    providerOutput: {
      ok: true,
      taskName: "reply",
      resolvedConfig: {},
      parsedOutput: { text: "ok" }
    },
    errorType: null,
    errorMessage: null,
    durationMs: 1,
    completedAt: "2026-07-14T07:01:00.000Z",
    resultHash: HASH_A,
    provenance: null
  };
}

function restFailure(ordinal: number): OfflineRestCaseResult {
  return {
    caseKey: `case-${ordinal}`,
    ordinal,
    caseDefinitionHash: HASH_A,
    status: "ERROR",
    httpStatus: null,
    providerOutput: null,
    errorType: "NETWORK",
    errorMessage: "network",
    durationMs: 1,
    completedAt: "2026-07-14T07:01:00.000Z",
    resultHash: HASH_A,
    provenance: null
  };
}

function stream<Value>(values: readonly Value[]): AsyncIterable<Value> {
  return {
    [Symbol.asyncIterator]: async function* (): AsyncGenerator<Value> {
      await Promise.resolve();
      for (const value of values) yield value;
    }
  };
}

async function collect<Value>(values: AsyncIterable<Value>): Promise<readonly Value[]> {
  const results: Value[] = [];
  for await (const value of values) results.push(value);
  return results;
}

beforeEach(() => {
  ports.prepareEvaluation.mockReset();
  ports.prepareRest.mockReset();
  ports.validateIntegrity.mockReset();
  ports.validateIntegrity.mockResolvedValue(undefined);
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Work Package Evaluation retry selection", () => {
  it("streams only terminal facts already verified by the strict Evaluation reader and aligned to target REST", async () => {
    const root = await mkdtemp(join(tmpdir(), "cortex-eval-retry-selection-"));
    roots.push(root);
    const baseManifest = await materializeWorkPackageFixture(root);
    const directory = await SecureWorkPackageDirectory.open(root);
    const cases = Array.from({ length: 13 }, (_, ordinal) => ({
      caseKey: `case-${ordinal}`,
      ordinal,
      baseDefinitionHash: HASH_A
    }));
    cases[1] = { caseKey: "different-case", ordinal: 1, baseDefinitionHash: HASH_A };
    const manifest = { ...baseManifest, cases };
    const source = execution(SOURCE_ID, { mode: "NEW" });
    const target = execution(TARGET_ID, {
      mode: "RETRY_FAILED",
      sourceExecutionId: SOURCE_ID
    });
    const ancestor = execution(ANCESTOR_ID, { mode: "NEW" });
    const emptyAncestor = execution(EMPTY_ANCESTOR_ID, { mode: "NEW" });
    const ancestorEvidence = evidence(ancestorRaw);
    const sourceCases: EvalCaseV1[] = [
      evalCase(0, {
        status: "NOT_EVALUATED",
        promptfooSuccess: null,
        score: null,
        reason: null,
        latencyMs: null,
        rawEvidence: null,
        metrics: [{ metric: "exact", status: "NOT_EVALUATED" }]
      }),
      evalCase(1),
      evalCase(2),
      evalCase(3, { finalCaseResultHash: HASH_B }),
      evalCase(4, { rawEvidence: null }),
      evalCase(5),
      evalCase(6, { rawEvidence: ancestorEvidence }),
      evalCase(7, {
        rawEvidence: ancestorEvidence,
        provenance: {
          sourceKind: "EXECUTION",
          sourceId: MISSING_ANCESTOR_ID,
          sourceResultHash: HASH_A
        }
      }),
      evalCase(8, {
        rawEvidence: ancestorEvidence,
        provenance: {
          sourceKind: "EXECUTION",
          sourceId: EMPTY_ANCESTOR_ID,
          sourceResultHash: HASH_A
        }
      }),
      evalCase(9, {
        rawEvidence: ancestorEvidence,
        provenance: {
          sourceKind: "EXECUTION",
          sourceId: ANCESTOR_ID,
          sourceResultHash: HASH_A
        }
      }),
      evalCase(10, {
        rawEvidence: ancestorEvidence,
        provenance: {
          sourceKind: "EXECUTION",
          sourceId: ANCESTOR_ID,
          sourceResultHash: HASH_B
        }
      }),
      evalCase(11, {
        rawEvidence: ancestorEvidence,
        provenance: {
          sourceKind: "RUN",
          sourceId: ANCESTOR_ID,
          sourceResultHash: HASH_A
        }
      }),
      evalCase(12, {
        rawEvidence: ancestorEvidence,
        provenance: {
          sourceKind: "EXECUTION",
          sourceId: SOURCE_ID,
          sourceResultHash: HASH_A
        }
      })
    ];
    const ancestorCases = [
      evalCase(9, { rawEvidence: evidence(sourceRaw) }),
      evalCase(10, {
        evalResultHash: HASH_B,
        finalCaseResultHash: HASH_A,
        rawEvidence: ancestorEvidence
      })
    ];
    const evaluations = new Map([
      [SOURCE_ID, { cases: sourceCases, rawArtifact: sourceRaw }],
      [ANCESTOR_ID, { cases: ancestorCases, rawArtifact: ancestorRaw }],
      [EMPTY_ANCESTOR_ID, { cases: [] as EvalCaseV1[], rawArtifact: ancestorRaw }]
    ]);
    ports.prepareEvaluation.mockImplementation(
      (input: { readonly sourceExecution: ExecutionV2 }): Promise<unknown> => {
        const prepared = evaluations.get(input.sourceExecution.executionId);
        if (prepared === undefined) return Promise.reject(new Error("WORK_PACKAGE_INVALID"));
        return Promise.resolve({
          evaluationContextHash: HASH_A,
          resultSetHash: HASH_A,
          rawArtifact: prepared.rawArtifact,
          results: stream(prepared.cases)
        });
      }
    );
    const restCases = Array.from({ length: cases.length }, (_, ordinal) => restCase(ordinal));
    restCases[2] = restFailure(2);
    ports.prepareRest.mockResolvedValue({ resultSetHash: HASH_A, results: stream(restCases) });
    const executions = new Map([
      [SOURCE_ID, source],
      [ANCESTOR_ID, ancestor],
      [EMPTY_ANCESTOR_ID, emptyAncestor]
    ]);
    const restHashing: WorkPackageRestSemanticHashing = {
      hashResult: (): string => HASH_A,
      createResultSetHasher: (): never => {
        throw new Error("TEST_UNUSED");
      }
    };
    const evalHashing: WorkPackageEvalSemanticHashing = {
      hashResult: (): string => HASH_A,
      hashFinalResult: (): string => HASH_A,
      createResultSetHasher: (): never => {
        throw new Error("TEST_UNUSED");
      }
    };

    const reusable = await prepareWorkPackageEvaluationRetryResults({
      directory,
      manifest,
      targetExecution: target,
      readExecution: (executionId): ExecutionV2 | null => executions.get(executionId) ?? null,
      restHashing,
      evalHashing,
      signal: new AbortController().signal
    });

    expect((await collect(reusable)).map((item) => item.ordinal)).toEqual([
      4, 5, 6, 7, 8, 9, 10, 11, 12
    ]);
    expect(ports.prepareEvaluation).toHaveBeenCalledTimes(1);
    expect(ports.validateIntegrity).not.toHaveBeenCalled();
    directory.close();
  });

  it("treats a source rejected by the strict Evaluation reader as non-reusable", async () => {
    const root = await mkdtemp(join(tmpdir(), "cortex-eval-retry-integrity-"));
    roots.push(root);
    const manifest = await materializeWorkPackageFixture(root);
    const directory = await SecureWorkPackageDirectory.open(root);
    const source = execution(SOURCE_ID, { mode: "NEW" });
    const target = execution(TARGET_ID, {
      mode: "RETRY_FAILED",
      sourceExecutionId: SOURCE_ID
    });
    ports.prepareEvaluation.mockRejectedValue(new Error("WORK_PACKAGE_INVALID"));
    ports.prepareRest.mockResolvedValue({
      resultSetHash: HASH_A,
      results: stream([restCase(0, "case-1")])
    });
    const hashing = {
      hashResult: (): string => HASH_A,
      hashFinalResult: (): string => HASH_A,
      createResultSetHasher: (): never => {
        throw new Error("TEST_UNUSED");
      }
    };
    const reusable = await prepareWorkPackageEvaluationRetryResults({
      directory,
      manifest,
      targetExecution: target,
      readExecution: (executionId): ExecutionV2 | null =>
        executionId === SOURCE_ID ? source : null,
      restHashing: hashing,
      evalHashing: hashing,
      signal: new AbortController().signal
    });
    expect(await collect(reusable)).toEqual([]);
    directory.close();
  });
});
