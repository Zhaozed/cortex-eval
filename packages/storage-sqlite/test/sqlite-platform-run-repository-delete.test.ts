import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  PlatformRun,
  StoredRestCaseResult
} from "@cortex-eval/application/src/features/runs/platform-run-models.ts";
import { caseDefinitionJson } from "@cortex-eval/domain/src/domain-case-projection.ts";
import {
  hashCaseDefinition,
  hashRestResult,
  hashRunContext
} from "@cortex-eval/domain/src/domain-hash-inputs.ts";
import {
  hashEndpointConfig,
  hashLlmConfig,
  hashRubricPromptSet,
  hashSuite
} from "@cortex-eval/domain/src/domain-resource-hashes.ts";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { initializeSqliteStorage } from "../src/sqlite-database.ts";
import { sqliteRunCaseDefinition } from "../test-support/sqlite-platform-run-fixtures.ts";

const openStorages: { close(): Promise<void> }[] = [];
const FIRST_TIME = "2026-07-13T00:00:00.000Z";
const SECOND_TIME = "2026-07-13T00:00:01.000Z";
const HASH = "a".repeat(64);
const RUN_A = "01900000-0000-7000-8000-000000000001";
const RUN_B = "01900000-0000-7000-8000-000000000002";
const RUN_RUNNING = "01900000-0000-7000-8000-000000000004";
const SUITE_ID = "01900000-0000-7000-8000-000000000100";
const ENDPOINT_ID = "01900000-0000-7000-8000-000000000200";
const EVALUATOR_ID = "01900000-0000-7000-8000-000000000300";

afterEach(async () => {
  await Promise.all(openStorages.splice(0).map(async (storage) => storage.close()));
});

const DEFINITION = sqliteRunCaseDefinition("case-1");
const DEFINITION_HASH = hashCaseDefinition({
  contractVersion: "cortex.case-definition.v1",
  caseKey: DEFINITION.caseKey,
  definition: caseDefinitionJson(DEFINITION)
});
const SUITE_HASH = hashSuite({
  contractVersion: "cortex.suite.v1",
  cases: [{ caseKey: DEFINITION.caseKey, ordinal: 0, definitionHash: DEFINITION_HASH }]
});
const ENDPOINT_DEFINITION = {
  urlTemplate: "https://example.test/{{vars.task}}",
  method: "POST" as const,
  headers: {},
  bodySelector: "/request_body",
  timeoutMs: 1_000,
  defaultConcurrency: 4
};
const ENDPOINT_HASH = hashEndpointConfig({
  contractVersion: "cortex.endpoint-config.v1",
  config: ENDPOINT_DEFINITION
});
const EVALUATOR_DEFINITION = {
  providerType: "GOOGLE_GEMINI" as const,
  apiKey: { kind: "ENV_SECRET" as const, envKey: "GEMINI_API_KEY" },
  model: "gemini-test",
  thinkingLevel: "OFF" as const,
  temperature: 0,
  topP: 1,
  maxOutputTokens: 1_024,
  timeoutMs: 60_000,
  structuredOutput: "JSON_SCHEMA" as const
};
const EVALUATOR_HASH = hashLlmConfig({
  contractVersion: "cortex.llm-config.v1",
  config: EVALUATOR_DEFINITION
});
const RUBRIC_SET_HASH = hashRubricPromptSet({
  contractVersion: "cortex.rubric-prompt-set.v1",
  prompts: []
});
const LIMITS = {
  contractVersion: "cortex.run-execution-limits.v1" as const,
  restConcurrency: 4,
  evalConcurrency: 2
};
const RUN_CONTEXT_HASH = hashRunContext({
  contractVersion: "cortex.run-context.v1",
  suiteHash: SUITE_HASH,
  endpointConfigHash: ENDPOINT_HASH,
  evaluatorConfigHash: EVALUATOR_HASH,
  rubricPromptSetHash: RUBRIC_SET_HASH,
  promptfooVersion: "0.121.18",
  runExecutionLimits: LIMITS
});


