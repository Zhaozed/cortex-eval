import type { ImportedReportRun } from "@cortex-eval/application/src/features/execution-imports/execution-import-models.ts";
import type { PlatformReportArtifactCaseInput } from "@cortex-eval/application/src/features/runs/run-artifact-port.ts";
import { ReportArtifactV1Schema } from "@cortex-eval/contracts/src/artifact-contracts.ts";
import { describe, expect, it } from "vitest";

import { openImportedReportExport } from "../src/imported-report-export.ts";

const RUN_ID = "01900000-0000-7000-8000-000000000001";
const PACKAGE_ID = "01900000-0000-7000-8000-000000000002";
const EXECUTION_ID = "01900000-0000-7000-8000-000000000003";
const TIME = "2026-07-15T00:00:00.000Z";
const HASH = "a".repeat(64);

function fixture(): {
  readonly run: ImportedReportRun;
  readonly item: PlatformReportArtifactCaseInput;
} {
  const definition = {
    caseKey: "case-1",
    description: "fixture",
    threshold: 1,
    task: "reply",
    requestBody: {},
    metadata: {
      requestId: "req-1",
      taskId: "task-1",
      businessModule: "chat",
      scenarioTag: "smoke"
    },
    assertions: [{ type: "contains", metric: "quality", weight: 1, value: "ok" }]
  };
  const item: PlatformReportArtifactCaseInput = {
    testCase: { caseKey: "case-1", ordinal: 0, definitionHash: HASH, definition },
    rest: {
      runId: RUN_ID,
      caseKey: "case-1",
      ordinal: 0,
      definition,
      caseDefinitionHash: HASH,
      status: "SUCCEEDED",
      httpStatus: 200,
      providerOutput: { ok: false, errorMessage: "business" },
      errorType: null,
      errorMessage: null,
      durationMs: 1,
      completedAt: TIME,
      resultHash: HASH,
      provenance: null
    },
    evaluation: {
      runId: RUN_ID,
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
      latencyMs: null,
      tokenUsage: null,
      cost: null,
      rawEvidence: null,
      evalResultHash: HASH,
      finalCaseResultHash: HASH,
      provenance: null,
      createdAt: TIME,
      updatedAt: TIME
    }
  };
  const run: ImportedReportRun = {
    id: RUN_ID,
    sourceType: "OFFLINE_IMPORT",
    packageId: PACKAGE_ID,
    executionId: EXECUTION_ID,
    sourceRunId: null,
    rerunMode: "NONE",
    suite: { id: PACKAGE_ID, name: "Suite", suiteHash: HASH, caseCount: 1 },
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
      caseDefinition: "cortex.case-definition.v1",
      restResults: "cortex.rest-results-jsonl.v1",
      normalizedEval: "cortex.normalized-eval-jsonl.v1",
      report: "cortex.report.v1",
      analysisInput: "cortex.analysis-input.v1",
      analysisOutput: "cortex.analysis-output.v1"
    },
    runExecutionLimits: {
      contractVersion: "cortex.run-execution-limits.v1",
      restConcurrency: 4,
      evalConcurrency: 2
    },
    status: "COMPLETED",
    stage: "DONE",
    restResultSetHash: HASH,
    evaluationContextHash: HASH,
    evaluationResultSetHash: HASH,
    reportResultSetHash: HASH,
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
      owner: { kind: "EXECUTION", id: EXECUTION_ID },
      artifacts: []
    },
    completedAt: TIME,
    createdAt: TIME,
    updatedAt: TIME
  };
  return { run, item };
}

describe("P8 imported Report export", () => {
  it("rejects a pre-aborted export before emitting any Report bytes", async () => {
    const value = fixture();
    const controller = new AbortController();
    controller.abort();
    const body = openImportedReportExport({
      run: value.run,
      cases: {
        async *[Symbol.asyncIterator](): AsyncGenerator<PlatformReportArtifactCaseInput> {
          await Promise.resolve();
          yield value.item;
        }
      },
      signal: controller.signal
    });
    const chunks: Uint8Array[] = [];

    const consume = async (): Promise<void> => {
      for await (const dirtyChunk of body) {
        if (!(dirtyChunk instanceof Uint8Array)) throw new Error("TEST_EXPORT_CHUNK_INVALID");
        chunks.push(dirtyChunk);
      }
    };

    await expect(consume()).rejects.toThrow("REQUEST_ABORTED");
    expect(chunks).toEqual([]);
  });

  it("streams a strict Report artifact from normalized database facts", async () => {
    const value = fixture();
    const body = openImportedReportExport({
      run: value.run,
      cases: {
        async *[Symbol.asyncIterator](): AsyncGenerator<PlatformReportArtifactCaseInput> {
          await Promise.resolve();
          yield value.item;
        }
      },
      signal: new AbortController().signal
    });
    const chunks: Uint8Array[] = [];
    for await (const dirtyChunk of body) {
      if (!(dirtyChunk instanceof Uint8Array)) throw new Error("TEST_EXPORT_CHUNK_INVALID");
      chunks.push(dirtyChunk);
    }
    const parsed = ReportArtifactV1Schema.parse(
      JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
    );
    expect(parsed).toMatchObject({
      owner: { kind: "EXECUTION", id: EXECUTION_ID },
      packageId: PACKAGE_ID,
      cases: [{ caseKey: "case-1" }],
      reportResultSetHash: HASH
    });
  });
});
