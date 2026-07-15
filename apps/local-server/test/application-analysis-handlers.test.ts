import { describe, expect, it, vi } from "vitest";
import type { CurrentCaseAnalysis } from "@cortex-eval/application/src/features/case-analysis/case-analysis-models.ts";

import {
  createApplicationAnalysisHandlers,
  type ApplicationAnalysisServiceBoundary
} from "../src/application-analysis-handlers.ts";
import type { LocalApiHandlerInput } from "../src/local-server.ts";

const RUN_ID = "01900000-0000-7000-8000-000000000001";
const CONFIG_ID = "01900000-0000-7000-8000-000000000002";
const PROMPT_ID = "01900000-0000-7000-8000-000000000003";
const ANALYSIS_ID = "01900000-0000-7000-8000-000000000004";
const HASH = "a".repeat(64);

function currentAnalysis(): CurrentCaseAnalysis {
  return {
    id: ANALYSIS_ID,
    runId: RUN_ID,
    caseKey: "case-1",
    finalCaseResultHash: HASH,
    revision: 3,
    prompt: { sourceId: PROMPT_ID, promptKey: "analysis", promptHash: HASH, snapshot: {} },
    analyzer: {
      sourceId: CONFIG_ID,
      configHash: HASH,
      provider: "GOOGLE_GEMINI",
      model: "analyzer",
      snapshot: {}
    },
    analysisInputContractVersion: "cortex.analysis-input.v1",
    analysisOutputContractVersion: "cortex.analysis-output.v1",
    analysisInputHash: HASH,
    analysisExecutionLimits: {
      contractVersion: "cortex.analysis-execution-limits.v1",
      analysisConcurrency: 1
    },
    status: "SUCCEEDED",
    output: {
      classification: "NORMAL_FAILURE",
      confidence: 0.8,
      evidence: [{ source: "run_context", fieldPath: null, conclusion: "运行事实" }],
      explanation: "失败原因",
      recommendedAction: "修复系统",
      proposal: {
        action: "REMOVE_ASSERTION",
        baseDefinitionHash: HASH,
        targetAssertionIndex: 0,
        targetAssertionDefinitionHash: HASH
      }
    },
    analysisResultHash: HASH,
    decision: "PENDING",
    applyStatus: "NOT_APPLIED",
    baseDefinitionHash: HASH,
    appliedDefinitionHash: null,
    errorCode: null,
    errorMessage: null,
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:01.000Z"
  };
}

