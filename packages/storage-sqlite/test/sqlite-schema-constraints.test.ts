import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initializeSqliteStorage } from "../src/sqlite-database.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const NOW = "2026-01-01T00:00:00.000Z";
let storage: Awaited<ReturnType<typeof initializeSqliteStorage>>;
let database: Database.Database;

beforeEach(async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "cortex-constraints-"));
  storage = await initializeSqliteStorage({ projectRoot });
  database = new Database(storage.databasePath);
  database.pragma("foreign_keys = ON");
  seedResources(database);
});

afterEach(async () => {
  database.close();
  await storage.close();
});

function seedResources(target: Database.Database): void {
  target
    .prepare("INSERT INTO test_suite VALUES (?, ?, ?, 0, ?, 0, ?, ?)")
    .run("suite-1", "Suite", "Current", HASH_A, NOW, NOW);
  target
    .prepare(
      `INSERT INTO endpoint_config VALUES
       (?, ?, ?, 'POST', '{}', '/request_body', 60000, 4, ?, 0, ?, ?)`
    )
    .run("endpoint-1", "Endpoint", "https://example.test", HASH_A, NOW, NOW);
  target
    .prepare(
      `INSERT INTO llm_config VALUES
       (?, ?, 'GOOGLE_GEMINI', ?, '{}', '{}', ?, 0, ?, ?)`
    )
    .run("llm-1", "LLM", "gemini", HASH_A, NOW, NOW);
}

function insertRun(target: Database.Database, id: string, sourceRunId: string | null = null): void {
  const rerunMode = sourceRunId === null ? "NONE" : "FORCE";
  target
    .prepare(
      `INSERT INTO run_log (
        id, source_type, source_package_id, execution_id, source_run_id, rerun_mode,
        suite_id, endpoint_config_id, evaluator_config_id, suite_snapshot_json,
        endpoint_snapshot_json, evaluator_snapshot_json, rubric_prompts_snapshot_json,
        run_context_hash, promptfoo_version, contract_versions_json,
        run_execution_limits_json, run_mode, status, stage, lock_revision,
        artifact_manifest_json, created_at, updated_at
      ) VALUES (
        ?, 'PLATFORM', NULL, NULL, ?, ?, ?, ?, ?, '{}', '{}', '{}', '[]', ?,
        '0.121.18', '{}', '{}', 'STAGED', 'READY', 'REST', 0, '[]', ?, ?
      )`
    )
    .run(id, sourceRunId, rerunMode, "suite-1", "endpoint-1", "llm-1", HASH_A, NOW, NOW);
}

function insertCaseResult(target: Database.Database, runId: string): void {
  target
    .prepare(
      `INSERT INTO case_result (
        run_id, case_key, ordinal, case_definition_json, case_definition_hash,
        rest_status, http_status, provider_output_json, duration_ms, error_type,
        error_message, completed_at, run_result_hash
      ) VALUES (?, 'case-1', 0, '{}', ?, 'SUCCEEDED', 200, '{}', 10, NULL, NULL, ?, ?)`
    )
    .run(runId, HASH_A, NOW, HASH_A);
}

function insertEvalResult(
  target: Database.Database,
  runId: string,
  status: "PASS" | "FAIL",
  promptfooSuccess: 0 | 1
): void {
  target
    .prepare(
      `INSERT INTO eval_result (
        run_id, case_key, eval_status, promptfoo_success, score, reason,
        evaluation_error, assertion_results_json, expected_actual_diffs_json,
        metric_results_json, allowlist_raw_evidence_json, eval_result_hash,
        final_case_result_hash, created_at, updated_at
      ) VALUES (?, 'case-1', ?, ?, 1, 'reason', NULL, '[]', '[]', '[]',
        '[{"kind":"PROMPTFOO_RAW","path":"missing.json","hash":"${HASH_A}","size":10}]',
        ?, ?, ?, ?)`
    )
    .run(runId, status, promptfooSuccess, HASH_A, HASH_A, NOW, NOW);
}

