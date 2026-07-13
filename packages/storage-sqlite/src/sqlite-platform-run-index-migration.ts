import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

// Install the partial covering order used by latest platform Run aggregation.
async function migratePlatformRunIndexesUp(database: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE INDEX run_log_suite_latest_platform
    ON run_log(suite_id, created_at DESC, id DESC)
    WHERE source_type = 'PLATFORM'
  `.execute(database);
}

// Remove only the index owned by this migration.
async function migratePlatformRunIndexesDown(database: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS run_log_suite_latest_platform`.execute(database);
}

/** P5 indexes required by platform Run list aggregates. */
export const PLATFORM_RUN_INDEX_MIGRATION: Migration = {
  up: migratePlatformRunIndexesUp,
  down: migratePlatformRunIndexesDown
};
