import type {
  PlatformRun,
  StoredRestCaseResult
} from "../src/features/runs/platform-run-models.ts";
import { hashRestResultSet } from "@cortex-eval/domain/src/domain-hash-inputs.ts";

/** Primary platform Evaluation Run identity. */
export const RUN_ID = "01900000-0000-7000-8000-000000000001";
/** Source Run identity used by retry tests. */
export const SOURCE_RUN_ID = "01900000-0000-7000-8000-000000000002";
/** Stable test clock. */
export const NOW = "2026-07-14T00:00:00.000Z";
/** Stable semantic hash fixture. */
export const HASH = "a".repeat(64);

const definition = {
  caseKey: "case-1",
  description: "Case",
  threshold: 1,
  task: "route",
  requestBody: { input: "hello" },
  metadata: {
    requestId: "request-1",
    taskId: "task-1",
    businessModule: "chat",
    scenarioTag: "smoke"
  },
  assertions: [{ type: "equals", metric: "quality", weight: 1, value: "expected" }]
} as const;

/** One aligned successful REST fact. */
export const restResult: StoredRestCaseResult = {
  runId: RUN_ID,
  caseKey: "case-1",
  ordinal: 0,
  definition,
  caseDefinitionHash: "b".repeat(64),
  status: "SUCCEEDED",
  httpStatus: 200,
  providerOutput: { ok: false, errorMessage: "business" },
  errorType: null,
  errorMessage: null,
  durationMs: 4,
  completedAt: NOW,
  resultHash: "c".repeat(64),
  provenance: null
};

const restResultSetHash = hashRestResultSet({
  contractVersion: "cortex.rest-result-set.v1",
  cases: [{ caseKey: "case-1", ordinal: 0, resultHash: restResult.resultHash }]
});

/** Build one READY/EVALUATION platform Run. */
export function evaluationRun(): PlatformRun {
  return {
    id: RUN_ID,
    sourceType: "PLATFORM",
    sourceRunId: null,
    rerunMode: "NONE",
    suite: {
      id: "01900000-0000-7000-8000-000000000100",
      name: "Suite",
      suiteHash: HASH,
      cases: [{ caseKey: "case-1", ordinal: 0, definitionHash: "b".repeat(64), definition }]
    },
    endpoint: {
      sourceId: null,
      name: "Endpoint",
      configHash: HASH,
      definition: {
        urlTemplate: "https://example.test/{{vars.task}}",
        method: "POST",
        headers: {},
        bodySelector: "/request_body",
        timeoutMs: 1_000,
        defaultConcurrency: 4
      }
    },
    evaluator: {
      sourceId: null,
      name: "Evaluator",
      configHash: HASH,
      definition: {
        providerType: "GOOGLE_GEMINI",
        apiKey: { kind: "ENV_SECRET", envKey: "GEMINI_API_KEY" },
        model: "gemini-test",
        thinkingLevel: "OFF",
        temperature: 0,
        topP: 1,
        maxOutputTokens: 256,
        timeoutMs: 1_000,
        structuredOutput: "JSON_OBJECT"
      }
    },
    rubricPrompts: [],
    runContextHash: HASH,
    promptfooVersion: "0.121.18",
    contractVersions: {
      runSnapshot: "cortex.run-snapshot.v1",
      caseDefinition: "cortex.case-definition.v1",
      platformRestResults: "cortex.platform-rest-results.v1"
    },
    runExecutionLimits: {
      contractVersion: "cortex.run-execution-limits.v1",
      restConcurrency: 4,
      evalConcurrency: 2
    },
    runMode: "STAGED",
    status: "READY",
    stage: "EVALUATION",
    lockRevision: 2,
    cancelRequestedAt: null,
    restCompletedCount: 1,
    restErrorCount: 0,
    evalCompletedCount: 0,
    evalPassCount: 0,
    evalFailCount: 0,
    evalErrorCount: 0,
    evalNotEvaluatedCount: 0,
    resultSetHash: restResultSetHash,
    artifactManifest: {
      contractVersion: "cortex.artifact-manifest.v1",
      owner: { kind: "RUN", id: RUN_ID },
      artifacts: [
        {
          kind: "REST_RESULTS",
          path: `runs/${RUN_ID}/rest-results.json`,
          expectedSha256: HASH,
          expectedSizeBytes: 10,
          contractVersion: "cortex.platform-rest-results.v1"
        }
      ]
    },
    errorCode: null,
    errorMessage: null,
    startedAt: NOW,
    completedAt: null,
    createdAt: NOW,
    updatedAt: NOW
  };
}

/** Build one source Run with complete Evaluation Artifacts. */
export function reusableSourceRun(): PlatformRun {
  return {
    ...evaluationRun(),
    id: SOURCE_RUN_ID,
    artifactManifest: {
      contractVersion: "cortex.artifact-manifest.v1",
      owner: { kind: "RUN", id: SOURCE_RUN_ID },
      artifacts: [
        {
          kind: "REST_RESULTS",
          path: `runs/${SOURCE_RUN_ID}/rest-results.json`,
          expectedSha256: HASH,
          expectedSizeBytes: 10,
          contractVersion: "cortex.platform-rest-results.v1"
        },
        {
          kind: "RAW_PROMPTFOO_EVIDENCE",
          path: `runs/${SOURCE_RUN_ID}/promptfoo-raw.json`,
          expectedSha256: "d".repeat(64),
          expectedSizeBytes: 50,
          contractVersion: "cortex.platform-raw-promptfoo-evidence.v1"
        },
        {
          kind: "NORMALIZED_EVAL_RESULTS",
          path: `runs/${SOURCE_RUN_ID}/normalized-eval.json`,
          expectedSha256: "e".repeat(64),
          expectedSizeBytes: 80,
          contractVersion: "cortex.platform-normalized-eval.v1"
        }
      ]
    }
  };
}
