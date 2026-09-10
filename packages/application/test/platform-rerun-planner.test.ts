import { describe, expect, it } from "vitest";

import type { PlatformEvalCaseResult } from "../src/features/evaluation/platform-eval-models.ts";
import type {
  PlatformEvalRepository,
  PlatformEvalTransactionManager
} from "../src/features/evaluation/platform-eval-ports.ts";
import type {
  PlatformRun,
  RunArtifactDescriptor,
  StoredRestCaseResult
} from "../src/features/runs/platform-run-models.ts";
import type { PlatformRunTransactionManager } from "../src/features/runs/platform-run-ports.ts";
import type {
  RestExecutionInput,
  RestExecutionSummary,
  RestExecutor
} from "../src/features/runs/run-rest-models.ts";
import { createRerunPlan } from "../src/features/runs/platform-rerun-planner.ts";
import { PlatformRerunService } from "../src/features/runs/platform-rerun-service.ts";
import { PlatformRunService } from "../src/features/runs/platform-run-service.ts";
import { MemoryPlatformRunStore } from "../test-support/in-memory-platform-run-store.ts";
import {
  MemoryArtifacts,
  MemoryRunEvents
} from "../test-support/platform-run-resilience-fixtures.ts";

const SOURCE_RUN_ID = "01900000-0000-7000-8000-000000000001";
const TARGET_RUN_ID = "01900000-0000-7000-8000-000000000002";
const INTERMEDIATE_RUN_ID = "01900000-0000-7000-8000-000000000003";
const HASH = "a".repeat(64);
const NOW = "2026-07-14T00:00:00.000Z";

function restResult(
  caseKey: string,
  ordinal: number,
  status: "SUCCEEDED" | "ERROR"
): StoredRestCaseResult {
  const base = {
    runId: SOURCE_RUN_ID,
    caseKey,
    ordinal,
    definition: {
      caseKey,
      description: caseKey,
      threshold: 1,
      task: "route",
      requestBody: { input: caseKey },
      metadata: {
        requestId: `request-${caseKey}`,
        taskId: `task-${caseKey}`,
        businessModule: "chat",
        scenarioTag: "smoke"
      },
      assertions: [{ type: "equals", metric: "quality", weight: 1 }]
    },
    caseDefinitionHash: HASH,
    durationMs: 10,
    completedAt: "2026-07-14T00:00:00.000Z",
    resultHash: `${ordinal + 1}`.repeat(64),
    provenance: null
  };
  if (status === "SUCCEEDED") {
    return {
      ...base,
      status,
      httpStatus: 200,
      providerOutput: { ok: false, errorMessage: "business" },
      errorType: null,
      errorMessage: null
    };
  }
  return {
    ...base,
    status,
    httpStatus: 500,
    providerOutput: null,
    errorType: "HTTP_STATUS",
    errorMessage: "HTTP status"
  };
}

function evalResult(
  caseKey: string,
  ordinal: number,
  status: "PASS" | "EVALUATION_ERROR" | "NOT_EVALUATED"
): PlatformEvalCaseResult {
  const observed = status === "PASS";
  return {
    runId: SOURCE_RUN_ID,
    caseKey,
    ordinal,
    status,
    promptfooSuccess: observed ? true : null,
    score: observed ? 1 : null,
    reason: observed ? "passed" : null,
    evaluationError: status === "EVALUATION_ERROR" ? { code: "EVALUATOR_TIMEOUT" } : null,
    assertions: [],
    diffs: [],
    metrics: [{ metric: "quality", status: observed ? "PASS" : "NOT_EVALUATED" }],
    latencyMs: observed ? 5 : null,
    tokenUsage: null,
    cost: null,
    rawEvidence: observed
      ? {
          present: true,
          path: `runs/${SOURCE_RUN_ID}/promptfoo-raw.json`,
          expectedSha256: HASH,
          expectedSizeBytes: 100
        }
      : null,
    evalResultHash: `${ordinal + 5}`.repeat(64),
    finalCaseResultHash: `${ordinal + 7}`.repeat(64),
    provenance: null,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z"
  };
}

