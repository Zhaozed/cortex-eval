import { sql, type Kysely } from "kysely";
import type { Migration, MigrationProvider } from "kysely/migration";

import { PLATFORM_RUN_INDEX_MIGRATION } from "./sqlite-platform-run-index-migration.ts";
import { EVALUATION_SUMMARY_MIGRATION } from "./sqlite-evaluation-summary-migration.ts";
import { REPORTING_MIGRATION } from "./sqlite-reporting-migration.ts";
import { CASE_ANALYSIS_MIGRATION } from "./sqlite-case-analysis-migration.ts";

const CREATE_STATEMENTS = [
  `CREATE TABLE test_suite (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL,
    case_count INTEGER NOT NULL DEFAULT 0 CHECK (case_count >= 0),
    suite_hash TEXT NOT NULL CHECK (length(suite_hash) = 64 AND suite_hash NOT GLOB '*[^0-9a-f]*'),
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE llm_rubric_prompt (
    id TEXT PRIMARY KEY,
    prompt_key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    messages_json TEXT NOT NULL CHECK (json_valid(messages_json)),
    prompt_hash TEXT NOT NULL CHECK (length(prompt_hash) = 64 AND prompt_hash NOT GLOB '*[^0-9a-f]*'),
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE test_case (
    id TEXT PRIMARY KEY,
    suite_id TEXT NOT NULL REFERENCES test_suite(id) ON DELETE CASCADE,
    case_key TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    description TEXT NOT NULL,
    business_module TEXT NOT NULL,
    scenario_tag TEXT NOT NULL,
    assertion_types_json TEXT NOT NULL CHECK (json_valid(assertion_types_json)),
    metrics_json TEXT NOT NULL CHECK (json_valid(metrics_json)),
    definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
    rubric_prompt_keys_json TEXT NOT NULL CHECK (json_valid(rubric_prompt_keys_json)),
    definition_hash TEXT NOT NULL CHECK (length(definition_hash) = 64 AND definition_hash NOT GLOB '*[^0-9a-f]*'),
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (suite_id, case_key),
    UNIQUE (suite_id, ordinal)
  )`,
  `CREATE TABLE endpoint_config (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    url_template TEXT NOT NULL,
    method TEXT NOT NULL CHECK (method = 'POST'),
    headers_json TEXT NOT NULL CHECK (json_valid(headers_json)),
    body_selector TEXT NOT NULL,
    timeout_ms INTEGER NOT NULL CHECK (timeout_ms BETWEEN 100 AND 600000),
    default_concurrency INTEGER NOT NULL CHECK (default_concurrency BETWEEN 1 AND 64),
    config_hash TEXT NOT NULL CHECK (length(config_hash) = 64 AND config_hash NOT GLOB '*[^0-9a-f]*'),
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE llm_config (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    provider_type TEXT NOT NULL CHECK (provider_type IN ('GOOGLE_GEMINI', 'OPENAI_COMPATIBLE')),
    model TEXT NOT NULL,
    options_json TEXT NOT NULL CHECK (json_valid(options_json)),
    secret_refs_json TEXT NOT NULL CHECK (json_valid(secret_refs_json)),
    config_hash TEXT NOT NULL CHECK (length(config_hash) = 64 AND config_hash NOT GLOB '*[^0-9a-f]*'),
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE case_analysis_prompt (
    id TEXT PRIMARY KEY,
    prompt_key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    messages_template_json TEXT NOT NULL CHECK (json_valid(messages_template_json)),
    prompt_hash TEXT NOT NULL CHECK (length(prompt_hash) = 64 AND prompt_hash NOT GLOB '*[^0-9a-f]*'),
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE run_log (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL CHECK (source_type IN ('PLATFORM', 'OFFLINE_IMPORT')),
    source_package_id TEXT,
    execution_id TEXT,
    source_run_id TEXT REFERENCES run_log(id) ON DELETE RESTRICT,
    rerun_mode TEXT NOT NULL CHECK (rerun_mode IN ('NONE', 'RETRY_FAILED', 'FORCE')),
    suite_id TEXT REFERENCES test_suite(id) ON DELETE SET NULL,
    endpoint_config_id TEXT REFERENCES endpoint_config(id) ON DELETE SET NULL,
    evaluator_config_id TEXT REFERENCES llm_config(id) ON DELETE SET NULL,
    suite_snapshot_json TEXT NOT NULL CHECK (json_valid(suite_snapshot_json)),
    endpoint_snapshot_json TEXT NOT NULL CHECK (json_valid(endpoint_snapshot_json)),
    evaluator_snapshot_json TEXT NOT NULL CHECK (json_valid(evaluator_snapshot_json)),
    rubric_prompts_snapshot_json TEXT NOT NULL CHECK (json_valid(rubric_prompts_snapshot_json)),
    run_context_hash TEXT NOT NULL CHECK (length(run_context_hash) = 64 AND run_context_hash NOT GLOB '*[^0-9a-f]*'),
    promptfoo_version TEXT NOT NULL,
    contract_versions_json TEXT NOT NULL CHECK (json_valid(contract_versions_json)),
    run_execution_limits_json TEXT NOT NULL CHECK (json_valid(run_execution_limits_json)),
    run_mode TEXT NOT NULL CHECK (run_mode IN ('STAGED', 'PIPELINE')),
    status TEXT NOT NULL CHECK (status IN ('READY', 'RUNNING', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED', 'CANCELLED', 'INTERRUPTED')),
    stage TEXT NOT NULL CHECK (stage IN ('REST', 'EVALUATION', 'REPORT', 'DONE')),
    lock_revision INTEGER NOT NULL DEFAULT 0 CHECK (lock_revision >= 0),
    cancel_requested_at TEXT,
    rest_completed_count INTEGER NOT NULL DEFAULT 0 CHECK (rest_completed_count >= 0),
    rest_error_count INTEGER NOT NULL DEFAULT 0 CHECK (rest_error_count >= 0),
    eval_completed_count INTEGER NOT NULL DEFAULT 0 CHECK (eval_completed_count >= 0),
    eval_error_count INTEGER NOT NULL DEFAULT 0 CHECK (eval_error_count >= 0),
    summary_json TEXT CHECK (summary_json IS NULL OR json_valid(summary_json)),
    result_set_hash TEXT CHECK (result_set_hash IS NULL OR (length(result_set_hash) = 64 AND result_set_hash NOT GLOB '*[^0-9a-f]*')),
    artifact_manifest_json TEXT NOT NULL CHECK (json_valid(artifact_manifest_json)),
    error_code TEXT,
    error_message TEXT,
    started_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((source_type = 'PLATFORM' AND source_package_id IS NULL AND execution_id IS NULL) OR (source_type = 'OFFLINE_IMPORT' AND source_package_id IS NOT NULL AND execution_id IS NOT NULL)),
    CHECK ((rerun_mode = 'NONE' AND source_run_id IS NULL) OR (rerun_mode IN ('RETRY_FAILED', 'FORCE') AND source_run_id IS NOT NULL AND source_type = 'PLATFORM')),
    CHECK ((status IN ('READY', 'RUNNING') AND stage IN ('REST', 'EVALUATION', 'REPORT')) OR (status IN ('COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED', 'CANCELLED', 'INTERRUPTED') AND stage = 'DONE'))
  )`,
  `CREATE TABLE case_result (
    run_id TEXT NOT NULL REFERENCES run_log(id) ON DELETE CASCADE,
    case_key TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    case_definition_json TEXT NOT NULL CHECK (json_valid(case_definition_json)),
    case_definition_hash TEXT NOT NULL CHECK (length(case_definition_hash) = 64 AND case_definition_hash NOT GLOB '*[^0-9a-f]*'),
    rest_status TEXT NOT NULL CHECK (rest_status IN ('SUCCEEDED', 'ERROR')),
    http_status INTEGER CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
    provider_output_json TEXT CHECK (provider_output_json IS NULL OR json_valid(provider_output_json)),
    duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
    error_type TEXT,
    error_message TEXT,
    completed_at TEXT NOT NULL,
    run_result_hash TEXT NOT NULL CHECK (length(run_result_hash) = 64 AND run_result_hash NOT GLOB '*[^0-9a-f]*'),
    reused_from_run_id TEXT REFERENCES run_log(id) ON DELETE RESTRICT,
    reused_from_execution_id TEXT,
    reused_result_hash TEXT CHECK (reused_result_hash IS NULL OR (length(reused_result_hash) = 64 AND reused_result_hash NOT GLOB '*[^0-9a-f]*')),
    PRIMARY KEY (run_id, case_key),
    UNIQUE (run_id, ordinal),
    CHECK ((rest_status = 'SUCCEEDED' AND provider_output_json IS NOT NULL AND error_type IS NULL AND error_message IS NULL) OR (rest_status = 'ERROR' AND provider_output_json IS NULL AND error_type IS NOT NULL)),
    CHECK ((reused_from_run_id IS NULL AND reused_from_execution_id IS NULL AND reused_result_hash IS NULL) OR ((reused_from_run_id IS NOT NULL OR reused_from_execution_id IS NOT NULL) AND reused_result_hash IS NOT NULL))
  )`,
  `CREATE TABLE eval_result (
    run_id TEXT NOT NULL,
    case_key TEXT NOT NULL,
    eval_status TEXT NOT NULL CHECK (eval_status IN ('PASS', 'FAIL', 'EVALUATION_ERROR', 'NOT_EVALUATED')),
    promptfoo_success INTEGER CHECK (promptfoo_success IS NULL OR promptfoo_success IN (0, 1)),
    score REAL,
    reason TEXT,
    evaluation_error TEXT,
    assertion_results_json TEXT NOT NULL CHECK (json_valid(assertion_results_json)),
    expected_actual_diffs_json TEXT NOT NULL CHECK (json_valid(expected_actual_diffs_json)),
    metric_results_json TEXT NOT NULL CHECK (json_valid(metric_results_json)),
    latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
    token_usage_json TEXT CHECK (token_usage_json IS NULL OR json_valid(token_usage_json)),
    cost REAL CHECK (cost IS NULL OR cost >= 0),
    allowlist_raw_evidence_json TEXT NOT NULL CHECK (json_valid(allowlist_raw_evidence_json)),
    eval_result_hash TEXT NOT NULL CHECK (length(eval_result_hash) = 64 AND eval_result_hash NOT GLOB '*[^0-9a-f]*'),
    final_case_result_hash TEXT NOT NULL CHECK (length(final_case_result_hash) = 64 AND final_case_result_hash NOT GLOB '*[^0-9a-f]*'),
    reused_from_run_id TEXT REFERENCES run_log(id) ON DELETE RESTRICT,
    reused_from_execution_id TEXT,
    reused_eval_result_hash TEXT CHECK (reused_eval_result_hash IS NULL OR (length(reused_eval_result_hash) = 64 AND reused_eval_result_hash NOT GLOB '*[^0-9a-f]*')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (run_id, case_key),
    UNIQUE (run_id, case_key, final_case_result_hash),
    FOREIGN KEY (run_id, case_key) REFERENCES case_result(run_id, case_key) ON DELETE CASCADE,
    CHECK ((eval_status = 'PASS' AND promptfoo_success = 1 AND score IS NOT NULL AND evaluation_error IS NULL) OR (eval_status = 'FAIL' AND promptfoo_success = 0 AND score IS NOT NULL AND evaluation_error IS NULL) OR (eval_status = 'EVALUATION_ERROR' AND promptfoo_success IS NULL AND score IS NULL AND evaluation_error IS NOT NULL) OR (eval_status = 'NOT_EVALUATED' AND promptfoo_success IS NULL AND score IS NULL AND evaluation_error IS NULL)),
    CHECK ((reused_from_run_id IS NULL AND reused_from_execution_id IS NULL AND reused_eval_result_hash IS NULL) OR ((reused_from_run_id IS NOT NULL OR reused_from_execution_id IS NOT NULL) AND reused_eval_result_hash IS NOT NULL))
  )`,
  `CREATE TABLE case_analysis (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    case_key TEXT NOT NULL,
    final_case_result_hash TEXT NOT NULL CHECK (length(final_case_result_hash) = 64 AND final_case_result_hash NOT GLOB '*[^0-9a-f]*'),
    analysis_revision INTEGER NOT NULL CHECK (analysis_revision >= 1),
    analysis_prompt_key TEXT NOT NULL,
    analysis_prompt_hash TEXT NOT NULL CHECK (length(analysis_prompt_hash) = 64 AND analysis_prompt_hash NOT GLOB '*[^0-9a-f]*'),
    analysis_prompt_snapshot_json TEXT NOT NULL CHECK (json_valid(analysis_prompt_snapshot_json)),
    analyzer_config_hash TEXT NOT NULL CHECK (length(analyzer_config_hash) = 64 AND analyzer_config_hash NOT GLOB '*[^0-9a-f]*'),
    analyzer_provider TEXT NOT NULL CHECK (analyzer_provider IN ('GOOGLE_GEMINI', 'OPENAI_COMPATIBLE')),
    analyzer_model TEXT NOT NULL,
    analyzer_snapshot_json TEXT NOT NULL CHECK (json_valid(analyzer_snapshot_json)),
    analysis_input_contract_version TEXT NOT NULL,
    analysis_output_contract_version TEXT NOT NULL,
    analysis_input_hash TEXT NOT NULL CHECK (length(analysis_input_hash) = 64 AND analysis_input_hash NOT GLOB '*[^0-9a-f]*'),
    analysis_execution_limits_json TEXT NOT NULL CHECK (json_valid(analysis_execution_limits_json)),
    analysis_status TEXT NOT NULL CHECK (analysis_status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'ERROR')),
    classification TEXT CHECK (classification IS NULL OR classification IN ('LABEL_ERROR', 'ADDITIONAL_VALID_RESULT', 'NORMAL_FAILURE', 'PARAMETER_VARIANCE')),
    confidence REAL CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
    evidence_json TEXT CHECK (evidence_json IS NULL OR json_valid(evidence_json)),
    explanation TEXT,
    recommended_action TEXT,
    proposal_json TEXT CHECK (proposal_json IS NULL OR json_valid(proposal_json)),
    decision TEXT NOT NULL CHECK (decision IN ('NO_PROPOSAL', 'PENDING', 'ACCEPTED', 'REJECTED', 'EDITED_AND_ACCEPTED')),
    apply_status TEXT NOT NULL CHECK (apply_status IN ('NOT_APPLICABLE', 'NOT_APPLIED', 'APPLIED', 'CONFLICT')),
    base_definition_hash TEXT CHECK (base_definition_hash IS NULL OR (length(base_definition_hash) = 64 AND base_definition_hash NOT GLOB '*[^0-9a-f]*')),
    applied_definition_hash TEXT CHECK (applied_definition_hash IS NULL OR (length(applied_definition_hash) = 64 AND applied_definition_hash NOT GLOB '*[^0-9a-f]*')),
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (run_id, case_key),
    FOREIGN KEY (run_id, case_key, final_case_result_hash) REFERENCES eval_result(run_id, case_key, final_case_result_hash) ON DELETE CASCADE,
    CHECK ((analysis_status IN ('PENDING', 'RUNNING', 'ERROR') AND decision = 'NO_PROPOSAL' AND apply_status = 'NOT_APPLICABLE') OR (analysis_status = 'SUCCEEDED' AND ((decision = 'NO_PROPOSAL' AND apply_status = 'NOT_APPLICABLE') OR (decision IN ('PENDING', 'REJECTED') AND apply_status = 'NOT_APPLIED') OR (decision IN ('ACCEPTED', 'EDITED_AND_ACCEPTED') AND apply_status IN ('APPLIED', 'CONFLICT')))))
  )`
] as const;

