import type { PlatformEvalCaseResult } from "@cortex-eval/application/src/features/evaluation/platform-eval-models.ts";
import type { ImportedReportRun } from "@cortex-eval/application/src/features/execution-imports/execution-import-models.ts";
import type { PlatformReportCase } from "@cortex-eval/application/src/features/reporting/platform-report-service.ts";
import {
  platformRunDetail,
  platformRunProgress,
  type PlatformRun,
  type PlatformRunSummary,
  type StoredRestCaseResult
} from "@cortex-eval/application/src/features/runs/platform-run-models.ts";
import { Readable } from "node:stream";
import { vi } from "vitest";

import { type ApplicationRunServiceBoundary } from "../src/application-run-handlers.ts";
import type { LocalApiHandlerInput } from "../src/local-server.ts";
import {
  importedReportRunFixture,
  passingEvaluationFixture,
  reportCaseFixture,
  reportedRunFixture
} from "../test-support/application-report-handler-fixtures.ts";

export const RUN_ID = "01900000-0000-7000-8000-000000000001";

export const SOURCE_RUN_ID = "01900000-0000-7000-8000-000000000002";

export const SUITE_ID = "01900000-0000-7000-8000-000000000100";

export const ENDPOINT_ID = "01900000-0000-7000-8000-000000000200";

export const EVALUATOR_ID = "01900000-0000-7000-8000-000000000300";

export const NOW = "2026-07-13T00:00:00.000Z";

export const HASH = "a".repeat(64);

export function run(): PlatformRun {
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

export function runSummary(): PlatformRunSummary {
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

export function successfulResult(businessSuccess: boolean): StoredRestCaseResult {
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

export function failedResult(): StoredRestCaseResult {
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

export function passingEvaluation(): PlatformEvalCaseResult {
  return passingEvaluationFixture(RUN_ID, "case-1", HASH, NOW);
}

export function reportedRun(): PlatformRun {
  return reportedRunFixture(run(), NOW);
}

export function importedReportRun(): ImportedReportRun {
  return importedReportRunFixture({
    current: reportedRun(),
    packageId: SUITE_ID,
    executionId: SOURCE_RUN_ID,
    fallbackHash: HASH,
    fallbackTime: NOW
  });
}

export function reportCase(): PlatformReportCase {
  return reportCaseFixture({
    run: reportedRun(),
    rest: successfulResult(true),
    evaluation: passingEvaluation()
  });
}

export function input(overrides: Partial<LocalApiHandlerInput> = {}): LocalApiHandlerInput {
  return {
    params: {},
    query: {},
    body: {},
    requestId: "01900000-0000-7000-8000-000000000999",
    signal: new AbortController().signal,
    ...overrides
  };
}

export function service(
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
    deleteRun: vi.fn().mockResolvedValue({ ok: true }),
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