function sourceRun(withEvalArtifacts = true): PlatformRun {
  const artifacts: RunArtifactDescriptor[] = [
    {
      kind: "REST_RESULTS",
      path: `runs/${SOURCE_RUN_ID}/rest-results.json`,
      expectedSha256: HASH,
      expectedSizeBytes: 100,
      contractVersion: "cortex.platform-rest-results.v1"
    }
  ];
  if (withEvalArtifacts) {
    artifacts.push(
      {
        kind: "RAW_PROMPTFOO_EVIDENCE",
        path: `runs/${SOURCE_RUN_ID}/promptfoo-raw.json`,
        expectedSha256: HASH,
        expectedSizeBytes: 100,
        contractVersion: "cortex.platform-raw-promptfoo-evidence.v1"
      },
      {
        kind: "NORMALIZED_EVAL_RESULTS",
        path: `runs/${SOURCE_RUN_ID}/normalized-eval.json`,
        expectedSha256: HASH,
        expectedSizeBytes: 100,
        contractVersion: "cortex.platform-normalized-eval.v1"
      }
    );
  }
  const rests = [
    restResult("pass", 0, "SUCCEEDED"),
    restResult("eval-error", 1, "SUCCEEDED"),
    restResult("rest-error", 2, "ERROR")
  ];
  return {
    id: SOURCE_RUN_ID,
    sourceType: "PLATFORM",
    sourceRunId: null,
    rerunMode: "NONE",
    suite: {
      id: "01900000-0000-7000-8000-000000000100",
      name: "Suite",
      suiteHash: HASH,
      cases: rests.map((item) => ({
        caseKey: item.caseKey,
        ordinal: item.ordinal,
        definitionHash: item.caseDefinitionHash,
        definition: item.definition
      }))
    },
    endpoint: {
      sourceId: null,
      name: "Endpoint",
      configHash: HASH,
      definition: {
        urlTemplate: "https://example.test/{{vars.task}}",
        method: "POST",
        headers: {},
        bodySelector: "/request_body",
        timeoutMs: 1_000,
        defaultConcurrency: 2
      }
    },
    evaluator: {
      sourceId: null,
      name: "Evaluator",
      configHash: HASH,
      definition: {
        providerType: "GOOGLE_GEMINI",
        apiKey: { kind: "ENV_SECRET", envKey: "GEMINI_API_KEY" },
        model: "gemini-test",
        thinkingLevel: "OFF",
        temperature: 0,
        topP: 1,
        maxOutputTokens: 128,
        timeoutMs: 1_000,
        structuredOutput: "JSON_OBJECT"
      }
    },
    rubricPrompts: [],
    runContextHash: HASH,
    promptfooVersion: "0.121.18",
    contractVersions: {
      runSnapshot: "cortex.run-snapshot.v1",
      caseDefinition: "cortex.case-definition.v1",
      platformRestResults: "cortex.platform-rest-results.v1"
    },
    runExecutionLimits: {
      contractVersion: "cortex.run-execution-limits.v1",
      restConcurrency: 2,
      evalConcurrency: 2
    },
    runMode: "STAGED",
    status: "FAILED",
    stage: "DONE",
    lockRevision: 4,
    cancelRequestedAt: null,
    restCompletedCount: rests.length,
    restErrorCount: 1,
    evalCompletedCount: 0,
    evalPassCount: 0,
    evalFailCount: 0,
    evalErrorCount: 0,
    evalNotEvaluatedCount: 0,
    resultSetHash: HASH,
    evaluationContextHash: null,
    evaluationResultSetHash: null,
    reportResultSetHash: null,
    reportSummary: null,
    artifactManifest: {
      contractVersion: "cortex.artifact-manifest.v1",
      owner: { kind: "RUN", id: SOURCE_RUN_ID },
      artifacts
    },
    errorCode: "EVALUATION_STAGE_FAILED",
    errorMessage: "evaluation failed",
    startedAt: NOW,
    completedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW
  };
}

// Verify every source descriptor unless a test overrides one exact file state.
function sourceArtifacts(
  run: PlatformRun,
  unavailable?: {
    readonly kind: RunArtifactDescriptor["kind"];
    readonly status: "MISSING" | "CORRUPTED";
  }
): MemoryArtifacts {
  const artifacts = new MemoryArtifacts();
  artifacts.availability = run.artifactManifest.artifacts.map((artifact) => ({
    artifact,
    status: artifact.kind === unavailable?.kind ? unavailable.status : "PRESENT"
  }));
  return artifacts;
}