const INDEX_STATEMENTS = [
  "CREATE INDEX test_case_suite_filter ON test_case(suite_id, business_module, scenario_tag, case_key)",
  "CREATE INDEX test_case_suite_ordinal ON test_case(suite_id, ordinal)",
  "CREATE INDEX test_case_definition_hash ON test_case(definition_hash)",
  "CREATE UNIQUE INDEX run_log_execution_unique ON run_log(execution_id) WHERE execution_id IS NOT NULL",
  "CREATE UNIQUE INDEX run_log_single_running ON run_log((1)) WHERE status = 'RUNNING'",
  "CREATE INDEX run_log_source_run ON run_log(source_run_id)",
  "CREATE INDEX run_log_current_resources ON run_log(suite_id, endpoint_config_id, evaluator_config_id)",
  "CREATE INDEX case_result_reused_run ON case_result(reused_from_run_id)",
  "CREATE INDEX eval_result_reused_run ON eval_result(reused_from_run_id)",
  "CREATE INDEX case_analysis_final_hash ON case_analysis(final_case_result_hash)"
] as const;

const DROP_TABLES = [
  "case_analysis",
  "eval_result",
  "case_result",
  "run_log",
  "case_analysis_prompt",
  "llm_config",
  "endpoint_config",
  "test_case",
  "llm_rubric_prompt",
  "test_suite"
] as const;

