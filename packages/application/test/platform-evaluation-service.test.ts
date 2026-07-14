import type { PlatformEvalRepository } from "../src/features/evaluation/platform-eval-ports.ts";
import type { PlatformEvalCaseResult } from "../src/features/evaluation/platform-eval-models.ts";
import type {
  PlatformEvaluationEngine,
  PlatformEvaluationEngineInput,
  PlatformEvaluationEngineResult,
  PlatformEvaluationRuntimePreflight
} from "../src/features/evaluation/platform-evaluation-engine.ts";
import {
  PlatformEvaluationService,
  type PlatformEvaluationBusinessEvent,
  type PlatformEvaluationServiceDependencies
} from "../src/features/evaluation/platform-evaluation-service.ts";
import type {
  PlatformRunResourceReader,
  PlatformRunTransactionManager
} from "../src/features/runs/platform-run-ports.ts";
import type {
  PlatformNormalizedEvalArtifactInput,
  PlatformRawPromptfooArtifactInput,
  PlatformRestArtifactWriteResult,
  PublishedRunArtifact,
  RunArtifactAvailability,
  RunArtifactStore
} from "../src/features/runs/run-artifact-port.ts";
import type {
  PlatformRunProgress,
  RunArtifactDescriptor,
  RunArtifactManifest
} from "../src/features/runs/platform-run-models.ts";
import { hashEvalResultSet } from "@cortex-eval/domain/src/domain-hash-inputs.ts";
import { describe, expect, it } from "vitest";

import {
  ClaimFailureRunStore,
  MemoryPlatformRunStore
} from "../test-support/in-memory-platform-run-store.ts";
import {
  MemoryPlatformEvalRepository as EvalRepository,
  MemoryPlatformEvalTransactions as EvalTransactions
} from "../test-support/platform-run-resilience-fixtures.ts";
import {
  evaluationRun,
  HASH,
  NOW,
  restResult,
  reusableSourceRun,
  RUN_ID,
  SOURCE_RUN_ID
} from "../test-support/platform-evaluation-service-fixtures.ts";

class RunTransactions implements PlatformRunTransactionManager {
  /** Whether one short transaction callback is active. */
  active = false;
  /** Backing in-memory Run facts. */
  readonly store: MemoryPlatformRunStore;
  /** Empty current-resource reader unused by Evaluation. */
  readonly resources: PlatformRunResourceReader = {
    getSuite: () => Promise.resolve(null),
    listCases: () => Promise.resolve([]),
    getConfiguration: () => Promise.resolve(null),
    listRubricPrompts: () => Promise.resolve([])
  };

  /** Bind one backing Run store. */
  public constructor(store: MemoryPlatformRunStore) {
    this.store = store;
  }

  /** Execute one synchronous-scope short transaction callback. */
  public async execute<T>(
    work: Parameters<PlatformRunTransactionManager["execute"]>[0]
  ): Promise<T> {
    this.active = true;
    try {
      return (await work({ resources: this.resources, runs: this.store })) as T;
    } finally {
      this.active = false;
    }
  }
}

class EvaluationArtifacts implements RunArtifactStore {
  /** Written raw input. */
  rawInput: PlatformRawPromptfooArtifactInput | null = null;
  /** Written normalized input. */
  normalizedInput: PlatformNormalizedEvalArtifactInput | null = null;
  /** Removed uncommitted files. */
  readonly removed: RunArtifactDescriptor[] = [];
  /** Optional forced availability used by corruption tests. */
  availability: readonly RunArtifactAvailability[] | null = null;

  /** REST writing is not part of this test. */
  public writeRestResults(): Promise<PlatformRestArtifactWriteResult> {
    throw new Error("unexpected");
  }

  /** Capture raw evidence. */
  public writeRawPromptfooEvidence(
    input: PlatformRawPromptfooArtifactInput
  ): Promise<PublishedRunArtifact> {
    this.rawInput = input;
    return Promise.resolve({
      descriptor: {
        kind: "RAW_PROMPTFOO_EVIDENCE",
        path: `runs/${RUN_ID}/promptfoo-raw.json`,
        expectedSha256: "d".repeat(64),
        expectedSizeBytes: 50,
        contractVersion: "cortex.platform-raw-promptfoo-evidence.v1"
      },
      publicationIdentity: "memory:raw"
    });
  }