class SourceEvalRepository implements PlatformEvalRepository {
  /** Source Eval facts returned in frozen order. */
  readonly #items: readonly PlatformEvalCaseResult[];

  /** Bind source facts. */
  public constructor(items: readonly PlatformEvalCaseResult[]) {
    this.#items = items;
  }

  /** Rerun planning never commits Evaluation. */
  public completeStage(): never {
    throw new Error("TEST_UNEXPECTED_EVAL_COMMIT");
  }

  /** Return the requested source page. */
  public queryResults(
    query: Parameters<PlatformEvalRepository["queryResults"]>[0]
  ): ReturnType<PlatformEvalRepository["queryResults"]> {
    const items = this.#items.filter(
      (item) => item.runId === query.runId && item.ordinal > (query.afterOrdinal ?? -1)
    );
    return Promise.resolve({ items: items.slice(0, query.limit), nextCursor: null });
  }
}

function evalTransactions(
  items: readonly PlatformEvalCaseResult[]
): PlatformEvalTransactionManager {
  const repository = new SourceEvalRepository(items);
  return {
    execute: (work) => work({ evaluations: repository })
  };
}

function runTransactions(runs: MemoryPlatformRunStore): PlatformRunTransactionManager {
  return {
    execute: (work) =>
      work({
        resources: {
          getSuite: () => Promise.resolve(null),
          listCases: () => Promise.resolve([]),
          getConfiguration: () => Promise.resolve(null),
          listRubricPrompts: () => Promise.resolve([])
        },
        runs
      })
  };
}

class PendingOnlyRestExecutor implements RestExecutor {
  /** Case keys observed at the external execution boundary. */
  caseKeys: readonly string[] = [];

  /** Complete only the one non-reused REST Case. */
  public async execute(input: RestExecutionInput): Promise<RestExecutionSummary> {
    this.caseKeys = input.cases.map((item) => item.caseKey);
    const pending = input.cases[0];
    if (pending !== undefined) {
      await input.onResult({
        caseKey: pending.caseKey,
        ordinal: pending.ordinal,
        status: "SUCCEEDED",
        httpStatus: 200,
        providerOutput: { ok: false, errorMessage: "retried" },
        errorType: undefined,
        durationMs: 3
      });
    }
    return { dispatchedCount: input.cases.length };
  }
}

class UnexpectedArtifactInspection extends MemoryArtifacts {
  /** Force must not read Eval Artifact availability because it never reuses Eval. */
  public override inspect(): Promise<never> {
    return Promise.reject(new Error("TEST_FORCE_ARTIFACT_INSPECTION"));
  }
}

class AllPresentArtifacts extends MemoryArtifacts {
  /** Verify every descriptor from whichever provenance generation is inspected. */
  public override inspect(
    manifest?: PlatformRun["artifactManifest"]
  ): Promise<readonly { readonly artifact: RunArtifactDescriptor; readonly status: "PRESENT" }[]> {
    if (manifest === undefined) {
      return Promise.resolve([]);
    }
    return Promise.resolve(
      manifest.artifacts.map((artifact) => ({ artifact, status: "PRESENT" as const }))
    );
  }
}

class InvalidCursorEvalRepository implements PlatformEvalRepository {
  /** Rerun planning never commits Evaluation. */
  public completeStage(): never {
    throw new Error("TEST_UNEXPECTED_EVAL_COMMIT");
  }

  /** Return a cursor that does not advance on the second page. */
  public queryResults(query: Parameters<PlatformEvalRepository["queryResults"]>[0]): Promise<{
    readonly items: readonly PlatformEvalCaseResult[];
    readonly nextCursor: number;
  }> {
    return Promise.resolve({
      items: query.afterOrdinal === undefined ? [evalResult("pass", 0, "PASS")] : [],
      nextCursor: 0
    });
  }
}

function invalidCursorTransactions(): PlatformEvalTransactionManager {
  const repository = new InvalidCursorEvalRepository();
  return {
    execute: (work) => work({ evaluations: repository })
  };
}

