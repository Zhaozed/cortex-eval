import { describe, expect, it, vi } from "vitest";

import type {
  ApplicationTransaction,
  RunReferenceRepository,
  TransactionManager
} from "../src/application-ports.ts";
import type {
  ExistingImportedExecutionReport,
  ImportedExecutionReportCase,
  ImportedExecutionReportRecord
} from "../src/features/execution-imports/execution-import-models.ts";
import {
  ImportExecutionReport,
  type ImportExecutionReportCommand
} from "../src/features/execution-imports/import-execution-report.ts";

const PACKAGE_ID = "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeeee";
const EXECUTION_ID = "018f22aa-33bb-7ccc-8ddd-fffffffffff1";
const RUN_ID = "018f22aa-33bb-7ccc-8ddd-fffffffffff2";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

function importedCase(): ImportedExecutionReportCase {
  return {
    testCase: {
      caseKey: "case-1",
      ordinal: 0,
      definitionHash: HASH_A,
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
    },
    rest: {
      caseKey: "case-1",
      ordinal: 0,
      caseDefinitionHash: HASH_A,
      status: "SUCCEEDED",
      httpStatus: 200,
      providerOutput: { ok: false, errorMessage: "business failure" },
      errorType: null,
      errorMessage: null,
      durationMs: 1,
      completedAt: "2026-07-15T00:00:00.000Z",
      resultHash: HASH_B,
      provenance: null
    },
    evaluation: {
      caseKey: "case-1",
      ordinal: 0,
      status: "FAIL",
      promptfooSuccess: false,
      score: 0,
      reason: "failed",
      evaluationError: null,
      assertions: [],
      diffs: [],
      metrics: [{ metric: "quality", status: "FAIL" }],
      latencyMs: null,
      tokenUsage: null,
      cost: null,
      rawEvidence: null,
      evalResultHash: HASH_C,
      finalCaseResultHash: HASH_D,
      provenance: null
    }
  };
}

function command(openCases = vi.fn(source)): ImportExecutionReportCommand {
  return {
    packageId: PACKAGE_ID,
    executionId: EXECUTION_ID,
    restResultSetHash: HASH_A,
    evaluationContextHash: HASH_B,
    evaluationResultSetHash: HASH_C,
    reportResultSetHash: HASH_D,
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
    suiteSnapshot: { id: PACKAGE_ID, name: "Suite", suiteHash: HASH_A, caseCount: 1 },
    endpointSnapshot: {
      sourceId: null,
      name: "Endpoint",
      configHash: HASH_A,
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
      name: "Evaluator",
      configHash: HASH_B,
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
    runContextHash: HASH_A,
    contractVersions: {
      caseDefinition: "cortex.case-definition.v1" as const,
      restResults: "cortex.rest-results-jsonl.v1" as const,
      normalizedEval: "cortex.normalized-eval-jsonl.v1" as const,
      report: "cortex.report.v1" as const,
      analysisInput: "cortex.analysis-input.v1" as const,
      analysisOutput: "cortex.analysis-output.v1" as const
    },
    runExecutionLimits: {
      contractVersion: "cortex.run-execution-limits.v1",
      restConcurrency: 4,
      evalConcurrency: 2
    },
    artifactManifest: {
      contractVersion: "cortex.artifact-manifest.v1" as const,
      owner: { kind: "EXECUTION" as const, id: EXECUTION_ID },
      artifacts: [
        {
          kind: "REPORT_JSON" as const,
          path: `executions/${EXECUTION_ID}/report.json`,
          expectedSha256: HASH_A,
          expectedSizeBytes: 10,
          contractVersion: "cortex.report.v1"
        }
      ]
    },
    executionCreatedAt: "2026-07-15T00:00:00.000Z",
    executionStartedAt: "2026-07-15T00:00:01.000Z",
    completedAt: "2026-07-15T00:00:02.000Z",
    openCases
  } as const;
}

function source(): AsyncIterable<ImportedExecutionReportCase> {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<ImportedExecutionReportCase> {
      await Promise.resolve();
      yield importedCase();
    }
  };
}

class FakeImportStore implements TransactionManager {
  public existing: ExistingImportedExecutionReport | null = null;
  public inserted: ImportedExecutionReportRecord | null = null;
  public cases: ImportedExecutionReportCase[] = [];

  public async execute<Value>(
    work: (transaction: ApplicationTransaction) => Promise<Value>
  ): Promise<Value> {
    const runs: RunReferenceRepository = {
      hasActiveResourceReference: () => Promise.resolve(false),
      getImportedExecution: () => Promise.resolve(null),
      getImportedExecutionReport: () => Promise.resolve(this.existing),
      insertImportedExecution: () => Promise.reject(new Error("unexpected identity-only insert")),
      insertImportedExecutionReport: async (record, cases): Promise<void> => {
        const captured: ImportedExecutionReportCase[] = [];
        for await (const item of cases) captured.push(item);
        this.inserted = record;
        this.cases = captured;
        this.existing = {
          runId: record.runId,
          sourceType: "OFFLINE_IMPORT",
          packageId: record.packageId,
          restResultSetHash: record.restResultSetHash,
          evaluationContextHash: record.evaluationContextHash,
          evaluationResultSetHash: record.evaluationResultSetHash,
          reportResultSetHash: record.reportResultSetHash,
          artifactManifest: record.artifactManifest
        };
      }
    };
    return await work({
      runs,
      testSuites: {} as ApplicationTransaction["testSuites"],
      configurations: {} as ApplicationTransaction["configurations"]
    });
  }
}

describe("Execution Report 完整导入", () => {
  it("首次导入在一个事务中消费完整明细并保存四个阶段身份", async () => {
    const store = new FakeImportStore();
    const useCase = new ImportExecutionReport({
      transactionManager: store,
      idGenerator: { nextId: (): string => RUN_ID },
      clock: { now: (): string => "2026-07-15T00:00:03.000Z" }
    });

    const result = await useCase.execute(command());

    expect(result).toEqual({ ok: true, runId: RUN_ID, idempotent: false });
    expect(store.inserted).toMatchObject({
      runId: RUN_ID,
      packageId: PACKAGE_ID,
      executionId: EXECUTION_ID,
      restResultSetHash: HASH_A,
      evaluationContextHash: HASH_B,
      evaluationResultSetHash: HASH_C,
      reportResultSetHash: HASH_D,
      importedAt: "2026-07-15T00:00:03.000Z"
    });
    expect(store.cases).toEqual([importedCase()]);
  });

  it("完全相同的版本和 Manifest 幂等且不再次消费明细，任一版本变化均冲突", async () => {
    const store = new FakeImportStore();
    const useCase = new ImportExecutionReport({
      transactionManager: store,
      idGenerator: { nextId: (): string => RUN_ID },
      clock: { now: (): string => "2026-07-15T00:00:03.000Z" }
    });
    await useCase.execute(command());
    const idempotentSource = vi.fn(source);

    await expect(useCase.execute(command(idempotentSource))).resolves.toEqual({
      ok: true,
      runId: RUN_ID,
      idempotent: true
    });
    expect(idempotentSource).not.toHaveBeenCalled();
    for (const changed of [
      { restResultSetHash: HASH_B },
      { evaluationContextHash: HASH_C },
      { evaluationResultSetHash: HASH_D },
      { reportResultSetHash: HASH_A }
    ]) {
      await expect(useCase.execute({ ...command(), ...changed })).resolves.toEqual({
        ok: false,
        error: { code: "EXECUTION_RESULT_CONFLICT", executionId: EXECUTION_ID }
      });
    }
  });
});
