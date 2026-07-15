import {
  platformRunDetail,
  platformRunProgress,
  type PlatformRun,
  type PlatformRunSummary,
  type StoredRestCaseResult
} from "@cortex-eval/application/src/features/runs/platform-run-models.ts";
import type { PlatformEvalCaseResult } from "@cortex-eval/application/src/features/evaluation/platform-eval-models.ts";
import type { PlatformReportCase } from "@cortex-eval/application/src/features/reporting/platform-report-service.ts";
import type { PlatformReportArtifactCaseInput } from "@cortex-eval/application/src/features/runs/run-artifact-port.ts";
import type { ImportedReportRun } from "@cortex-eval/application/src/features/execution-imports/execution-import-models.ts";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import {
  createApplicationRunHandlers,
  type ApplicationRunServiceBoundary
} from "../src/application-run-handlers.ts";
import type { LocalApiHandlerInput } from "../src/local-server.ts";
import {
  importedReportRunFixture,
  passingEvaluationFixture,
  reportCaseFixture,
  reportedRunFixture
} from "../test-support/application-report-handler-fixtures.ts";

const RUN_ID = "01900000-0000-7000-8000-000000000001";
const SOURCE_RUN_ID = "01900000-0000-7000-8000-000000000002";
const SUITE_ID = "01900000-0000-7000-8000-000000000100";
const ENDPOINT_ID = "01900000-0000-7000-8000-000000000200";
const EVALUATOR_ID = "01900000-0000-7000-8000-000000000300";
const NOW = "2026-07-13T00:00:00.000Z";
const HASH = "a".repeat(64);

function run(): PlatformRun {
  return {
    id: RUN_ID,
    sourceType: "PLATFORM",
    sourceRunId: null,
    rerunMode: "NONE",
    suite: {
      id: SUITE_ID,
      name: "Suite",
      suiteHash: HASH,
      cases: [
        {
          caseKey: "case-1",
          ordinal: 0,
          definitionHash: HASH,
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
          }
        }
      ]
    },
    endpoint: {
      sourceId: ENDPOINT_ID,
      name: "Endpoint",
      configHash: HASH,
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
      sourceId: EVALUATOR_ID,
      name: "Evaluator",
      configHash: HASH,
      definition: {
        providerType: "GOOGLE_GEMINI",
        apiKey: { kind: "ENV_SECRET", envKey: "GEMINI_API_KEY" },
        model: "gemini-test",
        thinkingLevel: "OFF",
        temperature: 0,
        topP: 1,
        maxOutputTokens: 1_024,
        timeoutMs: 60_000,
        structuredOutput: "JSON_SCHEMA"
      }
    },
    rubricPrompts: [
      {
        sourceId: "01900000-0000-7000-8000-000000000400",
        name: "Quality",
        promptHash: HASH,
        definition: {
          kind: "LLM_RUBRIC",
          promptKey: "quality",
          messages: [{ role: "SYSTEM", content: "secret prompt body" }]
        }
      }
    ],
    runContextHash: HASH,
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
    status: "READY",
    stage: "EVALUATION",
    lockRevision: 3,
    cancelRequestedAt: null,
    restCompletedCount: 1,
    restErrorCount: 0,
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
      owner: { kind: "RUN", id: RUN_ID },
      artifacts: [
        {
          kind: "REST_RESULTS",
          path: `runs/${RUN_ID}/rest-results.json`,
          expectedSha256: HASH,
          expectedSizeBytes: 100,
          contractVersion: "cortex.platform-rest-results.v1"
        }
      ]
    },
    errorCode: null,
    errorMessage: null,
    startedAt: NOW,
    completedAt: null,
    createdAt: NOW,
    updatedAt: NOW
  };
}

// Build one valid small Run list projection.
function runSummary(): PlatformRunSummary {
  return {
    id: RUN_ID,
    sourceType: "PLATFORM",
    suiteId: SUITE_ID,
    suiteName: "Suite",
    runMode: "STAGED",
    status: "READY",
    stage: "EVALUATION",
    lockRevision: 3,
    cancelRequestedAt: null,
    restTotalCount: 2,
    restCompletedCount: 2,
    restErrorCount: 1,
    evalCompletedCount: 0,
    evalPassCount: 0,
    evalFailCount: 0,
    evalErrorCount: 0,
    evalNotEvaluatedCount: 0,
    createdAt: NOW,
    updatedAt: NOW
  };
}

