import { describe, expect, it } from "vitest";
import { jevUsage } from "../src/features/runs/run-jev-usage.ts";
import { evidenceRow } from "./run-case-drawer-fixture.ts";
import { runReportCase } from "./run-test-fixture.ts";
const semantic = {
  provider: "jev",
  model: "jev-latest",
  planVersion: "v1",
  result: {
    contractVersion: "cortex.semantic-evaluation-contract.v1" as const,
    passed: true,
    score: 1,
    decisions: [],
    blockingFailures: [],
    warnings: []
  }
};
describe("JEV run usage totals", () => {
  it("includes measured usage and leaves historical unknowns incomplete", () => {
    const measured = {
      ...evidenceRow({}),
      evaluation: {
        ...runReportCase.evaluation,
        semanticEvaluation: {
          ...semantic,
          metrics: {
            durationMs: 100,
            requestCount: 1,
            inputTokens: 100,
            outputTokens: 0,
            usageComplete: true
          }
        }
      }
    };
    const historical = {
      ...evidenceRow({}),
      evaluation: { ...runReportCase.evaluation, semanticEvaluation: semantic }
    };
    expect(jevUsage([measured, historical])).toMatchObject({
      input: 100,
      output: 0,
      total: 100,
      recorded: 1,
      expected: 2,
      complete: false
    });
    expect(jevUsage([historical])).toMatchObject({
      recorded: 0,
      complete: false,
      inputKnown: false,
      outputKnown: false
    });
  });
  it("does not double count reused evaluations", () => {
    expect(
      jevUsage([
        {
          ...evidenceRow({}),
          evaluation: {
            ...runReportCase.evaluation,
            semanticEvaluation: semantic,
            provenance: { sourceKind: "RUN", sourceId: "source", sourceResultHash: "a".repeat(64) }
          }
        }
      ])
    ).toMatchObject({ expected: 0, recorded: 0, total: 0 });
  });
});
