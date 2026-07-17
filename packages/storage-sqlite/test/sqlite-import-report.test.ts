import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ImportExecutionReport,
  type ImportExecutionReportCommand
} from "@cortex-eval/application/src/features/execution-imports/import-execution-report.ts";
import type { ImportedExecutionReportCase } from "@cortex-eval/application/src/features/execution-imports/execution-import-models.ts";
import { caseDefinitionJson } from "@cortex-eval/domain/src/domain-case-projection.ts";
import {
  hashCaseDefinition,
  hashEvalResult,
  hashEvalResultSet,
  hashFinalCaseResult,
  hashRestResult,
  hashRestResultSet
} from "@cortex-eval/domain/src/domain-hash-inputs.ts";
import {
  hashEndpointConfig,
  hashLlmConfig
} from "@cortex-eval/domain/src/domain-resource-hashes.ts";
import {
  createReportAccumulator,
  type ReportAggregationResult
} from "@cortex-eval/application/src/features/reporting/report-aggregation-boundary.ts";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { initializeSqliteStorage } from "../src/sqlite-database.ts";

const PACKAGE_ID = "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeeee";
const EXECUTION_ID = "018f22aa-33bb-7ccc-8ddd-fffffffffff1";
const RUN_ID = "018f22aa-33bb-7ccc-8ddd-fffffffffff2";
const CONTEXT_HASH = "a".repeat(64);
const EVALUATION_CONTEXT_HASH = "b".repeat(64);
const ARTIFACT_HASH = "c".repeat(64);
const TIME = "2026-07-15T00:00:00.000Z";

function fixture(): {
  readonly item: ImportedExecutionReportCase;
  readonly restResultSetHash: string;
  readonly evaluationResultSetHash: string;
  readonly report: ReportAggregationResult;
} {
  const testCase: ImportedExecutionReportCase["testCase"] = {
    caseKey: "case-1",
    ordinal: 0,
    definitionHash: "",
    definition: {
      caseKey: "case-1",
      description: "fixture",
      threshold: 1,
      task: "reply",
      requestBody: {},
      metadata: {
        requestId: "req-1",
        taskId: "task-1",
        businessModule: "fixture",
        scenarioTag: "basic"
      },
      assertions: [{ type: "contains", metric: "quality", weight: 1, value: "ok" }]
    }
  };
  const definitionHash = hashCaseDefinition({
    contractVersion: "cortex.case-definition.v1",
    caseKey: testCase.caseKey,
    definition: caseDefinitionJson(testCase.definition)
  });
  const providerOutput = { ok: false as const, errorMessage: "business failure" };
  const restResultHash = hashRestResult({
    contractVersion: "cortex.rest-result.v1",
    caseKey: testCase.caseKey,
    caseDefinitionHash: definitionHash,
    result: { status: "SUCCEEDED", httpStatus: 200, providerOutput }
  });
  const restResultSetHash = hashRestResultSet({
    contractVersion: "cortex.rest-result-set.v1",
    cases: [{ caseKey: testCase.caseKey, ordinal: 0, resultHash: restResultHash }]
  });
  const evaluationFacts = {
    caseKey: testCase.caseKey,
    ordinal: 0,
    status: "FAIL" as const,
    promptfooSuccess: false,
    score: 0,
    reason: "failed",
    evaluationError: null,
    assertions: [],
    diffs: [],
    metrics: [{ metric: "quality", status: "FAIL" as const }],
    latencyMs: null,
    tokenUsage: null,
    cost: null,
    rawEvidence: null,
    provenance: null
  };
  const evalResultHash = hashEvalResult({
    contractVersion: "cortex.eval-result.v1",
    caseKey: testCase.caseKey,
    status: evaluationFacts.status,
    promptfooSuccess: evaluationFacts.promptfooSuccess,
    score: evaluationFacts.score,
    reason: evaluationFacts.reason,
    evaluationError: evaluationFacts.evaluationError,
    assertions: evaluationFacts.assertions,
    diffs: evaluationFacts.diffs,
    metrics: evaluationFacts.metrics
  });
  const finalCaseResultHash = hashFinalCaseResult({
    contractVersion: "cortex.final-case-result.v1",
    caseDefinitionHash: definitionHash,
    restResultHash,
    evalResultHash
  });
  const evaluationResultSetHash = hashEvalResultSet({
    contractVersion: "cortex.eval-result-set.v1",
    owner: { kind: "EXECUTION", id: EXECUTION_ID },
    evaluationContextHash: EVALUATION_CONTEXT_HASH,
    cases: [{ caseKey: testCase.caseKey, ordinal: 0, evalResultHash }]
  });
  const item: ImportedExecutionReportCase = {
    testCase: { ...testCase, definitionHash },
    rest: {
      caseKey: testCase.caseKey,
      ordinal: 0,
      caseDefinitionHash: definitionHash,
      status: "SUCCEEDED",
      httpStatus: 200,
      providerOutput,
      errorType: null,
      errorMessage: null,
      durationMs: 1,
      completedAt: TIME,
      resultHash: restResultHash,
      provenance: null
    },
    evaluation: {
      ...evaluationFacts,
      evalResultHash,
      finalCaseResultHash
    }
  };
  const accumulator = createReportAccumulator({
    owner: { kind: "EXECUTION", id: EXECUTION_ID },
    runContextHash: CONTEXT_HASH,
    evaluationContextHash: EVALUATION_CONTEXT_HASH,
    evaluationResultSetHash,
    expectedCaseKey: (ordinal) => (ordinal === 0 ? testCase.caseKey : null)
  });
  accumulator.add({
    caseKey: testCase.caseKey,
    ordinal: 0,
    rest: { status: "SUCCEEDED", resultHash: restResultHash },
    evaluation: {
      status: "FAIL",
      evalResultHash,
      finalCaseResultHash,
      metrics: evaluationFacts.metrics
    }
  });
  const report = accumulator.finish();
  return { item, restResultSetHash, evaluationResultSetHash, report };
}

