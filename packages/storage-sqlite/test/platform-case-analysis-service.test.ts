import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AnalysisModelClient } from "@cortex-eval/application/src/features/case-analysis/case-analysis-model-client.ts";
import {
  PlatformCaseAnalysisService,
  type PlatformAnalysisReportSource
} from "@cortex-eval/application/src/features/case-analysis/platform-case-analysis-service.ts";
import type { PlatformReportOverview } from "@cortex-eval/application/src/features/reporting/platform-report-service.ts";
import type { PlatformRun } from "@cortex-eval/application/src/features/runs/platform-run-models.ts";
import type { PlatformReportArtifactCaseInput } from "@cortex-eval/application/src/features/runs/run-artifact-port.ts";
import { hashLlmConfig, hashPrompt } from "@cortex-eval/domain/src/domain-resource-hashes.ts";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { initializeSqliteStorage, type SqliteStorage } from "../src/sqlite-database.ts";

const RUN_ID = "01900000-0000-7000-8000-000000000001";
const ANALYZER_ID = "01900000-0000-7000-8000-000000000002";
const PROMPT_ID = "01900000-0000-7000-8000-000000000003";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const NOW = "2026-07-15T02:00:00.000Z";
const storages: SqliteStorage[] = [];
const ANALYZER_DEFINITION = {
  providerType: "OPENAI_COMPATIBLE" as const,
  model: "analyzer",
  thinkingLevel: "OFF" as const,
  temperature: 0,
  topP: 1,
  maxOutputTokens: 256,
  timeoutMs: 1_000,
  structuredOutput: "JSON_OBJECT" as const,
  baseUrl: "http://127.0.0.1:8080/v1",
  auth: { kind: "NONE" as const }
};
const PROMPT_DEFINITION = {
  kind: "CASE_ANALYSIS" as const,
  promptKey: "analysis",
  messages: [{ role: "USER" as const, content: "{{case_definition}}" }]
};
const ANALYZER_HASH = hashLlmConfig({
  contractVersion: "cortex.llm-config.v1",
  config: ANALYZER_DEFINITION
});
const PROMPT_HASH = hashPrompt({
  contractVersion: "cortex.prompt.v1",
  kind: PROMPT_DEFINITION.kind,
  promptKey: PROMPT_DEFINITION.promptKey,
  messages: PROMPT_DEFINITION.messages
});

afterEach(async () => {
  await Promise.all(storages.splice(0).map(async (storage) => storage.close()));
});

function caseInput(): PlatformReportArtifactCaseInput {
  return {
    testCase: {
      caseKey: "case-1",
      ordinal: 0,
      definitionHash: HASH_A,
      definition: {
        caseKey: "case-1",
        description: "失败 Case",
        threshold: 1,
        task: "reply",
        requestBody: { text: "hello" },
        metadata: {
          requestId: "req-1",
          taskId: "task-1",
          businessModule: "support",
          scenarioTag: "reply"
        },
        assertions: [{ type: "equals", metric: "quality", weight: 1, value: "ok" }]
      }
    },
    rest: {
      runId: RUN_ID,
      caseKey: "case-1",
      ordinal: 0,
      definition: {
        caseKey: "case-1",
        description: "失败 Case",
        threshold: 1,
        task: "reply",
        requestBody: { text: "hello" },
        metadata: {
          requestId: "req-1",
          taskId: "task-1",
          businessModule: "support",
          scenarioTag: "reply"
        },
        assertions: [{ type: "equals", metric: "quality", weight: 1, value: "ok" }]
      },
      caseDefinitionHash: HASH_A,
      status: "SUCCEEDED",
      httpStatus: 200,
      providerOutput: {
        ok: true,
        taskName: "reply",
        resolvedConfig: {},
        parsedOutput: { answer: "wrong" }
      },
      errorType: null,
      errorMessage: null,
      durationMs: 5,
      completedAt: NOW,
      resultHash: HASH_B,
      provenance: null
    },
    evaluation: {
      runId: RUN_ID,
      caseKey: "case-1",
      ordinal: 0,
      status: "FAIL",
      promptfooSuccess: false,
      score: 0,
      reason: "不相等",
      evaluationError: null,
      assertions: [
        {
          index: 0,
          definitionHash: HASH_A,
          type: "equals",
          metric: "quality",
          weight: 1,
          status: "FAIL",
          score: 0,
          reason: "不相等"
        }
      ],
      diffs: [],
      metrics: [{ metric: "quality", status: "FAIL" }],
      latencyMs: 3,
      tokenUsage: null,
      cost: null,
      rawEvidence: null,
      evalResultHash: HASH_B,
      finalCaseResultHash: HASH_C,
      provenance: null,
      createdAt: NOW,
      updatedAt: NOW
    }
  };
}