// Build one durable REST success for transport projection tests.
function successfulResult(businessSuccess: boolean): StoredRestCaseResult {
  const frozen = run().suite.cases[0];
  if (frozen === undefined) throw new Error("TEST_FROZEN_CASE_MISSING");
  return {
    runId: RUN_ID,
    caseKey: frozen.caseKey,
    ordinal: frozen.ordinal,
    definition: frozen.definition,
    caseDefinitionHash: frozen.definitionHash,
    status: "SUCCEEDED",
    httpStatus: 200,
    providerOutput: businessSuccess
      ? {
          ok: true,
          taskName: "route",
          resolvedConfig: { model: "local" },
          parsedOutput: { answer: "ok" }
        }
      : { ok: false, errorMessage: "business rejected" },
    errorType: null,
    errorMessage: null,
    durationMs: 12,
    completedAt: NOW,
    resultHash: HASH,
    provenance: null
  };
}

// Build one durable REST failure for transport projection tests.
function failedResult(): StoredRestCaseResult {
  const successful = successfulResult(true);
  return {
    runId: successful.runId,
    caseKey: successful.caseKey,
    ordinal: successful.ordinal,
    definition: successful.definition,
    caseDefinitionHash: successful.caseDefinitionHash,
    status: "ERROR",
    httpStatus: 503,
    providerOutput: null,
    errorType: "HTTP_STATUS",
    errorMessage: "REST 请求返回非成功状态。",
    durationMs: successful.durationMs,
    completedAt: successful.completedAt,
    resultHash: successful.resultHash,
    provenance: null
  };
}

// Build the P8 Report fixtures from the shared normalized test boundary.
function passingEvaluation(): PlatformEvalCaseResult {
  return passingEvaluationFixture(RUN_ID, "case-1", HASH, NOW);
}

function reportedRun(): PlatformRun {
  return reportedRunFixture(run(), NOW);
}

function importedReportRun(): ImportedReportRun {
  return importedReportRunFixture({
    current: reportedRun(),
    packageId: SUITE_ID,
    executionId: SOURCE_RUN_ID,
    fallbackHash: HASH,
    fallbackTime: NOW
  });
}

function reportCase(): PlatformReportCase {
  return reportCaseFixture({
    run: reportedRun(),
    rest: successfulResult(true),
    evaluation: passingEvaluation()
  });
}

function input(overrides: Partial<LocalApiHandlerInput> = {}): LocalApiHandlerInput {
  return {
    params: {},
    query: {},
    body: {},
    requestId: "01900000-0000-7000-8000-000000000999",
    signal: new AbortController().signal,
    ...overrides
  };
}

function service(
  overrides: Partial<ApplicationRunServiceBoundary> = {}
): ApplicationRunServiceBoundary {
  return {
    preflight: vi.fn().mockResolvedValue({
      ok: true,
      preflight: {
        suiteId: SUITE_ID,
        endpointConfigId: ENDPOINT_ID,
        evaluatorConfigId: EVALUATOR_ID,
        caseCount: 1,
        rubricPromptKeys: ["quality"],
        requiredEnvKeys: { REST: [], EVALUATION: ["GEMINI_API_KEY"] },
        endpointTimeoutMs: 1_000,
        defaultRunExecutionLimits: {
          contractVersion: "cortex.run-execution-limits.v1",
          restConcurrency: 4,
          evalConcurrency: 2
        }
      }
    }),
    create: vi.fn().mockResolvedValue({ ok: true, run: run() }),
    queryRuns: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    get: vi.fn().mockResolvedValue(platformRunDetail(run())),
    getProgress: vi.fn().mockResolvedValue(platformRunProgress(run())),
    inspectArtifacts: vi
      .fn()
      .mockResolvedValue([{ artifact: run().artifactManifest.artifacts[0], status: "PRESENT" }]),
    queryRestResults: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    getRestResult: vi.fn().mockResolvedValue(null),
    start: vi.fn().mockResolvedValue({ ok: true, run: run() }),
    cancel: vi.fn().mockResolvedValue({ ok: true, run: run() }),
    startEvaluation: vi.fn().mockResolvedValue({ ok: true, run: run() }),
    cancelEvaluation: vi.fn().mockResolvedValue({ ok: true, run: platformRunProgress(run()) }),
    queryEvalResults: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    startReport: vi.fn().mockResolvedValue({ ok: true, run: reportedRun() }),
    cancelReport: vi.fn().mockResolvedValue({ ok: true, run: platformRunProgress(reportedRun()) }),
    getReport: vi.fn().mockResolvedValue(null),
    hasReportRun: vi.fn().mockResolvedValue(true),
    queryReportCases: vi.fn().mockResolvedValue(null),
    getReportCase: vi.fn().mockResolvedValue(null),
    streamReportCases: vi.fn().mockReturnValue(Readable.from([])),
    openReportExport: vi.fn().mockResolvedValue(null),
    createRerun: vi.fn().mockResolvedValue({
      ok: false,
      error: { code: "RUN_NOT_FOUND" }
    }),
    importExecutionReport: vi.fn().mockResolvedValue({
      ok: false,
      error: { code: "EXECUTION_RESULT_CONFLICT", executionId: RUN_ID }
    }),
    importExecutionAnalysis: vi.fn().mockResolvedValue({
      ok: false,
      error: { code: "EXECUTION_RESULT_CONFLICT", executionId: RUN_ID }
    }),
    startCaseAnalysis: vi.fn().mockResolvedValue({
      ok: false,
      error: { code: "RUN_NOT_FOUND" }
    }),
    getCurrentCaseAnalysis: vi.fn().mockResolvedValue(null),
    rejectAnalysisProposal: vi.fn().mockResolvedValue({
      ok: false,
      error: { code: "ANALYSIS_NOT_FOUND" },
      analysis: null
    }),
    acceptAnalysisProposal: vi.fn().mockResolvedValue({
      ok: false,
      error: { code: "ANALYSIS_NOT_FOUND" },
      analysis: null
    }),
    ...overrides
  };
}

