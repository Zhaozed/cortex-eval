import type { ImportedReportRun } from "@cortex-eval/application/src/features/execution-imports/execution-import-models.ts";
import type { Selectable } from "kysely";

import {
  ExecutionLimitsSchema,
  hasValidEvaluationCounters,
  ImportedContractVersionsSchema,
  ImportedSuiteSnapshotSchema,
  mapEndpoint,
  mapEvaluator,
  mapImportedManifest,
  mapRubricPrompts,
  parseJson,
  PersistedReportSummarySchema,
  Sha256Schema
} from "./sqlite-platform-run-mappers.ts";
import { SqliteRowInvalidError } from "./sqlite-row-mappers.ts";
import type { RunLogTable } from "./sqlite-schema.ts";

/** Map one complete imported Report history row without treating it as executable. */
export function mapImportedReportRunRow(row: Selectable<RunLogTable>): ImportedReportRun {
  if (
    row.source_type !== "OFFLINE_IMPORT" ||
    row.source_package_id === null ||
    row.execution_id === null ||
    row.source_run_id !== null ||
    row.rerun_mode !== "NONE" ||
    (row.status !== "COMPLETED" && row.status !== "COMPLETED_WITH_ERRORS") ||
    row.stage !== "DONE" ||
    row.result_set_hash === null ||
    row.evaluation_context_hash === null ||
    row.evaluation_result_set_hash === null ||
    row.report_result_set_hash === null ||
    row.summary_json === null ||
    row.completed_at === null ||
    !Sha256Schema.safeParse(row.run_context_hash).success
  ) {
    throw new SqliteRowInvalidError();
  }
  const suite = parseJson(ImportedSuiteSnapshotSchema, row.suite_snapshot_json);
  const endpoint = mapEndpoint(row.endpoint_snapshot_json);
  const evaluator = mapEvaluator(row.evaluator_snapshot_json);
  const rubricPrompts = mapRubricPrompts(row.rubric_prompts_snapshot_json);
  const contractVersions = parseJson(ImportedContractVersionsSchema, row.contract_versions_json);
  const runExecutionLimits = parseJson(ExecutionLimitsSchema, row.run_execution_limits_json);
  const reportSummary = parseJson(PersistedReportSummarySchema, row.summary_json);
  if (
    reportSummary.summary.total !== suite.caseCount ||
    !hasValidEvaluationCounters(row, suite.caseCount)
  ) {
    throw new SqliteRowInvalidError();
  }
  return {
    id: row.id,
    sourceType: "OFFLINE_IMPORT",
    packageId: row.source_package_id,
    executionId: row.execution_id,
    sourceRunId: null,
    rerunMode: "NONE",
    suite: {
      id: suite.id,
      name: suite.name,
      suiteHash: suite.suiteHash,
      caseCount: suite.caseCount
    },
    endpoint,
    evaluator,
    rubricPrompts,
    runContextHash: row.run_context_hash,
    promptfooVersion: "0.121.18",
    contractVersions,
    runExecutionLimits,
    status: row.status,
    stage: "DONE",
    restResultSetHash: row.result_set_hash,
    evaluationContextHash: row.evaluation_context_hash,
    evaluationResultSetHash: row.evaluation_result_set_hash,
    reportResultSetHash: row.report_result_set_hash,
    reportSummary,
    artifactManifest: mapImportedManifest(row.artifact_manifest_json, row.execution_id),
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
