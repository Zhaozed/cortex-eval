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

import {
  sqlitePassingEvalResult,
  sqliteRunCaseDefinition
} from "../test-support/sqlite-platform-run-fixtures.ts";

export const openStorages: { close(): Promise<void> }[] = [];

export const FIRST_TIME = "2026-07-13T00:00:00.000Z";

export const SECOND_TIME = "2026-07-13T00:00:01.000Z";

export const HASH = "a".repeat(64);

export const RUN_A = "01900000-0000-7000-8000-000000000001";

export const RUN_B = "01900000-0000-7000-8000-000000000002";

export const RUN_C = "01900000-0000-7000-8000-000000000003";

export const RUN_RUNNING = "01900000-0000-7000-8000-000000000004";

export const RUN_READY = "01900000-0000-7000-8000-000000000005";

export const SUITE_ID = "01900000-0000-7000-8000-000000000100";

export const ENDPOINT_ID = "01900000-0000-7000-8000-000000000200";

export const EVALUATOR_ID = "01900000-0000-7000-8000-000000000300";

export const DEFINITION = sqliteRunCaseDefinition("case-1");

export const DEFINITION_HASH = hashCaseDefinition({
  contractVersion: "cortex.case-definition.v1",
  caseKey: DEFINITION.caseKey,
  definition: caseDefinitionJson(DEFINITION)
});

export const SUITE_HASH = hashSuite({
  contractVersion: "cortex.suite.v1",
  cases: [{ caseKey: DEFINITION.caseKey, ordinal: 0, definitionHash: DEFINITION_HASH }]
});

export const ENDPOINT_DEFINITION = {
  urlTemplate: "https://example.test/{{vars.task}}",
  method: "POST" as const,
  headers: {},
  bodySelector: "/request_body",
  timeoutMs: 1_000,
  defaultConcurrency: 4
};

export const ENDPOINT_HASH = hashEndpointConfig({
  contractVersion: "cortex.endpoint-config.v1",
  config: ENDPOINT_DEFINITION
});

export const EVALUATOR_DEFINITION = {
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

export const EVALUATOR_HASH = hashLlmConfig({
  contractVersion: "cortex.llm-config.v1",
  config: EVALUATOR_DEFINITION
});

export const RUBRIC_SET_HASH = hashRubricPromptSet({
  contractVersion: "cortex.rubric-prompt-set.v1",
  prompts: []
});

export const LIMITS = {
  contractVersion: "cortex.run-execution-limits.v1" as const,
  restConcurrency: 4,
  evalConcurrency: 2
};

export const RUN_CONTEXT_HASH = hashRunContext({
  contractVersion: "cortex.run-context.v1",
  suiteHash: SUITE_HASH,
  endpointConfigHash: ENDPOINT_HASH,
  evaluatorConfigHash: EVALUATOR_HASH,
  rubricPromptSetHash: RUBRIC_SET_HASH,
  promptfooVersion: "0.121.18",
  runExecutionLimits: LIMITS
});

export function seedCurrentResources(databasePath: string): void {
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

export function platformRun(
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

export function successResult(
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

export function passingEvalResult(runId: string): ReturnType<typeof sqlitePassingEvalResult> {
  return sqlitePassingEvalResult({
    runId,
    definitionHash: DEFINITION_HASH,
    restResultHash: successResult(runId).resultHash,
    evidenceHash: HASH,
    completedAt: SECOND_TIME
  });
}
