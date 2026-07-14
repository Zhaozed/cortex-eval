import { describe, expect, it } from "vitest";

import type { DomainJsonObject } from "@cortex-eval/domain/src/domain-canonical-hash.ts";
import type { AssertionDefinition } from "@cortex-eval/domain/src/domain-evaluation.ts";

import { importPromptfooResults } from "../src/features/evaluation/promptfoo-result-importer.ts";

const HASH = "a".repeat(64);

// Build one evaluated Case around an exact special-aggregation component list.
function specialCaseInput(
  assertions: readonly AssertionDefinition[],
  componentResults: readonly Record<string, unknown>[],
  providerOutput: DomainJsonObject,
  aggregate: { readonly pass: boolean; readonly score: number; readonly reason: string },
  rubricPromptMaterializations: Readonly<Record<string, string>> = {}
): Parameters<typeof importPromptfooResults>[0] {
  return {
    promptfooVersion: "0.121.18",
    evaluationOwner: { kind: "RUN", id: "01900000-0000-7000-8000-000000000001" },
    evaluationContextHash: HASH,
    raw: {
      results: {
        version: 3,
        results: [
          {
            metadata: { case_id: "case-1" },
            response: { output: providerOutput },
            success: aggregate.pass,
            score: aggregate.score,
            latencyMs: 12,
            cost: 0,
            gradingResult: {
              pass: aggregate.pass,
              score: aggregate.score,
              reason: aggregate.reason,
              componentResults
            }
          }
        ]
      }
    },
    cases: [
      {
        caseKey: "case-1",
        ordinal: 0,
        caseDefinitionHash: "1".repeat(64),
        definition: {
          caseKey: "case-1",
          description: "special aggregation",
          threshold: 0.75,
          task: "router",
          requestBody: { input: "case-1" },
          metadata: {
            requestId: "request-1",
            taskId: "task-1",
            businessModule: "module",
            scenarioTag: "scenario"
          },
          assertions
        },
        restResult: {
          status: "SUCCEEDED",
          resultHash: "2".repeat(64),
          providerOutput
        }
      }
    ],
    rawEvidence: {
      present: true,
      path: "runs/run-1/promptfoo-raw.json",
      expectedSha256: HASH,
      expectedSizeBytes: 10
    },
    rubricPromptMaterializations
  };
}

