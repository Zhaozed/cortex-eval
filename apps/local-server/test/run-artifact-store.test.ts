import { lstat, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  PlatformNormalizedEvalArtifactInput,
  PlatformReportArtifactInput,
  PlatformRestArtifactInput
} from "@cortex-eval/application/src/features/runs/run-artifact-port.ts";
import type { PlatformEvalCaseResult } from "@cortex-eval/application/src/features/evaluation/platform-eval-models.ts";
import type {
  PlatformRun,
  StoredRestCaseResult
} from "@cortex-eval/application/src/features/runs/platform-run-models.ts";
import {
  hashEvalResultSet,
  hashRestResultSet
} from "@cortex-eval/domain/src/domain-hash-inputs.ts";
import { createReportAccumulator } from "@cortex-eval/reporting/src/report-aggregation.ts";
import { afterEach, describe, expect, it } from "vitest";

import { LocalRunArtifactStore } from "../src/run-artifact-store.ts";

const roots: string[] = [];
const RUN_ID = "01900000-0000-7000-8000-000000000001";
const NOW = "2026-07-13T00:00:00.000Z";
const EVALUATION_CONTEXT_HASH = "f".repeat(64);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const CASE_RESULT: StoredRestCaseResult = {
  runId: RUN_ID,
  caseKey: "case-1",
  ordinal: 0,
  definition: {
    caseKey: "case-1",
    description: "Case",
    threshold: 1,
    task: "route",
    requestBody: { input: "hello" },
    metadata: {
      requestId: "request-1",
      taskId: "task-1",
      businessModule: "chat",
      scenarioTag: "smoke"
    },
    assertions: [{ type: "equals", metric: "quality", weight: 1 }]
  },
  caseDefinitionHash: "b".repeat(64),
  status: "SUCCEEDED",
  httpStatus: 200,
  providerOutput: { ok: false, errorMessage: "business" },
  errorType: null,
  errorMessage: null,
  durationMs: 12,
  completedAt: NOW,
  resultHash: "c".repeat(64),
  provenance: null
};

const EVAL_RESULT: PlatformEvalCaseResult = {
  runId: RUN_ID,
  caseKey: "case-1",
  ordinal: 0,
  status: "PASS",
  promptfooSuccess: true,
  score: 1,
  reason: "ok",
  evaluationError: null,
  assertions: [
    {
      index: 0,
      definitionHash: "d".repeat(64),
      type: "equals",
      metric: "quality",
      weight: 1,
      status: "PASS",
      score: 1,
      reason: "ok"
    }
  ],
  diffs: [],
  metrics: [{ metric: "quality", status: "PASS" }],
  latencyMs: 3,
  tokenUsage: null,
  cost: 0,
  rawEvidence: {
    present: true,
    path: `runs/${RUN_ID}/promptfoo-raw.json`,
    expectedSha256: "e".repeat(64),
    expectedSizeBytes: 50
  },
  evalResultHash: "f".repeat(64),
  finalCaseResultHash: "1".repeat(64),
  provenance: null,
  createdAt: NOW,
  updatedAt: NOW
};

const SECOND_EVAL_RESULT: PlatformEvalCaseResult = {
  ...EVAL_RESULT,
  caseKey: "case-2",
  ordinal: 1,
  evalResultHash: "2".repeat(64),
  finalCaseResultHash: "3".repeat(64)
};

// Create one single-use async result stream.
async function* streamCases(
  values: readonly StoredRestCaseResult[]
): AsyncGenerator<StoredRestCaseResult> {
  for (const value of values) yield await Promise.resolve(value);
}

// Create one single-use normalized Evaluation stream.
async function* streamEvalCases(
  values: readonly PlatformEvalCaseResult[]
): AsyncGenerator<PlatformEvalCaseResult> {
  for (const value of values) yield await Promise.resolve(value);
}