  /** Capture and consume normalized results. */
  public async writeNormalizedEvalResults(
    input: PlatformNormalizedEvalArtifactInput
  ): Promise<PublishedRunArtifact> {
    this.normalizedInput = input;
    for await (const item of input.cases) {
      // Consume once like the real streaming writer.
      void item;
    }
    return {
      descriptor: {
        kind: "NORMALIZED_EVAL_RESULTS",
        path: `runs/${RUN_ID}/normalized-eval.json`,
        expectedSha256: "e".repeat(64),
        expectedSizeBytes: 80,
        contractVersion: "cortex.platform-normalized-eval.v1"
      },
      publicationIdentity: "memory:normalized"
    };
  }

  /** Capture rollback removals. */
  public removeUncommitted(artifact: PublishedRunArtifact): Promise<void> {
    this.removed.push(artifact.descriptor);
    return Promise.resolve();
  }

  /** Return exact configured availability or verify every expected descriptor. */
  public inspect(manifest: RunArtifactManifest): Promise<readonly RunArtifactAvailability[]> {
    return Promise.resolve(
      this.availability ??
        manifest.artifacts.map((artifact) => ({ artifact, status: "PRESENT" as const }))
    );
  }

  /** No cleanup in this test. */
  public cleanupOrphans(): Promise<void> {
    return Promise.resolve();
  }
}

class SuccessfulEvaluationEngine implements PlatformEvaluationEngine {
  /** Whether execution happened while a transaction callback was active. */
  observedActiveTransaction = false;
  /** Run transaction tracker. */
  readonly #transactions: RunTransactions;

  /** Bind the transaction tracker. */
  public constructor(transactions: RunTransactions) {
    this.#transactions = transactions;
  }

  /** Return one valid Promptfoo Assertion-fail raw result. */
  public execute(): Promise<PlatformEvaluationEngineResult> {
    this.observedActiveTransaction = this.#transactions.active;
    return Promise.resolve({
      promptfooVersion: "0.121.18" as const,
      exitCode: 100 as const,
      durationMs: 12,
      evaluationContextHash: "f".repeat(64),
      rubricPromptMaterializations: {},
      raw: {
        results: {
          version: 3,
          results: [
            {
              metadata: { case_id: "case-1" },
              response: { output: { ok: false, errorMessage: "business" } },
              success: false,
              score: 0,
              latencyMs: 3,
              cost: 0,
              gradingResult: {
                pass: false,
                score: 0,
                reason: "failed",
                componentResults: [
                  {
                    pass: false,
                    score: 0,
                    reason: "failed",
                    assertion: {
                      type: "equals",
                      metric: "quality",
                      value: "expected"
                    }
                  }
                ]
              }
            }
          ]
        }
      }
    });
  }
}

class FailingProgressStore extends MemoryPlatformRunStore {
  /** Number of small progress reads. */
  progressReads = 0;

  /** Fail the cross-process poll after the initial claim validation read. */
  public override getPlatformRunProgress(runId: string): Promise<PlatformRunProgress | null> {
    this.progressReads += 1;
    if (this.progressReads === 2) return Promise.reject(new Error("POLL_READ_FAILED"));
    return super.getPlatformRunProgress(runId);
  }
}

class AbortAwareEvaluationEngine implements PlatformEvaluationEngine {
  /** Whether the application propagated cancellation to the engine. */
  aborted = false;
  /** Reject an otherwise pending engine call so a failed assertion cannot leak test work. */
  release: () => void = () => undefined;

  /** Wait for Abort or explicit test release. */
  public execute(input: PlatformEvaluationEngineInput): Promise<PlatformEvaluationEngineResult> {
    if (input.signal.aborted) {
      this.aborted = true;
      return Promise.reject(new Error("ENGINE_ABORTED"));
    }
    return new Promise<never>((_resolve, reject) => {
      const fail = (): void => reject(new Error("ENGINE_RELEASED"));
      this.release = fail;
      input.signal.addEventListener(
        "abort",
        () => {
          this.aborted = true;
          fail();
        },
        { once: true }
      );
    });
  }
}