// Execute the fixed initial schema through Kysely without accepting runtime SQL.
async function migrateUp(database: Kysely<unknown>): Promise<void> {
  for (const statement of CREATE_STATEMENTS) await sql.raw(statement).execute(database);
  for (const statement of INDEX_STATEMENTS) await sql.raw(statement).execute(database);
}

// Drop the fixed initial schema in reverse foreign-key order.
async function migrateDown(database: Kysely<unknown>): Promise<void> {
  for (const table of DROP_TABLES) await sql.raw(`DROP TABLE IF EXISTS ${table}`).execute(database);
}

const INITIAL_MIGRATION: Migration = { up: migrateUp, down: migrateDown };

/** In-memory provider for the immutable initial SQLite Migration. */
export class CortexMigrationProvider implements MigrationProvider {
  /** Return all known migrations in stable name order. */
  public getMigrations(): Promise<Record<string, Migration>> {
    return Promise.resolve({
      "001_initial_schema": INITIAL_MIGRATION,
      "002_platform_run_indexes": PLATFORM_RUN_INDEX_MIGRATION,
      "003_evaluation_summary": EVALUATION_SUMMARY_MIGRATION,
      "004_reporting_versions": REPORTING_MIGRATION,
      "005_case_analysis_versions": CASE_ANALYSIS_MIGRATION
    });
  }
}
