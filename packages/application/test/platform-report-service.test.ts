import type { PlatformEvalCaseResult } from "../src/features/evaluation/platform-eval-models.ts";
import type { ImportedReportRun } from "../src/features/execution-imports/execution-import-models.ts";
import type { PlatformRunTransactionManager } from "../src/features/runs/platform-run-ports.ts";
import type { PlatformRun } from "../src/features/runs/platform-run-models.ts";
import type {
  PlatformReportArtifactInput,
  PlatformReportArtifactWriteResult
} from "../src/features/runs/run-artifact-port.ts";
import { PlatformReportService } from "../src/features/reporting/platform-report-service.ts";
import {
  HASH,
  NOW,
  RUN_ID,
  evaluationRun,
  restResult
} from "../test-support/platform-evaluation-service-fixtures.ts";
import {
  MemoryArtifacts,
  MemoryPlatformEvalRepository,
  MemoryPlatformEvalTransactions
} from "../test-support/platform-run-resilience-fixtures.ts";
import {
  ClaimFailureRunStore,
  MemoryPlatformRunStore
} from "../test-support/in-memory-platform-run-store.ts";
import { describe, expect, it } from "vitest";

const EVALUATION_CONTEXT_HASH = "e".repeat(64);
const EVALUATION_RESULT_SET_HASH = "f".repeat(64);
const REPORT_ARTIFACT_TIME = "2026-07-15T00:00:01.000Z";
const CROSS_PROCESS_CANCEL_TIME = "2026-07-15T00:00:02.000Z";
const REPORT_TERMINAL_TIME = "2026-07-15T00:00:03.000Z";

class RunTransactions implements PlatformRunTransactionManager {
  readonly #runs: MemoryPlatformRunStore;

  public constructor(runs: MemoryPlatformRunStore) {
    this.#runs = runs;
  }

  public execute<T>(work: Parameters<PlatformRunTransactionManager["execute"]>[0]): Promise<T> {
    return work({ resources: {} as never, runs: this.#runs }) as Promise<T>;
  }
}

function passingEvaluation(): PlatformEvalCaseResult {
  return {
    runId: RUN_ID,
    caseKey: "case-1",
    ordinal: 0,
    status: "PASS",
    promptfooSuccess: true,
    score: 1,
    reason: "passed",
    evaluationError: null,
    assertions: [
      {
        index: 0,
        definitionHash: HASH,
        type: "equals",
        metric: "quality",
        weight: 1,
        status: "PASS",
        score: 1,
        reason: "passed"
      }
    ],
    diffs: [],
    metrics: [{ metric: "quality", status: "PASS" }],
    latencyMs: 3,
    tokenUsage: null,
    cost: 0,
    rawEvidence: null,
    evalResultHash: "1".repeat(64),
    finalCaseResultHash: "2".repeat(64),
    provenance: null,
    createdAt: NOW,
    updatedAt: NOW
  };
}

class AbortableReportArtifacts extends MemoryArtifacts {
  /** Resolves after the Report writer owns the request signal. */
  public readonly started: Promise<void>;
  #markStarted: () => void = () => undefined;

  /** Create one controllable in-flight Report writer. */
  public constructor() {
    super();
    this.started = new Promise((resolve) => {
      this.#markStarted = resolve;
    });
  }

  /** Remain in flight until cancellation or shutdown aborts the Report owner. */
  public override async writeReport(
    input: PlatformReportArtifactInput
  ): Promise<PlatformReportArtifactWriteResult> {
    this.#markStarted();
    await new Promise<void>((resolve) => {
      input.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    throw new Error("TEST_REPORT_ABORTED");
  }
}

class TerminalRaceReportArtifacts extends MemoryArtifacts {
  readonly #runs: MemoryPlatformRunStore;

  /** Bind a simulated competing terminal writer. */
  public constructor(runs: MemoryPlatformRunStore) {
    super();
    this.#runs = runs;
  }

  /** Publish both files, then let another owner win before the Report CAS. */
  public override async writeReport(
    input: PlatformReportArtifactInput
  ): Promise<PlatformReportArtifactWriteResult> {
    const output = await super.writeReport(input);
    const current = this.#runs.values.get(input.run.id);
    if (current !== undefined) {
      this.#runs.values.set(input.run.id, {
        ...current,
        status: "FAILED",
        stage: "DONE",
        errorCode: "REPORT_STAGE_FAILED"
      });
    }
    return output;
  }
}

class ReturningAfterAbortReportArtifacts extends MemoryArtifacts {
  /** Resolve after cancellation while still returning a complete published pair. */
  public override async writeReport(
    input: PlatformReportArtifactInput
  ): Promise<PlatformReportArtifactWriteResult> {
    await new Promise<void>((resolve) => {
      input.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return super.writeReport(input);
  }
}

class ControlledReturningReportArtifacts extends MemoryArtifacts {
  /** Resolves once the Report writer is waiting after claim. */
  public readonly started: Promise<void>;
  #markStarted: () => void = () => undefined;
  #release: () => void = () => undefined;
  readonly #released: Promise<void>;

  /** Create a writer that deliberately completes after cancellation. */
  public constructor() {
    super();
    this.started = new Promise((resolve) => {
      this.#markStarted = resolve;
    });
    this.#released = new Promise((resolve) => {
      this.#release = resolve;
    });
  }

  /** Allow the already-started writer to return its complete pair. */
  public release(): void {
    this.#release();
  }

  /** Ignore Abort to simulate a dependency that wins the completion race. */
  public override async writeReport(
    input: PlatformReportArtifactInput
  ): Promise<PlatformReportArtifactWriteResult> {
    this.#markStarted();
    await this.#released;
    return super.writeReport(input);
  }
}

class CrossProcessCancelReportArtifacts extends MemoryArtifacts {
  readonly #runs: MemoryPlatformRunStore;

  /** Bind the durable Run store mutated by a simulated second process. */
  public constructor(runs: MemoryPlatformRunStore) {
    super();
    this.#runs = runs;
  }

  /** Persist a remote cancel request after the local writer has finished both files. */
  public override async writeReport(
    input: PlatformReportArtifactInput
  ): Promise<PlatformReportArtifactWriteResult> {
    const output = await super.writeReport(input);
    const current = this.#runs.values.get(input.run.id);
    if (current === undefined) throw new Error("TEST_RUN_MISSING");
    this.#runs.values.set(input.run.id, {
      ...current,
      cancelRequestedAt: CROSS_PROCESS_CANCEL_TIME,
      lockRevision: current.lockRevision + 1,
      updatedAt: CROSS_PROCESS_CANCEL_TIME
    });
    return output;
  }
}

