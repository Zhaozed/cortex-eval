import type {
  ExistingImportedExecution,
  ImportedExecutionArtifactManifest,
  ImportedExecutionRecord
} from "@cortex-eval/application/src/features/execution-imports/execution-import-models.ts";
import { importedExecutionArtifactManifestJson } from "@cortex-eval/application/src/features/execution-imports/execution-import-models.ts";
import { canonicalJson } from "@cortex-eval/domain/src/domain-canonical-hash.ts";
import { sql, type Kysely } from "kysely";
import { z } from "zod";

import { SqliteRowInvalidError } from "./sqlite-row-mappers.ts";
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
}