class EmptyRerunEvaluationEngine implements PlatformEvaluationEngine {
  /** REST Case count observed at the external execution boundary. */
  observedCaseCount = -1;

  /** Return an empty raw result only when all Evaluation facts were reused. */
  public execute(input: PlatformEvaluationEngineInput): Promise<PlatformEvaluationEngineResult> {
    this.observedCaseCount = input.restResults.length;
    return Promise.resolve({
      promptfooVersion: "0.121.18",
      exitCode: 0,
      durationMs: 0,
      evaluationContextHash: HASH,
      rubricPromptMaterializations: {},
      raw: { results: { version: 3, results: [] } }
    });
  }
}

class FailingNormalizedArtifacts extends EvaluationArtifacts {
  /** Fail after raw evidence has already been created. */
  public override writeNormalizedEvalResults(
    input: PlatformNormalizedEvalArtifactInput
  ): Promise<PublishedRunArtifact> {
    this.normalizedInput = input;
    return Promise.reject(new Error("NORMALIZED_WRITE_FAILED"));
  }
}

class RejectingEvalRepository extends EvalRepository {
  /** Reject the final atomic commit after both artifacts are written. */
  public override completeStage(): ReturnType<PlatformEvalRepository["completeStage"]> {
    return Promise.resolve({ ok: false, reason: "STATE_OR_REVISION" });
  }
}

const successfulRuntimePreflight: PlatformEvaluationRuntimePreflight = {
  check: (): Promise<{ readonly ok: true }> => Promise.resolve({ ok: true })
};

function evaluationDependencies(
  runs: MemoryPlatformRunStore,
  engine: PlatformEvaluationEngine,
  evaluations: PlatformEvalRepository = new EvalRepository(runs),
  artifacts: RunArtifactStore = new EvaluationArtifacts(),
  cancellationPollMs?: number
): PlatformEvaluationServiceDependencies {
  return {
    runTransactionManager: new RunTransactions(runs),
    evalTransactionManager: new EvalTransactions(evaluations),
    engine,
    runtimePreflight: successfulRuntimePreflight,
    artifactStore: artifacts,
    clock: { now: (): string => NOW },
    messageResolver: { message: (code): string => code },
    eventSink: { record: (): Promise<void> => Promise.resolve() },
    ...(cancellationPollMs === undefined ? {} : { cancellationPollMs })
  };
}