describe("Promptfoo 特殊聚合结果 Importer", () => {
  it("不因 select-best 类型名称拒绝已经结构对齐的结果", () => {
    const result = importPromptfooResults(
      specialCaseInput(
        [
          { type: "select-best", metric: "selection", weight: 1, value: "prefer exact" },
          { type: "equals", metric: "quality", weight: 1, value: "actual" }
        ],
        [
          {
            pass: true,
            score: 1,
            reason: "Assertion passed",
            assertion: { type: "equals", metric: "quality", value: "actual" }
          },
          {
            pass: true,
            score: 1,
            reason: "Output selected as the best: prefer exact",
            assertion: { type: "select-best", metric: "selection", value: "prefer exact" }
          }
        ],
        { answer: "actual" },
        { pass: true, score: 1, reason: "Aggregate score 1.00 ≥ 0.75 threshold" }
      )
    );

    expect(result.cases[0]?.assertions.map((assertion) => assertion.type)).toEqual([
      "equals",
      "select-best"
    ]);
  });

  it("max-score 多行只按通用重复 Case 规则拒绝，不按类型预判", () => {
    const first = specialCaseInput(
      [
        {
          type: "max-score",
          metric: "selection",
          weight: 1,
          value: { method: "average" }
        },
        { type: "equals", metric: "quality", weight: 1, value: "actual" }
      ],
      [
        {
          pass: true,
          score: 1,
          reason: "Assertion passed",
          assertion: { type: "equals", metric: "quality", value: "actual" }
        },
        {
          pass: true,
          score: 1,
          reason: "Selected as highest scoring output (score: 1.000)",
          assertion: {
            type: "max-score",
            metric: "selection",
            value: { method: "average" }
          }
        }
      ],
      { answer: "actual" },
      { pass: true, score: 1, reason: "Aggregate score 1.00 ≥ 0.75 threshold" }
    );
    const root = first.raw as {
      readonly results: { readonly version: number; readonly results: readonly unknown[] };
    };
    const row = root.results.results[0];

    expect(() =>
      importPromptfooResults({
        ...first,
        raw: { results: { version: 3, results: [row, row] } }
      })
    ).toThrow("PROMPTFOO_IMPORT_CASE_DUPLICATE");
  });

  it("把受控配置中的内联 Rubric Prompt 严格对账回冻结 prompt:// 身份", () => {
    const materialized = JSON.stringify([
      { role: "system", content: "judge" },
      { role: "user", content: "{{output}} {{rubric}}" }
    ]);
    const result = importPromptfooResults(
      specialCaseInput(
        [
          {
            type: "llm-rubric",
            metric: "quality",
            weight: 1,
            value: "criterion",
            rubricPrompt: "prompt://quality"
          }
        ],
        [
          {
            pass: true,
            score: 1,
            reason: "meets criterion",
            assertion: {
              type: "llm-rubric",
              metric: "quality",
              weight: 1,
              value: "criterion",
              rubricPrompt: materialized
            }
          }
        ],
        { answer: "actual" },
        { pass: true, score: 1, reason: "Aggregate score 1.00 ≥ 0.75 threshold" },
        { "prompt://quality": materialized }
      )
    );

    expect(result.cases[0]?.assertions[0]?.metric).toBe("quality");
  });

  it("复现 redteam guardrails 阻断在 Case 聚合层强制通过的语义", () => {
    const result = importPromptfooResults(
      specialCaseInput(
        [
          {
            type: "guardrails",
            metric: "safety",
            weight: 1,
            config: { purpose: "redteam" }
          }
        ],
        [
          {
            pass: false,
            score: 0,
            reason: "Output failed safety checks",
            assertion: {
              type: "guardrails",
              metric: "safety",
              config: { purpose: "redteam" }
            }
          }
        ],
        { answer: "blocked" },
        { pass: true, score: 0, reason: "Content failed guardrail safety checks" }
      )
    );

    expect(result.cases[0]).toMatchObject({
      status: "PASS",
      score: 0,
      reason: "Content failed guardrail safety checks",
      assertions: [{ type: "guardrails", status: "FAIL" }]
    });
  });

  it("redteam guardrails 只覆盖所在 Assertion Set，不越层覆盖 Case Threshold", () => {
    const child = {
      pass: false,
      score: 0,
      reason: "Output failed safety checks",
      assertion: {
        type: "guardrails",
        metric: "safety",
        config: { purpose: "redteam" }
      }
    };
    const set = {
      pass: true,
      score: 0,
      reason: "Content failed guardrail safety checks",
      componentResults: [child],
      metadata: {
        assertionSet: {
          type: "assert-set",
          assertionCount: 1,
          metric: "set-safety",
          threshold: 0.75,
          weight: 1
        }
      }
    };
    const result = importPromptfooResults(
      specialCaseInput(
        [
          {
            type: "assert-set",
            metric: "set-safety",
            weight: 1,
            threshold: 0.75,
            assertions: [
              {
                type: "guardrails",
                metric: "safety",
                weight: 1,
                config: { purpose: "redteam" }
              }
            ]
          }
        ],
        [set, child],
        { answer: "blocked" },
        { pass: false, score: 0, reason: "Aggregate score 0.00 < 0.75 threshold" }
      )
    );

    expect(result.cases[0]).toMatchObject({
      status: "FAIL",
      assertions: [
        { type: "assert-set", status: "PASS" },
        { type: "guardrails", status: "FAIL" }
      ]
    });
  });
});
