import { describe, expect, it } from "vitest";
import { JevCaseEvaluationV1Schema } from "@cortex-eval/contracts/src/semantic-evaluation-contracts.ts";
import { SemanticEvaluationSchema } from "../src/sqlite-semantic-evaluation-schemas.ts";

const source = {
  provider: "jev-http",
  model: "jev-latest",
  planVersion: "cortex.semantic-evaluation-contract.v1",
  result: {
    contractVersion: "cortex.semantic-evaluation-contract.v1",
    passed: true,
    score: 1,
    decisions: [
      {
        questionId: "routing.correct",
        kind: "BOOLEAN",
        value: true,
        applicable: true,
        evidence: [],
        evidenceRefs: []
      }
    ],
    blockingFailures: [],
    warnings: []
  }
};
describe("JEV metric persistence contract", () => {
  it("roundtrips metrics and per-item verdict through storage and API schemas", () => {
    const enriched = {
      ...source,
      metrics: {
        durationMs: 1251,
        requestCount: 1,
        inputTokens: 11256,
        outputTokens: 209,
        usageComplete: true
      },
      result: {
        ...source.result,
        decisions: source.result.decisions.map((d) => ({
          ...d,
          question: "路由是否正确？",
          blocking: false,
          verdict: "PASS",
          passThreshold: 0.5
        }))
      }
    };
    const stored = SemanticEvaluationSchema.parse(JSON.parse(JSON.stringify(enriched)));
    expect(stored).toEqual(enriched);
    expect(JevCaseEvaluationV1Schema.parse(stored)).toEqual(enriched);
  });
  it("does not inject new defaults into historical records (preserves hashed data)", () => {
    expect(SemanticEvaluationSchema.parse(source)).toEqual(source);
    expect(JevCaseEvaluationV1Schema.parse(source)).toEqual(source);
  });
});