describe("SQLite 跨字段约束与删除语义", () => {
  it("拒绝非法 Run 状态阶段和来源身份组合", () => {
    expect(() => {
      database
        .prepare(
          `INSERT INTO run_log (
            id, source_type, rerun_mode, suite_snapshot_json, endpoint_snapshot_json,
            evaluator_snapshot_json, rubric_prompts_snapshot_json, run_context_hash,
            promptfoo_version, contract_versions_json, run_execution_limits_json,
            run_mode, status, stage, artifact_manifest_json, created_at, updated_at
          ) VALUES ('bad-run', 'PLATFORM', 'NONE', '{}', '{}', '{}', '[]', ?,
            '0.121.18', '{}', '{}', 'STAGED', 'COMPLETED', 'REST', '[]', ?, ?)`
        )
        .run(HASH_A, NOW, NOW);
    }).toThrow(/CHECK constraint failed/);
    expect(() => {
      database
        .prepare(
          `INSERT INTO run_log (
            id, source_type, rerun_mode, suite_snapshot_json, endpoint_snapshot_json,
            evaluator_snapshot_json, rubric_prompts_snapshot_json, run_context_hash,
            promptfoo_version, contract_versions_json, run_execution_limits_json,
            run_mode, status, stage, artifact_manifest_json, created_at, updated_at
          ) VALUES ('bad-offline', 'OFFLINE_IMPORT', 'NONE', '{}', '{}', '{}', '[]', ?,
            '0.121.18', '{}', '{}', 'STAGED', 'READY', 'REST', '[]', ?, ?)`
        )
        .run(HASH_A, NOW, NOW);
    }).toThrow(/CHECK constraint failed/);
  });

  it("PASS/FAIL 与 Promptfoo Success 必须一致", () => {
    insertRun(database, "run-1");
    insertCaseResult(database, "run-1");
    expect(() => insertEvalResult(database, "run-1", "PASS", 0)).toThrow(/CHECK constraint failed/);
    expect(() => insertEvalResult(database, "run-1", "FAIL", 1)).toThrow(/CHECK constraint failed/);
  });

  it("Analysis 必须联合绑定相同 Final Case Result Hash", () => {
    insertRun(database, "run-1");
    insertCaseResult(database, "run-1");
    insertEvalResult(database, "run-1", "PASS", 1);

    expect(() => {
      database
        .prepare(
          `INSERT INTO case_analysis (
            id, run_id, case_key, final_case_result_hash, analysis_revision,
            analysis_prompt_key, analysis_prompt_hash, analysis_prompt_snapshot_json,
            analyzer_config_hash, analyzer_provider, analyzer_model, analyzer_snapshot_json,
            analysis_input_contract_version, analysis_output_contract_version,
            analysis_input_hash, analysis_execution_limits_json, analysis_status,
            decision, apply_status, created_at, updated_at
          ) VALUES ('analysis-1', 'run-1', 'case-1', ?, 1, 'analysis', ?, '{}', ?,
            'GOOGLE_GEMINI', 'gemini', '{}', 'cortex.analysis-input.v1',
            'cortex.analysis-output.v1', ?, '{}', 'PENDING', 'NO_PROPOSAL',
            'NOT_APPLICABLE', ?, ?)`
        )
        .run(HASH_B, HASH_A, HASH_A, HASH_A, NOW, NOW);
    }).toThrow(/FOREIGN KEY constraint failed/);
  });

  it("历史 Provenance 使用 RESTRICT，当前资源删除后快照和 Artifact 事实独立保留", () => {
    insertRun(database, "source-run");
    insertRun(database, "rerun", "source-run");
    expect(() => database.prepare("DELETE FROM run_log WHERE id = 'source-run'").run()).toThrow(
      /FOREIGN KEY constraint failed/
    );

    database.prepare("DELETE FROM test_suite WHERE id = 'suite-1'").run();
    database.prepare("DELETE FROM endpoint_config WHERE id = 'endpoint-1'").run();
    database.prepare("DELETE FROM llm_config WHERE id = 'llm-1'").run();
    const row = database
      .prepare(
        `SELECT suite_id, endpoint_config_id, evaluator_config_id,
                suite_snapshot_json, artifact_manifest_json
         FROM run_log WHERE id = 'source-run'`
      )
      .get();
    expect(row).toEqual({
      suite_id: null,
      endpoint_config_id: null,
      evaluator_config_id: null,
      suite_snapshot_json: "{}",
      artifact_manifest_json: "[]"
    });
  });
});
