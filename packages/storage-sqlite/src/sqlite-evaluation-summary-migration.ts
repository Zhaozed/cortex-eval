import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

const EVALUATION_COUNTER_COLUMNS = [
  "eval_pass_count",
  "eval_fail_count",
  "eval_not_evaluated_count"
] as const;

const PROVENANCE_TRIGGER_NAMES = [
  "case_result_provenance_insert",
  "case_result_provenance_update",
  "eval_result_provenance_insert",
  "eval_result_provenance_update"
] as const;

// Add one nonnegative persisted counter without rebuilding immutable Run facts.
async function addCounterColumn(database: Kysely<unknown>, column: string): Promise<void> {
  await sql
    .raw(
      `ALTER TABLE run_log ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0 CHECK (${column} >= 0)`
    )
    .execute(database);
}

// Install cross-counter guards for every future Run insert and update.
async function createCounterTrigger(
  database: Kysely<unknown>,
  operation: "INSERT" | "UPDATE"
): Promise<void> {
  const suffix = operation.toLowerCase();
  await sql
    .raw(
      `
    CREATE TRIGGER run_log_eval_counters_${suffix}
    BEFORE ${operation} ON run_log
    WHEN NEW.eval_completed_count != (
      NEW.eval_pass_count + NEW.eval_fail_count +
      NEW.eval_error_count + NEW.eval_not_evaluated_count
    ) OR NEW.eval_completed_count > json_array_length(
      json_extract(NEW.suite_snapshot_json, '$.cases')
    )
    BEGIN
      SELECT RAISE(ABORT, 'RUN_EVALUATION_COUNTERS_INVALID');
    END
  `
    )
    .execute(database);
}

// Enforce exactly one source identity without rewriting the published P5 tables.
async function createProvenanceTrigger(
  database: Kysely<unknown>,
  input: {
    readonly table: "case_result" | "eval_result";
    readonly operation: "INSERT" | "UPDATE";
    readonly resultHashColumn: "reused_result_hash" | "reused_eval_result_hash";
  }
): Promise<void> {
  const triggerName = `${input.table}_provenance_${input.operation.toLowerCase()}`;
  await sql
    .raw(
      `
    CREATE TRIGGER ${triggerName}
    BEFORE ${input.operation} ON ${input.table}
    WHEN NOT (
      (
        NEW.reused_from_run_id IS NULL AND
        NEW.reused_from_execution_id IS NULL AND
        NEW.${input.resultHashColumn} IS NULL
      ) OR (
        NEW.${input.resultHashColumn} IS NOT NULL AND (
          (NEW.reused_from_run_id IS NOT NULL AND NEW.reused_from_execution_id IS NULL) OR
          (NEW.reused_from_run_id IS NULL AND NEW.reused_from_execution_id IS NOT NULL)
        )
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'RUN_RESULT_PROVENANCE_INVALID');
    END
  `
    )
    .execute(database);
}

// Persist complete Evaluation classifications and guard their atomic invariant.
async function migrateEvaluationSummaryUp(database: Kysely<unknown>): Promise<void> {
  for (const column of EVALUATION_COUNTER_COLUMNS) await addCounterColumn(database, column);
  await createCounterTrigger(database, "INSERT");
  await createCounterTrigger(database, "UPDATE");
  for (const operation of ["INSERT", "UPDATE"] as const) {
    await createProvenanceTrigger(database, {
      table: "case_result",
      operation,
      resultHashColumn: "reused_result_hash"
    });
    await createProvenanceTrigger(database, {
      table: "eval_result",
      operation,
      resultHashColumn: "reused_eval_result_hash"
    });
  }
}

// Remove only schema facts introduced by this migration.
async function migrateEvaluationSummaryDown(database: Kysely<unknown>): Promise<void> {
  for (const trigger of PROVENANCE_TRIGGER_NAMES) {
    await sql.raw(`DROP TRIGGER IF EXISTS ${trigger}`).execute(database);
  }
  await sql`DROP TRIGGER IF EXISTS run_log_eval_counters_update`.execute(database);
  await sql`DROP TRIGGER IF EXISTS run_log_eval_counters_insert`.execute(database);
  for (const column of [...EVALUATION_COUNTER_COLUMNS].reverse()) {
    await sql.raw(`ALTER TABLE run_log DROP COLUMN ${column}`).execute(database);
  }
}

/** P6 persisted Evaluation summary projection and integrity guards. */
export const EVALUATION_SUMMARY_MIGRATION: Migration = {
  up: migrateEvaluationSummaryUp,
  down: migrateEvaluationSummaryDown
};
