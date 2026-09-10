import type { OfflineRestCaseResult } from "@cortex-eval/application/src/features/runs/offline-rest-execution-service.ts";
import type { FrozenRunCase } from "@cortex-eval/application/src/features/runs/run-rest-models.ts";
import {
  EvalCaseV1Schema,
  ReportCaseV1Schema,
  type EvalCaseV1,
  type ReportCaseV1
} from "@cortex-eval/contracts/src/artifact-contracts.ts";
import {
  CaseDefinitionV1Schema,
  type AssertionDefinitionV1
} from "@cortex-eval/contracts/src/case-contracts.ts";
import {
  createReportAccumulator,
  type ReportAggregationResult,
  type ReportOwner
} from "@cortex-eval/reporting/src/report-aggregation.ts";

import { workPackageRestArtifactCase } from "./work-package-rest-artifact-writer.ts";

/** Replayable bounded sources needed for offline Report reconciliation. */
export interface PrepareWorkPackageReportInput {
  /** Immutable offline Execution version identity. */
  readonly owner: ReportOwner;
  /** Frozen Execution context identity. */
  readonly runContextHash: string;
  /** Frozen Evaluation context identity. */
  readonly evaluationContextHash: string;
  /** Complete Evaluation result-set identity. */
  readonly evaluationResultSetHash: string;
  /** Resolve one exact frozen Case identity without retaining another complete set. */
  readonly expectedCaseKey: (ordinal: number) => string | null;
  /** Open a fresh validated Canonical Case stream. */
  readonly openCases: () => AsyncIterable<FrozenRunCase>;
  /** Open a fresh validated REST result stream. */
  readonly openRestResults: () => AsyncIterable<OfflineRestCaseResult>;
  /** Open a fresh validated Normalized Eval result stream. */
  readonly openEvaluationResults: () => AsyncIterable<EvalCaseV1>;
}

/** Preflighted aggregate and replayable complete Report Case stream. */
export interface PreparedWorkPackageReport {
  /** Complete bounded report statistics and report version hash. */
  readonly aggregation: ReportAggregationResult;
  /** Re-run all trust checks while streaming complete Report JSON facts. */
  readonly openCases: () => AsyncIterable<ReportCaseV1>;
}

// Preserve the two stable report reconciliation errors and collapse boundary details.
function reportError(error: unknown): Error {
  if (
    error instanceof Error &&
    (error.message === "REPORT_CASE_ALIGNMENT" || error.message === "REPORT_RECONCILIATION_FAILED")
  ) {
    return error;
  }
  return new Error("REPORT_RECONCILIATION_FAILED", { cause: error });
}

// Project one clean recursive Domain Assertion into the frozen transport shape.
function assertionDefinition(
  value: FrozenRunCase["definition"]["assertions"][number]
): AssertionDefinitionV1 {
  return {
    type: value.type,
    metric: value.metric,
    weight: value.weight,
    ...(value.value === undefined ? {} : { value: value.value }),
    ...(value.threshold === undefined ? {} : { threshold: value.threshold }),
    ...(value.config === undefined ? {} : { config: value.config }),
    ...(value.rubricPrompt === undefined ? {} : { rubricPrompt: value.rubricPrompt }),
    ...(value.transform === undefined ? {} : { transform: value.transform }),
    ...(value.contextTransform === undefined ? {} : { contextTransform: value.contextTransform }),
    ...(value.assertions === undefined ? {} : { assert: value.assertions.map(assertionDefinition) })
  };
}

// Project one clean Domain Case into its strict v1 transport definition.
function caseDefinition(value: FrozenRunCase["definition"]): unknown {
  return {
    contractVersion: "cortex.case-definition.v1",
    description: value.description,
    threshold: value.threshold,
    vars: { task: value.task, request_body: value.requestBody },
    metadata: {
      case_id: value.caseKey,
      req_id: value.metadata.requestId,
      task_id: value.metadata.taskId,
      business_module: value.metadata.businessModule,
      scenario_tag: value.metadata.scenarioTag,
      ...(value.metadata.a2uiCapture === undefined
        ? {}
        : { a2ui_capture: value.metadata.a2uiCapture })
    },
    assert: value.assertions.map(assertionDefinition)
  };
}

// Map and strictly align one ordinal from all three frozen source streams.
function reportCase(
  testCase: FrozenRunCase,
  rest: OfflineRestCaseResult,
  evaluation: EvalCaseV1
): ReportCaseV1 {
  if (
    testCase.caseKey !== rest.caseKey ||
    testCase.caseKey !== evaluation.caseKey ||
    testCase.ordinal !== rest.ordinal ||
    testCase.ordinal !== evaluation.ordinal ||
    testCase.definitionHash !== rest.caseDefinitionHash
  ) {
    throw new Error("REPORT_CASE_ALIGNMENT");
  }
  return ReportCaseV1Schema.parse({
    caseKey: testCase.caseKey,
    ordinal: testCase.ordinal,
    definitionHash: testCase.definitionHash,
    definition: CaseDefinitionV1Schema.parse(caseDefinition(testCase.definition)),
    rest: workPackageRestArtifactCase(rest),
    evaluation: EvalCaseV1Schema.parse(evaluation)
  });
}

// Join three already bounded streams and reject every missing or extra item.
async function* alignedCases(input: PrepareWorkPackageReportInput): AsyncGenerator<ReportCaseV1> {
  const cases = input.openCases()[Symbol.asyncIterator]();
  const rest = input.openRestResults()[Symbol.asyncIterator]();
  const evaluations = input.openEvaluationResults()[Symbol.asyncIterator]();
  try {
    for (;;) {
      const [caseStep, restStep, evalStep] = await Promise.all([
        cases.next(),
        rest.next(),
        evaluations.next()
      ]);
      if (caseStep.done || restStep.done || evalStep.done) {
        if (!(caseStep.done && restStep.done && evalStep.done)) {
          throw new Error("REPORT_RECONCILIATION_FAILED");
        }
        return;
      }
      yield reportCase(caseStep.value, restStep.value, evalStep.value);
    }
  } catch (error) {
    throw reportError(error);
  } finally {
    await Promise.allSettled([cases.return?.(), rest.return?.(), evaluations.return?.()]);
  }
}

/** Preflight every Case and build only compact aggregate state before publication. */
export async function prepareWorkPackageReport(
  input: PrepareWorkPackageReportInput
): Promise<PreparedWorkPackageReport> {
  const accumulator = createReportAccumulator({
    owner: input.owner,
    runContextHash: input.runContextHash,
    evaluationContextHash: input.evaluationContextHash,
    evaluationResultSetHash: input.evaluationResultSetHash,
    expectedCaseKey: input.expectedCaseKey
  });
  try {
    for await (const item of alignedCases(input)) {
      accumulator.add({
        caseKey: item.caseKey,
        ordinal: item.ordinal,
        rest: { status: item.rest.status, resultHash: item.rest.resultHash },
        evaluation: {
          status: item.evaluation.status,
          evalResultHash: item.evaluation.evalResultHash,
          finalCaseResultHash: item.evaluation.finalCaseResultHash,
          metrics: item.evaluation.metrics
        }
      });
    }
    const aggregation = accumulator.finish();
    return {
      aggregation,
      openCases: (): AsyncIterable<ReportCaseV1> => alignedCases(input)
    };
  } catch (error) {
    throw reportError(error);
  }
}
