import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  hashCaseDefinition,
  hashRestResult,
  hashRunContext,
  type RestResultHashInput
} from "@cortex-eval/domain/src/domain-hash-inputs.ts";
import { caseDefinitionJson } from "@cortex-eval/domain/src/domain-case-projection.ts";
import type {
  PlatformRun,
  StoredRestCaseResult
} from "@cortex-eval/application/src/features/runs/platform-run-models.ts";
import {
  hashEndpointConfig,
  hashLlmConfig,
  hashPrompt,
  hashRubricPromptSet,
  hashSuite
} from "@cortex-eval/domain/src/domain-resource-hashes.ts";
import type {
  EndpointConfigDefinition,
  LlmConfigDefinition
} from "@cortex-eval/domain/src/domain-resource-models.ts";

import { CaseImportWorkspaceManager, type ProcessLiveness } from "../src/case-import-workspace.ts";
import { initializeSqliteStorage } from "../src/sqlite-database.ts";
import {
  sqliteEvalArtifactManifest,
  sqliteEvalResultSetHash,
  sqlitePassingEvalResult,
  sqliteRestArtifactManifest,
  sqliteRunCaseDefinition
} from "../test-support/sqlite-platform-run-fixtures.ts";

const ID_A = "018f1e2d-3c4b-7abc-8def-0123456789ab";
const ID_B = "018f1e2d-3c4b-7abc-8def-0123456789ac";
const ID_C = "018f1e2d-3c4b-7abc-8def-0123456789ad";
const ID_D = "018f1e2d-3c4b-7abc-8def-0123456789ae";
const ID_E = "018f1e2d-3c4b-7abc-8def-0123456789af";
const SUITE_ID = "018f1e2d-3c4b-7abc-8def-0123456789b0";
const RUN_ID = "018f1e2d-3c4b-7abc-8def-0123456789b1";
const HASH = "a".repeat(64);
const NOW = "2026-07-15T00:00:00.000Z";

const RUN_CASE = sqliteRunCaseDefinition("case-1");
const RUN_CASE_HASH = hashCaseDefinition({
  contractVersion: "cortex.case-definition.v1",
  caseKey: RUN_CASE.caseKey,
  definition: caseDefinitionJson(RUN_CASE)
});

function platformRun(
  endpoint: EndpointConfigDefinition,
  endpointHash: string,
  evaluator: LlmConfigDefinition,
  evaluatorHash: string
): PlatformRun {
  const suiteHash = hashSuite({
    contractVersion: "cortex.suite.v1",
    cases: [{ caseKey: RUN_CASE.caseKey, ordinal: 0, definitionHash: RUN_CASE_HASH }]
  });
  const limits = {
    contractVersion: "cortex.run-execution-limits.v1" as const,
    restConcurrency: 4,
    evalConcurrency: 2
  };
  const runContextHash = hashRunContext({
    contractVersion: "cortex.run-context.v1",
    suiteHash,
    endpointConfigHash: endpointHash,
    evaluatorConfigHash: evaluatorHash,
    rubricPromptSetHash: hashRubricPromptSet({
      contractVersion: "cortex.rubric-prompt-set.v1",
      prompts: []
    }),
    promptfooVersion: "0.121.18",
    runExecutionLimits: limits
  });
  return {
    id: RUN_ID,
    sourceType: "PLATFORM",
    sourceRunId: null,
    rerunMode: "NONE",
    suite: {
      id: SUITE_ID,
      name: "Suite",
      suiteHash,
      cases: [
        {
          caseKey: RUN_CASE.caseKey,
          ordinal: 0,
          definitionHash: RUN_CASE_HASH,
          definition: RUN_CASE
        }
      ]
    },
    endpoint: {
      sourceId: ID_A,
      name: "Endpoint",
      configHash: endpointHash,
      definition: endpoint
    },
    evaluator: {
      sourceId: ID_B,
      name: "Gemini",
      configHash: evaluatorHash,
      definition: evaluator
    },
    rubricPrompts: [],
    runContextHash,
    promptfooVersion: "0.121.18",
    contractVersions: {
      runSnapshot: "cortex.run-snapshot.v1",
      caseDefinition: "cortex.case-definition.v1",
      platformRestResults: "cortex.platform-rest-results.v1"
    },
    runExecutionLimits: limits,
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
      owner: { kind: "RUN", id: RUN_ID },
      artifacts: []
    },
    errorCode: null,
    errorMessage: null,
    startedAt: null,
    completedAt: null,
    createdAt: NOW,
    updatedAt: NOW
  };
}