describe("Platform Evaluation Application 编排", () => {
  it("Preflight 只接收 REST 成功且未复用、确实会进入 Promptfoo 的 Case", async () => {
    const runs = new MemoryPlatformRunStore();
    runs.values.set(RUN_ID, evaluationRun());
    runs.results.set(`${RUN_ID}:case-1`, {
      ...restResult,
      status: "ERROR",
      httpStatus: 500,
      providerOutput: null,
      errorType: "HTTP_STATUS",
      errorMessage: "HTTP status"
    });
    let observedCases = -1;
    const runtimePreflight: PlatformEvaluationRuntimePreflight = {
      check: async (cases) => {
        observedCases = 0;
        for await (const testCase of cases) {
          void testCase;
          observedCases += 1;
        }
        return { ok: true };
      }
    };
    const service = new PlatformEvaluationService({
      ...evaluationDependencies(runs, new EmptyRerunEvaluationEngine()),
      runtimePreflight
    });
    await service.start({ runId: RUN_ID, expectedRevision: 2 });
    await service.waitForIdle();
    expect(observedCases).toBe(0);
  });

  it("解释器能力探测失败时不抢占 Evaluation Stage，也不启动外部引擎", async () => {
    const runs = new MemoryPlatformRunStore();
    runs.values.set(RUN_ID, evaluationRun());
    const engine = new SuccessfulEvaluationEngine(new RunTransactions(runs));
    let checks = 0;
    const runtimePreflight: PlatformEvaluationRuntimePreflight = {
      check: () => {
        checks += 1;
        return Promise.resolve({ ok: false, path: "runtime.python" });
      }
    };
    const service = new PlatformEvaluationService({
      ...evaluationDependencies(runs, engine),
      runtimePreflight
    });
    await expect(service.start({ runId: RUN_ID, expectedRevision: 2 })).resolves.toEqual({
      ok: false,
      error: { code: "VALIDATION_FAILED", path: "runtime.python" }
    });
    expect(checks).toBe(1);
    expect(engine.observedActiveTransaction).toBe(false);
    await expect(runs.getPlatformRunProgress(RUN_ID)).resolves.toMatchObject({
      status: "READY",
      stage: "EVALUATION",
      lockRevision: 2
    });
  });

  it("拒绝越界或非整数取消轮询周期", () => {
    const runs = new MemoryPlatformRunStore();
    const engine = new SuccessfulEvaluationEngine(new RunTransactions(runs));
    for (const poll of [24, 51, 25.5]) {
      expect(
        () =>
          new PlatformEvaluationService(
            evaluationDependencies(runs, engine, undefined, undefined, poll)
          )
      ).toThrow("RUN_CANCELLATION_POLL_INVALID");
    }
  });

  it("启动与取消按不存在、Stage 和 Revision 返回闭合错误", async () => {
    const runs = new MemoryPlatformRunStore();
    const service = new PlatformEvaluationService(
      evaluationDependencies(runs, new SuccessfulEvaluationEngine(new RunTransactions(runs)))
    );
    await expect(service.start({ runId: RUN_ID, expectedRevision: 2 })).resolves.toEqual({
      ok: false,
      error: { code: "RUN_NOT_FOUND" }
    });
    runs.values.set(RUN_ID, { ...evaluationRun(), stage: "REST" });
    await expect(service.start({ runId: RUN_ID, expectedRevision: 2 })).resolves.toEqual({
      ok: false,
      error: { code: "RUN_STATE_CONFLICT", reason: "STAGE_UNAVAILABLE" }
    });
    runs.values.set(RUN_ID, evaluationRun());
    await expect(service.start({ runId: RUN_ID, expectedRevision: 1 })).resolves.toEqual({
      ok: false,
      error: { code: "RUN_STATE_CONFLICT", reason: "STATE_OR_REVISION" }
    });
    await expect(service.cancel({ runId: SOURCE_RUN_ID, expectedRevision: 1 })).resolves.toEqual({
      ok: false,
      error: { code: "RUN_NOT_FOUND" }
    });
    await expect(service.cancel({ runId: RUN_ID, expectedRevision: 1 })).resolves.toEqual({
      ok: false,
      error: { code: "RUN_STATE_CONFLICT", reason: "STATE_OR_REVISION" }
    });
  });

  it("阶段抢占丢失或被其他全局运行占用时映射精确原因", async () => {
    for (const reason of ["NOT_FOUND", "GLOBAL_RUNNING"] as const) {
      const runs = new ClaimFailureRunStore(reason);
      runs.values.set(RUN_ID, evaluationRun());
      const service = new PlatformEvaluationService(
        evaluationDependencies(runs, new SuccessfulEvaluationEngine(new RunTransactions(runs)))
      );

      await expect(service.start({ runId: RUN_ID, expectedRevision: 2 })).resolves.toEqual(
        reason === "NOT_FOUND"
          ? { ok: false, error: { code: "RUN_NOT_FOUND" } }
          : { ok: false, error: { code: "RUN_STATE_CONFLICT", reason } }
      );
    }
  });

  it("Evaluation 查询透传有界 Cursor 并保持结果身份", async () => {
    const runs = new MemoryPlatformRunStore();
    const evaluations = new EvalRepository(runs);
    const result = {
      runId: RUN_ID,
      caseKey: "case-1",
      ordinal: 0
    } as PlatformEvalCaseResult;
    evaluations.queryItems = [result];
    const service = new PlatformEvaluationService(
      evaluationDependencies(
        runs,
        new SuccessfulEvaluationEngine(new RunTransactions(runs)),
        evaluations
      )
    );

    await expect(service.queryResults({ runId: RUN_ID, limit: 20 })).resolves.toEqual({
      items: [result],
      nextCursor: null
    });
  });

  it("Runtime Shutdown 中止 Evaluation 并收敛为 INTERRUPTED", async () => {
    const runs = new MemoryPlatformRunStore();
    runs.values.set(RUN_ID, evaluationRun());
    runs.results.set(`${RUN_ID}:case-1`, restResult);
    const engine = new AbortAwareEvaluationEngine();
    const service = new PlatformEvaluationService(evaluationDependencies(runs, engine));

    await service.start({ runId: RUN_ID, expectedRevision: 2 });
    await service.shutdown();

    expect(engine.aborted).toBe(true);
    await expect(runs.getPlatformRunProgress(RUN_ID)).resolves.toMatchObject({
      status: "INTERRUPTED",
      stage: "DONE"
    });
  });

  it("跨进程取消由持久轮询观察并提交 CANCELLED", async () => {
    const runs = new MemoryPlatformRunStore();
    runs.values.set(RUN_ID, evaluationRun());
    runs.results.set(`${RUN_ID}:case-1`, restResult);
    const engine = new AbortAwareEvaluationEngine();
    const service = new PlatformEvaluationService(
      evaluationDependencies(runs, engine, undefined, undefined, 25)
    );
    await service.start({ runId: RUN_ID, expectedRevision: 2 });
    await runs.requestCancel(RUN_ID, 3, NOW);
    await service.waitForIdle();

    expect(engine.aborted).toBe(true);
    await expect(runs.getPlatformRunProgress(RUN_ID)).resolves.toMatchObject({
      status: "CANCELLED",
      stage: "DONE"
    });
  });

  it("Eval 原子提交竞争失败会删除两个未提交 Artifact 并失败收口", async () => {
    const runs = new MemoryPlatformRunStore();
    runs.values.set(RUN_ID, evaluationRun());
    runs.results.set(`${RUN_ID}:case-1`, restResult);
    const transactions = new RunTransactions(runs);
    const artifacts = new EvaluationArtifacts();
    const service = new PlatformEvaluationService(
      evaluationDependencies(
        runs,
        new SuccessfulEvaluationEngine(transactions),
        new RejectingEvalRepository(runs),
        artifacts
      )
    );

    await service.start({ runId: RUN_ID, expectedRevision: 2 });
    await service.waitForIdle();

    expect(artifacts.removed.map((item) => item.kind)).toEqual([
      "NORMALIZED_EVAL_RESULTS",
      "RAW_PROMPTFOO_EVIDENCE"
    ]);
    await expect(runs.getPlatformRunProgress(RUN_ID)).resolves.toMatchObject({
      status: "FAILED",
      stage: "DONE"
    });
  });

  it("缺少 REST 集合 Hash 或逐 Case REST 事实时在外部执行前失败", async () => {
    for (const scenario of ["HASH", "CASE"] as const) {
      const runs = new MemoryPlatformRunStore();
      runs.values.set(
        RUN_ID,
        scenario === "HASH" ? { ...evaluationRun(), resultSetHash: null } : evaluationRun()
      );
      if (scenario === "HASH") runs.results.set(`${RUN_ID}:case-1`, restResult);
      const transactions = new RunTransactions(runs);
      const engine = new SuccessfulEvaluationEngine(transactions);
      const service = new PlatformEvaluationService(evaluationDependencies(runs, engine));

      await service.start({ runId: RUN_ID, expectedRevision: 2 });
      await service.waitForIdle();

      expect(engine.observedActiveTransaction).toBe(false);
      await expect(runs.getPlatformRunProgress(RUN_ID)).resolves.toMatchObject({
        status: "FAILED",
        stage: "DONE"
      });
    }
  });

  it("来源上下文、Artifact、实际文件或 Evidence 不一致时不复用来源评估", async () => {
    for (const scenario of ["CONTEXT", "ARTIFACT", "MISSING", "CORRUPTED", "EVIDENCE"] as const) {
      const source = reusableSourceRun();
      const runs = new MemoryPlatformRunStore();
      runs.values.set(
        SOURCE_RUN_ID,
        scenario === "CONTEXT"
          ? { ...source, runContextHash: "9".repeat(64) }
          : scenario === "ARTIFACT"
            ? {
                ...source,
                artifactManifest: {
                  ...source.artifactManifest,
                  artifacts: source.artifactManifest.artifacts.filter(
                    (artifact) => artifact.kind !== "NORMALIZED_EVAL_RESULTS"
                  )
                }
              }
            : source
      );
      runs.values.set(RUN_ID, {
        ...evaluationRun(),
        sourceRunId: SOURCE_RUN_ID,
        rerunMode: "RETRY_FAILED"
      });
      runs.results.set(`${RUN_ID}:case-1`, {
        ...restResult,
        provenance: {
          sourceKind: "RUN",
          sourceId: SOURCE_RUN_ID,
          sourceResultHash: restResult.resultHash
        }
      });
      const engine = new EmptyRerunEvaluationEngine();
      const evaluations = new EvalRepository(runs);
      evaluations.queryItems = [
        {
          runId: SOURCE_RUN_ID,
          caseKey: "case-1",
          ordinal: 0,
          status: "PASS",
          rawEvidence: {
            present: true,
            path:
              scenario === "EVIDENCE"
                ? "runs/different/promptfoo-raw.json"
                : `runs/${SOURCE_RUN_ID}/promptfoo-raw.json`,
            expectedSha256: "d".repeat(64),
            expectedSizeBytes: 50
          }
        } as PlatformEvalCaseResult
      ];
      const artifacts = new EvaluationArtifacts();
      if (scenario === "MISSING" || scenario === "CORRUPTED") {
        artifacts.availability = source.artifactManifest.artifacts.map((artifact) => ({
          artifact,
          status: artifact.kind === "RAW_PROMPTFOO_EVIDENCE" ? scenario : ("PRESENT" as const)
        }));
      }
      const service = new PlatformEvaluationService(
        evaluationDependencies(runs, engine, evaluations, artifacts)
      );

      await service.start({ runId: RUN_ID, expectedRevision: 2 });
      await service.waitForIdle();

      expect(engine.observedCaseCount).toBe(1);
    }
  });

  it("把退出码 100 作为评估事实，在事务外执行并按 Raw→Normalized 原子提交", async () => {
    const runs = new MemoryPlatformRunStore();
    runs.values.set(RUN_ID, evaluationRun());
    runs.results.set(`${RUN_ID}:case-1`, restResult);
    const runTransactions = new RunTransactions(runs);
    const evaluationRepository = new EvalRepository(runs);
    const artifacts = new EvaluationArtifacts();
    const engine = new SuccessfulEvaluationEngine(runTransactions);
    const service = new PlatformEvaluationService(
      evaluationDependencies(runs, engine, evaluationRepository, artifacts)
    );

    await expect(service.start({ runId: RUN_ID, expectedRevision: 2 })).resolves.toMatchObject({
      ok: true,
      run: { status: "RUNNING", stage: "EVALUATION", lockRevision: 3 }
    });
    await service.waitForIdle();

    expect(engine.observedActiveTransaction).toBe(false);
    expect(artifacts.rawInput).toMatchObject({
      exitCode: 100,
      promptfooVersion: "0.121.18",
      evaluationContextHash: "f".repeat(64)
    });
    expect(artifacts.normalizedInput).toMatchObject({
      evaluationContextHash: "f".repeat(64)
    });
    expect(evaluationRepository.completeInput).toMatchObject({
      evaluationContextHash: "f".repeat(64)
    });
    expect(
      evaluationRepository.completeInput?.artifactManifest.artifacts.map((item) => item.kind)
    ).toEqual(["RAW_PROMPTFOO_EVIDENCE", "NORMALIZED_EVAL_RESULTS"]);
    expect(evaluationRepository.completeInput?.results).toMatchObject([
      {
        caseKey: "case-1",
        status: "FAIL",
        rawEvidence: { path: `runs/${RUN_ID}/promptfoo-raw.json` }
      }
    ]);
    await expect(runs.getPlatformRunProgress(RUN_ID)).resolves.toMatchObject({
      status: "READY",
      stage: "REPORT",
      lockRevision: 4
    });
    expect(artifacts.removed).toEqual([]);
  });

  it("Raw Source 清理失败不回滚已提交结果并记录安全事件", async () => {
    const runs = new MemoryPlatformRunStore();
    runs.values.set(RUN_ID, evaluationRun());
    runs.results.set(`${RUN_ID}:case-1`, restResult);
    const transactions = new RunTransactions(runs);
    const source = await new SuccessfulEvaluationEngine(transactions).execute();
    if (typeof source.raw !== "object" || "kind" in source.raw) {
      throw new Error("TEST_RAW_OBJECT_MISSING");
    }
    const rawResults = source.raw.results;
    if (
      rawResults === null ||
      typeof rawResults !== "object" ||
      Array.isArray(rawResults) ||
      !Array.isArray(rawResults.results)
    ) {
      throw new Error("TEST_RAW_ROWS_MISSING");
    }
    const rows = rawResults.results;
    const events: PlatformEvaluationBusinessEvent[] = [];
    const engine: PlatformEvaluationEngine = {
      execute: (): Promise<PlatformEvaluationEngineResult> =>
        Promise.resolve({
          ...source,
          raw: {
            kind: "PROMPTFOO_RAW_SOURCE",
            openBytes: async function* () {
              yield await Promise.resolve(Buffer.from(JSON.stringify(source.raw), "utf8"));
            },
            openRows: async function* () {
              for (const row of rows) yield await Promise.resolve(row);
            },
            dispose: (): Promise<never> => Promise.reject(new Error("TEST_RAW_CLEANUP_FAILED"))
          }
        })
    };
    const service = new PlatformEvaluationService({
      ...evaluationDependencies(runs, engine),
      eventSink: {
        record: (event): Promise<void> => {
          events.push(event);
          return Promise.resolve();
        }
      }
    });

    await service.start({ runId: RUN_ID, expectedRevision: 2 });
    await service.waitForIdle();

    await expect(runs.getPlatformRunProgress(RUN_ID)).resolves.toMatchObject({
      status: "READY",
      stage: "REPORT"
    });
    expect(events.map((event) => event.event)).toContain("RUN_EVALUATION_RAW_CLEANUP_FAILED");
  });

  it("轮询读取失败会中止外部执行、失败收口且不悬挂 owner", async () => {
    const runs = new FailingProgressStore();
    runs.values.set(RUN_ID, evaluationRun());
    runs.results.set(`${RUN_ID}:case-1`, restResult);
    const engine = new AbortAwareEvaluationEngine();
    const service = new PlatformEvaluationService(
      evaluationDependencies(runs, engine, undefined, undefined, 25)
    );

    await service.start({ runId: RUN_ID, expectedRevision: 2 });
    await new Promise((resolve) => setTimeout(resolve, 80));
    engine.release();
    await service.waitForIdle();
    expect(engine.aborted).toBe(true);
    await expect(runs.getPlatformRunProgress(RUN_ID)).resolves.toMatchObject({
      status: "FAILED",
      stage: "DONE",
      errorCode: "EVALUATION_STAGE_FAILED"
    });
  });

  it("归一化产物写入失败会删除已落盘 Raw 并以稳定错误收口", async () => {
    const runs = new MemoryPlatformRunStore();
    runs.values.set(RUN_ID, evaluationRun());
    runs.results.set(`${RUN_ID}:case-1`, restResult);
    const runTransactions = new RunTransactions(runs);
    const artifacts = new FailingNormalizedArtifacts();
    const service = new PlatformEvaluationService(
      evaluationDependencies(
        runs,
        new SuccessfulEvaluationEngine(runTransactions),
        new EvalRepository(runs),
        artifacts
      )
    );

    await service.start({ runId: RUN_ID, expectedRevision: 2 });
    await service.waitForIdle();

    expect(artifacts.removed.map((item) => item.kind)).toEqual(["RAW_PROMPTFOO_EVIDENCE"]);
    await expect(runs.getPlatformRunProgress(RUN_ID)).resolves.toMatchObject({
      status: "FAILED",
      stage: "DONE",
      errorCode: "EVALUATION_STAGE_FAILED"
    });
  });

  it("直接取消会中止外部执行并按最新 Revision 提交 CANCELLED", async () => {
    const runs = new MemoryPlatformRunStore();
    runs.values.set(RUN_ID, evaluationRun());
    runs.results.set(`${RUN_ID}:case-1`, restResult);
    const engine = new AbortAwareEvaluationEngine();
    const service = new PlatformEvaluationService(evaluationDependencies(runs, engine));

    await service.start({ runId: RUN_ID, expectedRevision: 2 });
    await expect(service.cancel({ runId: RUN_ID, expectedRevision: 3 })).resolves.toMatchObject({
      ok: true,
      run: { cancelRequestedAt: NOW, lockRevision: 4 }
    });
    await service.waitForIdle();

    expect(engine.aborted).toBe(true);
    await expect(runs.getPlatformRunProgress(RUN_ID)).resolves.toMatchObject({
      status: "CANCELLED",
      stage: "DONE",
      lockRevision: 5
    });
  });

  it("Retry 复用来源 PASS/FAIL Eval，外部引擎只接收仍需评估的 Case", async () => {
    const source = reusableSourceRun();
    const target = {
      ...evaluationRun(),
      sourceRunId: SOURCE_RUN_ID,
      rerunMode: "RETRY_FAILED" as const
    };
    const reusedRest = {
      ...restResult,
      provenance: {
        sourceKind: "RUN" as const,
        sourceId: SOURCE_RUN_ID,
        sourceResultHash: restResult.resultHash
      }
    };
    const sourceEval: PlatformEvalCaseResult = {
      runId: SOURCE_RUN_ID,
      caseKey: "case-1",
      ordinal: 0,
      status: "PASS",
      promptfooSuccess: true,
      score: 1,
      reason: "passed",
      evaluationError: null,
      assertions: [],
      diffs: [],
      metrics: [{ metric: "quality", status: "PASS" }],
      latencyMs: 3,
      tokenUsage: null,
      cost: null,
      rawEvidence: {
        present: true,
        path: `runs/${SOURCE_RUN_ID}/promptfoo-raw.json`,
        expectedSha256: "d".repeat(64),
        expectedSizeBytes: 50
      },
      evalResultHash: "6".repeat(64),
      finalCaseResultHash: "7".repeat(64),
      provenance: null,
      createdAt: NOW,
      updatedAt: NOW
    };
    const runs = new MemoryPlatformRunStore();
    runs.values.set(SOURCE_RUN_ID, source);
    runs.values.set(RUN_ID, target);
    runs.results.set(`${RUN_ID}:case-1`, reusedRest);
    const evaluationRepository = new EvalRepository(runs);
    evaluationRepository.queryItems = [sourceEval];
    const engine = new EmptyRerunEvaluationEngine();
    const sourceResultSetHash = hashEvalResultSet({
      contractVersion: "cortex.eval-result-set.v1",
      owner: { kind: "RUN", id: SOURCE_RUN_ID },
      evaluationContextHash: HASH,
      cases: [
        {
          caseKey: sourceEval.caseKey,
          ordinal: sourceEval.ordinal,
          evalResultHash: sourceEval.evalResultHash
        }
      ]
    });
    const service = new PlatformEvaluationService(
      evaluationDependencies(runs, engine, evaluationRepository)
    );
    await service.start({ runId: RUN_ID, expectedRevision: 2 });
    await service.waitForIdle();
    expect(engine.observedCaseCount).toBe(0);
    expect(evaluationRepository.completeInput?.resultSetHash).not.toBe(sourceResultSetHash);
    expect(evaluationRepository.completeInput).toMatchObject({ evaluationContextHash: HASH });
    expect(evaluationRepository.completeInput?.results).toMatchObject([
      {
        runId: RUN_ID,
        caseKey: "case-1",
        status: "PASS",
        evalResultHash: sourceEval.evalResultHash,
        provenance: {
          sourceKind: "RUN",
          sourceId: SOURCE_RUN_ID,
          sourceResultHash: sourceEval.evalResultHash
        }
      }
    ]);
  });
});