function reportedRun(): PlatformRun {
  const testCase = caseInput().testCase;
  return {
    id: RUN_ID,
    sourceType: "PLATFORM",
    sourceRunId: null,
    rerunMode: "NONE",
    suite: { id: "suite-1", name: "Suite", suiteHash: HASH_A, cases: [testCase] },
    endpoint: {
      sourceId: null,
      name: "Endpoint",
      configHash: HASH_A,
      definition: {
        urlTemplate: "https://example.test",
        method: "POST",
        headers: {},
        bodySelector: "/",
        timeoutMs: 1_000,
        defaultConcurrency: 1
      }
    },
    evaluator: {
      sourceId: null,
      name: "Evaluator",
      configHash: HASH_A,
      definition: {
        providerType: "OPENAI_COMPATIBLE",
        model: "evaluator",
        thinkingLevel: "OFF",
        temperature: 0,
        topP: 1,
        maxOutputTokens: 256,
        timeoutMs: 1_000,
        structuredOutput: "JSON_OBJECT",
        baseUrl: "http://127.0.0.1:8080/v1",
        auth: { kind: "NONE" }
      }
    },
    rubricPrompts: [],
    runContextHash: HASH_A,
    promptfooVersion: "0.121.18",
    contractVersions: {
      runSnapshot: "cortex.run-snapshot.v1",
      caseDefinition: "cortex.case-definition.v1",
      platformRestResults: "cortex.platform-rest-results.v1"
    },
    runExecutionLimits: {
      contractVersion: "cortex.run-execution-limits.v1",
      restConcurrency: 1,
      evalConcurrency: 1
    },
    runMode: "STAGED",
    status: "COMPLETED",
    stage: "DONE",
    lockRevision: 5,
    cancelRequestedAt: null,
    restCompletedCount: 1,
    restErrorCount: 0,
    evalCompletedCount: 1,
    evalPassCount: 0,
    evalFailCount: 1,
    evalErrorCount: 0,
    evalNotEvaluatedCount: 0,
    resultSetHash: HASH_A,
    evaluationContextHash: HASH_B,
    evaluationResultSetHash: HASH_C,
    reportResultSetHash: HASH_B,
    reportSummary: {
      summary: {
        total: 1,
        restSucceeded: 1,
        restError: 0,
        evalPass: 0,
        evalFail: 1,
        evalError: 0,
        notEvaluated: 0,
        effectivePassRate: 0,
        evaluatedPassRate: 0,
        coverageRate: 1
      },
      byMetric: [
        {
          metric: "quality",
          pass: 0,
          fail: 1,
          error: 0,
          skipped: 0,
          notEvaluated: 0,
          passRate: 0
        }
      ]
    },
    artifactManifest: {
      contractVersion: "cortex.artifact-manifest.v1",
      owner: { kind: "RUN", id: RUN_ID },
      artifacts: []
    },
    errorCode: null,
    errorMessage: null,
    startedAt: NOW,
    completedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW
  };
}

function reportSource(): PlatformAnalysisReportSource {
  const run = reportedRun();
  if (run.reportSummary === null) throw new Error("TEST_REPORT_SUMMARY_MISSING");
  const overview: PlatformReportOverview = {
    run,
    report: run.reportSummary,
    artifactAvailability: []
  };
  return {
    get: (runId) => Promise.resolve(runId === RUN_ID ? overview : null),
    streamCases: async function* (runId): AsyncGenerator<PlatformReportArtifactCaseInput> {
      await Promise.resolve();
      if (runId === RUN_ID) yield caseInput();
    }
  };
}

function sourceFor(
  run: PlatformRun,
  input: PlatformReportArtifactCaseInput = caseInput()
): PlatformAnalysisReportSource {
  if (run.reportSummary === null) throw new Error("TEST_REPORT_SUMMARY_MISSING");
  const overview: PlatformReportOverview = {
    run,
    report: run.reportSummary,
    artifactAvailability: []
  };
  return {
    get: (runId) => Promise.resolve(runId === run.id ? overview : null),
    streamCases: async function* (runId): AsyncGenerator<PlatformReportArtifactCaseInput> {
      await Promise.resolve();
      if (runId === run.id) yield input;
    }
  };
}

