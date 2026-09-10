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
const RUN_C = "01900000-0000-7000-8000-000000000003";
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

describe("SQLite single Case replay", () => {
  it("persists a selected Case at ordinal zero and rejects altered frozen replay evidence", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-single-case-replay-"));
    const storage = await initializeSqliteStorage({ projectRoot });
    openStorages.push(storage);
    seedCurrentResources(storage.databasePath);
    const manager = storage.createRunTransactionManager();
    const base = platformRun(RUN_A);
    const extra = sqliteRunCaseDefinition("extra");
    const cases = [
      {
        caseKey: "extra",
        ordinal: 0,
        definition: extra,
        definitionHash: hashCaseDefinition({
          contractVersion: "cortex.case-definition.v1",
          caseKey: "extra",
          definition: caseDefinitionJson(extra)
        })
      },
      { caseKey: "case-1", ordinal: 1, definition: DEFINITION, definitionHash: DEFINITION_HASH }
    ];
    const suiteHash = hashSuite({ contractVersion: "cortex.suite.v1", cases });
    const source: PlatformRun = {
      ...base,
      suite: { ...base.suite, cases, suiteHash },
      runContextHash: hashRunContext({
        contractVersion: "cortex.run-context.v1",
        suiteHash,
        endpointConfigHash: ENDPOINT_HASH,
        evaluatorConfigHash: EVALUATOR_HASH,
        rubricPromptSetHash: RUBRIC_SET_HASH,
        promptfooVersion: "0.121.18",
        runExecutionLimits: LIMITS
      })
    };
    const original = { ...successResult(RUN_A), ordinal: 1 };
    await manager.execute(async (t) => {
      await t.runs.insertPlatformRun(source);
      await t.runs.claimStage(RUN_A, 0, SECOND_TIME);
      await t.runs.recordRestResult(original, SECOND_TIME);
    });
    const target = { ...platformRun(RUN_B, RUN_A, "FORCE"), restCompletedCount: 1 };
    const reused = successResult(RUN_B, {
      sourceKind: "RUN",
      sourceId: RUN_A,
      sourceResultHash: original.resultHash
    });
    if (reused.status !== "SUCCEEDED") throw new Error("TEST_REST_SUCCESS_REQUIRED");
    await manager.execute(async (t) => t.runs.insertPlatformRerun(target, [reused]));
    expect(await manager.execute(async (t) => t.runs.getPlatformRun(RUN_B))).toMatchObject({
      status: "READY",
      restCompletedCount: 1,
      suite: { cases: [{ caseKey: "case-1", ordinal: 0 }] }
    });
    expect(await manager.execute(async (t) => t.runs.getRestResult(RUN_B, "case-1"))).toMatchObject(
      { ordinal: 0, resultHash: original.resultHash, provenance: { sourceId: RUN_A } }
    );
    await expect(
      manager.execute(async (t) =>
        t.runs.insertPlatformRerun({ ...target, id: RUN_C }, [
          { ...reused, runId: RUN_C, providerOutput: { ok: false, errorMessage: "tampered" } }
        ])
      )
    ).rejects.toThrow();
    await expect(
      manager.execute(async (t) =>
        t.runs.insertPlatformRerun(
          { ...target, id: RUN_C, endpoint: { ...target.endpoint, configHash: HASH } },
          [{ ...reused, runId: RUN_C }]
        )
      )
    ).rejects.toThrow();
    // Full FORCE runs must not silently reuse multiple execution results.
    await expect(
      manager.execute(async (t) =>
        t.runs.insertPlatformRerun(
          { ...source, id: RUN_C, sourceRunId: RUN_A, rerunMode: "FORCE", restCompletedCount: 1 },
          [{ ...reused, runId: RUN_C }]
        )
      )
    ).rejects.toThrow();
    await manager.execute(async (t) =>
      t.runs.insertPlatformRerun(platformRun(RUN_C, RUN_A, "FORCE"), [])
    );
    expect(await manager.execute(async (t) => t.runs.getRestResult(RUN_C, "case-1"))).toBeNull();
  });
});

it("persists optional Run labels across reopening without changing execution identity or legacy labels", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "cortex-run-labels-"));
  const storage = await initializeSqliteStorage({ projectRoot });
  seedCurrentResources(storage.databasePath);
  const original = platformRun(RUN_A);
  const named = {
    ...original,
    name: "待办时间修复回归",
    description: "验证跨日解析\n关注明天上午"
  };
  await storage.createRunTransactionManager().execute(async (tx) => {
    await tx.runs.insertPlatformRun(named);
    await tx.runs.insertPlatformRun(platformRun(RUN_B));
  });
  await storage.close();
  const reopened = await initializeSqliteStorage({ projectRoot });
  openStorages.push(reopened);
  await reopened.createRunTransactionManager().execute(async (tx) => {
    expect(await tx.runs.getPlatformRun(RUN_A)).toMatchObject(named);
    expect(await tx.runs.getPlatformRunDetail(RUN_A)).toMatchObject({
      name: named.name,
      description: named.description,
      runContextHash: original.runContextHash
    });
    const page = await tx.runs.queryPlatformRuns({ limit: 10 });
    expect(page.items.find((item) => item.id === RUN_A)).toMatchObject({
      name: named.name,
      description: named.description
    });
    expect(page.items.find((item) => item.id === RUN_B)).toMatchObject({
      name: null,
      description: null
    });
    expect((await tx.runs.getPlatformRun(RUN_A))?.suite).toEqual(original.suite);
  });
});
