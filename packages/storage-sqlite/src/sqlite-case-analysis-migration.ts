import { sql, type Kysely } from "kysely";
import type { Migration } from "kysely/migration";

const CASE_ANALYSIS_COLUMNS = [
  {
    name: "analysis_result_hash",
    definition:
      "TEXT CHECK (analysis_result_hash IS NULL OR (length(analysis_result_hash) = 64 AND analysis_result_hash NOT GLOB '*[^0-9a-f]*'))"
  },
  { name: "analysis_prompt_id", definition: "TEXT" },
  { name: "analyzer_config_id", definition: "TEXT" }
] as const;

const CASE_ANALYSIS_STATE_VALID = `(
  (
    analysis_status IN ('PENDING', 'RUNNING')
    AND classification IS NULL
    AND confidence IS NULL
    AND evidence_json IS NULL
    AND explanation IS NULL
    AND recommended_action IS NULL
    AND proposal_json IS NULL
    AND decision = 'NO_PROPOSAL'
    AND apply_status = 'NOT_APPLICABLE'
    AND base_definition_hash IS NULL
    AND applied_definition_hash IS NULL
    AND analysis_result_hash IS NULL
    AND error_code IS NULL
    AND error_message IS NULL
  ) OR (
    analysis_status = 'ERROR'
    AND classification IS NULL
    AND confidence IS NULL
    AND evidence_json IS NULL
    AND explanation IS NULL
    AND recommended_action IS NULL
    AND proposal_json IS NULL
    AND decision = 'NO_PROPOSAL'
    AND apply_status = 'NOT_APPLICABLE'
    AND base_definition_hash IS NULL
    AND applied_definition_hash IS NULL
    AND analysis_result_hash IS NOT NULL
    AND length(trim(error_code)) > 0
    AND length(trim(error_message)) > 0
  ) OR (
    analysis_status = 'SUCCEEDED'
    AND classification IS NOT NULL
    AND confidence IS NOT NULL
    AND evidence_json IS NOT NULL
    AND json_type(evidence_json) = 'array'
    AND json_array_length(evidence_json) > 0
    AND length(trim(explanation)) > 0
    AND length(trim(recommended_action)) > 0
    AND analysis_result_hash IS NOT NULL
    AND error_code IS NULL
    AND error_message IS NULL
    AND (
      (
        proposal_json IS NULL
        AND decision = 'NO_PROPOSAL'
        AND apply_status = 'NOT_APPLICABLE'
        AND base_definition_hash IS NULL
        AND applied_definition_hash IS NULL
      ) OR (
        proposal_json IS NOT NULL
        AND base_definition_hash = json_extract(proposal_json, '$.baseDefinitionHash')
        AND (
          (
            decision IN ('PENDING', 'REJECTED')
            AND apply_status = 'NOT_APPLIED'
            AND applied_definition_hash IS NULL
          ) OR (
            decision IN ('ACCEPTED', 'EDITED_AND_ACCEPTED')
            AND (
              (apply_status = 'APPLIED' AND applied_definition_hash IS NOT NULL)
              OR (apply_status = 'CONFLICT' AND applied_definition_hash IS NULL)
            )
          )
        )
      )
    )
  )
)`;

const CASE_ANALYSIS_STATE_TRIGGERS = [
  {
    name: "case_analysis_state_insert",
    event: "INSERT"
  },
  {
    name: "case_analysis_state_update",
    event: "UPDATE"
  }
] as const;

const CASE_ANALYSIS_STATE_COLUMNS = [
  "analysis_status",
  "classification",
  "confidence",
  "evidence_json",
  "explanation",
  "recommended_action",
  "proposal_json",
  "decision",
  "apply_status",
  "base_definition_hash",
  "applied_definition_hash",
  "analysis_result_hash",
  "error_code",
  "error_message"
] as const;

const CASE_ANALYSIS_TRIGGER_STATE_VALID = CASE_ANALYSIS_STATE_COLUMNS.reduce(
  (condition, column) => condition.replaceAll(column, `NEW.${column}`),
  CASE_ANALYSIS_STATE_VALID
);

// Add only P9 Analysis version and source identities to the existing current table.
async function migrateCaseAnalysisUp(database: Kysely<unknown>): Promise<void> {
  for (const column of CASE_ANALYSIS_COLUMNS) {
    await sql
      .raw(`ALTER TABLE case_analysis ADD COLUMN ${column.name} ${column.definition}`)
      .execute(database);
  }
  await sql`
    ALTER TABLE run_log
    ADD COLUMN analysis_import_identity_json TEXT
    CHECK (analysis_import_identity_json IS NULL OR json_valid(analysis_import_identity_json))
  `.execute(database);
  for (const trigger of CASE_ANALYSIS_STATE_TRIGGERS) {
    await sql
      .raw(
        `
        CREATE TRIGGER ${trigger.name}
        BEFORE ${trigger.event} ON case_analysis
        FOR EACH ROW
        WHEN NOT ${CASE_ANALYSIS_TRIGGER_STATE_VALID}
        BEGIN
          SELECT RAISE(ABORT, 'CASE_ANALYSIS_STATE_INVALID');
        END
      `
      )
      .execute(database);
  }
}

// Remove only columns introduced by this migration in reverse order.
async function migrateCaseAnalysisDown(database: Kysely<unknown>): Promise<void> {
  for (const trigger of [...CASE_ANALYSIS_STATE_TRIGGERS].reverse()) {
    await sql.raw(`DROP TRIGGER ${trigger.name}`).execute(database);
  }
  await sql`ALTER TABLE run_log DROP COLUMN analysis_import_identity_json`.execute(database);
  for (const column of [...CASE_ANALYSIS_COLUMNS].reverse()) {
    await sql.raw(`ALTER TABLE case_analysis DROP COLUMN ${column.name}`).execute(database);
  }
}

/** P9 current Analysis version and offline import identity migration. */
export const CASE_ANALYSIS_MIGRATION: Migration = {
  up: migrateCaseAnalysisUp,
  down: migrateCaseAnalysisDown
};