class FailingReportArtifacts extends MemoryArtifacts {
  /** Fail before publishing either Report file. */
  public override writeReport(): Promise<PlatformReportArtifactWriteResult> {
    return Promise.reject(new Error("TEST_REPORT_WRITE_FAILED"));
  }
}

function reportReadyRun(): PlatformRun {
  return {
    ...evaluationRun(),
    status: "READY" as const,
    stage: "REPORT" as const,
    lockRevision: 4,
    evalCompletedCount: 1,
    evalPassCount: 1,
    evaluationContextHash: EVALUATION_CONTEXT_HASH,
    evaluationResultSetHash: EVALUATION_RESULT_SET_HASH
  };
}

function importedReportRun(): ImportedReportRun {
  const source = reportReadyRun();
  return {
    id: RUN_ID,
    sourceType: "OFFLINE_IMPORT",
    packageId: "01900000-0000-7000-8000-000000000010",
    executionId: "01900000-0000-7000-8000-000000000011",
    sourceRunId: null,
    rerunMode: "NONE",
    suite: {
      id: source.suite.id,
      name: source.suite.name,
      suiteHash: source.suite.suiteHash,
      caseCount: 1
    },
    endpoint: source.endpoint,
    evaluator: source.evaluator,
    rubricPrompts: source.rubricPrompts,
    runContextHash: source.runContextHash,
    promptfooVersion: "0.121.18",
    contractVersions: {
      caseDefinition: "cortex.case-definition.v1",
      restResults: "cortex.rest-results.v1",
      normalizedEval: "cortex.normalized-eval.v1",
      report: "cortex.report.v1",
      analysisInput: "cortex.analysis-input.v1",
      analysisOutput: "cortex.analysis-output.v1"
    },
    runExecutionLimits: source.runExecutionLimits,
    status: "COMPLETED",
    stage: "DONE",
    restResultSetHash: source.resultSetHash ?? HASH,
    evaluationContextHash: EVALUATION_CONTEXT_HASH,
    evaluationResultSetHash: EVALUATION_RESULT_SET_HASH,
    reportResultSetHash: "3".repeat(64),
    reportSummary: {
      summary: {
        total: 1,
        restSucceeded: 1,
        restError: 0,
        evalPass: 1,
        evalFail: 0,
        evalError: 0,
        notEvaluated: 0,
        effectivePassRate: 1,
        evaluatedPassRate: 1,
        coverageRate: 1
      },
      byMetric: [
        {
          metric: "quality",
          pass: 1,
          fail: 0,
          error: 0,
          skipped: 0,
          notEvaluated: 0,
          passRate: 1
        }
      ]
    },
    artifactManifest: {
      contractVersion: "cortex.artifact-manifest.v1",
      owner: { kind: "EXECUTION", id: "01900000-0000-7000-8000-000000000011" },
      artifacts: [
        {
          kind: "REPORT_JSON",
          path: "executions/01900000-0000-7000-8000-000000000011/report.json",
          expectedSha256: "3".repeat(64),
          expectedSizeBytes: 100,
          contractVersion: "cortex.report.v1"
        }
      ]
    },
    completedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW
  };
}