function seedAnalyzableRun(databasePath: string): void {
  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  database
    .prepare(
      `INSERT INTO run_log (
        id, source_type, source_package_id, execution_id, source_run_id, rerun_mode,
        suite_snapshot_json, endpoint_snapshot_json, evaluator_snapshot_json,
        rubric_prompts_snapshot_json, run_context_hash, promptfoo_version,
        contract_versions_json, run_execution_limits_json, run_mode, status, stage,
        rest_completed_count, rest_error_count, eval_completed_count, eval_fail_count,
        summary_json, result_set_hash, report_result_set_hash, artifact_manifest_json,
        completed_at, created_at, updated_at
      ) VALUES (?, 'PLATFORM', NULL, NULL, NULL, 'NONE', '{}', '{}', '{}', '[]', ?,
        '0.121.18', '{}', '{}', 'STAGED', 'COMPLETED', 'DONE', 1, 0, 1, 1,
        '{}', ?, ?, ?, ?, ?, ?)`
    )
    .run(
      RUN_ID,
      HASH_A,
      HASH_A,
      HASH_B,
      JSON.stringify({
        contractVersion: "cortex.artifact-manifest.v1",
        owner: { kind: "RUN", id: RUN_ID },
        artifacts: []
      }),
      NOW,
      NOW,
      NOW
    );
  database
    .prepare(
      `INSERT INTO case_result (
        run_id, case_key, ordinal, case_definition_json, case_definition_hash,
        rest_status, http_status, provider_output_json, duration_ms, error_type,
        error_message, completed_at, run_result_hash
      ) VALUES (?, 'case-1', 0, '{}', ?, 'SUCCEEDED', 200,
        '{"ok":true,"taskName":"reply","resolvedConfig":{},"parsedOutput":{}}',
        1, NULL, NULL, ?, ?)`
    )
    .run(RUN_ID, HASH_A, NOW, HASH_B);
  database
    .prepare(
      `INSERT INTO eval_result (
        run_id, case_key, eval_status, promptfoo_success, score, reason, evaluation_error,
        assertion_results_json, expected_actual_diffs_json, metric_results_json,
        allowlist_raw_evidence_json, eval_result_hash, final_case_result_hash, created_at, updated_at
      ) VALUES (?, 'case-1', 'FAIL', 0, 0, 'failed', NULL, '[]', '[]', '[]',
        'null', ?, ?, ?, ?)`
    )
    .run(RUN_ID, HASH_B, HASH_C, NOW, NOW);
  database.close();
}

async function seedResources(storage: SqliteStorage): Promise<void> {
  await storage.createTransactionManager().execute(async (transaction) => {
    await transaction.configurations.insertResource({
      id: ANALYZER_ID,
      kind: "LLM",
      name: "Analyzer",
      semanticHash: ANALYZER_HASH,
      revision: 0,
      definition: ANALYZER_DEFINITION,
      createdAt: NOW,
      updatedAt: NOW
    });
    await transaction.configurations.insertResource({
      id: PROMPT_ID,
      kind: "CASE_ANALYSIS_PROMPT",
      name: "Analysis Prompt",
      semanticHash: PROMPT_HASH,
      revision: 0,
      definition: PROMPT_DEFINITION,
      createdAt: NOW,
      updatedAt: NOW
    });
  });
}

function command(): Parameters<PlatformCaseAnalysisService["start"]>[0] {
  return {
    runId: RUN_ID,
    analyzerConfigId: ANALYZER_ID,
    analysisPromptId: PROMPT_ID,
    selector: "failed",
    analysisExecutionLimits: {
      contractVersion: "cortex.analysis-execution-limits.v1",
      analysisConcurrency: 1
    },
    signal: new AbortController().signal
  };
}

function modelOutput(): Awaited<ReturnType<AnalysisModelClient["analyze"]>> {
  return {
    classification: "NORMAL_FAILURE",
    confidence: 0.9,
    evidence: [
      {
        source: "failed_assertions",
        fieldPath: "/0",
        conclusion: "quality 断言失败"
      }
    ],
    explanation: "实际输出不满足冻结断言",
    recommendedAction: "修复被测系统"
  };
}

