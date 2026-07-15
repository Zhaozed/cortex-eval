import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PlatformEvalCaseResult } from "@cortex-eval/application/src/features/evaluation/platform-eval-models.ts";
import type {
  PlatformReportArtifactCaseInput,
  PlatformReportArtifactInput
} from "@cortex-eval/application/src/features/runs/run-artifact-port.ts";
import type {
  PlatformRun,
  StoredRestCaseResult
} from "@cortex-eval/application/src/features/runs/platform-run-models.ts";
import { createReportAccumulator } from "@cortex-eval/reporting/src/report-aggregation.ts";
import { runBenchmark } from "../../../tooling/src/benchmark-harness.ts";
import { describe, expect, it } from "vitest";

import { LocalRunArtifactStore } from "../src/run-artifact-store.ts";

const NOW = "2026-07-15T00:00:00.000Z";
const HASH = "a".repeat(64);
const EVALUATION_CONTEXT_HASH = "b".repeat(64);
const EVALUATION_RESULT_SET_HASH = "c".repeat(64);
const CASE_COUNT = 1_000;

function runId(index: number): string {
  return `01900000-0000-7000-8000-${index.toString(16).padStart(12, "0")}`;
}

function definition(index: number): PlatformRun["suite"]["cases"][number]["definition"] {
  const caseKey = `case-${index.toString().padStart(4, "0")}`;
  return {
    caseKey,
    description: `Case ${index}`,
    threshold: 1,
    task: "route",
    requestBody: { index },
    metadata: {
      requestId: `request-${index}`,
      taskId: `task-${index}`,
      businessModule: index % 2 === 0 ? "chat" : "search",
      scenarioTag: index % 3 === 0 ? "smoke" : "regression"
    },
    assertions: [{ type: "equals", metric: index % 5 === 0 ? "quality" : "schema", weight: 1 }]
  };
}

function reportRun(id: string): PlatformRun {
  return {
    id,
    sourceType: "PLATFORM",
    sourceRunId: null,
    rerunMode: "NONE",
    suite: {
      id: "01900000-0000-7000-8000-000000000100",
      name: "Performance Suite",
      suiteHash: HASH,
      cases: Array.from({ length: CASE_COUNT }, (_, ordinal) => ({
        caseKey: `case-${ordinal.toString().padStart(4, "0")}`,
        ordinal,
        definitionHash: HASH,
        definition: definition(ordinal)
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
        defaultConcurrency: 4
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
        maxOutputTokens: 256,
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
      restConcurrency: 4,
      evalConcurrency: 2
    },
    runMode: "STAGED",
    status: "RUNNING",
    stage: "REPORT",
    lockRevision: 5,
    cancelRequestedAt: null,
    restCompletedCount: CASE_COUNT,
    restErrorCount: 0,
    evalCompletedCount: CASE_COUNT,
    evalPassCount: CASE_COUNT,
    evalFailCount: 0,
    evalErrorCount: 0,
    evalNotEvaluatedCount: 0,
    resultSetHash: HASH,
    evaluationContextHash: EVALUATION_CONTEXT_HASH,
    evaluationResultSetHash: EVALUATION_RESULT_SET_HASH,
    reportResultSetHash: null,
    reportSummary: null,
    artifactManifest: {
      contractVersion: "cortex.artifact-manifest.v1",
      owner: { kind: "RUN", id },
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

function alignedCase(run: PlatformRun, ordinal: number): PlatformReportArtifactCaseInput {
  const testCase = run.suite.cases[ordinal];
  if (testCase === undefined) throw new Error("TEST_CASE_MISSING");
  const metric = ordinal % 5 === 0 ? "quality" : "schema";
  const rest: StoredRestCaseResult = {
    runId: run.id,
    caseKey: testCase.caseKey,
    ordinal,
    definition: testCase.definition,
    caseDefinitionHash: testCase.definitionHash,
    status: "SUCCEEDED",
    httpStatus: 200,
    providerOutput: { ok: true, taskName: "route", resolvedConfig: {}, parsedOutput: {} },
    errorType: null,
    errorMessage: null,
    durationMs: 1,
    completedAt: NOW,
    resultHash: HASH,
    provenance: null
  };
  const evaluation: PlatformEvalCaseResult = {
    runId: run.id,
    caseKey: testCase.caseKey,
    ordinal,
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
        metric,
        weight: 1,
        status: "PASS",
        score: 1,
        reason: "passed"
      }
    ],
    diffs: [],
    metrics: [{ metric, status: "PASS" }],
    latencyMs: 1,
    tokenUsage: null,
    cost: 0,
    rawEvidence: null,
    evalResultHash: HASH,
    finalCaseResultHash: HASH,
    provenance: null,
    createdAt: NOW,
    updatedAt: NOW
  };
  return { testCase, rest, evaluation };
}

function reportInput(run: PlatformRun): PlatformReportArtifactInput {
  const accumulator = createReportAccumulator({
    owner: { kind: "RUN", id: run.id },
    runContextHash: run.runContextHash,
    evaluationContextHash: EVALUATION_CONTEXT_HASH,
    evaluationResultSetHash: EVALUATION_RESULT_SET_HASH,
    expectedCaseKey: (ordinal) => run.suite.cases[ordinal]?.caseKey ?? null
  });
  for (let ordinal = 0; ordinal < CASE_COUNT; ordinal += 1) {
    const item = alignedCase(run, ordinal);
    accumulator.add({
      caseKey: item.testCase.caseKey,
      ordinal,
      rest: { status: item.rest.status, resultHash: item.rest.resultHash },
      evaluation: {
        status: item.evaluation.status,
        evalResultHash: item.evaluation.evalResultHash,
        finalCaseResultHash: item.evaluation.finalCaseResultHash,
        metrics: item.evaluation.metrics
      }
    });
  }
  const cases = async function* (): AsyncGenerator<PlatformReportArtifactCaseInput> {
    for (let ordinal = 0; ordinal < CASE_COUNT; ordinal += 1) {
      yield await Promise.resolve(alignedCase(run, ordinal));
    }
  };
  return {
    run,
    completedAt: NOW,
    aggregation: accumulator.finish(),
    expectedTotal: CASE_COUNT,
    signal: new AbortController().signal,
    cases: cases()
  };
}

describe("Report 千级 Case 性能门禁", () => {
  it("JSON 与 Markdown 双写的中位数不超过五秒", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-report-performance-"));
    try {
      const store = await LocalRunArtifactStore.create({ projectRoot });
      let iteration = 0;
      const benchmark = await runBenchmark(
        async () => {
          iteration += 1;
          const run = reportRun(runId(iteration));
          const output = await store.writeReport(reportInput(run));
          expect(output.json.descriptor.expectedSizeBytes).toBeGreaterThan(0);
          expect(output.markdown.descriptor.expectedSizeBytes).toBeGreaterThan(0);
        },
        1,
        5
      );

      expect(benchmark.environment).toMatchObject({ platform: "darwin", architecture: "arm64" });
      expect(benchmark.medianMs).toBeLessThanOrEqual(5_000);
      process.stdout.write(`${JSON.stringify({ gate: "P10_REPORT_PERFORMANCE", benchmark })}\n`);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  }, 60_000);
});
