import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

const REPORT_VERSION_COLUMNS = [
  "evaluation_context_hash",
  "evaluation_result_set_hash",
  "report_result_set_hash"
] as const;

// Add one optional immutable stage identity; the owning stage makes it non-null on commit.
async function addHashColumn(database: Kysely<unknown>, column: string): Promise<void> {
  await sql
    .raw(
      `ALTER TABLE run_log ADD COLUMN ${column} TEXT CHECK (` +
        `${column} IS NULL OR (length(${column}) = 64 AND ${column} NOT GLOB '*[^0-9a-f]*'))`
    )
    .execute(database);
}

// Keep REST, Evaluation and Report result versions independently addressable.
async function migrateReportingUp(database: Kysely<unknown>): Promise<void> {
  for (const column of REPORT_VERSION_COLUMNS) await addHashColumn(database, column);
}

// Remove only P8 version identities in reverse introduction order.
async function migrateReportingDown(database: Kysely<unknown>): Promise<void> {
  for (const column of [...REPORT_VERSION_COLUMNS].reverse()) {
    await sql.raw(`ALTER TABLE run_log DROP COLUMN ${column}`).execute(database);
  }
}

/** P8 independent Evaluation and Report version migration. */
export const REPORTING_MIGRATION: Migration = {
  up: migrateReportingUp,
  down: migrateReportingDown
};
