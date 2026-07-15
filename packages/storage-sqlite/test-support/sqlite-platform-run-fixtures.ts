import type { CaseDefinition } from "@cortex-eval/domain/src/domain-evaluation.ts";
import { hashEvalResultSet } from "@cortex-eval/domain/src/domain-hash-inputs.ts";
import type { PlatformRun } from "@cortex-eval/application/src/features/runs/platform-run-models.ts";
import type { PlatformEvalCaseResult } from "@cortex-eval/application/src/features/evaluation/platform-eval-models.ts";
import {
  hashCaseDefinition,
  hashEvalResult,
  hashFinalCaseResult
} from "@cortex-eval/domain/src/domain-hash-inputs.ts";

/** Hash one platform Evaluation fixture with its execution-version identity. */
export function sqliteEvalResultSetHash(
  runId: string,
  evaluationContextHash: string,
  cases: readonly {
    readonly caseKey: string;
    readonly ordinal: number;
    readonly evalResultHash: string;
  }[]
): string {
  return hashEvalResultSet({
    contractVersion: "cortex.eval-result-set.v1",
    owner: { kind: "RUN", id: runId },
    evaluationContextHash,
    cases
  });
}

/** Build one deterministic frozen Case definition for SQLite Run repository tests. */
export function sqliteRunCaseDefinition(caseKey: string): CaseDefinition {
  return {
    caseKey,
    description: caseKey,
    threshold: 1,
    task: "route",
    requestBody: { input: caseKey },
    metadata: {
      requestId: `request-${caseKey}`,
      taskId: `task-${caseKey}`,
      businessModule: "chat",
      scenarioTag: "smoke"
    },
    assertions: [{ type: "equals", metric: "quality", weight: 1 }]
  };
}

/** Build the two immutable Evaluation Artifact descriptors used by repository commits. */
export function sqliteEvalArtifactManifest(runId: string): PlatformRun["artifactManifest"] {
  return {
    contractVersion: "cortex.artifact-manifest.v1",
    owner: { kind: "RUN", id: runId },
    artifacts: [
      {
        kind: "RAW_PROMPTFOO_EVIDENCE",
        path: "runs/raw.json",
        expectedSha256: "a".repeat(64),
        expectedSizeBytes: 10,
        contractVersion: "cortex.raw-promptfoo-evidence.v1"
      },
      {
        kind: "NORMALIZED_EVAL_RESULTS",
        path: "runs/eval.json",
        expectedSha256: "b".repeat(64),
        expectedSizeBytes: 20,
        contractVersion: "cortex.platform-normalized-eval.v1"
      }
    ]
  };
}

/** Build the immutable REST Artifact descriptor used by repository commits. */
export function sqliteRestArtifactManifest(runId: string): PlatformRun["artifactManifest"] {
  return {
    contractVersion: "cortex.artifact-manifest.v1",
    owner: { kind: "RUN", id: runId },
    artifacts: [
      {
        kind: "REST_RESULTS",
        path: "runs/rest.json",
        expectedSha256: "d".repeat(64),
        expectedSizeBytes: 30,
        contractVersion: "cortex.platform-rest-results.v1"
      }
    ]
  };
}

/** Build one hash-consistent normalized PASS fact for SQLite repository tests. */
export function sqlitePassingEvalResult(input: {
  readonly runId: string;
  readonly definitionHash: string;
  readonly restResultHash: string;
  readonly evidenceHash: string;
  readonly completedAt: string;
}): PlatformEvalCaseResult {
  const assertions = [
    {
      index: 0,
      definitionHash: hashCaseDefinition({
        contractVersion: "cortex.case-definition.v1",
        caseKey: "assertion",
        definition: { type: "equals", metric: "quality", weight: 1 }
      }),
      type: "equals",
      metric: "quality",
      weight: 1,
      status: "PASS" as const,
      score: 1,
      reason: "Assertion passed"
    }
  ];
  const evalResultHash = hashEvalResult({
    contractVersion: "cortex.eval-result.v1",
    caseKey: "case-1",
    status: "PASS",
    promptfooSuccess: true,
    score: 1,
    reason: "All assertions passed",
    evaluationError: null,
    assertions,
    diffs: [],
    metrics: [{ metric: "quality", status: "PASS" }]
  });
  return {
    runId: input.runId,
    caseKey: "case-1",
    ordinal: 0,
    status: "PASS",
    promptfooSuccess: true,
    score: 1,
    reason: "All assertions passed",
    evaluationError: null,
    assertions,
    diffs: [],
    metrics: [{ metric: "quality", status: "PASS" }],
    latencyMs: 5,
    tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    cost: 0,
    rawEvidence: {
      present: true,
      path: "runs/raw.json",
      expectedSha256: input.evidenceHash,
      expectedSizeBytes: 10
    },
    evalResultHash,
    finalCaseResultHash: hashFinalCaseResult({
      contractVersion: "cortex.final-case-result.v1",
      caseDefinitionHash: input.definitionHash,
      restResultHash: input.restResultHash,
      evalResultHash
    }),
    provenance: null,
    createdAt: input.completedAt,
    updatedAt: input.completedAt
  };
}