function seedCurrentResources(databasePath: string): void {
  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  database
    .prepare(
      `INSERT INTO test_suite
       (id, name, description, case_count, suite_hash, revision, created_at, updated_at)
       VALUES (?, 'Suite', 'Suite', 1, ?, 0, ?, ?)`
    )
    .run(SUITE_ID, SUITE_HASH, FIRST_TIME, FIRST_TIME);
  database
    .prepare(
      `INSERT INTO endpoint_config
       (id, name, url_template, method, headers_json, body_selector, timeout_ms,
        default_concurrency, config_hash, revision, created_at, updated_at)
       VALUES (?, 'Endpoint', ?, 'POST', '{}', '/request_body', 1000, 4, ?, 0, ?, ?)`
    )
    .run(ENDPOINT_ID, ENDPOINT_DEFINITION.urlTemplate, ENDPOINT_HASH, FIRST_TIME, FIRST_TIME);
  database
    .prepare(
      `INSERT INTO llm_config
       (id, name, provider_type, model, options_json, secret_refs_json, config_hash,
        revision, created_at, updated_at)
       VALUES (?, 'Evaluator', 'GOOGLE_GEMINI', 'gemini-test', ?, ?, ?, 0, ?, ?)`
    )
    .run(
      EVALUATOR_ID,
      JSON.stringify({
        thinkingLevel: "OFF",
        temperature: 0,
        topP: 1,
        maxOutputTokens: 1_024,
        timeoutMs: 60_000,
        structuredOutput: "JSON_SCHEMA"
      }),
      JSON.stringify({ apiKey: "GEMINI_API_KEY" }),
      EVALUATOR_HASH,
      FIRST_TIME,
      FIRST_TIME
    );
  database.close();
}

function platformRun(
  id: string,
  sourceRunId: string | null = null,
  rerunMode: PlatformRun["rerunMode"] = "NONE"
): PlatformRun {
  return {
    id,
    sourceType: "PLATFORM",
    sourceRunId,
    rerunMode,
    suite: {
      id: SUITE_ID,
      name: `Suite ${id}`,
      suiteHash: SUITE_HASH,
      cases: [
        {
          caseKey: "case-1",
          ordinal: 0,
          definitionHash: DEFINITION_HASH,
          definition: DEFINITION
        }
      ]
    },
    endpoint: {
      sourceId: ENDPOINT_ID,
      name: "Endpoint",
      configHash: ENDPOINT_HASH,
      definition: ENDPOINT_DEFINITION
    },
    evaluator: {
      sourceId: EVALUATOR_ID,
      name: "Evaluator",
      configHash: EVALUATOR_HASH,
      definition: EVALUATOR_DEFINITION
    },
    rubricPrompts: [],
    runContextHash: RUN_CONTEXT_HASH,
    promptfooVersion: "0.121.18",
    contractVersions: {
      runSnapshot: "cortex.run-snapshot.v1",
      caseDefinition: "cortex.case-definition.v1",
      platformRestResults: "cortex.platform-rest-results.v1"
    },
    runExecutionLimits: LIMITS,
    runMode: "STAGED",
    status: "READY",
    stage: "REST",
    lockRevision: 0,
    cancelRequestedAt: null,
    restCompletedCount: 0,
    restErrorCount: 0,
    evalCompletedCount: 0,
    evalPassCount: 0,
    evalFailCount: 0,
    evalErrorCount: 0,
    evalNotEvaluatedCount: 0,
    resultSetHash: null,
    evaluationContextHash: null,
    evaluationResultSetHash: null,
    reportResultSetHash: null,
    reportSummary: null,
    artifactManifest: {
      contractVersion: "cortex.artifact-manifest.v1",
      owner: { kind: "RUN", id },
      artifacts: []
    },
    errorCode: null,
    errorMessage: null,
    startedAt: null,
    completedAt: null,
    createdAt: FIRST_TIME,
    updatedAt: FIRST_TIME
  };
}

function successResult(
  runId: string,
  provenance: StoredRestCaseResult["provenance"] = null
): StoredRestCaseResult {
  const providerOutput = { ok: false as const, errorMessage: "business" };
  return {
    runId,
    caseKey: "case-1",
    ordinal: 0,
    definition: DEFINITION,
    caseDefinitionHash: DEFINITION_HASH,
    status: "SUCCEEDED",
    httpStatus: 200,
    providerOutput,
    errorType: null,
    errorMessage: null,
    durationMs: 10,
    completedAt: SECOND_TIME,
    resultHash: hashRestResult({
      contractVersion: "cortex.rest-result.v1",
      caseKey: "case-1",
      caseDefinitionHash: DEFINITION_HASH,
      result: { status: "SUCCEEDED", httpStatus: 200, providerOutput }
    }),
    provenance
  };
}