function completedPlatformReportRun(): PlatformRun {
  const ready = reportReadyRun();
  return {
    ...ready,
    status: "COMPLETED",
    stage: "DONE",
    reportResultSetHash: "3".repeat(64),
    reportSummary: importedReportRun().reportSummary,
    completedAt: NOW
  };
}

function reportService(
  runs: MemoryPlatformRunStore,
  evaluations: MemoryPlatformEvalRepository,
  artifacts: MemoryArtifacts,
  events: string[] = []
): PlatformReportService {
  return new PlatformReportService({
    runTransactionManager: new RunTransactions(runs),
    evalTransactionManager: new MemoryPlatformEvalTransactions(evaluations),
    artifactStore: artifacts,
    clock: { now: (): string => NOW },
    messageResolver: { message: (code): string => code },
    eventSink: {
      record: (event): Promise<void> => {
        events.push(event.event);
        return Promise.resolve();
      }
    }
  });
}

describe("Platform Report Service", () => {
  it("在抢占前拒绝缺失、错误阶段、过期版本和不完整 Evaluation 版本", async () => {
    const runs = new MemoryPlatformRunStore();
    const evaluations = new MemoryPlatformEvalRepository(runs);
    const service = reportService(runs, evaluations, new MemoryArtifacts());

    await expect(service.start({ runId: RUN_ID, expectedRevision: 4 })).resolves.toEqual({
      ok: false,
      error: { code: "RUN_NOT_FOUND" }
    });
    runs.values.set(RUN_ID, { ...reportReadyRun(), stage: "EVALUATION" });
    await expect(service.start({ runId: RUN_ID, expectedRevision: 4 })).resolves.toEqual({
      ok: false,
      error: { code: "RUN_STATE_CONFLICT", reason: "STAGE_UNAVAILABLE" }
    });
    runs.values.set(RUN_ID, reportReadyRun());
    await expect(service.start({ runId: RUN_ID, expectedRevision: 3 })).resolves.toEqual({
      ok: false,
      error: { code: "RUN_STATE_CONFLICT", reason: "STATE_OR_REVISION" }
    });
    runs.values.set(RUN_ID, {
      ...reportReadyRun(),
      evaluationContextHash: null,
      evaluationResultSetHash: null
    });
    await expect(service.start({ runId: RUN_ID, expectedRevision: 4 })).resolves.toEqual({
      ok: false,
      error: { code: "REPORT_RECONCILIATION_FAILED" }
    });
  });

  it("把抢占竞态精确映射为不存在或全局运行冲突", async () => {
    for (const reason of ["NOT_FOUND", "GLOBAL_RUNNING"] as const) {
      const runs = new ClaimFailureRunStore(reason);
      runs.values.set(RUN_ID, reportReadyRun());
      runs.results.set(`${RUN_ID}:case-1`, restResult);
      const evaluations = new MemoryPlatformEvalRepository(runs);
      evaluations.queryItems = [passingEvaluation()];
      const service = reportService(runs, evaluations, new MemoryArtifacts());

      await expect(service.start({ runId: RUN_ID, expectedRevision: 4 })).resolves.toEqual(
        reason === "NOT_FOUND"
          ? { ok: false, error: { code: "RUN_NOT_FOUND" } }
          : { ok: false, error: { code: "RUN_STATE_CONFLICT", reason } }
      );
    }
  });

  it("读取离线导入报告及已落库明细，不把导入 Run 当作可执行平台 Run", async () => {
    const runs = new MemoryPlatformRunStore();
    runs.importedValues.set(RUN_ID, importedReportRun());
    runs.results.set(`${RUN_ID}:case-1`, restResult);
    const evaluations = new MemoryPlatformEvalRepository(runs);
    evaluations.queryItems = [
      {
        ...passingEvaluation(),
        rawEvidence: {
          present: true,
          path: `executions/${importedReportRun().executionId}/promptfoo-raw.json`,
          expectedSha256: HASH,
          expectedSizeBytes: 10
        }
      }
    ];
    const service = reportService(runs, evaluations, new MemoryArtifacts());

    await expect(service.get(RUN_ID)).resolves.toMatchObject({
      run: { id: RUN_ID, sourceType: "OFFLINE_IMPORT" },
      report: { summary: { total: 1, evalPass: 1 } },
      artifactAvailability: [{ artifact: { kind: "REPORT_JSON" }, status: "MISSING" }]
    });
    await expect(service.queryCases({ runId: RUN_ID, limit: 20 })).resolves.toMatchObject({
      items: [
        {
          testCase: { caseKey: "case-1", ordinal: 0 },
          rest: { status: "SUCCEEDED" },
          evaluation: { status: "PASS" }
        }
      ]
    });
    await expect(service.getCase(RUN_ID, "case-1")).resolves.toMatchObject({
      rawEvidenceStatus: "MISSING"
    });
  });

  it("保留 REST 与 Evaluation 版本并原子提交 JSON、Markdown 和 Report 版本", async () => {
    const runs = new MemoryPlatformRunStore();
    const evaluated = reportReadyRun();
    runs.values.set(RUN_ID, evaluated);
    runs.results.set(`${RUN_ID}:case-1`, restResult);
    const evaluations = new MemoryPlatformEvalRepository(runs);
    evaluations.queryItems = [passingEvaluation()];
    const artifacts = new MemoryArtifacts();
    const events: string[] = [];
    const service = reportService(runs, evaluations, artifacts, events);

    const started = await service.start({ runId: RUN_ID, expectedRevision: 4 });
    expect(started).toMatchObject({ ok: true, run: { status: "RUNNING", stage: "REPORT" } });
    await service.waitForIdle();

    const completed = runs.values.get(RUN_ID);
    expect(completed).toMatchObject({
      status: "COMPLETED",
      stage: "DONE",
      resultSetHash: evaluated.resultSetHash,
      evaluationContextHash: EVALUATION_CONTEXT_HASH,
      evaluationResultSetHash: EVALUATION_RESULT_SET_HASH
    });
    expect(completed?.reportResultSetHash).toMatch(/^[0-9a-f]{64}$/);
    expect(completed?.artifactManifest.artifacts.map((item) => item.kind)).toEqual([
      "REST_RESULTS",
      "REPORT_JSON",
      "REPORT_MARKDOWN"
    ]);
    expect(events).toEqual(["RUN_REPORT_STARTED", "RUN_REPORT_COMPLETED"]);

    const overview = await service.get(RUN_ID);
    expect(overview).toMatchObject({
      run: { id: RUN_ID },
      report: { summary: { total: 1, evalPass: 1 }, byMetric: [{ metric: "quality" }] }
    });
    const page = await service.queryCases({
      runId: RUN_ID,
      limit: 20,
      evalStatuses: ["PASS"],
      metrics: ["quality"]
    });
    expect(page).toMatchObject({
      items: [{ testCase: { caseKey: "case-1" }, rawEvidenceStatus: "ABSENT" }],
      nextCursor: null
    });
    await expect(service.getCase(RUN_ID, "case-1")).resolves.toMatchObject({
      testCase: { caseKey: "case-1", ordinal: 0 },
      rest: { status: "SUCCEEDED" },
      evaluation: { status: "PASS" },
      rawEvidenceStatus: "ABSENT"
    });
    await expect(service.getCase(RUN_ID, "missing")).resolves.toBeNull();
    await expect(
      service.queryCases({ runId: RUN_ID, limit: 20, metrics: ["other"] })
    ).resolves.toMatchObject({ items: [], nextCursor: null });
  });

  it("取消在途 Report 后停止文件 Owner 并提交 CANCELLED", async () => {
    const runs = new MemoryPlatformRunStore();
    runs.values.set(RUN_ID, reportReadyRun());
    runs.results.set(`${RUN_ID}:case-1`, restResult);
    const evaluations = new MemoryPlatformEvalRepository(runs);
    evaluations.queryItems = [passingEvaluation()];
    const artifacts = new AbortableReportArtifacts();
    const events: string[] = [];
    const service = reportService(runs, evaluations, artifacts, events);

    await expect(service.start({ runId: RUN_ID, expectedRevision: 4 })).resolves.toMatchObject({
      ok: true,
      run: { lockRevision: 5 }
    });
    await artifacts.started;
    await expect(service.cancel({ runId: RUN_ID, expectedRevision: 5 })).resolves.toMatchObject({
      ok: true,
      run: { cancelRequestedAt: NOW, lockRevision: 6 }
    });
    await service.waitForIdle();

    expect(runs.values.get(RUN_ID)).toMatchObject({ status: "CANCELLED", stage: "DONE" });
    expect(events).toEqual(["RUN_REPORT_STARTED", "RUN_CANCEL_REQUESTED", "RUN_CANCELLED"]);
  });

  it("Writer 在取消后仍返回完整文件时补偿文件并记录同一 CANCELLED 终态事件", async () => {
    const runs = new MemoryPlatformRunStore();
    runs.values.set(RUN_ID, reportReadyRun());
    runs.results.set(`${RUN_ID}:case-1`, restResult);
    const evaluations = new MemoryPlatformEvalRepository(runs);
    evaluations.queryItems = [passingEvaluation()];
    const artifacts = new ControlledReturningReportArtifacts();
    const events: string[] = [];
    const service = reportService(runs, evaluations, artifacts, events);

    await service.start({ runId: RUN_ID, expectedRevision: 4 });
    await artifacts.started;
    await service.cancel({ runId: RUN_ID, expectedRevision: 5 });
    artifacts.release();
    await service.waitForIdle();

    expect(runs.values.get(RUN_ID)).toMatchObject({ status: "CANCELLED", stage: "DONE" });
    expect(artifacts.removed.map((item) => item.kind)).toEqual(["REPORT_JSON", "REPORT_MARKDOWN"]);
    expect(events).toEqual(["RUN_REPORT_STARTED", "RUN_CANCEL_REQUESTED", "RUN_CANCELLED"]);
  });

  it("跨进程取消发生在文件写入期间时使用取消请求之后的终态时间", async () => {
    const runs = new MemoryPlatformRunStore();
    runs.values.set(RUN_ID, reportReadyRun());
    runs.results.set(`${RUN_ID}:case-1`, restResult);
    const evaluations = new MemoryPlatformEvalRepository(runs);
    evaluations.queryItems = [passingEvaluation()];
    const artifacts = new CrossProcessCancelReportArtifacts(runs);
    const times = [NOW, REPORT_ARTIFACT_TIME, REPORT_TERMINAL_TIME];
    const service = new PlatformReportService({
      runTransactionManager: new RunTransactions(runs),
      evalTransactionManager: new MemoryPlatformEvalTransactions(evaluations),
      artifactStore: artifacts,
      clock: {
        now: (): string => {
          const time = times.shift();
          if (time === undefined) throw new Error("TEST_CLOCK_EXHAUSTED");
          return time;
        }
      },
      messageResolver: { message: (code): string => code },
      eventSink: { record: (): Promise<void> => Promise.resolve() }
    });

    await service.start({ runId: RUN_ID, expectedRevision: 4 });
    await service.waitForIdle();

    expect(runs.values.get(RUN_ID)).toMatchObject({
      status: "CANCELLED",
      stage: "DONE",
      cancelRequestedAt: CROSS_PROCESS_CANCEL_TIME,
      completedAt: REPORT_TERMINAL_TIME,
      updatedAt: REPORT_TERMINAL_TIME
    });
    expect(artifacts.removed.map((item) => item.kind)).toEqual(["REPORT_JSON", "REPORT_MARKDOWN"]);
  });

  it("关闭进程中断在途 Report，不能把 Shutdown 伪装成用户取消", async () => {
    const runs = new MemoryPlatformRunStore();
    runs.values.set(RUN_ID, reportReadyRun());
    runs.results.set(`${RUN_ID}:case-1`, restResult);
    const evaluations = new MemoryPlatformEvalRepository(runs);
    evaluations.queryItems = [passingEvaluation()];
    const artifacts = new AbortableReportArtifacts();
    const service = reportService(runs, evaluations, artifacts);

    await service.start({ runId: RUN_ID, expectedRevision: 4 });
    await artifacts.started;
    await service.shutdown();

    expect(runs.values.get(RUN_ID)).toMatchObject({
      status: "INTERRUPTED",
      stage: "DONE",
      cancelRequestedAt: null
    });
  });

  it("Report 提交前丢失 Owner 时只补偿本次发布并保留竞争终态", async () => {
    const runs = new MemoryPlatformRunStore();
    runs.values.set(RUN_ID, reportReadyRun());
    runs.results.set(`${RUN_ID}:case-1`, restResult);
    const evaluations = new MemoryPlatformEvalRepository(runs);
    evaluations.queryItems = [passingEvaluation()];
    const artifacts = new TerminalRaceReportArtifacts(runs);
    const service = reportService(runs, evaluations, artifacts);

    await service.start({ runId: RUN_ID, expectedRevision: 4 });
    await service.waitForIdle();

    expect(runs.values.get(RUN_ID)).toMatchObject({
      status: "FAILED",
      stage: "DONE",
      errorCode: "REPORT_STAGE_FAILED"
    });
    expect(artifacts.removed.map((item) => item.kind)).toEqual(["REPORT_JSON", "REPORT_MARKDOWN"]);
  });

  it("文件写入失败收敛为 REPORT_RECONCILIATION_FAILED，观测失败不改变终态", async () => {
    const runs = new MemoryPlatformRunStore();
    runs.values.set(RUN_ID, reportReadyRun());
    runs.results.set(`${RUN_ID}:case-1`, restResult);
    const evaluations = new MemoryPlatformEvalRepository(runs);
    evaluations.queryItems = [passingEvaluation()];
    const service = new PlatformReportService({
      runTransactionManager: new RunTransactions(runs),
      evalTransactionManager: new MemoryPlatformEvalTransactions(evaluations),
      artifactStore: new FailingReportArtifacts(),
      clock: { now: (): string => NOW },
      messageResolver: { message: (code): string => code },
      eventSink: { record: (): Promise<void> => Promise.reject(new Error("LOG_FAILED")) }
    });

    await expect(service.start({ runId: RUN_ID, expectedRevision: 4 })).resolves.toMatchObject({
      ok: true
    });
    await service.waitForIdle();
    expect(runs.values.get(RUN_ID)).toMatchObject({
      status: "FAILED",
      stage: "DONE",
      errorCode: "REPORT_RECONCILIATION_FAILED"
    });
  });

  it("Shutdown 后即使 Writer 返回完整文件也优先中断并补偿两个文件", async () => {
    const runs = new MemoryPlatformRunStore();
    runs.values.set(RUN_ID, reportReadyRun());
    runs.results.set(`${RUN_ID}:case-1`, restResult);
    const evaluations = new MemoryPlatformEvalRepository(runs);
    evaluations.queryItems = [passingEvaluation()];
    const artifacts = new ReturningAfterAbortReportArtifacts();
    const service = reportService(runs, evaluations, artifacts);

    await service.start({ runId: RUN_ID, expectedRevision: 4 });
    await service.shutdown();

    expect(runs.values.get(RUN_ID)).toMatchObject({ status: "INTERRUPTED", stage: "DONE" });
    expect(artifacts.removed.map((item) => item.kind)).toEqual(["REPORT_JSON", "REPORT_MARKDOWN"]);
  });

  it("查询严格校验分页并区分不存在、未完成与可流式导出的报告", async () => {
    const runs = new MemoryPlatformRunStore();
    const evaluations = new MemoryPlatformEvalRepository(runs);
    const service = reportService(runs, evaluations, new MemoryArtifacts());

    await expect(service.exists(RUN_ID)).resolves.toBe(false);
    await expect(service.get(RUN_ID)).resolves.toBeNull();
    await expect(service.cancel({ runId: RUN_ID, expectedRevision: 1 })).resolves.toEqual({
      ok: false,
      error: { code: "RUN_NOT_FOUND" }
    });
    await expect(service.queryCases({ runId: RUN_ID, limit: 0 })).rejects.toThrow(
      "REPORT_QUERY_INVALID"
    );
    await expect(
      service.queryCases({ runId: RUN_ID, limit: 201, afterOrdinal: -1 })
    ).rejects.toThrow("REPORT_QUERY_INVALID");
    await expect(service.queryCases({ runId: RUN_ID, limit: 20 })).resolves.toBeNull();
    await expect(service.getCase(RUN_ID, "case-1")).resolves.toBeNull();

    runs.values.set(RUN_ID, reportReadyRun());
    await expect(service.exists(RUN_ID)).resolves.toBe(true);
    await expect(service.cancel({ runId: RUN_ID, expectedRevision: 4 })).resolves.toEqual({
      ok: false,
      error: { code: "RUN_STATE_CONFLICT", reason: "STATE_OR_REVISION" }
    });
    await expect(service.get(RUN_ID)).resolves.toBeNull();
    await expect(service.queryCases({ runId: RUN_ID, limit: 20 })).resolves.toBeNull();
    await expect(service.getCase(RUN_ID, "case-1")).resolves.toBeNull();
    const stream = service.streamCases("01900000-0000-7000-8000-000000000099");
    await expect(stream.next()).rejects.toThrow("REPORT_RECONCILIATION_FAILED");
    const incompleteStream = service.streamCases(RUN_ID);
    await expect(incompleteStream.next()).rejects.toThrow("REPORT_RECONCILIATION_FAILED");
  });

  it("报告查询组合过滤、分页和 Raw Evidence 状态不改变规范化事实", async () => {
    const first = reportReadyRun();
    const firstCase = first.suite.cases[0];
    if (firstCase === undefined) throw new Error("TEST_CASE_MISSING");
    const secondCase: PlatformRun["suite"]["cases"][number] = {
      ...firstCase,
      caseKey: "case-2",
      ordinal: 1,
      definitionHash: "4".repeat(64),
      definition: {
        ...firstCase.definition,
        caseKey: "case-2",
        metadata: {
          ...firstCase.definition.metadata,
          requestId: "request-case-2",
          taskId: "task-case-2",
          businessModule: "billing",
          scenarioTag: "refund"
        }
      }
    };
    const completed = {
      ...first,
      suite: { ...first.suite, cases: [...first.suite.cases, secondCase] },
      status: "COMPLETED" as const,
      stage: "DONE" as const,
      reportResultSetHash: "5".repeat(64),
      reportSummary: {
        summary: {
          total: 2,
          restSucceeded: 2,
          restError: 0,
          evalPass: 2,
          evalFail: 0,
          evalError: 0,
          notEvaluated: 0,
          effectivePassRate: 1,
          evaluatedPassRate: 1,
          coverageRate: 1
        },
        byMetric: []
      }
    };
    const runs = new MemoryPlatformRunStore();
    runs.values.set(RUN_ID, completed);
    runs.results.set(`${RUN_ID}:case-1`, restResult);
    runs.results.set(`${RUN_ID}:case-2`, {
      ...restResult,
      caseKey: "case-2",
      ordinal: 1,
      caseDefinitionHash: secondCase.definitionHash,
      definition: secondCase.definition
    });
    const evaluations = new MemoryPlatformEvalRepository(runs);
    evaluations.queryItems = [
      {
        ...passingEvaluation(),
        rawEvidence: {
          present: true,
          path: `runs/${RUN_ID}/promptfoo-raw.json`,
          expectedSha256: "6".repeat(64),
          expectedSizeBytes: 20
        }
      },
      {
        ...passingEvaluation(),
        caseKey: "case-2",
        ordinal: 1,
        metrics: [{ metric: "other", status: "PASS" }],
        rawEvidence: {
          present: true,
          path: "invalid/raw.json",
          expectedSha256: "7".repeat(64),
          expectedSizeBytes: 20
        }
      }
    ];
    const artifacts = new MemoryArtifacts();
    artifacts.availability = [
      {
        artifact: {
          kind: "RAW_PROMPTFOO_EVIDENCE",
          path: `runs/${RUN_ID}/promptfoo-raw.json`,
          expectedSha256: "6".repeat(64),
          expectedSizeBytes: 20,
          contractVersion: "cortex.platform-raw-promptfoo-evidence.v1"
        },
        status: "PRESENT"
      }
    ];
    const service = reportService(runs, evaluations, artifacts);

    await expect(service.queryCases({ runId: RUN_ID, limit: 1 })).resolves.toMatchObject({
      items: [{ testCase: { caseKey: "case-1" }, rawEvidenceStatus: "PRESENT" }],
      nextCursor: 0
    });
    await expect(
      service.queryCases({
        runId: RUN_ID,
        limit: 20,
        afterOrdinal: 0,
        restStatuses: ["SUCCEEDED"],
        evalStatuses: ["PASS"],
        metrics: ["other"],
        businessModules: ["billing"],
        scenarioTags: ["refund"]
      })
    ).resolves.toMatchObject({
      items: [{ testCase: { caseKey: "case-2" }, rawEvidenceStatus: "CORRUPTED" }],
      nextCursor: null
    });
    await expect(
      service.queryCases({ runId: RUN_ID, limit: 20, restStatuses: ["ERROR"] })
    ).resolves.toMatchObject({ items: [] });
    await expect(
      service.queryCases({ runId: RUN_ID, limit: 20, evalStatuses: ["FAIL"] })
    ).resolves.toMatchObject({ items: [] });
    await expect(
      service.queryCases({ runId: RUN_ID, limit: 20, businessModules: ["other"] })
    ).resolves.toMatchObject({ items: [] });
    await expect(
      service.queryCases({ runId: RUN_ID, limit: 20, scenarioTags: ["other"] })
    ).resolves.toMatchObject({ items: [] });
    await expect(service.getCase(RUN_ID, "case-1")).resolves.toMatchObject({
      rawEvidenceStatus: "PRESENT"
    });
    const exported = [];
    for await (const item of service.streamCases(RUN_ID)) exported.push(item.testCase.caseKey);
    expect(exported).toEqual(["case-1", "case-2"]);
  });

  it("拒绝平台与离线 Report 的 Case 身份漂移、尾部多项和两侧数量不等", async () => {
    const mismatchedRuns = new MemoryPlatformRunStore();
    mismatchedRuns.values.set(RUN_ID, completedPlatformReportRun());
    mismatchedRuns.results.set(`${RUN_ID}:case-1`, restResult);
    const mismatchedEvaluations = new MemoryPlatformEvalRepository(mismatchedRuns);
    mismatchedEvaluations.queryItems = [{ ...passingEvaluation(), caseKey: "different" }];
    const mismatchedService = reportService(
      mismatchedRuns,
      mismatchedEvaluations,
      new MemoryArtifacts()
    );
    await expect(mismatchedService.getCase(RUN_ID, "case-1")).resolves.toBeNull();
    await expect(mismatchedService.queryCases({ runId: RUN_ID, limit: 20 })).rejects.toThrow(
      "REPORT_RECONCILIATION_FAILED"
    );

    const extraRuns = new MemoryPlatformRunStore();
    extraRuns.values.set(RUN_ID, completedPlatformReportRun());
    extraRuns.results.set(`${RUN_ID}:case-1`, restResult);
    extraRuns.results.set(`${RUN_ID}:case-2`, {
      ...restResult,
      caseKey: "case-2",
      ordinal: 1
    });
    const extraEvaluations = new MemoryPlatformEvalRepository(extraRuns);
    extraEvaluations.queryItems = [
      passingEvaluation(),
      { ...passingEvaluation(), caseKey: "case-2", ordinal: 1 }
    ];
    await expect(
      reportService(extraRuns, extraEvaluations, new MemoryArtifacts()).queryCases({
        runId: RUN_ID,
        limit: 20
      })
    ).rejects.toThrow("REPORT_RECONCILIATION_FAILED");

    const truncatedRuns = new MemoryPlatformRunStore();
    truncatedRuns.importedValues.set(RUN_ID, importedReportRun());
    truncatedRuns.results.set(`${RUN_ID}:case-1`, restResult);
    const truncatedEvaluations = new MemoryPlatformEvalRepository(truncatedRuns);
    await expect(
      reportService(truncatedRuns, truncatedEvaluations, new MemoryArtifacts()).queryCases({
        runId: RUN_ID,
        limit: 20
      })
    ).rejects.toThrow("REPORT_RECONCILIATION_FAILED");

    const importedMismatchRuns = new MemoryPlatformRunStore();
    importedMismatchRuns.importedValues.set(RUN_ID, importedReportRun());
    importedMismatchRuns.results.set(`${RUN_ID}:case-1`, restResult);
    const importedMismatchEvaluations = new MemoryPlatformEvalRepository(importedMismatchRuns);
    importedMismatchEvaluations.queryItems = [{ ...passingEvaluation(), caseKey: "different" }];
    await expect(
      reportService(
        importedMismatchRuns,
        importedMismatchEvaluations,
        new MemoryArtifacts()
      ).queryCases({ runId: RUN_ID, limit: 20 })
    ).rejects.toThrow("REPORT_RECONCILIATION_FAILED");
  });
});