function createService(
  storage: SqliteStorage,
  reports: PlatformAnalysisReportSource,
  modelClient: AnalysisModelClient
): PlatformCaseAnalysisService {
  let nextId = 200;
  return new PlatformCaseAnalysisService({
    transactionManager: storage.createAnalysisTransactionManager(),
    reports,
    modelClient,
    idGenerator: {
      nextId: (): string => `01900000-0000-7000-8000-${String(nextId++).padStart(12, "0")}`
    },
    clock: { now: (): string => NOW },
    errorMessage: (code): string => code
  });
}

describe("Platform Case Analysis Service", () => {
  it("并发重分析只返回当前状态冲突，不恢复或覆盖首个正在运行的版本", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-platform-analysis-"));
    const storage = await initializeSqliteStorage({ projectRoot });
    storages.push(storage);
    seedAnalyzableRun(storage.databasePath);
    await seedResources(storage);

    let releaseModel = (): void => undefined;
    let announceModel = (): void => undefined;
    const modelStarted = new Promise<void>((resolve) => {
      announceModel = resolve;
    });
    const modelReleased = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    const modelClient: AnalysisModelClient = {
      analyze: async () => {
        announceModel();
        await modelReleased;
        return {
          classification: "NORMAL_FAILURE",
          confidence: 0.9,
          evidence: [
            {
              source: "failed_assertions",
              fieldPath: "/0",
              conclusion: "quality 断言失败"
            }
          ],
          explanation: "实际输出不满足冻结断言",
          recommendedAction: "修复被测系统"
        };
      }
    };
    let nextId = 100;
    const service = new PlatformCaseAnalysisService({
      transactionManager: storage.createAnalysisTransactionManager(),
      reports: reportSource(),
      modelClient,
      idGenerator: {
        nextId: (): string => `01900000-0000-7000-8000-${String(nextId++).padStart(12, "0")}`
      },
      clock: { now: (): string => NOW },
      errorMessage: (code): string => code
    });

    const first = service.start(command());
    await modelStarted;
    await expect(service.start(command())).resolves.toEqual({
      ok: false,
      error: { code: "ANALYSIS_STATE_CONFLICT" }
    });
    await expect(service.getCurrent(RUN_ID, "case-1")).resolves.toMatchObject({
      status: "RUNNING",
      revision: 2
    });

    releaseModel();
    await expect(first).resolves.toMatchObject({
      ok: true,
      selectedCount: 1,
      succeededCount: 1,
      errorCount: 0
    });
    await expect(service.getCurrent(RUN_ID, "case-1")).resolves.toMatchObject({
      status: "SUCCEEDED",
      revision: 3,
      output: {
        evidence: [
          {
            source: "failed_assertions",
            fieldPath: "/0",
            conclusion: "quality 断言失败"
          }
        ]
      }
    });
  });

  it("在模型副作用前拒绝取消、缺失 Run、未闭合 Report 与缺失配置", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-platform-analysis-"));
    const storage = await initializeSqliteStorage({ projectRoot });
    storages.push(storage);
    seedAnalyzableRun(storage.databasePath);
    const modelClient: AnalysisModelClient = { analyze: () => Promise.resolve(modelOutput()) };
    const service = createService(storage, reportSource(), modelClient);

    const aborted = new AbortController();
    aborted.abort();
    await expect(service.start({ ...command(), signal: aborted.signal })).rejects.toThrow(
      "REQUEST_ABORTED"
    );
    await expect(
      service.start({ ...command(), runId: "01900000-0000-7000-8000-000000000099" })
    ).resolves.toEqual({ ok: false, error: { code: "RUN_NOT_FOUND" } });

    const unreconciled = createService(
      storage,
      sourceFor({ ...reportedRun(), reportResultSetHash: null }),
      modelClient
    );
    await expect(unreconciled.start(command())).resolves.toEqual({
      ok: false,
      error: { code: "REPORT_RECONCILIATION_FAILED" }
    });
    await expect(service.start(command())).resolves.toEqual({
      ok: false,
      error: { code: "CONFIGURATION_NOT_FOUND" }
    });

    await seedResources(storage);
    await expect(service.start({ ...command(), selector: "errors" })).resolves.toMatchObject({
      ok: true,
      selectedCount: 0,
      succeededCount: 0,
      errorCount: 0
    });
    await expect(service.getCurrent(RUN_ID, "case-1")).resolves.toBeNull();
  });

  it("将模型错误隔离为版本化 Case Error，并允许后续重分析保存 Proposal", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-platform-analysis-"));
    const storage = await initializeSqliteStorage({ projectRoot });
    storages.push(storage);
    seedAnalyzableRun(storage.databasePath);
    await seedResources(storage);

    const errorService = createService(storage, reportSource(), {
      analyze: () =>
        Promise.reject(
          Object.assign(new Error("MODEL_OUTPUT_INVALID"), { code: "ANALYZER_OUTPUT_INVALID" })
        )
    });
    await expect(errorService.start(command())).resolves.toMatchObject({
      ok: true,
      selectedCount: 1,
      succeededCount: 0,
      errorCount: 1
    });
    await expect(errorService.getCurrent(RUN_ID, "case-1")).resolves.toMatchObject({
      status: "ERROR",
      revision: 3,
      errorCode: "ANALYZER_OUTPUT_INVALID",
      errorMessage: "ANALYZER_OUTPUT_INVALID"
    });

    const proposalService = createService(storage, reportSource(), {
      analyze: () =>
        Promise.resolve({
          ...modelOutput(),
          proposal: {
            action: "ADD_ASSERTION",
            baseDefinitionHash: HASH_A,
            targetAssertionIndex: 1,
            assertion: { type: "equals", metric: "quality", weight: 1, value: "alternative" }
          }
        })
    });
    await expect(proposalService.start(command())).resolves.toMatchObject({
      ok: true,
      selectedCount: 1,
      succeededCount: 1,
      errorCount: 0
    });
    await expect(proposalService.getCurrent(RUN_ID, "case-1")).resolves.toMatchObject({
      status: "SUCCEEDED",
      revision: 6,
      decision: "PENDING",
      applyStatus: "NOT_APPLIED",
      output: {
        proposal: { action: "ADD_ASSERTION", targetAssertionIndex: 1 }
      }
    });
  });

  it("把 REST 错误映射为结构化 Provider Output 后交给 Analyzer", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-platform-analysis-"));
    const storage = await initializeSqliteStorage({ projectRoot });
    storages.push(storage);
    seedAnalyzableRun(storage.databasePath);
    await seedResources(storage);
    const base = caseInput();
    const sourceCase: PlatformReportArtifactCaseInput = {
      ...base,
      rest: {
        ...base.rest,
        status: "ERROR",
        httpStatus: null,
        providerOutput: null,
        errorType: "NETWORK",
        errorMessage: "连接失败"
      }
    };
    let observedProviderOutput: Readonly<Record<string, unknown>> | null = null;
    const service = createService(storage, sourceFor(reportedRun(), sourceCase), {
      analyze: (request) => {
        observedProviderOutput = request.variables.provider_output;
        return Promise.resolve(modelOutput());
      }
    });

    await expect(service.start(command())).resolves.toMatchObject({
      ok: true,
      selectedCount: 1,
      succeededCount: 1
    });
    expect(observedProviderOutput).toEqual({ ok: false, errorMessage: "连接失败" });
  });

  it("取消运行时只把本请求已认领的 Analysis 恢复为稳定错误", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-platform-analysis-"));
    const storage = await initializeSqliteStorage({ projectRoot });
    storages.push(storage);
    seedAnalyzableRun(storage.databasePath);
    await seedResources(storage);
    let announceModel = (): void => undefined;
    let releaseModel = (): void => undefined;
    const modelStarted = new Promise<void>((resolve) => {
      announceModel = resolve;
    });
    const modelReleased = new Promise<ReturnType<typeof modelOutput>>((resolve) => {
      releaseModel = (): void => resolve(modelOutput());
    });
    const service = createService(storage, reportSource(), {
      analyze: () => {
        announceModel();
        return modelReleased;
      }
    });
    const controller = new AbortController();
    const running = service.start({ ...command(), signal: controller.signal });
    await modelStarted;
    controller.abort();
    releaseModel();

    await expect(running).rejects.toMatchObject({ code: "ANALYSIS_CANCELLED" });
    await expect(service.getCurrent(RUN_ID, "case-1")).resolves.toMatchObject({
      status: "ERROR",
      revision: 3,
      errorCode: "ANALYSIS_STAGE_FAILED",
      errorMessage: "ANALYSIS_STAGE_FAILED"
    });
  });
});
