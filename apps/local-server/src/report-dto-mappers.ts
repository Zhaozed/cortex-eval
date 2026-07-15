import type { PlatformEvalCaseResult } from "@cortex-eval/application/src/features/evaluation/platform-eval-models.ts";
import type { ImportedReportRun } from "@cortex-eval/application/src/features/execution-imports/execution-import-models.ts";
import type { PlatformReportCase } from "@cortex-eval/application/src/features/reporting/platform-report-service.ts";
import type {
  PlatformRun,
  StoredRestCaseResult
} from "@cortex-eval/application/src/features/runs/platform-run-models.ts";
import type { PlatformReportArtifactCaseInput } from "@cortex-eval/application/src/features/runs/run-artifact-port.ts";
import {
  EvalCaseV1Schema,
  ReportCaseV1Schema,
  ReportContextV1Schema,
  RestArtifactCaseV1Schema,
  type ReportCaseV1,
  type ReportContextV1,
  type RestArtifactCaseV1
} from "@cortex-eval/contracts/src/artifact-contracts.ts";
import { RunReportCaseV1Schema } from "@cortex-eval/contracts/src/run-api-contracts.ts";

import {
  mapCaseDefinitionToV1,
  mapEndpointDefinitionToV1,
  mapLlmDefinitionToV1
} from "./resource-dto-mappers.ts";

/** Map one durable REST fact to the shared Report/Artifact contract. */
export function mapReportRestResultToV1(value: StoredRestCaseResult): RestArtifactCaseV1 {
  const common = {
    caseKey: value.caseKey,
    ordinal: value.ordinal,
    caseDefinitionHash: value.caseDefinitionHash,
    status: value.status,
    httpStatus: value.httpStatus,
    durationMs: value.durationMs,
    completedAt: value.completedAt,
    resultHash: value.resultHash,
    provenance:
      value.provenance === null
        ? null
        : {
            sourceKind: value.provenance.sourceKind,
            sourceId: value.provenance.sourceId,
            sourceResultHash: value.provenance.sourceResultHash
          }
  };
  const projection =
    value.status === "SUCCEEDED"
      ? {
          ...common,
          providerOutput: value.providerOutput.ok
            ? {
                ok: true as const,
                task_name: value.providerOutput.taskName,
                resolved_config: value.providerOutput.resolvedConfig,
                parsed_output: value.providerOutput.parsedOutput
              }
            : { ok: false as const, err_msg: value.providerOutput.errorMessage }
        }
      : {
          ...common,
          providerOutput: null,
          error: { type: value.errorType, message: value.errorMessage }
        };
  return RestArtifactCaseV1Schema.parse(projection);
}

/** Remove persistence timestamps and owner duplication from one normalized Evaluation fact. */
export function mapReportEvaluationToV1(
  value: PlatformEvalCaseResult
): ReturnType<typeof EvalCaseV1Schema.parse> {
  return EvalCaseV1Schema.parse({
    caseKey: value.caseKey,
    ordinal: value.ordinal,
    status: value.status,
    promptfooSuccess: value.promptfooSuccess,
    score: value.score,
    reason: value.reason,
    evaluationError: value.evaluationError,
    assertions: value.assertions,
    diffs: value.diffs,
    metrics: value.metrics,
    latencyMs: value.latencyMs,
    tokenUsage: value.tokenUsage,
    cost: value.cost,
    rawEvidence: value.rawEvidence,
    evalResultHash: value.evalResultHash,
    finalCaseResultHash: value.finalCaseResultHash,
    provenance: value.provenance
  });
}

/** Map one frozen platform context to the complete safe Report context. */
export function mapRunReportContextToV1(run: PlatformRun | ImportedReportRun): ReportContextV1 {
  return ReportContextV1Schema.parse({
    contractVersion: "cortex.report-context.v1",
    runContextHash: run.runContextHash,
    suite: {
      sourceId: run.suite.id,
      name: run.suite.name,
      suiteHash: run.suite.suiteHash
    },
    endpoint: {
      sourceId: run.endpoint.sourceId,
      name: run.endpoint.name,
      configHash: run.endpoint.configHash,
      config: mapEndpointDefinitionToV1(run.endpoint.definition)
    },
    evaluator: {
      sourceId: run.evaluator.sourceId,
      name: run.evaluator.name,
      configHash: run.evaluator.configHash,
      config: mapLlmDefinitionToV1(run.evaluator.definition)
    },
    rubricPrompts: run.rubricPrompts.map((item) => ({
      sourceId: item.sourceId,
      promptKey: item.definition.promptKey,
      name: item.name,
      promptHash: item.promptHash
    })),
    promptfooVersion: run.promptfooVersion,
    runExecutionLimits: run.runExecutionLimits
  });
}

/** Map one aligned platform Report Case to the shared complete transport shape. */
export function mapAlignedPlatformReportCaseToV1(
  value: PlatformReportArtifactCaseInput
): ReportCaseV1 {
  return ReportCaseV1Schema.parse({
    caseKey: value.testCase.caseKey,
    ordinal: value.testCase.ordinal,
    definitionHash: value.testCase.definitionHash,
    definition: mapCaseDefinitionToV1(value.testCase.definition),
    rest: mapReportRestResultToV1(value.rest),
    evaluation: mapReportEvaluationToV1(value.evaluation)
  });
}

/** Add current raw-evidence availability to one aligned Report Case DTO. */
export function mapPlatformReportCaseToV1(
  value: PlatformReportCase
): ReturnType<typeof RunReportCaseV1Schema.parse> {
  const reportCase = mapAlignedPlatformReportCaseToV1(value);
  return RunReportCaseV1Schema.parse({
    ...reportCase,
    rawEvidenceStatus: value.rawEvidenceStatus
  });
}
