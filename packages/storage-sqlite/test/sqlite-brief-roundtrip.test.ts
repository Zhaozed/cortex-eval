import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { caseFromV1, CaseDefinitionV1Schema } from "../src/sqlite-platform-run-mappers.ts";
import { caseDefinitionJson } from "@cortex-eval/domain/src/domain-case-projection.ts";
import { hashCaseDefinition } from "@cortex-eval/domain/src/domain-hash-inputs.ts";
import { SemanticEvaluationSchema } from "../src/sqlite-semantic-evaluation-schemas.ts";

function fixture(type: string): ReturnType<typeof CaseDefinitionV1Schema.parse> {
  return CaseDefinitionV1Schema.parse(
    JSON.parse(
      readFileSync(
        new URL(`../../../test_suite/brief-content/${type}.case.json`, import.meta.url),
        "utf8"
      )
    )
  );
}
describe("Frozen Brief storage boundary", () => {
  it.each(["daily", "meeting"])("roundtrips %s bundle, GT and scoring profile", (type) => {
    const source = fixture(type);
    const frozen = caseFromV1(CaseDefinitionV1Schema.parse(source));
    expect(caseDefinitionJson(frozen)).toEqual(source);
    const before = hashCaseDefinition({
      contractVersion: "cortex.case-definition.v1",
      caseKey: frozen.caseKey,
      definition: caseDefinitionJson(frozen)
    });
    const atom = source.semanticEvaluation?.brief?.checklist[0];
    if (!atom) throw new Error("fixture");
    atom.assertion += "修改";
    const after = caseFromV1(CaseDefinitionV1Schema.parse(source));
    expect(
      hashCaseDefinition({
        contractVersion: "cortex.case-definition.v1",
        caseKey: frozen.caseKey,
        definition: caseDefinitionJson(after)
      })
    ).not.toBe(before);
    expect(frozen.semanticEvaluation).not.toEqual(after.semanticEvaluation);
  });
  it("preserves atomic evidence and not-applicable metrics in result JSON", () => {
    const value = {
      provider: "fake",
      model: "test",
      planVersion: "cortex.brief-atomic-plan.v1",
      result: {
        contractVersion: "cortex.semantic-evaluation-contract.v1",
        passed: false,
        score: 0.75,
        decisions: [
          {
            questionId: "brief.P0.core",
            kind: "BOOLEAN",
            value: false,
            applicable: true,
            reason: "未覆盖",
            evidence: ["实际输出"],
            evidenceRefs: ["bundle/material/snapshot"]
          },
          {
            questionId: "brief.metric.P1",
            kind: "SCORE",
            value: 0,
            applicable: false,
            evidence: [],
            evidenceRefs: []
          }
        ],
        blockingFailures: ["brief.score:低于阈值"],
        warnings: []
      }
    };
    expect(SemanticEvaluationSchema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
  });
});
