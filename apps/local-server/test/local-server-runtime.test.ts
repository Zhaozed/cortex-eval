import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initializeSqliteStorage } from "@cortex-eval/storage-sqlite/src/sqlite-database.ts";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { createLocalServerRuntime, resolveAnalysisMessage } from "../src/local-server-runtime.ts";
import {
  jsonArrayProperty,
  jsonStringProperty,
  parseJsonObject
} from "./test-support/json-test-values.ts";

const RUN_ID = "01900000-0000-7000-8000-000000000091";
const ANALYSIS_ID = "01900000-0000-7000-8000-000000000092";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const TIME = "2026-07-15T00:00:00.000Z";

function seedAnalyzableRun(databasePath: string): void {
  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  database
    .prepare(
      `INSERT INTO run_log (
        id, source_type, source_package_id, execution_id, source_run_id, rerun_mode,
        suite_snapshot_json, endpoint_snapshot_json, evaluator_snapshot_json,
        rubric_prompts_snapshot_json, run_context_hash, promptfoo_version,
        contract_versions_json, run_execution_limits_json, run_mode, status, stage,
        rest_completed_count, rest_error_count, eval_completed_count, eval_fail_count,
        summary_json, result_set_hash, report_result_set_hash, artifact_manifest_json,
        completed_at, created_at, updated_at
      ) VALUES (?, 'PLATFORM', NULL, NULL, NULL, 'NONE', '{}', '{}', '{}', '[]', ?,
        '0.121.18', '{}', '{}', 'STAGED', 'COMPLETED', 'DONE', 1, 0, 1, 1,
        '{}', ?, ?, ?, ?, ?, ?)`
    )
    .run(
      RUN_ID,
      HASH_A,
      HASH_A,
      HASH_B,
      JSON.stringify({
        contractVersion: "cortex.artifact-manifest.v1",
        owner: { kind: "RUN", id: RUN_ID },
        artifacts: []
      }),
      TIME,
      TIME,
      TIME
    );
  database
    .prepare(
      `INSERT INTO case_result (
        run_id, case_key, ordinal, case_definition_json, case_definition_hash,
        rest_status, http_status, provider_output_json, duration_ms, error_type,
        error_message, completed_at, run_result_hash
      ) VALUES (?, 'case-1', 0, '{}', ?, 'SUCCEEDED', 200,
        '{"ok":true,"taskName":"reply","resolvedConfig":{},"parsedOutput":{}}',
        1, NULL, NULL, ?, ?)`
    )
    .run(RUN_ID, HASH_A, TIME, HASH_B);
  database
    .prepare(
      `INSERT INTO eval_result (
        run_id, case_key, eval_status, promptfoo_success, score, reason, evaluation_error,
        assertion_results_json, expected_actual_diffs_json, metric_results_json,
        allowlist_raw_evidence_json, eval_result_hash, final_case_result_hash, created_at, updated_at
      ) VALUES (?, 'case-1', 'FAIL', 0, 0, 'failed', NULL, '[]', '[]', '[]',
        'null', ?, ?, ?, ?)`
    )
    .run(RUN_ID, HASH_B, HASH_C, TIME, TIME);
  database.close();
}