function restResult(): StoredRestCaseResult {
  const providerOutput = {
    ok: true as const,
    taskName: "reply",
    resolvedConfig: {},
    parsedOutput: {}
  };
  const hashInput: RestResultHashInput = {
    contractVersion: "cortex.rest-result.v1",
    caseKey: RUN_CASE.caseKey,
    caseDefinitionHash: RUN_CASE_HASH,
    result: { status: "SUCCEEDED", httpStatus: 200, providerOutput }
  };
  return {
    runId: RUN_ID,
    caseKey: RUN_CASE.caseKey,
    ordinal: 0,
    definition: RUN_CASE,
    caseDefinitionHash: RUN_CASE_HASH,
    status: "SUCCEEDED",
    httpStatus: 200,
    providerOutput,
    errorType: null,
    errorMessage: null,
    durationMs: 1,
    completedAt: NOW,
    resultHash: hashRestResult(hashInput),
    provenance: null
  };
}

const processLiveness: ProcessLiveness = {
  processStartedAt: () => Promise.resolve("Wed Jul 15 00:00:00 2026")
};

describe("SQLite Canonical Export Snapshot", () => {
  const storages: { close(): Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(storages.splice(0).map(async (storage) => storage.close()));
  });

  it("先生成 owner-only 不可变快照，再释放主库供后续写入", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-canonical-snapshot-"));
    const storage = await initializeSqliteStorage({ projectRoot });
    storages.push(storage);
    const database = new Database(storage.databasePath);
    database
      .prepare(
        `INSERT INTO test_suite
         (id, name, description, case_count, suite_hash, revision, created_at, updated_at)
         VALUES (?, ?, '', 0, ?, 0, ?, ?)`
      )
      .run(ID_A, "Snapshot A", HASH, NOW, NOW);
    database.close();
    const workspaces = new CaseImportWorkspaceManager({
      containmentRoot: projectRoot,
      temporaryRoot: join(projectRoot, ".cortex-eval", "tmp"),
      processLiveness,
      now: Date.now,
      nonce: (): string => "snapshot-nonce",
      pid: process.pid,
      ttlMs: 60_000,
      workspacePrefix: "canonical-export-"
    });
    const snapshot = await storage.createCanonicalExportSnapshotFactory(workspaces).create();
    expect((await stat(snapshot.databasePath)).mode & 0o777).toBe(0o600);

    const writer = new Database(storage.databasePath);
    writer
      .prepare(
        `INSERT INTO test_suite
         (id, name, description, case_count, suite_hash, revision, created_at, updated_at)
         VALUES (?, ?, '', 0, ?, 0, ?, ?)`
      )
      .run(ID_B, "Live B", HASH, NOW, NOW);
    writer.close();

    const exported: string[] = [];
    for await (const entity of snapshot.stream("TEST_SUITE")) {
      if (!("id" in entity.entityKey)) throw new Error("UUID_KEY_EXPECTED");
      exported.push(entity.entityKey.id);
    }
    expect(exported).toEqual([ID_A]);
    const workspacePath = snapshot.workspacePath;
    await snapshot.close();
    await expect(stat(workspacePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("创建前已取消时不留下快照工作区", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-canonical-snapshot-"));
    const storage = await initializeSqliteStorage({ projectRoot });
    storages.push(storage);
    const workspaces = new CaseImportWorkspaceManager({
      containmentRoot: projectRoot,
      temporaryRoot: join(projectRoot, ".cortex-eval", "tmp"),
      processLiveness,
      now: Date.now,
      nonce: (): string => "snapshot-nonce",
      pid: process.pid,
      ttlMs: 60_000,
      workspacePrefix: "canonical-export-"
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      storage.createCanonicalExportSnapshotFactory(workspaces).create(controller.signal)
    ).rejects.toThrow("REQUEST_ABORTED");
  });

  it("拒绝未经过当前 LLM DTO 和语义 Hash 校验的 Secret 脏行", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-canonical-snapshot-"));
    const storage = await initializeSqliteStorage({ projectRoot });
    storages.push(storage);
    const database = new Database(storage.databasePath);
    database
      .prepare(
        `INSERT INTO llm_config
         (id, name, provider_type, model, options_json, secret_refs_json, config_hash,
          revision, created_at, updated_at)
         VALUES (?, 'Dirty', 'GOOGLE_GEMINI', 'gemini-2.5-flash', ?, ?, ?, 0, ?, ?)`
      )
      .run(
        ID_A,
        JSON.stringify({
          thinkingLevel: "OFF",
          temperature: 0,
          topP: 1,
          maxOutputTokens: 1024,
          timeoutMs: 60_000,
          structuredOutput: "JSON_SCHEMA"
        }),
        JSON.stringify({ apiKey: "expanded-secret-value" }),
        HASH,
        NOW,
        NOW
      );
    database.close();
    const snapshot = await storage
      .createCanonicalExportSnapshotFactory(
        new CaseImportWorkspaceManager({
          containmentRoot: projectRoot,
          temporaryRoot: join(projectRoot, ".cortex-eval", "tmp"),
          processLiveness,
          now: Date.now,
          nonce: (): string => "snapshot-secret-nonce",
          pid: process.pid,
          ttlMs: 60_000,
          workspacePrefix: "canonical-export-"
        })
      )
      .create();

    await expect(
      (async (): Promise<void> => {
        for await (const entity of snapshot.stream("LLM_CONFIG")) void entity;
      })()
    ).rejects.toThrow("CANONICAL_SNAPSHOT_ROW_INVALID");
    await snapshot.close();
  });

  it("拒绝绕过 Case Writer 写入的未知定义字段", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-canonical-snapshot-"));
    const storage = await initializeSqliteStorage({ projectRoot });
    storages.push(storage);
    const database = new Database(storage.databasePath);
    database
      .prepare(
        `INSERT INTO test_suite
         (id, name, description, case_count, suite_hash, revision, created_at, updated_at)
         VALUES (?, 'Suite', '', 1, ?, 0, ?, ?)`
      )
      .run(ID_A, HASH, NOW, NOW);
    database
      .prepare(
        `INSERT INTO test_case
         (id, suite_id, case_key, ordinal, description, business_module, scenario_tag,
          assertion_types_json, metrics_json, definition_json, rubric_prompt_keys_json,
          definition_hash, revision, created_at, updated_at)
         VALUES (?, ?, 'case-1', 0, 'Dirty', 'module', 'scenario', '[]', '[]', ?, '[]', ?, 0, ?, ?)`
      )
      .run(
        ID_B,
        ID_A,
        JSON.stringify({
          contractVersion: "cortex.case-definition.v1",
          description: "Dirty",
          threshold: 1,
          vars: { task: "evaluate", request_body: {} },
          metadata: {
            case_id: "case-1",
            req_id: "req-1",
            task_id: "task-1",
            business_module: "module",
            scenario_tag: "scenario"
          },
          assert: [],
          expandedSecret: "must-not-export"
        }),
        HASH,
        NOW,
        NOW
      );
    database.close();
    const snapshot = await storage
      .createCanonicalExportSnapshotFactory(
        new CaseImportWorkspaceManager({
          containmentRoot: projectRoot,
          temporaryRoot: join(projectRoot, ".cortex-eval", "tmp"),
          processLiveness,
          now: Date.now,
          nonce: (): string => "snapshot-case-nonce",
          pid: process.pid,
          ttlMs: 60_000,
          workspacePrefix: "canonical-export-"
        })
      )
      .create();

    await expect(
      (async (): Promise<void> => {
        for await (const entity of snapshot.stream("TEST_CASE")) void entity;
      })()
    ).rejects.toThrow("CANONICAL_SNAPSHOT_ROW_INVALID");
    await snapshot.close();
  });

  it("通过当前 DTO Mapper 导出四类合法配置及两种 LLM Provider", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-canonical-snapshot-"));
    const storage = await initializeSqliteStorage({ projectRoot });
    storages.push(storage);
    const endpoint: EndpointConfigDefinition = {
      urlTemplate: "https://example.test/v1/{{vars.task}}",
      method: "POST",
      headers: {
        Accept: { kind: "LITERAL", value: "application/json" },
        Authorization: { kind: "ENV_SECRET", envKey: "SERVICE_TOKEN" }
      },
      bodySelector: "/request_body",
      timeoutMs: 60_000,
      defaultConcurrency: 4
    };
    const gemini: LlmConfigDefinition = {
      providerType: "GOOGLE_GEMINI",
      model: "gemini-2.5-flash",
      thinkingLevel: "LOW",
      temperature: 0,
      topP: 1,
      maxOutputTokens: 1_024,
      timeoutMs: 60_000,
      structuredOutput: "JSON_SCHEMA",
      apiKey: { kind: "ENV_SECRET", envKey: "GEMINI_API_KEY" }
    };
    const local: LlmConfigDefinition = {
      providerType: "OPENAI_COMPATIBLE",
      model: "local-model",
      thinkingLevel: "OFF",
      temperature: 0,
      topP: 1,
      maxOutputTokens: 1_024,
      timeoutMs: 60_000,
      structuredOutput: "JSON_OBJECT",
      baseUrl: "http://127.0.0.1:11434/v1",
      auth: { kind: "NONE" }
    };
    const rubricMessages = [{ role: "SYSTEM" as const, content: "Evaluate." }];
    const analysisMessages = [{ role: "USER" as const, content: "{{case_definition}}" }];
    const endpointHash = hashEndpointConfig({
      contractVersion: "cortex.endpoint-config.v1",
      config: endpoint
    });
    const geminiHash = hashLlmConfig({
      contractVersion: "cortex.llm-config.v1",
      config: gemini
    });
    const localHash = hashLlmConfig({
      contractVersion: "cortex.llm-config.v1",
      config: local
    });
    const run = platformRun(endpoint, endpointHash, gemini, geminiHash);
    const database = new Database(storage.databasePath);
    database
      .prepare(
        `INSERT INTO test_suite
         (id, name, description, case_count, suite_hash, revision, created_at, updated_at)
         VALUES (?, 'Suite', '', 1, ?, 0, ?, ?)`
      )
      .run(SUITE_ID, run.suite.suiteHash, NOW, NOW);
    database
      .prepare(
        `INSERT INTO endpoint_config
         (id, name, url_template, method, headers_json, body_selector, timeout_ms,
          default_concurrency, config_hash, revision, created_at, updated_at)
         VALUES (?, 'Endpoint', ?, 'POST', ?, ?, ?, ?, ?, 0, ?, ?)`
      )
      .run(
        ID_A,
        endpoint.urlTemplate,
        JSON.stringify(endpoint.headers),
        endpoint.bodySelector,
        endpoint.timeoutMs,
        endpoint.defaultConcurrency,
        endpointHash,
        NOW,
        NOW
      );
    const insertLlm = database.prepare(
      `INSERT INTO llm_config
       (id, name, provider_type, model, options_json, secret_refs_json, config_hash,
        revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    );
    insertLlm.run(
      ID_B,
      "Gemini",
      gemini.providerType,
      gemini.model,
      JSON.stringify({
        thinkingLevel: gemini.thinkingLevel,
        temperature: gemini.temperature,
        topP: gemini.topP,
        maxOutputTokens: gemini.maxOutputTokens,
        timeoutMs: gemini.timeoutMs,
        structuredOutput: gemini.structuredOutput
      }),
      JSON.stringify({ apiKey: gemini.apiKey.envKey }),
      geminiHash,
      NOW,
      NOW
    );
    insertLlm.run(
      ID_C,
      "Local",
      local.providerType,
      local.model,
      JSON.stringify({
        thinkingLevel: local.thinkingLevel,
        temperature: local.temperature,
        topP: local.topP,
        maxOutputTokens: local.maxOutputTokens,
        timeoutMs: local.timeoutMs,
        structuredOutput: local.structuredOutput,
        baseUrl: local.baseUrl,
        authKind: local.auth.kind
      }),
      JSON.stringify({}),
      localHash,
      NOW,
      NOW
    );
    database
      .prepare(
        `INSERT INTO llm_rubric_prompt
         (id, prompt_key, name, messages_json, prompt_hash, revision, created_at, updated_at)
         VALUES (?, 'quality', 'Rubric', ?, ?, 0, ?, ?)`
      )
      .run(
        ID_D,
        JSON.stringify(rubricMessages),
        hashPrompt({
          contractVersion: "cortex.prompt.v1",
          kind: "LLM_RUBRIC",
          promptKey: "quality",
          messages: rubricMessages
        }),
        NOW,
        NOW
      );
    database
      .prepare(
        `INSERT INTO case_analysis_prompt
         (id, prompt_key, name, messages_template_json, prompt_hash, revision, created_at, updated_at)
         VALUES (?, 'diagnose', 'Analysis', ?, ?, 0, ?, ?)`
      )
      .run(
        ID_E,
        JSON.stringify(analysisMessages),
        hashPrompt({
          contractVersion: "cortex.prompt.v1",
          kind: "CASE_ANALYSIS",
          promptKey: "diagnose",
          messages: analysisMessages
        }),
        NOW,
        NOW
      );
    database.close();
    const runManager = storage.createRunTransactionManager();
    await runManager.execute(async (transaction) => {
      await transaction.runs.insertPlatformRun(run);
      const claimed = await transaction.runs.claimStage(RUN_ID, 0, NOW);
      if (!claimed.ok) throw new Error("TEST_REST_CLAIM_FAILED");
      const progress = await transaction.runs.recordRestResult(restResult(), NOW);
      const completed = await transaction.runs.completeRestStage({
        runId: RUN_ID,
        expectedRevision: progress?.lockRevision ?? -1,
        expectedTotal: 1,
        resultSetHash: HASH,
        artifactManifest: sqliteRestArtifactManifest(RUN_ID),
        updatedAt: NOW
      });
      if (completed === null) throw new Error("TEST_REST_COMMIT_FAILED");
    });
    const evalClaim = await runManager.execute(async (transaction) =>
      transaction.runs.claimStage(RUN_ID, 3, NOW)
    );
    if (!evalClaim.ok) throw new Error("TEST_EVAL_CLAIM_FAILED");
    const evaluation = sqlitePassingEvalResult({
      runId: RUN_ID,
      definitionHash: RUN_CASE_HASH,
      restResultHash: restResult().resultHash,
      evidenceHash: HASH,
      completedAt: NOW
    });
    const evalManager = storage.createEvalTransactionManager();
    const evalResultSetHash = sqliteEvalResultSetHash(RUN_ID, HASH, [evaluation]);
    const committed = await evalManager.execute(async (transaction) =>
      transaction.evaluations.completeStage({
        runId: RUN_ID,
        expectedRevision: evalClaim.run.lockRevision,
        expectedTotal: 1,
        resultSetHash: evalResultSetHash,
        evaluationContextHash: HASH,
        results: [evaluation],
        artifactManifest: sqliteEvalArtifactManifest(RUN_ID),
        updatedAt: NOW
      })
    );
    if (!committed.ok) throw new Error("TEST_EVAL_COMMIT_FAILED");
    const snapshot = await storage
      .createCanonicalExportSnapshotFactory(
        new CaseImportWorkspaceManager({
          containmentRoot: projectRoot,
          temporaryRoot: join(projectRoot, ".cortex-eval", "tmp"),
          processLiveness,
          now: Date.now,
          nonce: (): string => "snapshot-config-nonce",
          pid: process.pid,
          ttlMs: 60_000,
          workspacePrefix: "canonical-export-"
        })
      )
      .create();

    const exported = [];
    for (const entityType of [
      "ENDPOINT_CONFIG",
      "LLM_CONFIG",
      "RUBRIC_PROMPT",
      "ANALYSIS_PROMPT",
      "RUN",
      "CASE_RESULT",
      "EVAL_RESULT"
    ] as const) {
      for await (const entity of snapshot.stream(entityType)) exported.push(entity);
    }

    expect(exported.map((entity) => entity.entityType)).toEqual([
      "ENDPOINT_CONFIG",
      "LLM_CONFIG",
      "LLM_CONFIG",
      "RUBRIC_PROMPT",
      "ANALYSIS_PROMPT",
      "RUN",
      "CASE_RESULT",
      "EVAL_RESULT"
    ]);
    const artifacts = [];
    for await (const artifact of snapshot.streamArtifacts()) artifacts.push(artifact);
    expect(artifacts.map((artifact) => artifact.kind)).toEqual([
      "NORMALIZED_EVAL_RESULTS",
      "RAW_PROMPTFOO_EVIDENCE",
      "REST_RESULTS"
    ]);
    expect(JSON.stringify(exported)).toContain("GEMINI_API_KEY");
    expect(JSON.stringify(exported)).not.toContain("expanded-secret");
    await snapshot.close();
  });
});
