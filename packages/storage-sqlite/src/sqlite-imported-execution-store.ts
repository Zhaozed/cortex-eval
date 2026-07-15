import type {
  ExistingImportedExecution,
  ExistingImportedExecutionReport,
  ImportedExecutionArtifactManifest,
  ImportedExecutionRecord,
  ImportedExecutionReportCase,
  ImportedExecutionReportRecord
} from "@cortex-eval/application/src/features/execution-imports/execution-import-models.ts";
import { importedExecutionArtifactManifestJson } from "@cortex-eval/application/src/features/execution-imports/execution-import-models.ts";
import { canonicalJson } from "@cortex-eval/domain/src/domain-canonical-hash.ts";
import { hashFinalCaseResult } from "@cortex-eval/domain/src/domain-hash-inputs.ts";
import { createReportAccumulator } from "@cortex-eval/application/src/features/reporting/report-aggregation-boundary.ts";
import { sql, type Kysely } from "kysely";
import { z } from "zod";

import { SqliteRowInvalidError } from "./sqlite-row-mappers.ts";
import {
  frozenEndpointSnapshotJson,
  frozenEvaluatorSnapshotJson,
  frozenRubricPromptsSnapshotJson
} from "./sqlite-platform-run-mappers.ts";
import {
  platformRestResultHashMatches,
  requireRunTimestamp,
  restResultInsertValues
} from "./sqlite-platform-rest-mappers.ts";
import {
  evalResultInsertValues,
  platformEvalResultHashMatches
} from "./sqlite-platform-eval-mappers.ts";
import type { SqliteDatabaseSchema } from "./sqlite-schema.ts";

const ImportedExecutionArtifactManifestSchema = z.strictObject({
  contractVersion: z.literal("cortex.artifact-manifest.v1"),
  owner: z.strictObject({ kind: z.literal("EXECUTION"), id: z.string().trim().min(1) }),
  artifacts: z.array(
    z.strictObject({
      kind: z.enum([
        "REST_RESULTS",
        "RAW_PROMPTFOO_EVIDENCE",
        "NORMALIZED_EVAL_RESULTS",
        "REPORT_JSON",
        "REPORT_MARKDOWN",
        "ANALYSIS_RESULTS"
      ]),
      path: z
        .string()
        .min(1)
        .refine(
          (value) =>
            !value.startsWith("/") &&
            !value.includes("\\") &&
            value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
        ),
      expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
      expectedSizeBytes: z.number().int().nonnegative(),
      contractVersion: z.string().regex(/^[a-z0-9.-]+$/)
    })
  )
});

// Clean one persisted Manifest before returning it to Application identity logic.
function parseArtifactManifest(
  serialized: string,
  executionId: string
): ImportedExecutionArtifactManifest {
  try {
    const value = ImportedExecutionArtifactManifestSchema.parse(JSON.parse(serialized) as unknown);
    if (value.owner.id !== executionId) throw new SqliteRowInvalidError();
    const kinds = new Set<string>();
    const paths = new Set<string>();
    const artifactPrefix = `executions/${executionId}/`;
    for (const artifact of value.artifacts) {
      if (
        kinds.has(artifact.kind) ||
        paths.has(artifact.path) ||
        !artifact.path.startsWith(artifactPrefix)
      ) {
        throw new SqliteRowInvalidError();
      }
      kinds.add(artifact.kind);
      paths.add(artifact.path);
    }
    return value;
  } catch (error) {
    if (error instanceof SqliteRowInvalidError) throw error;
    throw new SqliteRowInvalidError();
  }
}

/** SQLite persistence dedicated to offline Execution import identity. */
export class SqliteImportedExecutionStore {
  /** Transaction-bound database connection. */
  readonly #database: Kysely<SqliteDatabaseSchema>;

  /** Bind all reads and writes to one managed transaction. */
  public constructor(database: Kysely<SqliteDatabaseSchema>) {
    this.#database = database;
  }