describe("平台失败重跑选择计划", () => {
  it("复用 REST 成功及对齐 PASS/FAIL，重评错误或缺失，重试 REST 错误", () => {
    const plan = createRerunPlan({
      sourceRunId: SOURCE_RUN_ID,
      mode: "RETRY_FAILED",
      cases: [
        {
          caseKey: "pass",
          ordinal: 0,
          rest: restResult("pass", 0, "SUCCEEDED"),
          evaluation: evalResult("pass", 0, "PASS")
        },
        {
          caseKey: "eval-error",
          ordinal: 1,
          rest: restResult("eval-error", 1, "SUCCEEDED"),
          evaluation: evalResult("eval-error", 1, "EVALUATION_ERROR")
        },
        {
          caseKey: "missing-eval",
          ordinal: 2,
          rest: restResult("missing-eval", 2, "SUCCEEDED"),
          evaluation: null
        },
        {
          caseKey: "rest-error",
          ordinal: 3,
          rest: restResult("rest-error", 3, "ERROR"),
          evaluation: evalResult("rest-error", 3, "NOT_EVALUATED")
        }
      ]
    });

    expect(plan.cases).toEqual([
      {
        caseKey: "pass",
        ordinal: 0,
        action: "REUSE_REST_AND_EVAL",
        restReuse: { sourceRunId: SOURCE_RUN_ID, sourceResultHash: "1".repeat(64) },
        evalReuse: { sourceRunId: SOURCE_RUN_ID, sourceResultHash: "5".repeat(64) }
      },
      {
        caseKey: "eval-error",
        ordinal: 1,
        action: "REUSE_REST_REEVALUATE",
        restReuse: { sourceRunId: SOURCE_RUN_ID, sourceResultHash: "2".repeat(64) }
      },
      {
        caseKey: "missing-eval",
        ordinal: 2,
        action: "REUSE_REST_REEVALUATE",
        restReuse: { sourceRunId: SOURCE_RUN_ID, sourceResultHash: "3".repeat(64) }
      },
      {
        caseKey: "rest-error",
        ordinal: 3,
        action: "RETRY_REST_THEN_EVALUATE"
      }
    ]);
    expect(plan.counts).toEqual({ reuseRest: 3, executeRest: 1, reuseEval: 1, executeEval: 3 });
  });

  it("Force 对全部 Case 重做 REST，并只在新 REST 成功后评估", () => {
    const plan = createRerunPlan({
      sourceRunId: SOURCE_RUN_ID,
      mode: "FORCE",
      cases: [
        {
          caseKey: "pass",
          ordinal: 0,
          rest: restResult("pass", 0, "SUCCEEDED"),
          evaluation: evalResult("pass", 0, "PASS")
        }
      ]
    });

    expect(plan.cases).toEqual([
      { caseKey: "pass", ordinal: 0, action: "FORCE_REST_THEN_EVALUATE" }
    ]);
    expect(plan.counts).toEqual({ reuseRest: 0, executeRest: 1, reuseEval: 0, executeEval: 1 });
  });

  it("拒绝乱序、跨 Run 和 REST Error 携带可复用 Eval 的来源事实", () => {
    expect(() =>
      createRerunPlan({
        sourceRunId: SOURCE_RUN_ID,
        mode: "RETRY_FAILED",
        cases: [
          {
            caseKey: "case",
            ordinal: 1,
            rest: restResult("case", 1, "SUCCEEDED"),
            evaluation: null
          }
        ]
      })
    ).toThrow("RERUN_PLAN_SOURCE_ALIGNMENT");
    expect(() =>
      createRerunPlan({
        sourceRunId: SOURCE_RUN_ID,
        mode: "RETRY_FAILED",
        cases: [
          {
            caseKey: "case",
            ordinal: 0,
            rest: { ...restResult("case", 0, "SUCCEEDED"), runId: "different" },
            evaluation: null
          }
        ]
      })
    ).toThrow("RERUN_PLAN_SOURCE_ALIGNMENT");
    expect(() =>
      createRerunPlan({
        sourceRunId: SOURCE_RUN_ID,
        mode: "RETRY_FAILED",
        cases: [
          {
            caseKey: "case",
            ordinal: 0,
            rest: restResult("case", 0, "ERROR"),
            evaluation: evalResult("case", 0, "PASS")
          }
        ]
      })
    ).toThrow("RERUN_PLAN_SOURCE_ALIGNMENT");
  });

  it.each([false, true])(
    "single Case replay preserves source and seeds REST only for reevaluation: %s",
    async (reevaluateOnly) => {
      const source = sourceRun();
      const runs = new MemoryPlatformRunStore();
      runs.values.set(SOURCE_RUN_ID, source);
      for (const frozen of source.suite.cases)
        runs.results.set(
          `${SOURCE_RUN_ID}:${frozen.caseKey}`,
          restResult(
            frozen.caseKey,
            frozen.ordinal,
            frozen.caseKey === "rest-error" ? "ERROR" : "SUCCEEDED"
          )
        );
      const service = new PlatformRerunService({
        runTransactionManager: runTransactions(runs),
        evalTransactionManager: evalTransactions([]),
        artifactStore: sourceArtifacts(source),
        idGenerator: { nextId: (): string => TARGET_RUN_ID },
        clock: { now: (): string => NOW }
      });
      const created = await service.create({
        sourceRunId: SOURCE_RUN_ID,
        mode: "FORCE",
        caseKey: "eval-error",
        reevaluateOnly
      });
      expect(created).toMatchObject({
        ok: true,
        run: {
          status: "READY",
          restCompletedCount: reevaluateOnly ? 1 : 0,
          suite: { cases: [{ caseKey: "eval-error", ordinal: 0 }] }
        },
        plan: { counts: { executeRest: reevaluateOnly ? 0 : 1, executeEval: 1, reuseEval: 0 } }
      });
      expect(runs.values.get(SOURCE_RUN_ID)).toEqual(source);
      if (reevaluateOnly) {
        const executor = new PendingOnlyRestExecutor();
        const execution = new PlatformRunService({
          transactionManager: runTransactions(runs),
          restExecutor: executor,
          artifactStore: new MemoryArtifacts(),
          clock: { now: (): string => NOW },
          idGenerator: { nextId: (): string => "unused" },
          messageResolver: { message: (code): string => code },
          eventSink: new MemoryRunEvents(),
          cancellationPollMs: 25
        });
        await execution.start({ runId: TARGET_RUN_ID, expectedRevision: 0 });
        await execution.waitForIdle();
        expect(executor.caseKeys).toEqual([]);
        expect(await execution.getProgress(TARGET_RUN_ID)).toMatchObject({
          stage: "EVALUATION",
          status: "READY",
          restCompletedCount: 1
        });
      }

      expect(await runs.getRestResult(TARGET_RUN_ID, "eval-error")).toEqual(
        reevaluateOnly
          ? expect.objectContaining({
              ordinal: 0,
              provenance: {
                sourceKind: "RUN",
                sourceId: SOURCE_RUN_ID,
                sourceResultHash: "2".repeat(64)
              }
            })
          : null
      );
      await expect(
        service.create({ sourceRunId: SOURCE_RUN_ID, mode: "FORCE", caseKey: "missing" })
      ).resolves.toMatchObject({ ok: false });
      await expect(
        service.create({
          sourceRunId: SOURCE_RUN_ID,
          mode: "FORCE",
          caseKey: "rest-error",
          reevaluateOnly: true
        })
      ).resolves.toMatchObject({ ok: false });
    }
  );

  it("内部 Retry 用例创建新执行版本、预置成功 REST，并保持来源 Run 不变", async () => {
    const source = sourceRun();
    const runs = new MemoryPlatformRunStore();
    runs.values.set(SOURCE_RUN_ID, source);
    for (const frozen of source.suite.cases) {
      runs.results.set(
        `${SOURCE_RUN_ID}:${frozen.caseKey}`,
        restResult(
          frozen.caseKey,
          frozen.ordinal,
          frozen.caseKey === "rest-error" ? "ERROR" : "SUCCEEDED"
        )
      );
    }
    const evaluations = [
      evalResult("pass", 0, "PASS"),
      evalResult("eval-error", 1, "EVALUATION_ERROR"),
      evalResult("rest-error", 2, "NOT_EVALUATED")
    ];
    const service = new PlatformRerunService({
      runTransactionManager: runTransactions(runs),
      evalTransactionManager: evalTransactions(evaluations),
      artifactStore: sourceArtifacts(source),
      idGenerator: { nextId: (): string => TARGET_RUN_ID },
      clock: { now: (): string => NOW }
    });

    const created = await service.create({ sourceRunId: SOURCE_RUN_ID, mode: "RETRY_FAILED" });

    expect(created).toMatchObject({
      ok: true,
      run: {
        id: TARGET_RUN_ID,
        sourceRunId: SOURCE_RUN_ID,
        rerunMode: "RETRY_FAILED",
        status: "READY",
        stage: "REST",
        restCompletedCount: 2
      },
      plan: { counts: { reuseRest: 2, executeRest: 1, reuseEval: 1, executeEval: 2 } }
    });
    await expect(runs.getRestResult(TARGET_RUN_ID, "pass")).resolves.toMatchObject({
      status: "SUCCEEDED",
      provenance: {
        sourceKind: "RUN",
        sourceId: SOURCE_RUN_ID,
        sourceResultHash: "1".repeat(64)
      }
    });
    await expect(runs.getRestResult(TARGET_RUN_ID, "rest-error")).resolves.toBeNull();
    expect(runs.values.get(SOURCE_RUN_ID)).toEqual(source);
  });

  it("连续 Retry 沿 provenance 找到原始 Raw Artifact，不把第二代结果误判为需重评", async () => {
    const original = sourceRun();
    const intermediate: PlatformRun = {
      ...original,
      id: INTERMEDIATE_RUN_ID,
      sourceRunId: SOURCE_RUN_ID,
      rerunMode: "RETRY_FAILED",
      artifactManifest: {
        ...original.artifactManifest,
        owner: { kind: "RUN", id: INTERMEDIATE_RUN_ID },
        artifacts: original.artifactManifest.artifacts.map((artifact) => ({
          ...artifact,
          path: artifact.path.replace(SOURCE_RUN_ID, INTERMEDIATE_RUN_ID)
        }))
      }
    };
    const originalEval = evalResult("pass", 0, "PASS");
    const intermediateEval: PlatformEvalCaseResult = {
      ...originalEval,
      runId: INTERMEDIATE_RUN_ID,
      provenance: {
        sourceKind: "RUN",
        sourceId: SOURCE_RUN_ID,
        sourceResultHash: originalEval.evalResultHash
      }
    };
    const runs = new MemoryPlatformRunStore();
    runs.values.set(SOURCE_RUN_ID, original);
    runs.values.set(INTERMEDIATE_RUN_ID, intermediate);
    for (const frozen of intermediate.suite.cases) {
      runs.results.set(`${INTERMEDIATE_RUN_ID}:${frozen.caseKey}`, {
        ...restResult(
          frozen.caseKey,
          frozen.ordinal,
          frozen.caseKey === "rest-error" ? "ERROR" : "SUCCEEDED"
        ),
        runId: INTERMEDIATE_RUN_ID
      });
    }
    const service = new PlatformRerunService({
      runTransactionManager: runTransactions(runs),
      evalTransactionManager: evalTransactions([originalEval, intermediateEval]),
      artifactStore: new AllPresentArtifacts(),
      idGenerator: { nextId: (): string => TARGET_RUN_ID },
      clock: { now: (): string => NOW }
    });

    await expect(
      service.create({ sourceRunId: INTERMEDIATE_RUN_ID, mode: "RETRY_FAILED" })
    ).resolves.toMatchObject({
      ok: true,
      plan: { counts: { reuseRest: 2, executeRest: 1, reuseEval: 1, executeEval: 2 } }
    });
  });

  it("内部重跑对不存在或 REST 不完整的来源返回闭合错误", async () => {
    const runs = new MemoryPlatformRunStore();
    const service = new PlatformRerunService({
      runTransactionManager: runTransactions(runs),
      evalTransactionManager: evalTransactions([]),
      artifactStore: new MemoryArtifacts(),
      idGenerator: { nextId: (): string => TARGET_RUN_ID },
      clock: { now: (): string => NOW }
    });

    await expect(
      service.create({ sourceRunId: SOURCE_RUN_ID, mode: "RETRY_FAILED" })
    ).resolves.toEqual({ ok: false, error: { code: "RUN_NOT_FOUND" } });
    runs.values.set(SOURCE_RUN_ID, sourceRun());
    runs.results.set(`${SOURCE_RUN_ID}:pass`, restResult("pass", 0, "SUCCEEDED"));
    await expect(
      service.create({ sourceRunId: SOURCE_RUN_ID, mode: "RETRY_FAILED" })
    ).resolves.toEqual({ ok: false, error: { code: "RERUN_SOURCE_INCOMPLETE" } });
  });

  it("内部重跑拒绝仍处于 READY 或 RUNNING 的来源版本", async () => {
    for (const status of ["READY", "RUNNING"] as const) {
      const runs = new MemoryPlatformRunStore();
      const source = sourceRun();
      runs.values.set(SOURCE_RUN_ID, {
        ...source,
        status,
        stage: "REPORT",
        completedAt: null,
        errorCode: null,
        errorMessage: null
      });
      for (const frozen of source.suite.cases) {
        runs.results.set(
          `${SOURCE_RUN_ID}:${frozen.caseKey}`,
          restResult(frozen.caseKey, frozen.ordinal, "SUCCEEDED")
        );
      }
      const service = new PlatformRerunService({
        runTransactionManager: runTransactions(runs),
        evalTransactionManager: evalTransactions([]),
        artifactStore: sourceArtifacts(source),
        idGenerator: { nextId: (): string => TARGET_RUN_ID },
        clock: { now: (): string => NOW }
      });

      await expect(service.create({ sourceRunId: SOURCE_RUN_ID, mode: "FORCE" })).resolves.toEqual({
        ok: false,
        error: { code: "RERUN_SOURCE_INCOMPLETE" }
      });
    }
  });

  it("内部重跑拒绝不前进的来源 Evaluation Cursor", async () => {
    const source = sourceRun();
    const runs = new MemoryPlatformRunStore();
    runs.values.set(SOURCE_RUN_ID, source);
    for (const frozen of source.suite.cases) {
      runs.results.set(
        `${SOURCE_RUN_ID}:${frozen.caseKey}`,
        restResult(frozen.caseKey, frozen.ordinal, "SUCCEEDED")
      );
    }
    const service = new PlatformRerunService({
      runTransactionManager: runTransactions(runs),
      evalTransactionManager: invalidCursorTransactions(),
      artifactStore: sourceArtifacts(source),
      idGenerator: { nextId: (): string => TARGET_RUN_ID },
      clock: { now: (): string => NOW }
    });

    await expect(
      service.create({ sourceRunId: SOURCE_RUN_ID, mode: "RETRY_FAILED" })
    ).rejects.toThrow("EVALUATION_REUSE_CURSOR_INVALID");
  });

  it("Force 不预置结果；来源缺少完整 Eval Artifact 时 Retry 只复用 REST", async () => {
    const source = { ...sourceRun(false), name: "原回归", description: "原目的" };
    const evaluations = [evalResult("pass", 0, "PASS")];
    for (const mode of ["FORCE", "RETRY_FAILED"] as const) {
      const runs = new MemoryPlatformRunStore();
      runs.values.set(SOURCE_RUN_ID, source);
      for (const frozen of source.suite.cases) {
        runs.results.set(
          `${SOURCE_RUN_ID}:${frozen.caseKey}`,
          restResult(
            frozen.caseKey,
            frozen.ordinal,
            frozen.caseKey === "rest-error" ? "ERROR" : "SUCCEEDED"
          )
        );
      }
      const service = new PlatformRerunService({
        runTransactionManager: runTransactions(runs),
        evalTransactionManager: evalTransactions(evaluations),
        artifactStore: sourceArtifacts(source),
        idGenerator: { nextId: (): string => TARGET_RUN_ID },
        clock: { now: (): string => NOW }
      });

      const created = await service.create({
        sourceRunId: SOURCE_RUN_ID,
        mode,
        ...(mode === "FORCE" ? { name: " 新回归 ", description: "" } : {})
      });
      expect(created).toMatchObject({
        ok: true,
        run:
          mode === "FORCE"
            ? { name: "新回归", description: null }
            : { name: "原回归", description: "原目的" }
      });
      expect(runs.values.get(SOURCE_RUN_ID)).toEqual(source);
      expect(created).toMatchObject({
        ok: true,
        plan: {
          counts:
            mode === "FORCE"
              ? { reuseRest: 0, executeRest: 3, reuseEval: 0, executeEval: 3 }
              : { reuseRest: 2, executeRest: 1, reuseEval: 0, executeEval: 3 }
        }
      });
    }
  });

  it("Force 不检查来源 Eval Artifact，因为全部 Case 都会重新执行", async () => {
    const source = sourceRun();
    const runs = new MemoryPlatformRunStore();
    runs.values.set(SOURCE_RUN_ID, source);
    for (const frozen of source.suite.cases) {
      runs.results.set(
        `${SOURCE_RUN_ID}:${frozen.caseKey}`,
        restResult(frozen.caseKey, frozen.ordinal, "SUCCEEDED")
      );
    }
    const service = new PlatformRerunService({
      runTransactionManager: runTransactions(runs),
      evalTransactionManager: evalTransactions([evalResult("pass", 0, "PASS")]),
      artifactStore: new UnexpectedArtifactInspection(),
      idGenerator: { nextId: (): string => TARGET_RUN_ID },
      clock: { now: (): string => NOW }
    });

    await expect(
      service.create({ sourceRunId: SOURCE_RUN_ID, mode: "FORCE" })
    ).resolves.toMatchObject({
      ok: true,
      plan: { counts: { reuseRest: 0, executeRest: 3, reuseEval: 0, executeEval: 3 } }
    });
  });

  it("来源 Eval Artifact 实际缺失或损坏时 Retry 只复用 REST，不读取来源评估", async () => {
    for (const status of ["MISSING", "CORRUPTED"] as const) {
      const source = sourceRun();
      const runs = new MemoryPlatformRunStore();
      runs.values.set(SOURCE_RUN_ID, source);
      for (const frozen of source.suite.cases) {
        runs.results.set(
          `${SOURCE_RUN_ID}:${frozen.caseKey}`,
          restResult(
            frozen.caseKey,
            frozen.ordinal,
            frozen.caseKey === "rest-error" ? "ERROR" : "SUCCEEDED"
          )
        );
      }
      const service = new PlatformRerunService({
        runTransactionManager: runTransactions(runs),
        evalTransactionManager: evalTransactions([evalResult("pass", 0, "PASS")]),
        artifactStore: sourceArtifacts(source, {
          kind: "RAW_PROMPTFOO_EVIDENCE",
          status
        }),
        idGenerator: { nextId: (): string => TARGET_RUN_ID },
        clock: { now: (): string => NOW }
      });

      const created = await service.create({
        sourceRunId: SOURCE_RUN_ID,
        mode: "RETRY_FAILED"
      });

      expect(created).toMatchObject({
        ok: true,
        plan: { counts: { reuseRest: 2, executeRest: 1, reuseEval: 0, executeEval: 3 } }
      });
    }
  });

  it("新 Retry Run 启动 REST 时只派发未预置的来源失败 Case", async () => {
    const source = sourceRun();
    const runs = new MemoryPlatformRunStore();
    runs.values.set(SOURCE_RUN_ID, source);
    for (const frozen of source.suite.cases) {
      runs.results.set(
        `${SOURCE_RUN_ID}:${frozen.caseKey}`,
        restResult(
          frozen.caseKey,
          frozen.ordinal,
          frozen.caseKey === "rest-error" ? "ERROR" : "SUCCEEDED"
        )
      );
    }
    const manager = runTransactions(runs);
    const reruns = new PlatformRerunService({
      runTransactionManager: manager,
      evalTransactionManager: evalTransactions([
        evalResult("pass", 0, "PASS"),
        evalResult("eval-error", 1, "EVALUATION_ERROR"),
        evalResult("rest-error", 2, "NOT_EVALUATED")
      ]),
      artifactStore: sourceArtifacts(source),
      idGenerator: { nextId: (): string => TARGET_RUN_ID },
      clock: { now: (): string => NOW }
    });
    const created = await reruns.create({
      sourceRunId: SOURCE_RUN_ID,
      mode: "RETRY_FAILED"
    });
    if (!created.ok) throw new Error("TEST_RERUN_CREATE_FAILED");
    const executor = new PendingOnlyRestExecutor();
    const runsService = new PlatformRunService({
      transactionManager: manager,
      restExecutor: executor,
      artifactStore: new MemoryArtifacts(),
      clock: { now: (): string => NOW },
      idGenerator: { nextId: (): string => "unused" },
      messageResolver: { message: (code): string => code },
      eventSink: new MemoryRunEvents(),
      cancellationPollMs: 25
    });

    await runsService.start({ runId: TARGET_RUN_ID, expectedRevision: 0 });
    await runsService.waitForIdle();

    expect(executor.caseKeys).toEqual(["rest-error"]);
    await expect(runsService.getProgress(TARGET_RUN_ID)).resolves.toMatchObject({
      status: "READY",
      stage: "EVALUATION",
      restCompletedCount: 3,
      restErrorCount: 0
    });
  });
});
