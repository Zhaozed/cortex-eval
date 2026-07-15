import type { ImportedReportRun } from "@cortex-eval/application/src/features/execution-imports/execution-import-models.ts";
import type { PlatformEvalCaseResult } from "@cortex-eval/application/src/features/evaluation/platform-eval-models.ts";
import type { PlatformReportCase } from "@cortex-eval/application/src/features/reporting/platform-report-service.ts";
import type {
  PlatformRun,
  StoredRestCaseResult
} from "@cortex-eval/application/src/features/runs/platform-run-models.ts";

/** Build one complete normalized PASS fact for Report protocol mapping. */
export function passingEvaluationFixture(
  runId: string,
  caseKey: string,
  hash: string,
  now: string
): PlatformEvalCaseResult {
  return {
    runId,
    caseKey,
    ordinal: 0,
    status: "PASS",
    promptfooSuccess: true,
    score: 1,
    reason: "passed",
    evaluationError: null,
    assertions: [
      {
        index: 0,
        definitionHash: hash,
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
    evalResultHash: hash,
    finalCaseResultHash: hash,
    provenance: null,
    createdAt: now,
    updatedAt: now
  };
}

/** Complete one base platform Run with an independently versioned Report. */
export function reportedRunFixture(base: PlatformRun, now: string): PlatformRun {
  return {
    ...base,
    status: "COMPLETED",
    stage: "DONE",
    lockRevision: 5,
    evalCompletedCount: 1,
    evalPassCount: 1,
    evaluationContextHash: "b".repeat(64),
    evaluationResultSetHash: "c".repeat(64),
    reportResultSetHash: "d".repeat(64),
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
    completedAt: now
  };
}

/** Project one completed platform fixture into a complete imported Report history version. */
export function importedReportRunFixture(input: {
  readonly current: PlatformRun;
  readonly packageId: string;
  readonly executionId: string;
  readonly fallbackHash: string;
  readonly fallbackTime: string;
}): ImportedReportRun {
  const current = input.current;
  if (current.reportSummary === null || current.resultSetHash === null) {
    throw new Error("TEST_REPORT_RUN_INVALID");
  }
  return {
    id: current.id,
    sourceType: "OFFLINE_IMPORT",
    packageId: input.packageId,
    executionId: input.executionId,
    sourceRunId: null,
    rerunMode: "NONE",
    suite: {
      id: current.suite.id,
      name: current.suite.name,
      suiteHash: current.suite.suiteHash,
      caseCount: current.suite.cases.length
    },
    endpoint: current.endpoint,
    evaluator: current.evaluator,
    rubricPrompts: current.rubricPrompts,
    runContextHash: current.runContextHash,
    promptfooVersion: "0.121.18",
    contractVersions: {
      caseDefinition: "cortex.case-definition.v1",
      restResults: "cortex.rest-results.v1",
      normalizedEval: "cortex.normalized-eval.v1",
      report: "cortex.report.v1",
      analysisInput: "cortex.analysis-input.v1",
      analysisOutput: "cortex.analysis-output.v1"
    },
    runExecutionLimits: current.runExecutionLimits,
    status: "COMPLETED",
    stage: "DONE",
    restResultSetHash: current.resultSetHash,
    evaluationContextHash: current.evaluationContextHash ?? input.fallbackHash,
    evaluationResultSetHash: current.evaluationResultSetHash ?? input.fallbackHash,
    reportResultSetHash: current.reportResultSetHash ?? input.fallbackHash,
    reportSummary: current.reportSummary,
    artifactManifest: {
      contractVersion: "cortex.artifact-manifest.v1",
      owner: { kind: "EXECUTION", id: input.executionId },
      artifacts: []
    },
    completedAt: current.completedAt ?? input.fallbackTime,
    createdAt: current.createdAt,
    updatedAt: current.updatedAt
  };
}

/** Build one aligned complete Report Case from already valid fixture facts. */
export function reportCaseFixture(input: {
  readonly run: PlatformRun;
  readonly rest: StoredRestCaseResult;
  readonly evaluation: PlatformEvalCaseResult;
}): PlatformReportCase {
  const testCase = input.run.suite.cases[0];
  if (testCase === undefined) throw new Error("TEST_FROZEN_CASE_MISSING");
  return {
    testCase,
    rest: input.rest,
    evaluation: input.evaluation,
    rawEvidenceStatus: "ABSENT"
  };
}