// Consume one export body without assuming chunk boundaries.
async function readBody(body: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function artifactInput(): PlatformRestArtifactInput {
  return {
    runId: RUN_ID,
    runContextHash: "a".repeat(64),
    completedAt: NOW,
    expectedTotal: 1,
    cases: streamCases([CASE_RESULT])
  };
}

function reportRun(): PlatformRun {
  return {
    id: RUN_ID,
    sourceType: "PLATFORM",
    sourceRunId: null,
    rerunMode: "NONE",
    suite: {
      id: "01900000-0000-7000-8000-000000000010",
      name: "Suite",
      suiteHash: "2".repeat(64),
      cases: [
        {
          caseKey: CASE_RESULT.caseKey,
          ordinal: CASE_RESULT.ordinal,
          definitionHash: CASE_RESULT.caseDefinitionHash,
          definition: CASE_RESULT.definition
        }
      ]
    },
    endpoint: {
      sourceId: null,
      name: "Endpoint",
      configHash: "3".repeat(64),
      definition: {
        urlTemplate: "https://example.test/{{vars.task}}",
        method: "POST",
        headers: {},
        bodySelector: "/request_body",
        timeoutMs: 1_000,
        defaultConcurrency: 4
      }
    },
    evaluator: {
      sourceId: null,
      name: "Evaluator",
      configHash: "4".repeat(64),
      definition: {
        providerType: "GOOGLE_GEMINI",
        apiKey: { kind: "ENV_SECRET", envKey: "GEMINI_API_KEY" },
        model: "gemini-test",
        thinkingLevel: "OFF",
        temperature: 0,
        topP: 1,
        maxOutputTokens: 256,
        timeoutMs: 1_000,
        structuredOutput: "JSON_OBJECT"
      }
    },
    rubricPrompts: [],
    runContextHash: "a".repeat(64),
    promptfooVersion: "0.121.18",
    contractVersions: {
      runSnapshot: "cortex.run-snapshot.v1",
      caseDefinition: "cortex.case-definition.v1",
      platformRestResults: "cortex.platform-rest-results.v1"
    },
    runExecutionLimits: {
      contractVersion: "cortex.run-execution-limits.v1",
      restConcurrency: 4,
      evalConcurrency: 2
    },
    runMode: "STAGED",
    status: "RUNNING",
    stage: "REPORT",
    lockRevision: 5,
    cancelRequestedAt: null,
    restCompletedCount: 1,
    restErrorCount: 0,
    evalCompletedCount: 1,
    evalPassCount: 1,
    evalFailCount: 0,
    evalErrorCount: 0,
    evalNotEvaluatedCount: 0,
    resultSetHash: "5".repeat(64),
    evaluationContextHash: EVALUATION_CONTEXT_HASH,
    evaluationResultSetHash: "6".repeat(64),
    reportResultSetHash: null,
    reportSummary: null,
    artifactManifest: {
      contractVersion: "cortex.artifact-manifest.v1",
      owner: { kind: "RUN", id: RUN_ID },
      artifacts: []
    },
    errorCode: null,
    errorMessage: null,
    startedAt: NOW,
    completedAt: null,
    createdAt: NOW,
    updatedAt: NOW
  };
}

function reportInput(): PlatformReportArtifactInput {
  const run = reportRun();
  const item = reportCaseInput(run);
  return {
    run,
    completedAt: NOW,
    aggregation: reportAggregation(run),
    expectedTotal: 1,
    signal: new AbortController().signal,
    cases: reportCases(item)
  };
}

function reportCaseInput(
  run: PlatformRun = reportRun()
): PlatformReportArtifactInput["cases"] extends AsyncIterable<infer T> ? T : never {
  const testCase = run.suite.cases[0];
  if (testCase === undefined) throw new Error("TEST_CASE_MISSING");
  return { testCase, rest: CASE_RESULT, evaluation: EVAL_RESULT };
}

function reportAggregation(
  run: PlatformRun = reportRun()
): PlatformReportArtifactInput["aggregation"] {
  const accumulator = createReportAccumulator({
    owner: { kind: "RUN", id: run.id },
    runContextHash: run.runContextHash,
    evaluationContextHash: EVALUATION_CONTEXT_HASH,
    evaluationResultSetHash: run.evaluationResultSetHash ?? "",
    expectedCaseKey: (ordinal) => run.suite.cases[ordinal]?.caseKey ?? null
  });
  accumulator.add({
    caseKey: CASE_RESULT.caseKey,
    ordinal: CASE_RESULT.ordinal,
    rest: { status: CASE_RESULT.status, resultHash: CASE_RESULT.resultHash },
    evaluation: {
      status: EVAL_RESULT.status,
      evalResultHash: EVAL_RESULT.evalResultHash,
      finalCaseResultHash: EVAL_RESULT.finalCaseResultHash,
      metrics: EVAL_RESULT.metrics
    }
  });
  return accumulator.finish();
}

function reportCases(
  ...items: readonly ReturnType<typeof reportCaseInput>[]
): PlatformReportArtifactInput["cases"] {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<ReturnType<typeof reportCaseInput>, void> {
      for (const item of items) yield await Promise.resolve(item);
    }
  };
}

