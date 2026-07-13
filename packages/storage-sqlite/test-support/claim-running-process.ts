import Database from "better-sqlite3";

const databasePath = process.argv[2];
const runId = process.argv[3];
if (databasePath === undefined || runId === undefined) {
  process.exitCode = 2;
} else {
  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  try {
    database
      .prepare(
        `INSERT INTO run_log (
          id, source_type, rerun_mode, suite_snapshot_json, endpoint_snapshot_json,
          evaluator_snapshot_json, rubric_prompts_snapshot_json, run_context_hash,
          promptfoo_version, contract_versions_json, run_execution_limits_json,
          run_mode, status, stage, artifact_manifest_json, created_at, updated_at
        ) VALUES (?, 'PLATFORM', 'NONE', '{}', '{}', '{}', '[]', ?, '0.121.18',
          '{}', '{}', 'STAGED', 'RUNNING', 'REST', '[]', ?, ?)`
      )
      .run(runId, "a".repeat(64), "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    process.stdout.write("SUCCESS\n");
  } catch (error) {
    const code =
      error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
    if (typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT")) {
      process.stdout.write("CONFLICT\n");
    } else {
      throw error;
    }
  } finally {
    database.close();
  }
}
