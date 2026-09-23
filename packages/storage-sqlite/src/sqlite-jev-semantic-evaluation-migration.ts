import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/** Add optional persisted JEV evidence without rewriting historical Eval hashes. */
export const JEV_SEMANTIC_EVALUATION_MIGRATION: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`ALTER TABLE eval_result ADD COLUMN semantic_evaluation_json TEXT CHECK (semantic_evaluation_json IS NULL OR json_valid(semantic_evaluation_json))`.execute(
      database
    );
  },
  async down(database: Kysely<unknown>): Promise<void> {
    await sql`ALTER TABLE eval_result DROP COLUMN semantic_evaluation_json`.execute(database);
  }
};
