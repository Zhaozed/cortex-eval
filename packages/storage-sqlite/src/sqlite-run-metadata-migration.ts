import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/** Optional display metadata only; do not backfill history or rewrite frozen snapshots. */
export const RUN_METADATA_MIGRATION: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`ALTER TABLE run_log ADD COLUMN run_name TEXT CHECK (run_name IS NULL OR (length(trim(run_name)) BETWEEN 1 AND 120))`.execute(
      database
    );
    await sql`ALTER TABLE run_log ADD COLUMN run_description TEXT CHECK (run_description IS NULL OR length(run_description) <= 2000)`.execute(
      database
    );
  },
  async down(database: Kysely<unknown>): Promise<void> {
    await sql`ALTER TABLE run_log DROP COLUMN run_description`.execute(database);
    await sql`ALTER TABLE run_log DROP COLUMN run_name`.execute(database);
  }
};