describe("Application Run HTTP handlers", () => {
  it("协议边界拒绝无效 Body、Query、Run ID 与 Revision", async () => {
    const handlers = createApplicationRunHandlers(service());
    const invalidRun = input({ params: { runId: "not-a-run" } });
    const invalidBodies = await Promise.all([
      handlers.preflightRun(input({ body: null })),
      handlers.createRun(input({ body: {} })),
      handlers.listRuns(input({ query: { limit: 0 } })),
      handlers.startRun(input({ params: { runId: RUN_ID }, body: { expectedRevision: -1 } })),
      handlers.cancelRun(input({ params: { runId: RUN_ID }, body: null }))
    ]);
    for (const response of invalidBodies) {
      expect(response).toMatchObject({
        statusCode: 400,
        body: { error: { code: "VALIDATION_FAILED" } }
      });
    }
    const invalidIds = await Promise.all([
      handlers.getRun(invalidRun),
      handlers.listRunCases(invalidRun),
      handlers.getRunCase(invalidRun),
      handlers.startRun(invalidRun),
      handlers.cancelRun(invalidRun),
      handlers.getRunProgress(invalidRun)
    ]);
    for (const response of invalidIds) {
      expect(response).toMatchObject({ statusCode: 400, body: { error: { path: "request" } } });
    }
  });

  it("预检成功并完整映射资源、Rubric、环境变量和默认并发", async () => {
    const handlers = createApplicationRunHandlers(service());
    const response = await handlers.preflightRun(
      input({
        body: { suiteId: SUITE_ID, endpointConfigId: ENDPOINT_ID, evaluatorConfigId: EVALUATOR_ID }
      })
    );
    expect(response).toMatchObject({
      statusCode: 200,
      body: {
        caseCount: 1,
        rubricPromptKeys: ["quality"],
        requiredEnvKeys: { EVALUATION: ["GEMINI_API_KEY"] },
        defaultRunExecutionLimits: { restConcurrency: 4, evalConcurrency: 2 }
      }
    });
  });

  it("Application 错误按类型映射 400、404、409 与 422", async () => {
    const selection = {
      suiteId: SUITE_ID,
      endpointConfigId: ENDPOINT_ID,
      evaluatorConfigId: EVALUATOR_ID
    };
    const cases = [
      {
        error: { code: "SUITE_NOT_FOUND" as const },
        expected: { statusCode: 404, code: "SUITE_NOT_FOUND" }
      },
      {
        error: { code: "CONFIGURATION_NOT_FOUND" as const, kind: "ENDPOINT" as const },
        expected: { statusCode: 404, code: "CONFIGURATION_NOT_FOUND" }
      },
      {
        error: { code: "RUN_SUITE_EMPTY" as const },
        expected: { statusCode: 422, code: "RUN_SUITE_EMPTY" }
      },
      {
        error: { code: "RUBRIC_PROMPT_NOT_FOUND" as const, promptKey: "quality" },
        expected: { statusCode: 422, code: "RUBRIC_PROMPT_NOT_FOUND" }
      }
    ];
    for (const item of cases) {
      const handlers = createApplicationRunHandlers(
        service({ preflight: vi.fn().mockResolvedValue({ ok: false, error: item.error }) })
      );
      const response = await handlers.preflightRun(input({ body: selection }));
      expect(response).toMatchObject({
        statusCode: item.expected.statusCode,
        body: { error: { code: item.expected.code } }
      });
    }
    const invalidCreate = createApplicationRunHandlers(
      service({
        create: vi.fn().mockResolvedValue({
          ok: false,
          error: { code: "VALIDATION_FAILED", path: "runExecutionLimits" }
        })
      })
    );
    expect(
      await invalidCreate.createRun(input({ body: { ...selection, runMode: "STAGED" } }))
    ).toMatchObject({ statusCode: 400, body: { error: { path: "runExecutionLimits" } } });
  });

  it("创建 Run 返回有界详情，Artifact 检查缺失时使用空可用性", async () => {
    const handlers = createApplicationRunHandlers(
      service({ inspectArtifacts: vi.fn().mockResolvedValue(null) })
    );
    const response = await handlers.createRun(
      input({
        body: {
          suiteId: SUITE_ID,
          endpointConfigId: ENDPOINT_ID,
          evaluatorConfigId: EVALUATOR_ID,
          runMode: "STAGED"
        }
      })
    );
    expect(response).toMatchObject({
      statusCode: 201,
      body: { id: RUN_ID, artifactAvailability: [] }
    });
  });

  it("Run 列表支持空/有效 Cursor、下一页 Cursor，并拒绝版本和内容错误", async () => {
    const queryRuns = vi.fn().mockResolvedValue({
      items: [runSummary()],
      nextCursor: { createdAt: NOW, id: RUN_ID }
    });
    const handlers = createApplicationRunHandlers(service({ queryRuns }));
    const first = await handlers.listRuns(input({ query: { limit: 1 } }));
    expect(first).toMatchObject({
      statusCode: 200,
      body: {
        items: [
          {
            rest: { total: 2, completed: 2, succeeded: 1, error: 1 },
            evaluation: { total: 2, completed: 0, passed: 0, failed: 0 }
          }
        ]
      }
    });
    const cursor = (first.body as { readonly nextCursor: string }).nextCursor;
    const second = await handlers.listRuns(input({ query: { limit: 1, cursor } }));
    expect(second.statusCode).toBe(200);
    expect(queryRuns).toHaveBeenLastCalledWith({
      limit: 1,
      afterCursor: { createdAt: NOW, id: RUN_ID }
    });
    for (const invalidCursor of ["run_v2_e30", "run_v1_invalid"]) {
      const response = await handlers.listRuns(input({ query: { cursor: invalidCursor } }));
      expect(response.statusCode).toBe(400);
      const body = response.body as { readonly error: { readonly code: string } };
      expect(body.error.code).toMatch(/^CURSOR_/);
    }
  });

  it("Run Detail 保持有界，不返回冻结 Case 数组或 Prompt 正文", async () => {
    const handlers = createApplicationRunHandlers(service());
    const response = await handlers.getRun(input({ params: { runId: RUN_ID } }));
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      id: RUN_ID,
      suite: { id: SUITE_ID, caseCount: 1 },
      rubricPrompts: [{ promptKey: "quality" }],
      evaluation: { total: 1, completed: 0, error: 0, notEvaluated: 0 },
      artifactAvailability: [{ status: "PRESENT" }]
    });
    expect(JSON.stringify(response.body)).not.toContain("secret prompt body");
    expect(JSON.stringify(response.body)).not.toContain('"cases"');
  });

  it("Run Detail 和进度对不存在的 Run 返回 404，进度存在时返回小事实", async () => {
    const missing = createApplicationRunHandlers(
      service({
        get: vi.fn().mockResolvedValue(null),
        getProgress: vi.fn().mockResolvedValue(null)
      })
    );
    expect(await missing.getRun(input({ params: { runId: RUN_ID } }))).toMatchObject({
      statusCode: 404,
      body: { error: { code: "RUN_NOT_FOUND" } }
    });
    expect(await missing.getRunProgress(input({ params: { runId: RUN_ID } }))).toMatchObject({
      statusCode: 404,
      body: { error: { code: "RUN_NOT_FOUND" } }
    });
    const handlers = createApplicationRunHandlers(service());
    expect(await handlers.getRunProgress(input({ params: { runId: RUN_ID } }))).toMatchObject({
      statusCode: 200,
      body: {
        runId: RUN_ID,
        rest: { total: 1, completed: 1 },
        evaluation: { total: 1, completed: 0 }
      }
    });
  });

  it("Case 列表先区分 Run 不存在，存在但无真实结果时返回空页", async () => {
    const missingHandlers = createApplicationRunHandlers(
      service({ getProgress: vi.fn().mockResolvedValue(null) })
    );
    const missing = await missingHandlers.listRunCases(input({ params: { runId: RUN_ID } }));
    expect(missing).toMatchObject({ statusCode: 404, body: { error: { code: "RUN_NOT_FOUND" } } });

    const handlers = createApplicationRunHandlers(service());
    const empty = await handlers.listRunCases(input({ params: { runId: RUN_ID } }));
    expect(empty).toEqual({ statusCode: 200, body: { items: [], nextCursor: null } });
  });

  it("Case 列表映射成功/错误摘要、Cursor 分页并拒绝无效 Cursor", async () => {
    const queryRestResults = vi.fn().mockResolvedValue({
      items: [successfulResult(true), failedResult()],
      nextCursor: 1
    });
    const handlers = createApplicationRunHandlers(service({ queryRestResults }));
    const first = await handlers.listRunCases(
      input({ params: { runId: RUN_ID }, query: { limit: 2 } })
    );
    expect(first).toMatchObject({
      statusCode: 200,
      body: {
        items: [
          { status: "SUCCEEDED", errorType: null },
          { status: "ERROR", errorType: "HTTP_STATUS" }
        ]
      }
    });
    const cursor = (first.body as { readonly nextCursor: string }).nextCursor;
    expect(
      await handlers.listRunCases(input({ params: { runId: RUN_ID }, query: { limit: 2, cursor } }))
    ).toMatchObject({ statusCode: 200 });
    expect(queryRestResults).toHaveBeenLastCalledWith({ runId: RUN_ID, limit: 2, afterOrdinal: 1 });
    for (const invalidCursor of ["run_case_v2_e30", "run_case_v1_invalid"]) {
      const response = await handlers.listRunCases(
        input({ params: { runId: RUN_ID }, query: { cursor: invalidCursor } })
      );
      expect(response.statusCode).toBe(400);
      const body = response.body as { readonly error: { readonly code: string } };
      expect(body.error.code).toMatch(/^CURSOR_/);
    }
    expect(
      await handlers.listRunCases(input({ params: { runId: RUN_ID }, query: { limit: 0 } }))
    ).toMatchObject({ statusCode: 400, body: { error: { path: "limit" } } });
  });

  it("Case Detail 区分 Run/Case 缺失、空 Key、业务成功/失败与 REST 错误", async () => {
    const missingRun = createApplicationRunHandlers(
      service({ getProgress: vi.fn().mockResolvedValue(null) })
    );
    expect(
      await missingRun.getRunCase(input({ params: { runId: RUN_ID, caseKey: "case-1" } }))
    ).toMatchObject({ statusCode: 404, body: { error: { code: "RUN_NOT_FOUND" } } });
    const handlers = createApplicationRunHandlers(service());
    for (const caseKey of [undefined, " "]) {
      expect(
        await handlers.getRunCase(input({ params: { runId: RUN_ID, caseKey } }))
      ).toMatchObject({ statusCode: 400, body: { error: { path: "caseKey" } } });
    }
    expect(
      await handlers.getRunCase(input({ params: { runId: RUN_ID, caseKey: "missing" } }))
    ).toMatchObject({ statusCode: 404, body: { error: { code: "RUN_CASE_RESULT_NOT_FOUND" } } });

    for (const [value, expected] of [
      [successfulResult(true), { providerOutput: { ok: true, task_name: "route" }, error: null }],
      [
        successfulResult(false),
        { providerOutput: { ok: false, err_msg: "business rejected" }, error: null }
      ],
      [failedResult(), { providerOutput: null, error: { type: "HTTP_STATUS" } }]
    ] as const) {
      const detailHandlers = createApplicationRunHandlers(
        service({ getRestResult: vi.fn().mockResolvedValue(value) })
      );
      expect(
        await detailHandlers.getRunCase(input({ params: { runId: RUN_ID, caseKey: "case-1" } }))
      ).toMatchObject({ statusCode: 200, body: expected });
    }
  });

  it("Evaluation 状态冲突返回结构化 reason", async () => {
    const handlers = createApplicationRunHandlers(
      service({
        startEvaluation: vi.fn().mockResolvedValue({
          ok: false,
          error: { code: "RUN_STATE_CONFLICT", reason: "STAGE_UNAVAILABLE" }
        })
      })
    );
    const response = await handlers.startRun(
      input({
        params: { runId: RUN_ID },
        body: { expectedRevision: 3 }
      })
    );
    expect(response).toMatchObject({
      statusCode: 409,
      body: { error: { code: "RUN_STATE_CONFLICT", reason: "STAGE_UNAVAILABLE" } }
    });
  });

  it("启动与取消只返回小型进度事实，不回传冻结上下文", async () => {
    const handlers = createApplicationRunHandlers(service());
    const actionInput = input({
      params: { runId: RUN_ID },
      body: { expectedRevision: 3 }
    });

    for (const response of [
      await handlers.startRun(actionInput),
      await handlers.cancelRun(actionInput)
    ]) {
      expect(response).toMatchObject({
        statusCode: 202,
        body: { runId: RUN_ID, status: "READY", stage: "EVALUATION" }
      });
      expect(JSON.stringify(response.body)).not.toMatch(
        /suite|endpoint|evaluator|artifactManifest/
      );
    }
  });

  it("按当前阶段分派 Evaluation 启动，并分页返回不含 Raw 正文的规范化结果", async () => {
    const start = vi.fn().mockResolvedValue({ ok: true, run: run() });
    const startEvaluation = vi.fn().mockResolvedValue({ ok: true, run: run() });
    const queryEvalResults = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    const handlers = createApplicationRunHandlers(
      service({ start, startEvaluation, queryEvalResults })
    );
    const actionInput = input({
      params: { runId: RUN_ID },
      body: { expectedRevision: 3 }
    });

    expect((await handlers.startRun(actionInput)).statusCode).toBe(202);
    expect(start).not.toHaveBeenCalled();
    expect(startEvaluation).toHaveBeenCalledWith({ runId: RUN_ID, expectedRevision: 3 });
    expect(
      (
        await handlers.listRunEvaluations(
          input({ params: { runId: RUN_ID }, query: { limit: 20 } })
        )
      ).statusCode
    ).toBe(200);
    expect(queryEvalResults).toHaveBeenCalledWith({ runId: RUN_ID, limit: 20 });
  });

  it("启动和取消透传 Run 缺失与 Revision 冲突", async () => {
    const actionInput = input({ params: { runId: RUN_ID }, body: { expectedRevision: 3 } });
    for (const method of ["startEvaluation", "cancelEvaluation"] as const) {
      for (const error of [
        { code: "RUN_NOT_FOUND" as const },
        { code: "RUN_STATE_CONFLICT" as const, reason: "STATE_OR_REVISION" as const }
      ]) {
        const handlers = createApplicationRunHandlers(
          service({ [method]: vi.fn().mockResolvedValue({ ok: false, error }) })
        );
        const response =
          method === "startEvaluation"
            ? await handlers.startRun(actionInput)
            : await handlers.cancelRun(actionInput);
        expect(response.statusCode).toBe(error.code === "RUN_NOT_FOUND" ? 404 : 409);
      }
    }
  });

  it("Report 阶段启动和取消只分派 Report Owner", async () => {
    const current = { ...reportedRun(), status: "READY" as const, stage: "REPORT" as const };
    const startReport = vi.fn().mockResolvedValue({ ok: true, run: current });
    const cancelReport = vi.fn().mockResolvedValue({ ok: true, run: platformRunProgress(current) });
    const start = vi.fn();
    const startEvaluation = vi.fn();
    const handlers = createApplicationRunHandlers(
      service({
        getProgress: vi.fn().mockResolvedValue(platformRunProgress(current)),
        start,
        startEvaluation,
        startReport,
        cancelReport
      })
    );
    const action = input({ params: { runId: RUN_ID }, body: { expectedRevision: 5 } });

    expect((await handlers.startRun(action)).statusCode).toBe(202);
    expect((await handlers.cancelRun(action)).statusCode).toBe(202);
    expect(startReport).toHaveBeenCalledWith({ runId: RUN_ID, expectedRevision: 5 });
    expect(cancelReport).toHaveBeenCalledWith({ runId: RUN_ID, expectedRevision: 5 });
    expect(start).not.toHaveBeenCalled();
    expect(startEvaluation).not.toHaveBeenCalled();
  });

  it("读取 Report Overview、过滤分页和单 Case 时保持同一规范化 DTO", async () => {
    const current = reportedRun();
    const item = reportCase();
    const queryReportCases = vi.fn().mockResolvedValue({ items: [item], nextCursor: 0 });
    const handlers = createApplicationRunHandlers(
      service({
        getProgress: vi.fn().mockResolvedValue(platformRunProgress(current)),
        getReport: vi.fn().mockResolvedValue({
          run: current,
          report: current.reportSummary,
          artifactAvailability: []
        }),
        queryReportCases,
        getReportCase: vi.fn().mockResolvedValue(item)
      })
    );

    const overview = await handlers.getRunReport(input({ params: { runId: RUN_ID } }));
    expect(overview).toMatchObject({
      statusCode: 200,
      body: {
        runId: RUN_ID,
        evaluationContextHash: "b".repeat(64),
        evaluationResultSetHash: "c".repeat(64),
        reportResultSetHash: "d".repeat(64),
        summary: { total: 1, evalPass: 1 },
        byMetric: [{ metric: "quality", pass: 1 }]
      }
    });
    expect(JSON.stringify(overview.body)).not.toContain("secret prompt body");

    const first = await handlers.listRunReportCases(
      input({
        params: { runId: RUN_ID },
        query: {
          limit: 1,
          restStatus: ["SUCCEEDED"],
          evalStatus: ["PASS"],
          metric: ["quality"],
          businessModule: ["chat"],
          scenarioTag: ["smoke"]
        }
      })
    );
    expect(first).toMatchObject({
      statusCode: 200,
      body: { items: [{ caseKey: "case-1", rawEvidenceStatus: "ABSENT" }] }
    });
    const cursor = (first.body as { readonly nextCursor: string }).nextCursor;
    await handlers.listRunReportCases(
      input({ params: { runId: RUN_ID }, query: { limit: 1, cursor } })
    );
    expect(queryReportCases).toHaveBeenLastCalledWith({
      runId: RUN_ID,
      limit: 1,
      afterOrdinal: 0
    });

    expect(
      await handlers.getRunReportCase(input({ params: { runId: RUN_ID, caseKey: "case-1" } }))
    ).toMatchObject({
      statusCode: 200,
      body: {
        caseKey: "case-1",
        rest: { status: "SUCCEEDED" },
        evaluation: { status: "PASS" }
      }
    });
  });

  it("导出只返回已完成完整性校验的 Report JSON 流", async () => {
    const current = reportedRun();
    const body = Readable.from(['{"contractVersion":"cortex.report.v1"}\n']);
    const handlers = createApplicationRunHandlers(
      service({
        getProgress: vi.fn().mockResolvedValue(platformRunProgress(current)),
        getReport: vi.fn().mockResolvedValue({
          run: current,
          report: current.reportSummary,
          artifactAvailability: []
        }),
        openReportExport: vi.fn().mockResolvedValue(body)
      })
    );

    await expect(
      handlers.exportRunReport(input({ params: { runId: RUN_ID } }))
    ).resolves.toMatchObject({
      statusCode: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body
    });
    const corrupted = createApplicationRunHandlers(
      service({
        getProgress: vi.fn().mockResolvedValue(platformRunProgress(current)),
        getReport: vi.fn().mockResolvedValue({
          run: current,
          report: current.reportSummary,
          artifactAvailability: []
        }),
        openReportExport: vi.fn().mockResolvedValue(null)
      })
    );
    await expect(
      corrupted.exportRunReport(input({ params: { runId: RUN_ID } }))
    ).resolves.toMatchObject({
      statusCode: 422,
      body: { error: { code: "REPORT_RECONCILIATION_FAILED" } }
    });
  });

  it("离线导入 Report 使用统一 Overview 并从规范化明细流式导出", async () => {
    const current = importedReportRun();
    const item = reportCase();
    const handlers = createApplicationRunHandlers(
      service({
        getReport: vi.fn().mockResolvedValue({
          run: current,
          report: current.reportSummary,
          artifactAvailability: []
        }),
        streamReportCases: vi.fn().mockReturnValue({
          async *[Symbol.asyncIterator](): AsyncGenerator<PlatformReportArtifactCaseInput> {
            await Promise.resolve();
            yield { testCase: item.testCase, rest: item.rest, evaluation: item.evaluation };
          }
        })
      })
    );

    await expect(
      handlers.getRunReport(input({ params: { runId: RUN_ID } }))
    ).resolves.toMatchObject({
      statusCode: 200,
      body: { sourceType: "OFFLINE_IMPORT", reportResultSetHash: current.reportResultSetHash }
    });
    const response = await handlers.exportRunReport(input({ params: { runId: RUN_ID } }));
    expect(response.statusCode).toBe(200);
    if (!(response.body instanceof Readable)) throw new Error("TEST_REPORT_BODY_INVALID");
    const chunks: Uint8Array[] = [];
    for await (const chunk of response.body) {
      if (!(chunk instanceof Uint8Array)) throw new Error("TEST_REPORT_CHUNK_INVALID");
      chunks.push(chunk);
    }
    expect(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown).toMatchObject({
      owner: { kind: "EXECUTION", id: SOURCE_RUN_ID },
      packageId: SUITE_ID,
      cases: [{ caseKey: "case-1" }]
    });
  });

  it("Retry/Force 创建新 Run 并返回来源、模式和复用数量", async () => {
    const created = {
      ...run(),
      id: RUN_ID,
      sourceRunId: SOURCE_RUN_ID,
      rerunMode: "RETRY_FAILED" as const,
      status: "READY" as const,
      stage: "REST" as const,
      lockRevision: 0
    };
    const handlers = createApplicationRunHandlers(
      service({
        createRerun: vi.fn().mockResolvedValue({
          ok: true,
          run: created,
          plan: {
            sourceRunId: SOURCE_RUN_ID,
            mode: "RETRY_FAILED",
            cases: [{ caseKey: "case-1", ordinal: 0, action: "REUSE_REST_AND_EVAL" }],
            counts: { reuseRest: 1, executeRest: 0, reuseEval: 1, executeEval: 0 }
          }
        })
      })
    );

    await expect(
      handlers.createRunRerun(
        input({ params: { runId: SOURCE_RUN_ID }, body: { mode: "RETRY_FAILED" } })
      )
    ).resolves.toMatchObject({
      statusCode: 201,
      body: {
        runId: RUN_ID,
        sourceRunId: SOURCE_RUN_ID,
        rerunMode: "RETRY_FAILED",
        counts: { reuseRest: 1, reuseEval: 1 }
      }
    });

    const incomplete = createApplicationRunHandlers(
      service({
        createRerun: vi.fn().mockResolvedValue({
          ok: false,
          error: { code: "RERUN_SOURCE_INCOMPLETE" }
        })
      })
    );
    await expect(
      incomplete.createRunRerun(
        input({ params: { runId: SOURCE_RUN_ID }, body: { mode: "FORCE" } })
      )
    ).resolves.toMatchObject({
      statusCode: 422,
      body: { error: { code: "RERUN_SOURCE_INCOMPLETE" } }
    });
  });

  it("Report Execution 导入返回独立版本身份并稳定映射冲突", async () => {
    const importExecutionReport = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        runId: RUN_ID,
        packageId: SUITE_ID,
        executionId: SOURCE_RUN_ID,
        idempotent: false,
        status: "COMPLETED",
        restResultSetHash: HASH,
        evaluationContextHash: HASH,
        evaluationResultSetHash: HASH,
        reportResultSetHash: HASH
      }
    });
    const handlers = createApplicationRunHandlers(service({ importExecutionReport }));
    const request = input({
      body: {
        contractVersion: "cortex.execution-report-import-request.v1",
        packagePath: "/tmp/package",
        executionId: SOURCE_RUN_ID
      }
    });

    await expect(handlers.importExecutionReport(request)).resolves.toMatchObject({
      statusCode: 201,
      body: {
        runId: RUN_ID,
        sourceType: "OFFLINE_IMPORT",
        stage: "DONE",
        restResultSetHash: HASH,
        evaluationContextHash: HASH,
        evaluationResultSetHash: HASH,
        reportResultSetHash: HASH
      }
    });
    expect(importExecutionReport).toHaveBeenCalledWith(request.body, request.signal);

    const conflict = createApplicationRunHandlers(
      service({
        importExecutionReport: vi.fn().mockResolvedValue({
          ok: false,
          error: { code: "EXECUTION_RESULT_CONFLICT", executionId: SOURCE_RUN_ID }
        })
      })
    );
    await expect(conflict.importExecutionReport(request)).resolves.toMatchObject({
      statusCode: 409,
      body: { error: { code: "EXECUTION_RESULT_CONFLICT" } }
    });
  });
});