describe("LocalRunArtifactStore", () => {
  it("流式原子发布 Report JSON 与 Markdown，并支持逐文件精确补偿", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-report-artifacts-"));
    roots.push(projectRoot);
    const store = await LocalRunArtifactStore.create({ projectRoot });

    const written = await store.writeReport(reportInput());
    const jsonPath = join(projectRoot, ".cortex-eval", "artifacts", written.json.descriptor.path);
    const markdownPath = join(
      projectRoot,
      ".cortex-eval",
      "artifacts",
      written.markdown.descriptor.path
    );
    const reportBytes = await readFile(jsonPath, "utf8");
    const report = JSON.parse(reportBytes) as Record<string, unknown>;
    expect(report).toMatchObject({
      contractVersion: "cortex.report.v1",
      owner: { kind: "RUN", id: RUN_ID },
      packageId: null,
      evaluationContextHash: EVALUATION_CONTEXT_HASH,
      cases: [{ caseKey: "case-1", ordinal: 0 }]
    });
    const manifest = {
      contractVersion: "cortex.artifact-manifest.v1" as const,
      owner: { kind: "RUN" as const, id: RUN_ID },
      artifacts: [written.json.descriptor, written.markdown.descriptor]
    };
    const exportBody = await store.openReportJson(manifest, new AbortController().signal);
    expect(exportBody).not.toBeNull();
    await expect(readBody(exportBody as NodeJS.ReadableStream)).resolves.toContain(
      '"contractVersion":"cortex.report.v1"'
    );
    await writeFile(jsonPath, "corrupted\n", { encoding: "utf8", mode: 0o600 });
    await expect(store.openReportJson(manifest, new AbortController().signal)).resolves.toBeNull();
    await writeFile(jsonPath, reportBytes, { encoding: "utf8", mode: 0o600 });
    await expect(readFile(markdownPath, "utf8")).resolves.toContain("# Cortex Eval 报告");
    await expect(store.removeUncommitted(written.json)).resolves.toBeUndefined();
    await expect(lstat(jsonPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(markdownPath)).size).toBeGreaterThan(0);
  });

  it("Report 第二个目标冲突时补偿本次 JSON 且保留既有 Markdown", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-report-pair-collision-"));
    roots.push(projectRoot);
    const store = await LocalRunArtifactStore.create({ projectRoot, nonce: () => "collision" });
    const runRoot = join(projectRoot, ".cortex-eval", "artifacts", "runs", RUN_ID);
    await mkdir(runRoot, { mode: 0o700 });
    const markdownPath = join(runRoot, "report.md");
    await writeFile(markdownPath, "existing\n", { encoding: "utf8", mode: 0o600 });

    await expect(store.writeReport(reportInput())).rejects.toMatchObject({
      code: "ARTIFACT_WRITE_FAILED"
    });
    await expect(lstat(join(runRoot, "report.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(markdownPath, "utf8")).resolves.toBe("existing\n");
  });

  it("在创建文件前拒绝非法 Report 身份、时间、数量和已取消请求", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-report-invalid-input-"));
    roots.push(projectRoot);
    const store = await LocalRunArtifactStore.create({ projectRoot });
    const base = reportInput();
    const cancelled = new AbortController();
    cancelled.abort();
    const invalidInputs: readonly PlatformReportArtifactInput[] = [
      { ...base, run: { ...base.run, id: "invalid" } },
      { ...base, run: { ...base.run, evaluationContextHash: null } },
      { ...base, run: { ...base.run, evaluationResultSetHash: null } },
      { ...base, completedAt: "invalid" },
      { ...base, expectedTotal: 0 },
      { ...base, expectedTotal: 1.5 },
      { ...base, expectedTotal: 2 },
      { ...base, signal: cancelled.signal }
    ];

    for (const input of invalidInputs) {
      await expect(store.writeReport(input)).rejects.toMatchObject({
        code: "ARTIFACT_WRITE_FAILED"
      });
    }
  });

  it("拒绝 Report Case 流少项、多项、聚合漂移和流结束后的取消", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-report-invalid-stream-"));
    roots.push(projectRoot);
    const store = await LocalRunArtifactStore.create({ projectRoot });
    const base = reportInput();
    const item = reportCaseInput(base.run);
    const abortedAfterCase = new AbortController();
    const abortingCases: PlatformReportArtifactInput["cases"] = {
      async *[Symbol.asyncIterator]() {
        yield await Promise.resolve(item);
        abortedAfterCase.abort();
      }
    };
    const invalidInputs: readonly PlatformReportArtifactInput[] = [
      { ...base, cases: reportCases() },
      { ...base, cases: reportCases(item, item) },
      {
        ...base,
        aggregation: { ...base.aggregation, reportResultSetHash: "0".repeat(64) }
      },
      { ...base, cases: abortingCases, signal: abortedAfterCase.signal }
    ];

    for (const input of invalidInputs) {
      await expect(store.writeReport(input)).rejects.toMatchObject({
        code: "ARTIFACT_WRITE_FAILED"
      });
    }
    const runRoot = join(projectRoot, ".cortex-eval", "artifacts", "runs", RUN_ID);
    await expect(readFile(join(runRoot, "report.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(readFile(join(runRoot, "report.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("Report 导出拒绝取消、错误 Manifest、缺失文件和尺寸漂移", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-report-export-boundary-"));
    roots.push(projectRoot);
    const store = await LocalRunArtifactStore.create({ projectRoot });
    const written = await store.writeReport(reportInput());
    const manifest = {
      contractVersion: "cortex.artifact-manifest.v1" as const,
      owner: { kind: "RUN" as const, id: RUN_ID },
      artifacts: [written.json.descriptor]
    };
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(store.openReportJson(manifest, cancelled.signal)).rejects.toThrow(
      "REQUEST_ABORTED"
    );
    await expect(
      store.openReportJson({ ...manifest, artifacts: [] }, new AbortController().signal)
    ).resolves.toBeNull();
    await expect(
      store.openReportJson(
        {
          ...manifest,
          artifacts: [{ ...written.json.descriptor, contractVersion: "cortex.report-markdown.v1" }]
        },
        new AbortController().signal
      )
    ).resolves.toBeNull();
    await expect(
      store.openReportJson(
        {
          ...manifest,
          artifacts: [
            {
              ...written.json.descriptor,
              expectedSizeBytes: written.json.descriptor.expectedSizeBytes + 1
            }
          ]
        },
        new AbortController().signal
      )
    ).resolves.toBeNull();
    const jsonPath = join(projectRoot, ".cortex-eval", "artifacts", written.json.descriptor.path);
    await unlink(jsonPath);
    await expect(store.openReportJson(manifest, new AbortController().signal)).resolves.toBeNull();
  });
  it("补偿 post-link 同步失败且不留下未登记目标文件", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-artifact-post-link-"));
    roots.push(projectRoot);
    let syncCalls = 0;
    const cleanupFailures: string[] = [];
    const store = await LocalRunArtifactStore.create({
      projectRoot,
      nonce: (): string => "post-link",
      syncDirectory: (): Promise<void> => {
        syncCalls += 1;
        return syncCalls === 1
          ? Promise.reject(new Error("TEST_POST_LINK_SYNC_FAILED"))
          : Promise.resolve();
      },
      onCleanupFailure: (code): void => {
        cleanupFailures.push(code);
      }
    });

    await expect(store.writeRestResults(artifactInput())).rejects.toMatchObject({
      code: "ARTIFACT_WRITE_FAILED"
    });
    const runRoot = join(projectRoot, ".cortex-eval", "artifacts", "runs", RUN_ID);
    await expect(lstat(join(runRoot, "rest-results.json"))).rejects.toMatchObject({
      code: "ENOENT"
    });
    expect(cleanupFailures).toEqual([]);
  });

  it("补偿同步和清理观察器都失败时仍保留首次 Artifact 错误", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-artifact-cleanup-report-"));
    roots.push(projectRoot);
    const cleanupFailures: string[] = [];
    const store = await LocalRunArtifactStore.create({
      projectRoot,
      nonce: (): string => "cleanup-report",
      syncDirectory: (): Promise<never> => Promise.reject(new Error("TEST_DIRECTORY_SYNC_FAILED")),
      onCleanupFailure: (code): Promise<void> => {
        cleanupFailures.push(code);
        return Promise.reject(new Error("TEST_CLEANUP_REPORT_FAILED"));
      }
    });

    await expect(store.writeRestResults(artifactInput())).rejects.toMatchObject({
      code: "ARTIFACT_WRITE_FAILED"
    });
    const runRoot = join(projectRoot, ".cortex-eval", "artifacts", "runs", RUN_ID);
    await expect(lstat(join(runRoot, "rest-results.json"))).rejects.toMatchObject({
      code: "ENOENT"
    });
    expect(cleanupFailures).toEqual(["RUN_ARTIFACT_CLEANUP_FAILED"]);
  });

  it("post-link 同步失败补偿不会删除并发替换后的目标文件", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-artifact-replacement-"));
    roots.push(projectRoot);
    const target = join(
      projectRoot,
      ".cortex-eval",
      "artifacts",
      "runs",
      RUN_ID,
      "rest-results.json"
    );
    const cleanupFailures: string[] = [];
    let syncCalls = 0;
    const store = await LocalRunArtifactStore.create({
      projectRoot,
      nonce: (): string => "replacement",
      syncDirectory: async (): Promise<void> => {
        syncCalls += 1;
        if (syncCalls !== 1) return;
        await rm(target);
        await writeFile(target, "replacement\n", { encoding: "utf8", mode: 0o600 });
        throw new Error("TEST_POST_LINK_SYNC_FAILED");
      },
      onCleanupFailure: (code): void => {
        cleanupFailures.push(code);
      }
    });

    await expect(store.writeRestResults(artifactInput())).rejects.toMatchObject({
      code: "ARTIFACT_WRITE_FAILED"
    });
    await expect(readFile(target, "utf8")).resolves.toBe("replacement\n");
    expect(cleanupFailures).toEqual(["RUN_ARTIFACT_CLEANUP_FAILED"]);
  });

  it("原子写入 Raw 与 Normalized Evaluation Artifact 并保持固定顺序", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-eval-artifacts-"));
    roots.push(projectRoot);
    const store = await LocalRunArtifactStore.create({ projectRoot });
    const rawPublication = await store.writeRawPromptfooEvidence({
      runId: RUN_ID,
      runContextHash: "a".repeat(64),
      evaluationContextHash: EVALUATION_CONTEXT_HASH,
      promptfooVersion: "0.121.18",
      exitCode: 100,
      durationMs: 15,
      raw: { results: { version: 3, results: [] } }
    });
    const evalResultSetHash = hashEvalResultSet({
      contractVersion: "cortex.eval-result-set.v1",
      owner: { kind: "RUN", id: RUN_ID },
      evaluationContextHash: EVALUATION_CONTEXT_HASH,
      cases: [
        {
          caseKey: EVAL_RESULT.caseKey,
          ordinal: EVAL_RESULT.ordinal,
          evalResultHash: EVAL_RESULT.evalResultHash
        }
      ]
    });
    const normalizedInput: PlatformNormalizedEvalArtifactInput = {
      runId: RUN_ID,
      runContextHash: "a".repeat(64),
      evaluationContextHash: EVALUATION_CONTEXT_HASH,
      completedAt: NOW,
      expectedTotal: 1,
      resultSetHash: evalResultSetHash,
      cases: streamEvalCases([EVAL_RESULT])
    };
    const normalizedPublication = await store.writeNormalizedEvalResults(normalizedInput);
    const raw = rawPublication.descriptor;
    const normalized = normalizedPublication.descriptor;

    expect([raw.kind, normalized.kind]).toEqual([
      "RAW_PROMPTFOO_EVIDENCE",
      "NORMALIZED_EVAL_RESULTS"
    ]);
    const rawJson = JSON.parse(
      await readFile(join(projectRoot, ".cortex-eval", "artifacts", raw.path), "utf8")
    ) as unknown;
    const normalizedJson = JSON.parse(
      await readFile(join(projectRoot, ".cortex-eval", "artifacts", normalized.path), "utf8")
    ) as unknown;
    expect(rawJson).toMatchObject({
      promptfooVersion: "0.121.18",
      exitCode: 100,
      evaluationContextHash: EVALUATION_CONTEXT_HASH
    });
    expect(normalizedJson).toMatchObject({
      resultSetHash: evalResultSetHash,
      evaluationContextHash: EVALUATION_CONTEXT_HASH,
      cases: [{ caseKey: "case-1", ordinal: 0, status: "PASS" }]
    });
    await expect(
      store.inspect({
        contractVersion: "cortex.artifact-manifest.v1",
        owner: { kind: "RUN", id: RUN_ID },
        artifacts: [raw, normalized]
      })
    ).resolves.toMatchObject([{ status: "PRESENT" }, { status: "PRESENT" }]);
  });

  it("拒绝乱序或重复 Case Key 的 Normalized Evaluation 流且不提交 Artifact", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-eval-normalized-order-"));
    roots.push(projectRoot);
    const store = await LocalRunArtifactStore.create({ projectRoot, nonce: () => "invalid" });
    const orderedResultSetHash = hashEvalResultSet({
      contractVersion: "cortex.eval-result-set.v1",
      owner: { kind: "RUN", id: RUN_ID },
      evaluationContextHash: EVALUATION_CONTEXT_HASH,
      cases: [EVAL_RESULT, SECOND_EVAL_RESULT].map((item) => ({
        caseKey: item.caseKey,
        ordinal: item.ordinal,
        evalResultHash: item.evalResultHash
      }))
    });
    const duplicateCaseKey = { ...SECOND_EVAL_RESULT, caseKey: EVAL_RESULT.caseKey };
    const inputs: PlatformNormalizedEvalArtifactInput[] = [
      {
        runId: RUN_ID,
        runContextHash: "a".repeat(64),
        evaluationContextHash: EVALUATION_CONTEXT_HASH,
        completedAt: NOW,
        expectedTotal: 2,
        resultSetHash: orderedResultSetHash,
        cases: streamEvalCases([SECOND_EVAL_RESULT, EVAL_RESULT])
      },
      {
        runId: RUN_ID,
        runContextHash: "a".repeat(64),
        evaluationContextHash: EVALUATION_CONTEXT_HASH,
        completedAt: NOW,
        expectedTotal: 2,
        resultSetHash: "9".repeat(64),
        cases: streamEvalCases([EVAL_RESULT, duplicateCaseKey])
      }
    ];

    for (const input of inputs) {
      await expect(store.writeNormalizedEvalResults(input)).rejects.toMatchObject({
        code: "ARTIFACT_WRITE_FAILED"
      });
      const runRoot = join(projectRoot, ".cortex-eval", "artifacts", "runs", RUN_ID);
      await expect(lstat(join(runRoot, ".normalized-eval.invalid.tmp"))).rejects.toMatchObject({
        code: "ENOENT"
      });
      await expect(lstat(join(runRoot, "normalized-eval.json"))).rejects.toMatchObject({
        code: "ENOENT"
      });
    }
  });

  it("逐 Case 流式写入并在同一遍生成结果集 Hash，不要求完整结果数组驻留内存", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-artifacts-"));
    roots.push(projectRoot);
    const store = await LocalRunArtifactStore.create({ projectRoot });
    let yielded = 0;
    const cases = async function* (): AsyncGenerator<StoredRestCaseResult> {
      for (const item of [CASE_RESULT]) {
        yielded += 1;
        yield await Promise.resolve(item);
      }
    };

    const written = await store.writeRestResults({
      runId: RUN_ID,
      runContextHash: "a".repeat(64),
      completedAt: NOW,
      expectedTotal: 1,
      cases: cases()
    });

    expect(yielded).toBe(1);
    expect(written.resultSetHash).toBe(
      hashRestResultSet({
        contractVersion: "cortex.rest-result-set.v1",
        cases: [
          {
            caseKey: CASE_RESULT.caseKey,
            ordinal: CASE_RESULT.ordinal,
            resultHash: CASE_RESULT.resultHash
          }
        ]
      })
    );
    const bytes = await readFile(
      join(projectRoot, ".cortex-eval", "artifacts", written.descriptor.path),
      "utf8"
    );
    expect(JSON.parse(bytes)).toMatchObject({
      resultSetHash: written.resultSetHash,
      cases: [{ caseKey: "case-1", ordinal: 0 }]
    });
  });

  it("把 REST 复用来源写入不可变 Artifact", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-artifacts-provenance-"));
    roots.push(projectRoot);
    const store = await LocalRunArtifactStore.create({ projectRoot });
    const sourceId = "01900000-0000-7000-8000-000000000002";
    const reusedResult: StoredRestCaseResult = {
      ...CASE_RESULT,
      provenance: {
        sourceKind: "RUN",
        sourceId,
        sourceResultHash: CASE_RESULT.resultHash
      }
    };

    const written = await store.writeRestResults({
      ...artifactInput(),
      cases: streamCases([reusedResult])
    });
    const bytes = await readFile(
      join(projectRoot, ".cortex-eval", "artifacts", written.descriptor.path),
      "utf8"
    );

    expect(JSON.parse(bytes)).toMatchObject({
      cases: [
        {
          provenance: {
            sourceKind: "RUN",
            sourceId,
            sourceResultHash: CASE_RESULT.resultHash
          }
        }
      ]
    });
  });

  it("拒绝结果流少项、多项、跨 Run 或单项契约损坏并清理临时文件", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-artifacts-"));
    roots.push(projectRoot);
    const store = await LocalRunArtifactStore.create({ projectRoot, nonce: () => "invalid" });
    const wrongRun = { ...CASE_RESULT, runId: "01900000-0000-7000-8000-000000000002" };
    const invalidResult = { ...CASE_RESULT, resultHash: "invalid" };
    const inputs: PlatformRestArtifactInput[] = [
      { ...artifactInput(), cases: streamCases([]) },
      { ...artifactInput(), cases: streamCases([CASE_RESULT, CASE_RESULT]) },
      { ...artifactInput(), cases: streamCases([wrongRun]) },
      { ...artifactInput(), cases: streamCases([invalidResult]) }
    ];

    for (const input of inputs) {
      await expect(store.writeRestResults(input)).rejects.toMatchObject({
        code: "ARTIFACT_WRITE_FAILED"
      });
      const runRoot = join(projectRoot, ".cortex-eval", "artifacts", "runs", RUN_ID);
      await expect(lstat(join(runRoot, ".rest-results.invalid.tmp"))).rejects.toMatchObject({
        code: "ENOENT"
      });
    }
  });

  it("在创建文件前拒绝无效 Owner、Hash、时间与结果总数", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-artifacts-"));
    roots.push(projectRoot);
    const store = await LocalRunArtifactStore.create({ projectRoot });
    const inputs: PlatformRestArtifactInput[] = [
      { ...artifactInput(), runId: "invalid" },
      { ...artifactInput(), runContextHash: "invalid" },
      { ...artifactInput(), completedAt: "2026-07-13" },
      { ...artifactInput(), expectedTotal: 0 },
      { ...artifactInput(), expectedTotal: 1.5 }
    ];

    for (const input of inputs) {
      await expect(store.writeRestResults(input)).rejects.toMatchObject({
        code: "ARTIFACT_WRITE_FAILED"
      });
    }
  });

  it("以 canonical JSON、单个 LF 和 owner-only 权限原子提交且拒绝覆盖", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-artifacts-"));
    roots.push(projectRoot);
    const store = await LocalRunArtifactStore.create({
      projectRoot,
      nonce: () => "nonce-1"
    });
    const written = await store.writeRestResults(artifactInput());
    const { descriptor } = written;
    const path = join(projectRoot, ".cortex-eval", "artifacts", descriptor.path);
    const bytes = await readFile(path);
    expect(bytes.toString("utf8")).toMatch(/^\{"cases":.+\}\n$/);
    expect(bytes.toString("utf8").endsWith("\n\n")).toBe(false);
    expect(descriptor).toMatchObject({
      kind: "REST_RESULTS",
      path: `runs/${RUN_ID}/rest-results.json`,
      expectedSizeBytes: bytes.byteLength,
      contractVersion: "cortex.platform-rest-results.v1"
    });
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect(
      (await lstat(join(projectRoot, ".cortex-eval", "artifacts", "runs", RUN_ID))).mode & 0o777
    ).toBe(0o700);
    await expect(store.writeRestResults(artifactInput())).rejects.toMatchObject({
      code: "ARTIFACT_WRITE_FAILED"
    });
  });

  it("区分 PRESENT、CORRUPTED、MISSING，不改变 Manifest 事实", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-artifacts-"));
    roots.push(projectRoot);
    const store = await LocalRunArtifactStore.create({ projectRoot });
    const written = await store.writeRestResults(artifactInput());
    const { descriptor } = written;
    const manifest = {
      contractVersion: "cortex.artifact-manifest.v1" as const,
      owner: { kind: "RUN" as const, id: RUN_ID },
      artifacts: [descriptor]
    };
    await expect(store.inspect(manifest)).resolves.toMatchObject([{ status: "PRESENT" }]);
    await expect(
      store.inspect({
        ...manifest,
        owner: { kind: "RUN", id: "01900000-0000-7000-8000-000000000002" }
      })
    ).resolves.toMatchObject([{ status: "CORRUPTED" }]);
    const path = join(projectRoot, ".cortex-eval", "artifacts", descriptor.path);
    const original = await readFile(path);
    const replacement = Buffer.from(original);
    await unlink(path);
    await writeFile(path, replacement, { mode: 0o600 });
    await expect(store.inspect(manifest)).resolves.toMatchObject([{ status: "PRESENT" }]);
    await expect(store.removeUncommitted(written)).rejects.toMatchObject({
      code: "ARTIFACT_WRITE_FAILED"
    });
    await expect(readFile(path)).resolves.toEqual(replacement);
  });

  it("只按完整 Descriptor 删除未提交 Artifact，并对缺失文件幂等", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-artifacts-"));
    roots.push(projectRoot);
    const store = await LocalRunArtifactStore.create({ projectRoot });
    const written = await store.writeRestResults(artifactInput());
    const { descriptor } = written;
    const path = join(projectRoot, ".cortex-eval", "artifacts", descriptor.path);

    await expect(store.removeUncommitted(written)).resolves.toBeUndefined();
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.removeUncommitted(written)).resolves.toBeUndefined();
  });

  it("拒绝清理不属于对应 Artifact kind 固定槽位的 Descriptor", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-artifacts-"));
    roots.push(projectRoot);
    const store = await LocalRunArtifactStore.create({ projectRoot });
    const written = await store.writeRestResults(artifactInput());
    const { descriptor } = written;

    await expect(
      store.removeUncommitted({
        ...written,
        descriptor: {
          ...descriptor,
          path: `runs/${RUN_ID}/promptfoo-raw.json`
        }
      })
    ).rejects.toMatchObject({ code: "ARTIFACT_WRITE_FAILED" });
    await expect(
      store.removeUncommitted({
        ...written,
        descriptor: {
          ...descriptor,
          path: "outside/rest-results.json"
        }
      })
    ).rejects.toMatchObject({ code: "ARTIFACT_WRITE_FAILED" });
  });

  it("启动发现缺少发布身份的 orphan 时保留文件并报告", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-artifacts-"));
    roots.push(projectRoot);
    const cleanupFailures: string[] = [];
    const store = await LocalRunArtifactStore.create({
      projectRoot,
      onCleanupFailure: (code): void => {
        cleanupFailures.push(code);
      }
    });
    const { descriptor } = await store.writeRestResults(artifactInput());
    await store.cleanupOrphans([]);
    const path = join(projectRoot, ".cortex-eval", "artifacts", descriptor.path);
    await expect(lstat(path)).resolves.toMatchObject({ size: descriptor.expectedSizeBytes });
    expect(cleanupFailures).toEqual(["RUN_ARTIFACT_CLEANUP_FAILED"]);
  });
});