describe("SQLite Platform Run Repository 删除", () => {
  it("删除非运行中且未被引用的 Run 及其全部 Case 事实", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-platform-delete-"));
    const storage = await initializeSqliteStorage({ projectRoot });
    openStorages.push(storage);
    seedCurrentResources(storage.databasePath);
    const manager = storage.createRunTransactionManager();
    await manager.execute(async (transaction) => {
      await transaction.runs.insertPlatformRun(platformRun(RUN_A));
      const claim = await transaction.runs.claimStage(RUN_A, 0, SECOND_TIME);
      if (!claim.ok) throw new Error("TEST_CLAIM_FAILED");
      const progress = await transaction.runs.recordRestResult(successResult(RUN_A), SECOND_TIME);
      await transaction.runs.completeRestStage({
        runId: RUN_A,
        expectedRevision: progress?.lockRevision ?? -1,
        expectedTotal: 1,
        resultSetHash: HASH,
        artifactManifest: platformRun(RUN_A).artifactManifest,
        updatedAt: SECOND_TIME
      });
      await transaction.runs.insertPlatformRun(platformRun(RUN_RUNNING));
      await transaction.runs.claimStage(RUN_RUNNING, 0, SECOND_TIME);
    });
    const database = new Database(storage.databasePath);
    database
      .prepare(
        `UPDATE run_log
         SET status = 'COMPLETED', stage = 'DONE', summary_json = '{}',
             report_result_set_hash = ?, completed_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .run("d".repeat(64), SECOND_TIME, SECOND_TIME, RUN_A);
    database.close();

    const missing = await manager.execute(async (transaction) =>
      transaction.runs.deletePlatformRun("01900000-0000-7000-8000-000000000999")
    );
    expect(missing).toEqual({ ok: false, reason: "NOT_FOUND" });
    const running = await manager.execute(async (transaction) =>
      transaction.runs.deletePlatformRun(RUN_RUNNING)
    );
    expect(running).toEqual({ ok: false, reason: "RUNNING" });
    const deleted = await manager.execute(async (transaction) =>
      transaction.runs.deletePlatformRun(RUN_A)
    );
    expect(deleted).toEqual({ ok: true });
    const page = await manager.execute(async (transaction) =>
      transaction.runs.queryPlatformRuns({ limit: 20 })
    );
    expect(page.items.map((item) => item.id)).toEqual([RUN_RUNNING]);
    const verify = new Database(storage.databasePath);
    const runCount = verify
      .prepare("SELECT COUNT(*) AS count FROM run_log WHERE id = ?")
      .get(RUN_A) as { readonly count: number };
    const resultCount = verify
      .prepare("SELECT COUNT(*) AS count FROM case_result WHERE run_id = ?")
      .get(RUN_A) as { readonly count: number };
    const evalCount = verify
      .prepare("SELECT COUNT(*) AS count FROM eval_result WHERE run_id = ?")
      .get(RUN_A) as { readonly count: number };
    const analysisCount = verify
      .prepare("SELECT COUNT(*) AS count FROM case_analysis WHERE run_id = ?")
      .get(RUN_A) as { readonly count: number };
    verify.close();
    expect({
      run: runCount.count,
      result: resultCount.count,
      eval: evalCount.count,
      analysis: analysisCount.count
    }).toEqual({ run: 0, result: 0, eval: 0, analysis: 0 });
  });

  it("拒绝删除被重跑或复用结果引用的 Run", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-platform-delete-referenced-"));
    const storage = await initializeSqliteStorage({ projectRoot });
    openStorages.push(storage);
    seedCurrentResources(storage.databasePath);
    const manager = storage.createRunTransactionManager();
    const sourceResult = successResult(RUN_A);
    await manager.execute(async (transaction) => {
      await transaction.runs.insertPlatformRun(platformRun(RUN_A));
      const sourceClaim = await transaction.runs.claimStage(RUN_A, 0, SECOND_TIME);
      if (!sourceClaim.ok) throw new Error("TEST_SOURCE_CLAIM_FAILED");
      const sourceProgress = await transaction.runs.recordRestResult(sourceResult, SECOND_TIME);
      await transaction.runs.completeRestStage({
        runId: RUN_A,
        expectedRevision: sourceProgress?.lockRevision ?? -1,
        expectedTotal: 1,
        resultSetHash: HASH,
        artifactManifest: platformRun(RUN_A).artifactManifest,
        updatedAt: SECOND_TIME
      });
      await transaction.runs.insertPlatformRerun(
        { ...platformRun(RUN_B, RUN_A, "RETRY_FAILED"), restCompletedCount: 1 },
        [
          successResult(RUN_B, {
            sourceKind: "RUN",
            sourceId: RUN_A,
            sourceResultHash: sourceResult.resultHash
          })
        ]
      );
    });
    const rejected = await manager.execute(async (transaction) =>
      transaction.runs.deletePlatformRun(RUN_A)
    );
    expect(rejected).toEqual({ ok: false, reason: "REFERENCED" });
    const kept = await manager.execute(async (transaction) =>
      transaction.runs.deletePlatformRun(RUN_B)
    );
    expect(kept).toEqual({ ok: true });
    const released = await manager.execute(async (transaction) =>
      transaction.runs.deletePlatformRun(RUN_A)
    );
    expect(released).toEqual({ ok: true });
  });
});
