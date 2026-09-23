import { describe, expect, it } from "vitest";
import { briefEvaluationError } from "../src/features/evaluation/brief-evaluation-error.ts";
import type { ImportedEvalCase } from "../src/features/evaluation/promptfoo-result-importer.ts";

const item: ImportedEvalCase = {
  caseKey: "brief",
  ordinal: 0,
  status: "PASS",
  promptfooSuccess: true,
  score: 1,
  reason: "ok",
  evaluationError: null,
  assertions: [],
  diffs: [],
  metrics: [],
  latencyMs: null,
  tokenUsage: null,
  cost: null,
  rawEvidence: null,
  evalResultHash: "a".repeat(64),
  finalCaseResultHash: "b".repeat(64),
  provenance: null
};
describe("Brief evaluation error normalization", () => {
  it("uses error/null score and recomputes frozen identities without exposing provider errors", () => {
    const result = briefEvaluationError({
      item,
      error: new Error("api-key-secret"),
      caseDefinitionHash: "c".repeat(64),
      restResultHash: "d".repeat(64)
    });
    expect(result.status).toBe("EVALUATION_ERROR");
    expect(result.score).toBeNull();
    expect(result.reason).not.toContain("api-key-secret");
    expect(result.evalResultHash).not.toBe(item.evalResultHash);
    expect(result.finalCaseResultHash).not.toBe(item.finalCaseResultHash);
  });
  it("preserves the safe review code", () => {
    const result = briefEvaluationError({
      item,
      error: new Error("BRIEF_JUDGE_REVIEW_REQUIRED:brief.P0.id"),
      caseDefinitionHash: "c".repeat(64),
      restResultHash: "d".repeat(64)
    });
    expect(result.evaluationError?.code).toBe("BRIEF_JUDGE_REVIEW_REQUIRED");
  });
});