  /** Read one existing offline Execution identity. */
  public async get(executionId: string): Promise<ExistingImportedExecution | null> {
    const result = await sql<{
      readonly id: string;
      readonly source_type: string;
      readonly source_package_id: string | null;
      readonly result_set_hash: string;
      readonly artifact_manifest_json: string;
    }>`
      SELECT id, source_type, source_package_id, result_set_hash, artifact_manifest_json
      FROM run_log
      WHERE execution_id = ${executionId}
      LIMIT 1
    `.execute(this.#database);
    const row = result.rows[0];
    if (row === undefined) return null;
    if (row.source_type !== "OFFLINE_IMPORT" || row.source_package_id === null) {
      throw new SqliteRowInvalidError();
    }
    return {
      runId: row.id,
      sourceType: "OFFLINE_IMPORT",
      packageId: row.source_package_id,
      resultSetHash: row.result_set_hash,
      artifactManifest: parseArtifactManifest(row.artifact_manifest_json, executionId)
    };
  }

  /** Read one existing complete offline Report import identity. */
  public async getReport(executionId: string): Promise<ExistingImportedExecutionReport | null> {
    const row = await this.#database
      .selectFrom("run_log")
      .select([
        "id",
        "source_type",
        "source_package_id",
        "result_set_hash",
        "evaluation_context_hash",
        "evaluation_result_set_hash",
        "report_result_set_hash",
        "artifact_manifest_json"
      ])
      .where("execution_id", "=", executionId)
      .executeTakeFirst();
    if (row === undefined) return null;
    if (
      row.source_type !== "OFFLINE_IMPORT" ||
      row.source_package_id === null ||
      row.result_set_hash === null ||
      row.evaluation_context_hash === null ||
      row.evaluation_result_set_hash === null ||
      row.report_result_set_hash === null
    ) {
      throw new SqliteRowInvalidError();
    }
    return {
      runId: row.id,
      sourceType: "OFFLINE_IMPORT",
      packageId: row.source_package_id,
      restResultSetHash: row.result_set_hash,
      evaluationContextHash: row.evaluation_context_hash,
      evaluationResultSetHash: row.evaluation_result_set_hash,
      reportResultSetHash: row.report_result_set_hash,
      artifactManifest: parseArtifactManifest(row.artifact_manifest_json, executionId)
    };
  }

  /** Insert one normalized minimal imported Run registration. */
  public async insert(value: ImportedExecutionRecord): Promise<void> {
    const status = value.hasErrors ? "COMPLETED_WITH_ERRORS" : "COMPLETED";
    await sql`
      INSERT INTO run_log (
        id, source_type, source_package_id, execution_id, source_run_id, rerun_mode,
        suite_snapshot_json, endpoint_snapshot_json, evaluator_snapshot_json,
        rubric_prompts_snapshot_json, run_context_hash, promptfoo_version,
        contract_versions_json, run_execution_limits_json, run_mode, status, stage,
        lock_revision, summary_json, result_set_hash, artifact_manifest_json,
        completed_at, created_at, updated_at
      ) VALUES (
        ${value.runId}, 'OFFLINE_IMPORT', ${value.packageId}, ${value.executionId}, NULL, 'NONE',
        ${canonicalJson(value.suiteSnapshot)}, ${canonicalJson(value.endpointSnapshot)},
        ${canonicalJson(value.evaluatorSnapshot)}, ${canonicalJson([...value.rubricPromptsSnapshot])},
        ${value.runContextHash}, '0.121.18', ${canonicalJson(value.contractVersions)},
        ${canonicalJson(value.runExecutionLimits)}, 'STAGED', ${status}, 'DONE', 0,
        NULL, ${value.resultSetHash}, ${canonicalJson(
          importedExecutionArtifactManifestJson(value.artifactManifest)
        )},
        ${value.createdAt}, ${value.createdAt}, ${value.createdAt}
      )
    `.execute(this.#database);
  }

  /** Atomically stream, recompute and persist one complete imported Report Run. */
  public async insertReport(
    value: ImportedExecutionReportRecord,
    cases: AsyncIterable<ImportedExecutionReportCase>
  ): Promise<void> {
    requireRunTimestamp(value.executionCreatedAt);
    if (value.executionStartedAt !== null) requireRunTimestamp(value.executionStartedAt);
    requireRunTimestamp(value.completedAt);
    requireRunTimestamp(value.importedAt);
    const manifest = parseArtifactManifest(
      canonicalJson(importedExecutionArtifactManifestJson(value.artifactManifest)),
      value.executionId
    );
    const kinds = new Set(manifest.artifacts.map((artifact) => artifact.kind));
    if (
      !kinds.has("REST_RESULTS") ||
      !kinds.has("NORMALIZED_EVAL_RESULTS") ||
      !kinds.has("REPORT_JSON") ||
      !kinds.has("REPORT_MARKDOWN") ||
      kinds.has("ANALYSIS_RESULTS")
    ) {
      throw new SqliteRowInvalidError();
    }
    const hasErrors =
      value.reportSummary.summary.restError > 0 || value.reportSummary.summary.evalError > 0;
    await sql`
      INSERT INTO run_log (
        id, source_type, source_package_id, execution_id, source_run_id, rerun_mode,
        suite_id, suite_snapshot_json, endpoint_snapshot_json, evaluator_snapshot_json,
        rubric_prompts_snapshot_json, run_context_hash, promptfoo_version,
        contract_versions_json, run_execution_limits_json, run_mode, status, stage,
        lock_revision, cancel_requested_at, rest_completed_count, rest_error_count,
        eval_completed_count, eval_pass_count, eval_fail_count, eval_error_count,
        eval_not_evaluated_count, summary_json, result_set_hash, evaluation_context_hash,
        evaluation_result_set_hash, report_result_set_hash, artifact_manifest_json,
        error_code, error_message, started_at, completed_at, created_at, updated_at
      ) VALUES (
        ${value.runId}, 'OFFLINE_IMPORT', ${value.packageId}, ${value.executionId}, NULL, 'NONE',
        CASE
          WHEN EXISTS (SELECT 1 FROM test_suite WHERE id = ${value.suiteSnapshot.id})
            THEN ${value.suiteSnapshot.id}
          ELSE NULL
        END,
        ${canonicalJson({
          contractVersion: "cortex.run-snapshot.v1",
          kind: "IMPORTED_SUITE",
          ...value.suiteSnapshot
        })}, ${canonicalJson(frozenEndpointSnapshotJson(value.endpointSnapshot))},
        ${canonicalJson(frozenEvaluatorSnapshotJson(value.evaluatorSnapshot))},
        ${canonicalJson(frozenRubricPromptsSnapshotJson(value.rubricPromptsSnapshot))},
        ${value.runContextHash}, '0.121.18', ${canonicalJson({ ...value.contractVersions })},
        ${canonicalJson({ ...value.runExecutionLimits })}, 'STAGED',
        ${hasErrors ? "COMPLETED_WITH_ERRORS" : "COMPLETED"}, 'DONE', 0, NULL,
        ${value.reportSummary.summary.total}, ${value.reportSummary.summary.restError},
        ${value.reportSummary.summary.total}, ${value.reportSummary.summary.evalPass},
        ${value.reportSummary.summary.evalFail}, ${value.reportSummary.summary.evalError},
        ${value.reportSummary.summary.notEvaluated},
        ${canonicalJson({
          summary: { ...value.reportSummary.summary },
          byMetric: value.reportSummary.byMetric.map((item) => ({ ...item }))
        })},
        ${value.restResultSetHash}, ${value.evaluationContextHash},
        ${value.evaluationResultSetHash}, ${value.reportResultSetHash},
        ${canonicalJson(importedExecutionArtifactManifestJson(value.artifactManifest))},
        NULL, NULL, ${value.executionStartedAt}, ${value.completedAt},
        ${value.executionCreatedAt}, ${value.importedAt}
      )
    `.execute(this.#database);

    let nextOrdinal = 0;
    let currentCaseKey: string | null = null;
    const accumulator = createReportAccumulator({
      owner: { kind: "EXECUTION", id: value.executionId },
      runContextHash: value.runContextHash,
      evaluationContextHash: value.evaluationContextHash,
      evaluationResultSetHash: value.evaluationResultSetHash,
      expectedCaseKey: (ordinal) =>
        ordinal === nextOrdinal && currentCaseKey !== null ? currentCaseKey : null
    });
    for await (const item of cases) {
      const rest = { ...item.rest, runId: value.runId, definition: item.testCase.definition };
      const evaluation = {
        ...item.evaluation,
        runId: value.runId,
        createdAt: value.importedAt,
        updatedAt: value.importedAt
      };
      if (
        item.testCase.ordinal !== nextOrdinal ||
        item.rest.ordinal !== nextOrdinal ||
        item.evaluation.ordinal !== nextOrdinal ||
        item.testCase.caseKey !== item.rest.caseKey ||
        item.testCase.caseKey !== item.evaluation.caseKey ||
        item.testCase.definitionHash !== item.rest.caseDefinitionHash ||
        !platformRestResultHashMatches(rest) ||
        !platformEvalResultHashMatches(evaluation) ||
        hashFinalCaseResult({
          contractVersion: "cortex.final-case-result.v1",
          caseDefinitionHash: item.testCase.definitionHash,
          restResultHash: item.rest.resultHash,
          evalResultHash: item.evaluation.evalResultHash
        }) !== item.evaluation.finalCaseResultHash
      ) {
        throw new SqliteRowInvalidError();
      }
      currentCaseKey = item.testCase.caseKey;
      accumulator.add({
        caseKey: item.testCase.caseKey,
        ordinal: nextOrdinal,
        rest: { status: item.rest.status, resultHash: item.rest.resultHash },
        evaluation: {
          status: item.evaluation.status,
          evalResultHash: item.evaluation.evalResultHash,
          finalCaseResultHash: item.evaluation.finalCaseResultHash,
          metrics: item.evaluation.metrics
        }
      });
      await this.#database.insertInto("case_result").values(restResultInsertValues(rest)).execute();
      await this.#database
        .insertInto("eval_result")
        .values(evalResultInsertValues(evaluation))
        .execute();
      nextOrdinal += 1;
      currentCaseKey = null;
    }
    const aggregation = accumulator.finish();
    if (
      nextOrdinal !== value.reportSummary.summary.total ||
      aggregation.reportResultSetHash !== value.reportResultSetHash ||
      canonicalJson({ ...aggregation.summary }) !==
        canonicalJson({ ...value.reportSummary.summary }) ||
      canonicalJson(aggregation.byMetric.map((item) => ({ ...item }))) !==
        canonicalJson(value.reportSummary.byMetric.map((item) => ({ ...item })))
    ) {
      throw new SqliteRowInvalidError();
    }
  }
}