describe("P3 Local Server composition root", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true }))
    );
  });

  it("装配真实 SQLite、UUIDv7 与资源 API，并按生命周期关闭", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-runtime-"));
    roots.push(projectRoot);
    const runtime = await createLocalServerRuntime({
      projectRoot,
      endpointValidator: { validate: () => Promise.resolve({ ok: true }) },
      llmValidator: { validate: () => Promise.resolve({ ok: true }) }
    });
    const created = await runtime.server.inject({
      method: "POST",
      url: "/api/v1/test-suites",
      headers: { host: "127.0.0.1:4310", "content-type": "application/json" },
      payload: { name: "Runtime Suite", description: "Current" }
    });
    expect(created.statusCode).toBe(201);
    const createdBody = parseJsonObject(created);
    expect(jsonStringProperty(createdBody, "id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(jsonStringProperty(createdBody, "createdAt")).toMatch(/Z$/);
    expect((await stat(runtime.databasePath)).isFile()).toBe(true);

    await runtime.close();
    await expect(runtime.close()).resolves.toBeUndefined();
  });

  it("SQLite 初始化前拒绝指向项目外的状态根且不创建外部文件", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-runtime-symlink-"));
    const external = await mkdtemp(join(tmpdir(), "cortex-runtime-external-"));
    roots.push(projectRoot, external);
    await symlink(external, join(projectRoot, ".cortex-eval"), "dir");

    await expect(createLocalServerRuntime({ projectRoot })).rejects.toMatchObject({
      code: "SQLITE_INITIALIZATION_FAILED"
    });
    expect(await readdir(external)).toEqual([]);
  });

  it("显式开发 Seed 重复启动不覆盖或复制已有资源", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-runtime-seed-"));
    roots.push(projectRoot);
    const first = await createLocalServerRuntime({ projectRoot, developmentSeed: true });
    const firstSuites = await first.server.inject({
      method: "GET",
      url: "/api/v1/test-suites",
      headers: { host: "127.0.0.1:4310" }
    });
    expect(firstSuites.json()).toMatchObject({
      items: [{ name: "开发示例测试集", caseCount: 1 }]
    });
    await first.close();

    const second = await createLocalServerRuntime({ projectRoot, developmentSeed: true });
    const secondSuites = await second.server.inject({
      method: "GET",
      url: "/api/v1/test-suites",
      headers: { host: "127.0.0.1:4310" }
    });
    expect(jsonArrayProperty(parseJsonObject(secondSuites), "items")).toHaveLength(1);
    const prompts = await second.server.inject({
      method: "GET",
      url: "/api/v1/llm-rubric-prompts",
      headers: { host: "127.0.0.1:4310" }
    });
    expect(jsonArrayProperty(parseJsonObject(prompts), "items")).toHaveLength(1);
    await second.close();
  });

  it("默认启动装配轮转日志并接收 staging 安全事件", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-runtime-log-"));
    roots.push(projectRoot);
    const forged = join(projectRoot, ".cortex-eval", "tmp", "case-import-forged");
    await mkdir(forged, { recursive: true });
    await writeFile(join(forged, "owner.json"), "{}", "utf8");
    const stale = new Date("2026-01-01T00:00:00.000Z");
    await utimes(forged, stale, stale);

    const runtime = await createLocalServerRuntime({ projectRoot });
    await runtime.server.inject({
      method: "GET",
      url: "/api/v1/test-suites",
      headers: { host: "127.0.0.1:4310" }
    });
    await runtime.close();

    const logPath = join(projectRoot, ".cortex-eval", "logs", "local-server.log");
    const log = await readFile(logPath, "utf8");
    expect(log).toContain("临时资源 owner 无效");
    expect(log).toContain("请求处理完成");
    expect((await stat(logPath)).mode & 0o777).toBe(0o600);
  });

  it("Analysis 消息同时解析 Analyzer Case 错误与平台阶段错误", () => {
    expect(resolveAnalysisMessage("ANALYZER_SECRET_MISSING")).toBe("Analyzer 密钥缺失");
    expect(resolveAnalysisMessage("ANALYSIS_INTERRUPTED")).toBe("分析因进程中断而终止");
  });

  it("开放请求前把崩溃遗留的 RUNNING Analysis 恢复为稳定错误", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-runtime-analysis-recovery-"));
    roots.push(projectRoot);
    const storage = await initializeSqliteStorage({ projectRoot });
    seedAnalyzableRun(storage.databasePath);
    const running = await storage
      .createAnalysisTransactionManager()
      .execute(async (transaction) => {
        const replaced = await transaction.analyses.replaceCurrent({
          id: ANALYSIS_ID,
          runId: RUN_ID,
          caseKey: "case-1",
          finalCaseResultHash: HASH_C,
          expectedRevision: null,
          prompt: {
            sourceId: null,
            promptKey: "analysis",
            promptHash: HASH_A,
            snapshot: {}
          },
          analyzer: {
            sourceId: null,
            configHash: HASH_B,
            provider: "OPENAI_COMPATIBLE",
            model: "analyzer",
            snapshot: {}
          },
          analysisInputHash: HASH_B,
          analysisExecutionLimits: {
            contractVersion: "cortex.analysis-execution-limits.v1",
            analysisConcurrency: 1
          },
          timestamp: TIME
        });
        if (!replaced.ok) throw new Error("TEST_ANALYSIS_REPLACE_FAILED");
        return transaction.analyses.claim(replaced.analysis.id, replaced.analysis.revision, TIME);
      });
    expect(running).toMatchObject({ ok: true, analysis: { status: "RUNNING" } });
    await storage.close();

    const runtime = await createLocalServerRuntime({ projectRoot });
    const response = await runtime.server.inject({
      method: "GET",
      url: `/api/v1/runs/${RUN_ID}/analyses/case-1`,
      headers: { host: "127.0.0.1:4310" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ERROR",
      revision: 3,
      errorCode: "ANALYSIS_INTERRUPTED",
      errorMessage: "分析因进程中断而终止"
    });
    await runtime.close();
  });
});