describe("SQLite Execution Report 完整导入", () => {
  it("在同一事务写入 Run/REST/Eval/重算 Summary，重复导入不重复写入", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-import-report-"));
    const storage = await initializeSqliteStorage({ projectRoot });
    const value = fixture();
    const openCases = (): AsyncIterable<ImportedExecutionReportCase> => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<ImportedExecutionReportCase> {
        await Promise.resolve();
        yield value.item;
      }
    });
    const useCase = new ImportExecutionReport({
      transactionManager: storage.createTransactionManager(),
      idGenerator: { nextId: (): string => RUN_ID },
      clock: { now: (): string => "2026-07-15T00:00:03.000Z" }
    });
    const command: ImportExecutionReportCommand = {
      packageId: PACKAGE_ID,
      executionId: EXECUTION_ID,
      restResultSetHash: value.restResultSetHash,
      evaluationContextHash: EVALUATION_CONTEXT_HASH,
      evaluationResultSetHash: value.evaluationResultSetHash,
      reportResultSetHash: value.report.reportResultSetHash,
      reportSummary: { summary: value.report.summary, byMetric: value.report.byMetric },
      suiteSnapshot: {
        id: PACKAGE_ID,
        name: "Imported Suite",
        suiteHash: "d".repeat(64),
        caseCount: 1
      },
      endpointSnapshot: {
        sourceId: null,
        name: "Imported Endpoint",
        configHash: hashEndpointConfig({
          contractVersion: "cortex.endpoint-config.v1",
          config: {
            urlTemplate: "https://example.test/{{vars.task}}",
            method: "POST",
            headers: {},
            bodySelector: "/request_body",
            timeoutMs: 1_000,
            defaultConcurrency: 4
          }
        }),
        definition: {
          urlTemplate: "https://example.test/{{vars.task}}",
          method: "POST" as const,
          headers: {},
          bodySelector: "/request_body",
          timeoutMs: 1_000,
          defaultConcurrency: 4
        }
      },
      evaluatorSnapshot: {
        sourceId: null,
        name: "Imported Evaluator",
        configHash: hashLlmConfig({
          contractVersion: "cortex.llm-config.v1",
          config: {
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
        }),
        definition: {
          providerType: "GOOGLE_GEMINI" as const,
          apiKey: { kind: "ENV_SECRET" as const, envKey: "GEMINI_API_KEY" },
          model: "gemini-test",
          thinkingLevel: "OFF" as const,
          temperature: 0,
          topP: 1,
          maxOutputTokens: 256,
          timeoutMs: 1_000,
          structuredOutput: "JSON_OBJECT" as const
        }
      },
      rubricPromptsSnapshot: [],
      runContextHash: CONTEXT_HASH,
      contractVersions: {
        caseDefinition: "cortex.case-definition.v1" as const,
        restResults: "cortex.rest-results-jsonl.v1" as const,
        normalizedEval: "cortex.normalized-eval-jsonl.v1" as const,
        report: "cortex.report.v1" as const,
        analysisInput: "cortex.analysis-input.v1" as const,
        analysisOutput: "cortex.analysis-output.v1" as const
      },
      runExecutionLimits: {
        contractVersion: "cortex.run-execution-limits.v1" as const,
        restConcurrency: 4,
        evalConcurrency: 2
      },
      artifactManifest: {
        contractVersion: "cortex.artifact-manifest.v1" as const,
        owner: { kind: "EXECUTION" as const, id: EXECUTION_ID },
        artifacts: [
          ["REST_RESULTS", "rest-results.jsonl", "cortex.rest-results-jsonl.v1"],
          ["NORMALIZED_EVAL_RESULTS", "normalized-eval.jsonl", "cortex.normalized-eval-jsonl.v1"],
          ["REPORT_JSON", "report.json", "cortex.report.v1"],
          ["REPORT_MARKDOWN", "report.md", "cortex.report-markdown.v1"]
        ].map(([kind, fileName, contractVersion]) => ({
          kind: kind as
            "REST_RESULTS" | "NORMALIZED_EVAL_RESULTS" | "REPORT_JSON" | "REPORT_MARKDOWN",
          path: `executions/${EXECUTION_ID}/${fileName}`,
          expectedSha256: ARTIFACT_HASH,
          expectedSizeBytes: 10,
          contractVersion: contractVersion ?? ""
        }))
      },
      executionCreatedAt: TIME,
      executionStartedAt: "2026-07-15T00:00:01.000Z",
      completedAt: "2026-07-15T00:00:02.000Z",
      openCases
    };

    await expect(
      useCase.execute({
        ...command,
        reportSummary: {
          summary: { ...value.report.summary, evalFail: 0, evalPass: 1 },
          byMetric: value.report.byMetric
        }
      })
    ).rejects.toMatchObject({ code: "SQLITE_ROW_INVALID" });
    const rolledBackDatabase = new Database(storage.databasePath, { readonly: true });
    const rolledBackCounts = rolledBackDatabase
      .prepare(
        "SELECT (SELECT COUNT(*) FROM run_log WHERE id = ?) AS run_count, (SELECT COUNT(*) FROM case_result WHERE run_id = ?) AS rest_count, (SELECT COUNT(*) FROM eval_result WHERE run_id = ?) AS eval_count"
      )
      .get(RUN_ID, RUN_ID, RUN_ID);
    rolledBackDatabase.close();
    expect(rolledBackCounts).toEqual({ run_count: 0, rest_count: 0, eval_count: 0 });

    await expect(useCase.execute(command)).resolves.toEqual({
      ok: true,
      runId: RUN_ID,
      idempotent: false
    });
    await expect(useCase.execute(command)).resolves.toEqual({
      ok: true,
      runId: RUN_ID,
      idempotent: true
    });

    const database = new Database(storage.databasePath, { readonly: true });
    const run = database
      .prepare(
        "SELECT result_set_hash, evaluation_result_set_hash, report_result_set_hash, summary_json FROM run_log WHERE id = ?"
      )
      .get(RUN_ID) as Record<string, unknown>;
    const counts = database
      .prepare(
        "SELECT (SELECT COUNT(*) FROM case_result WHERE run_id = ?) AS rest_count, (SELECT COUNT(*) FROM eval_result WHERE run_id = ?) AS eval_count"
      )
      .get(RUN_ID, RUN_ID);
    database.close();
    expect(run).toMatchObject({
      result_set_hash: value.restResultSetHash,
      evaluation_result_set_hash: value.evaluationResultSetHash,
      report_result_set_hash: value.report.reportResultSetHash
    });
    expect(JSON.parse(String(run.summary_json))).toEqual({
      summary: value.report.summary,
      byMetric: value.report.byMetric
    });
    expect(counts).toEqual({ rest_count: 1, eval_count: 1 });

    const manager = storage.createRunTransactionManager();
    const imported = await manager.execute(async (transaction) =>
      transaction.runs.getImportedReportRun(RUN_ID)
    );
    expect(imported).toMatchObject({
      id: RUN_ID,
      sourceType: "OFFLINE_IMPORT",
      packageId: PACKAGE_ID,
      executionId: EXECUTION_ID,
      suite: { id: PACKAGE_ID, name: "Imported Suite", caseCount: 1 },
      evaluationContextHash: EVALUATION_CONTEXT_HASH,
      reportResultSetHash: value.report.reportResultSetHash,
      contractVersions: {
        restResults: "cortex.rest-results-jsonl.v1",
        normalizedEval: "cortex.normalized-eval-jsonl.v1"
      }
    });
    expect(imported?.artifactManifest).toMatchObject({
      owner: { kind: "EXECUTION", id: EXECUTION_ID }
    });
    expect(imported?.artifactManifest.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "REST_RESULTS",
          path: `executions/${EXECUTION_ID}/rest-results.jsonl`,
          contractVersion: "cortex.rest-results-jsonl.v1"
        }),
        expect.objectContaining({
          kind: "NORMALIZED_EVAL_RESULTS",
          path: `executions/${EXECUTION_ID}/normalized-eval.jsonl`,
          contractVersion: "cortex.normalized-eval-jsonl.v1"
        })
      ])
    );
    const page = await manager.execute(async (transaction) =>
      transaction.runs.queryPlatformRuns({ limit: 10 })
    );
    expect(page.items).toMatchObject([
      {
        id: RUN_ID,
        sourceType: "OFFLINE_IMPORT",
        suiteId: PACKAGE_ID,
        suiteName: "Imported Suite",
        status: "COMPLETED",
        stage: "DONE"
      }
    ]);
    await storage.close();
  });
});
