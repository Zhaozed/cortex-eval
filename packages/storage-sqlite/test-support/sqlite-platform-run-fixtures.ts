import type { CaseDefinition } from "@cortex-eval/domain/src/domain-evaluation.ts";
import { hashEvalResultSet } from "@cortex-eval/domain/src/domain-hash-inputs.ts";

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