function acceptBody(editedProposal?: Record<string, unknown>): Record<string, unknown> {
  return {
    analysisId: ANALYSIS_ID,
    expectedAnalysisRevision: 3,
    expectedFinalCaseResultHash: HASH,
    expectedAnalysisInputHash: HASH,
    expectedPromptHash: HASH,
    expectedAnalyzerConfigHash: HASH,
    suiteId: RUN_ID,
    expectedSuiteRevision: 2,
    expectedCaseId: CONFIG_ID,
    expectedCaseRevision: 4,
    ...(editedProposal === undefined ? {} : { editedProposal })
  };
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

function boundary(
  overrides: Partial<ApplicationAnalysisServiceBoundary> = {}
): ApplicationAnalysisServiceBoundary {
  return {
    startCaseAnalysis: vi.fn().mockResolvedValue({
      ok: true,
      selectedCount: 1,
      succeededCount: 1,
      errorCount: 0,
      finalCaseResultSetHash: HASH
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
    importExecutionAnalysis: vi.fn().mockResolvedValue({
      ok: true,
      value: {
        runId: RUN_ID,
        packageId: CONFIG_ID,
        executionId: PROMPT_ID,
        idempotent: false,
        selector: "failed",
        selectedCount: 1,
        importedCount: 1,
        finalCaseResultSetHash: HASH,
        analysisResultSetHash: HASH
      }
    }),
    ...overrides
  };
}

describe("Application Analysis HTTP handlers", () => {
  it("启动时冻结显式资源、Selector 和默认并发，并返回稳定摘要", async () => {
    const startCaseAnalysis = vi
      .fn<ApplicationAnalysisServiceBoundary["startCaseAnalysis"]>()
      .mockResolvedValue({
        ok: true,
        selectedCount: 1,
        succeededCount: 1,
        errorCount: 0,
        finalCaseResultSetHash: HASH
      });
    const handlers = createApplicationAnalysisHandlers(boundary({ startCaseAnalysis }));
    await expect(
      handlers.startCaseAnalysis(
        input({
          params: { runId: RUN_ID },
          body: {
            analyzerConfigId: CONFIG_ID,
            analysisPromptId: PROMPT_ID,
            selector: "failed"
          }
        })
      )
    ).resolves.toMatchObject({
      statusCode: 200,
      body: { selector: "failed", selectedCount: 1, finalCaseResultSetHash: HASH }
    });
    expect(startCaseAnalysis.mock.calls[0]?.[0]).toMatchObject({
      runId: RUN_ID,
      selector: "failed",
      analysisExecutionLimits: { analysisConcurrency: 1 }
    });
  });

  it("查询和决策使用 Run/Case 当前身份并映射不存在与 Revision 冲突", async () => {
    const rejectAnalysisProposal = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: "ANALYSIS_REVISION_CONFLICT", actualRevision: 4 },
      analysis: null
    });
    const handlers = createApplicationAnalysisHandlers(boundary({ rejectAnalysisProposal }));
    const target = { runId: RUN_ID, caseKey: "case-1" };
    await expect(handlers.getCurrentCaseAnalysis(input({ params: target }))).resolves.toMatchObject(
      {
        statusCode: 404,
        body: { error: { code: "ANALYSIS_NOT_FOUND" } }
      }
    );
    await expect(
      handlers.rejectAnalysisProposal(
        input({
          params: target,
          body: { analysisId: ANALYSIS_ID, expectedAnalysisRevision: 3 }
        })
      )
    ).resolves.toMatchObject({
      statusCode: 409,
      body: { error: { code: "ANALYSIS_REVISION_CONFLICT", actualRevision: 4 } }
    });
  });

  it("Analysis Execution 导入返回版本身份并稳定映射冲突", async () => {
    const service = boundary();
    const handlers = createApplicationAnalysisHandlers(service);
    const request = input({
      body: {
        contractVersion: "cortex.execution-analysis-import-request.v1",
        packagePath: "/tmp/package",
        executionId: PROMPT_ID
      }
    });
    await expect(handlers.importExecutionAnalysis(request)).resolves.toMatchObject({
      statusCode: 201,
      body: { runId: RUN_ID, selector: "failed", importedCount: 1 }
    });

    const conflict = createApplicationAnalysisHandlers(
      boundary({
        importExecutionAnalysis: vi.fn().mockResolvedValue({
          ok: false,
          error: { code: "EXECUTION_RESULT_CONFLICT", executionId: PROMPT_ID }
        })
      })
    );
    await expect(conflict.importExecutionAnalysis(request)).resolves.toMatchObject({
      statusCode: 409,
      body: { error: { code: "EXECUTION_RESULT_CONFLICT" } }
    });
  });

  it("拒绝无效目标和请求，并返回当前结构化 Analysis", async () => {
    const handlers = createApplicationAnalysisHandlers(
      boundary({ getCurrentCaseAnalysis: vi.fn().mockResolvedValue(currentAnalysis()) })
    );
    await expect(
      handlers.startCaseAnalysis(input({ params: { runId: "bad" }, body: {} }))
    ).resolves.toMatchObject({ statusCode: 400, body: { error: { path: "request" } } });
    await expect(
      handlers.startCaseAnalysis(input({ params: { runId: RUN_ID }, body: {} }))
    ).resolves.toMatchObject({ statusCode: 400, body: { error: { path: "analyzerConfigId" } } });
    await expect(
      handlers.getCurrentCaseAnalysis(input({ params: { runId: RUN_ID, caseKey: " " } }))
    ).resolves.toMatchObject({ statusCode: 400, body: { error: { path: "caseKey" } } });
    await expect(
      handlers.getCurrentCaseAnalysis(input({ params: { runId: RUN_ID, caseKey: "case-1" } }))
    ).resolves.toMatchObject({
      statusCode: 200,
      body: {
        id: ANALYSIS_ID,
        output: { evidence: [{ source: "run_context", fieldPath: null }] }
      }
    });
  });

  it.each([
    ["RUN_NOT_FOUND", 404],
    ["CONFIGURATION_NOT_FOUND", 404],
    ["REPORT_RECONCILIATION_FAILED", 422],
    ["ANALYSIS_STATE_CONFLICT", 409]
  ] as const)("稳定映射启动错误 %s", async (code, statusCode) => {
    const handlers = createApplicationAnalysisHandlers(
      boundary({
        startCaseAnalysis: vi.fn().mockResolvedValue({ ok: false, error: { code } })
      })
    );
    await expect(
      handlers.startCaseAnalysis(
        input({
          params: { runId: RUN_ID },
          body: {
            analyzerConfigId: CONFIG_ID,
            analysisPromptId: PROMPT_ID,
            selector: "errors",
            analysisExecutionLimits: {
              contractVersion: "cortex.analysis-execution-limits.v1",
              analysisConcurrency: 3
            }
          }
        })
      )
    ).resolves.toMatchObject({ statusCode, body: { error: { code } } });
  });

  it("把启动取消映射为 499，其他异常保持给统一错误边界", async () => {
    const controller = new AbortController();
    controller.abort();
    const cancelled = createApplicationAnalysisHandlers(
      boundary({ startCaseAnalysis: vi.fn().mockRejectedValue(new Error("cancelled")) })
    );
    await expect(
      cancelled.startCaseAnalysis(
        input({
          params: { runId: RUN_ID },
          body: {
            analyzerConfigId: CONFIG_ID,
            analysisPromptId: PROMPT_ID,
            selector: "all"
          },
          signal: controller.signal
        })
      )
    ).resolves.toMatchObject({ statusCode: 499, body: { error: { code: "REQUEST_ABORTED" } } });

    const failed = createApplicationAnalysisHandlers(
      boundary({ startCaseAnalysis: vi.fn().mockRejectedValue(new Error("unexpected")) })
    );
    await expect(
      failed.startCaseAnalysis(
        input({
          params: { runId: RUN_ID },
          body: {
            analyzerConfigId: CONFIG_ID,
            analysisPromptId: PROMPT_ID,
            selector: "all"
          }
        })
      )
    ).rejects.toThrow("unexpected");
  });

  it("闭合拒绝、接受和编辑后接受的成功及错误映射", async () => {
    const analysis = currentAnalysis();
    const successful = createApplicationAnalysisHandlers(
      boundary({
        rejectAnalysisProposal: vi.fn().mockResolvedValue({ ok: true, analysis }),
        acceptAnalysisProposal: vi.fn().mockResolvedValue({ ok: true, analysis })
      })
    );
    const params = { runId: RUN_ID, caseKey: "case-1" };
    await expect(
      successful.rejectAnalysisProposal(
        input({ params, body: { analysisId: ANALYSIS_ID, expectedAnalysisRevision: 3 } })
      )
    ).resolves.toMatchObject({ statusCode: 200, body: { id: ANALYSIS_ID } });
    await expect(
      successful.acceptAnalysisProposal(input({ params, body: acceptBody() }))
    ).resolves.toMatchObject({ statusCode: 200 });
    const editedProposal = {
      action: "REMOVE_ASSERTION",
      baseDefinitionHash: HASH,
      targetAssertionIndex: 0,
      targetAssertionDefinitionHash: HASH
    };
    await expect(
      successful.editAndAcceptAnalysisProposal(input({ params, body: acceptBody(editedProposal) }))
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      successful.acceptAnalysisProposal(input({ params, body: acceptBody(editedProposal) }))
    ).resolves.toMatchObject({ statusCode: 400, body: { error: { path: "editedProposal" } } });
    await expect(
      successful.editAndAcceptAnalysisProposal(input({ params, body: acceptBody() }))
    ).resolves.toMatchObject({ statusCode: 400, body: { error: { path: "editedProposal" } } });

    for (const expected of [
      { error: { code: "ANALYSIS_NOT_FOUND" }, statusCode: 404 },
      {
        error: { code: "ANALYSIS_PROPOSAL_INVALID", path: "proposal.assertion" },
        statusCode: 422
      },
      {
        error: { code: "ANALYSIS_APPLY_CONFLICT", reason: "CASE_VERSION_CHANGED" },
        statusCode: 409
      },
      { error: { code: "ANALYSIS_STATE_CONFLICT", actualRevision: 3 }, statusCode: 409 }
    ] as const) {
      const handlers = createApplicationAnalysisHandlers(
        boundary({
          rejectAnalysisProposal: vi
            .fn()
            .mockResolvedValue({ ok: false, error: expected.error, analysis })
        })
      );
      await expect(
        handlers.rejectAnalysisProposal(
          input({ params, body: { analysisId: ANALYSIS_ID, expectedAnalysisRevision: 3 } })
        )
      ).resolves.toMatchObject({
        statusCode: expected.statusCode,
        body: { error: { code: expected.error.code } }
      });
    }
  });

  it.each([
    ["REQUEST_ABORTED", 499, "REQUEST_ABORTED"],
    ["WORK_PACKAGE_LOCKED", 409, "WORK_PACKAGE_LOCKED"],
    ["WORK_PACKAGE_HASH_MISMATCH", 422, "WORK_PACKAGE_INVALID"],
    ["ARTIFACT_CORRUPTED", 422, "WORK_PACKAGE_INVALID"]
  ] as const)("稳定映射 Analysis 导入错误 %s", async (message, statusCode, code) => {
    const handlers = createApplicationAnalysisHandlers(
      boundary({ importExecutionAnalysis: vi.fn().mockRejectedValue(new Error(message)) })
    );
    await expect(
      handlers.importExecutionAnalysis(
        input({
          body: {
            contractVersion: "cortex.execution-analysis-import-request.v1",
            packagePath: "/tmp/package",
            executionId: PROMPT_ID
          }
        })
      )
    ).resolves.toMatchObject({ statusCode, body: { error: { code } } });
  });

  it("拒绝无效 Analysis 导入请求并上抛未知异常", async () => {
    const handlers = createApplicationAnalysisHandlers(boundary());
    await expect(handlers.importExecutionAnalysis(input({ body: {} }))).resolves.toMatchObject({
      statusCode: 400,
      body: { error: { code: "VALIDATION_FAILED" } }
    });
    const failed = createApplicationAnalysisHandlers(
      boundary({ importExecutionAnalysis: vi.fn().mockRejectedValue(new Error("unexpected")) })
    );
    await expect(
      failed.importExecutionAnalysis(
        input({
          body: {
            contractVersion: "cortex.execution-analysis-import-request.v1",
            packagePath: "/tmp/package",
            executionId: PROMPT_ID
          }
        })
      )
    ).rejects.toThrow("unexpected");
  });
});
