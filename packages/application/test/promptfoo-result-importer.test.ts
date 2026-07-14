import { describe, expect, it } from "vitest";

import type { DomainJsonObject } from "@cortex-eval/domain/src/domain-canonical-hash.ts";
import type {
  AssertionDefinition,
  CaseDefinition
} from "@cortex-eval/domain/src/domain-evaluation.ts";

import {
  importPartialPromptfooResults,
  importPromptfooResults
} from "../src/features/evaluation/promptfoo-result-importer.ts";

const HASH = "a".repeat(64);

function caseDefinition(caseKey: string): CaseDefinition {
  return {
    caseKey,
    description: `${caseKey} description`,
    threshold: 0.75,
    task: "router",
    requestBody: { input: caseKey },
    metadata: {
      requestId: `${caseKey}-request`,
      taskId: `${caseKey}-task`,
      businessModule: "module",
      scenarioTag: "scenario"
    },
    assertions: [
      { type: "equals", metric: "quality", weight: 1, value: "expected" },
      {
        type: "is-json",
        metric: "quality",
        weight: 2,
        value: {
          type: "object",
          required: ["answer"],
          properties: { answer: { const: "expected" } }
        }
      }
    ]
  };
}

function rawResult(caseKey: string): Record<string, unknown> {
  return {
    metadata: { case_id: caseKey },
    response: { output: { answer: "actual" } },
    success: false,
    score: 1 / 3,
    latencyMs: 12,
    cost: 0,
    gradingResult: {
      pass: false,
      score: 1 / 3,
      reason: "aggregate failed",
      tokensUsed: { prompt: 3, completion: 2, total: 5 },
      componentResults: [
        {
          pass: true,
          score: 1,
          reason: "Assertion passed",
          assertion: { type: "equals", metric: "quality", value: "expected" }
        },
        {
          pass: false,
          score: 0,
          reason: "schema mismatch",
          assertion: {
            type: "is-json",
            metric: "quality",
            weight: 2,
            value: {
              type: "object",
              required: ["answer"],
              properties: { answer: { const: "expected" } }
            }
          }
        }
      ]
    }
  };
}

function input(): Parameters<typeof importPromptfooResults>[0] {
  return {
    promptfooVersion: "0.121.18",
    evaluationOwner: { kind: "RUN", id: "01900000-0000-7000-8000-000000000001" },
    evaluationContextHash: HASH,
    raw: { results: { version: 3, results: [rawResult("case-1")] } },
    cases: [
      {
        caseKey: "case-1",
        ordinal: 0,
        caseDefinitionHash: "1".repeat(64),
        definition: caseDefinition("case-1"),
        restResult: {
          status: "SUCCEEDED",
          resultHash: "2".repeat(64),
          providerOutput: { answer: "actual" }
        }
      },
      {
        caseKey: "case-2",
        ordinal: 1,
        caseDefinitionHash: "3".repeat(64),
        definition: caseDefinition("case-2"),
        restResult: { status: "ERROR", resultHash: "4".repeat(64) }
      }
    ],
    rawEvidence: {
      present: true,
      path: "runs/run-1/promptfoo-raw.json",
      expectedSha256: HASH,
      expectedSizeBytes: 10
    },
    rubricPromptMaterializations: {}
  };
}

// Build one evaluated Case around an exact component list.
function singleCaseInput(
  assertions: readonly AssertionDefinition[],
  componentResults: readonly Record<string, unknown>[],
  providerOutput: DomainJsonObject,
  aggregate: { readonly pass: boolean; readonly score: number; readonly reason: string }
): Parameters<typeof importPromptfooResults>[0] {
  const definition = { ...caseDefinition("case-1"), assertions };
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
        definition,
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
    rubricPromptMaterializations: {}
  };
}

describe("Promptfoo 固定版本结果 Importer", () => {
  it("允许重跑只导入保持原 Ordinal 的有序子集，但不生成不完整集合 Hash", () => {
    const base = input();
    const second = base.cases[1];
    if (second === undefined) throw new Error("TEST_CASE_MISSING");
    const cases = importPartialPromptfooResults({
      ...base,
      raw: { results: { version: 3, results: [] } },
      cases: [second]
    });

    expect(cases).toMatchObject([{ caseKey: "case-2", ordinal: 1, status: "NOT_EVALUATED" }]);
  });

  it("拒绝 Raw 评分输出与冻结 REST Provider Output 不一致", () => {
    const base = input();
    const mismatched = {
      ...rawResult("case-1"),
      response: { output: { answer: "stale" } }
    };

    expect(() =>
      importPromptfooResults({
        ...base,
        raw: { results: { version: 3, results: [mismatched] } }
      })
    ).toThrow("PROMPTFOO_IMPORT_PROVIDER_OUTPUT:case-1");
  });

  it("Promptfoo 结构化 Row Error 不要求伪造 Provider Output，并清洗上游错误正文", () => {
    const base = input();
    const result = importPromptfooResults({
      ...base,
      raw: {
        results: {
          version: 3,
          results: [
            {
              metadata: { case_id: "case-1" },
              success: false,
              failureReason: 2,
              error: `private provider failure at ${process.cwd()}`,
              gradingResult: null,
              score: 0,
              response: undefined,
              latencyMs: 0,
              cost: 0,
              namedScores: {},
              tokenUsage: { prompt: 0, completion: 0, total: 0 }
            }
          ]
        }
      }
    });

    expect(result.cases[0]).toMatchObject({
      status: "EVALUATION_ERROR",
      promptfooSuccess: null,
      evaluationError: { code: "PROMPTFOO_ASSERTION_EXECUTION_ERROR" }
    });
    expect(JSON.stringify(result.cases[0])).not.toContain("private provider failure");
    expect(JSON.stringify(result.cases[0])).not.toContain(process.cwd());
  });

  it.each([
    ["缺失错误字段", { error: undefined }],
    ["错误字段类型错误", { error: { private: true } }],
    ["携带评分聚合", { gradingResult: { pass: false, score: 0 } }],
    ["携带 Provider 响应", { response: { output: { ok: true } } }],
    ["分数与固定错误结构冲突", { score: 1 }]
  ])("拒绝 %s 的 Promptfoo Row Error", (_name, override) => {
    const base = input();
    expect(() =>
      importPromptfooResults({
        ...base,
        raw: {
          results: {
            version: 3,
            results: [
              {
                metadata: { case_id: "case-1" },
                success: false,
                failureReason: 2,
                error: "provider failure",
                gradingResult: null,
                score: 0,
                response: undefined,
                latencyMs: 0,
                cost: 0,
                namedScores: {},
                tokenUsage: { prompt: 0, completion: 0, total: 0 },
                ...override
              }
            ]
          }
        }
      })
    ).toThrow("PROMPTFOO_IMPORT_ROW_ERROR:case-1");
  });

  it("严格对齐评估组件、生成 Diff/Metric/NOT_EVALUATED 与稳定 Hash", () => {
    const result = importPromptfooResults(input());

    expect(result.resultSetHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.cases).toHaveLength(2);
    expect(result.cases[0]).toMatchObject({
      caseKey: "case-1",
      ordinal: 0,
      status: "FAIL",
      promptfooSuccess: false,
      score: 1 / 3,
      reason: "aggregate failed",
      evaluationError: null,
      metrics: [{ metric: "quality", status: "FAIL" }],
      latencyMs: 12,
      tokenUsage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      cost: 0,
      rawEvidence: input().rawEvidence,
      provenance: null
    });
    expect(result.cases[0]?.assertions).toHaveLength(2);
    expect(result.cases[0]?.assertions[0]?.definitionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.cases[0]?.diffs.map((item) => item.keyword)).toEqual(["const"]);
    expect(result.cases[0]?.evalResultHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.cases[0]?.finalCaseResultHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.cases[1]).toMatchObject({
      caseKey: "case-2",
      ordinal: 1,
      status: "NOT_EVALUATED",
      promptfooSuccess: null,
      score: null,
      reason: null,
      evaluationError: null,
      assertions: [],
      diffs: [],
      metrics: [{ metric: "quality", status: "NOT_EVALUATED" }],
      latencyMs: null,
      tokenUsage: null,
      cost: null,
      rawEvidence: null,
      provenance: null
    });
  });

  it("拒绝版本、重复 Case、未知 Case 和组件错位", () => {
    const base = input();
    expect(() =>
      importPromptfooResults({ ...base, raw: { results: { version: 2, results: [] } } })
    ).toThrow("PROMPTFOO_IMPORT_VERSION");
    expect(() =>
      importPromptfooResults({
        ...base,
        raw: { results: { version: 3, results: [rawResult("case-1"), rawResult("case-1")] } }
      })
    ).toThrow("PROMPTFOO_IMPORT_CASE_DUPLICATE");
    expect(() =>
      importPromptfooResults({
        ...base,
        raw: { results: { version: 3, results: [rawResult("unknown")] } }
      })
    ).toThrow("PROMPTFOO_IMPORT_CASE_UNKNOWN");
    const misaligned = rawResult("case-1");
    const grading = misaligned.gradingResult as { componentResults: Record<string, unknown>[] };
    grading.componentResults[0] = {
      ...grading.componentResults[0],
      assertion: { type: "contains", metric: "quality", value: "expected" }
    };
    expect(() =>
      importPromptfooResults({
        ...base,
        raw: { results: { version: 3, results: [misaligned] } }
      })
    ).toThrow("PROMPTFOO_IMPORT_COMPONENT_ALIGNMENT:case-1:0");
  });

  it("同类型、Metric、Weight 但完整 Definition 不同时拒绝错位组件", () => {
    const base = input();
    const misaligned = rawResult("case-1");
    const grading = misaligned.gradingResult as { componentResults: Record<string, unknown>[] };
    grading.componentResults[0] = {
      ...grading.componentResults[0],
      assertion: { type: "equals", metric: "quality", value: "different" }
    };

    expect(() =>
      importPromptfooResults({
        ...base,
        raw: { results: { version: 3, results: [misaligned] } }
      })
    ).toThrow("PROMPTFOO_IMPORT_COMPONENT_ALIGNMENT:case-1:0");
  });

  it("is-json 无 Schema 时只校验 JSON，不生成虚构 Diff", () => {
    const assertion = { type: "is-json", metric: "json", weight: 1 } as const;
    const result = importPromptfooResults(
      singleCaseInput(
        [assertion],
        [
          {
            pass: true,
            score: 1,
            reason: "Assertion passed",
            assertion: { type: "is-json", metric: "json" }
          }
        ],
        { answer: "actual" },
        { pass: true, score: 1, reason: "Aggregate score 1.00 ≥ 0.75 threshold" }
      )
    );

    expect(result.cases[0]?.diffs).toEqual([]);
  });

  it("is-json 字符串 YAML Schema 使用锁定 Validator 生成 Diff", () => {
    const schema = [
      "type: object",
      "required:",
      "  - answer",
      "properties:",
      "  answer:",
      "    const: expected"
    ].join("\n");
    const assertion = { type: "is-json", metric: "json", weight: 1, value: schema } as const;
    const result = importPromptfooResults(
      singleCaseInput(
        [assertion],
        [
          {
            pass: false,
            score: 0,
            reason: "schema mismatch",
            assertion: { type: "is-json", metric: "json", value: schema }
          }
        ],
        { answer: "actual" },
        { pass: false, score: 0, reason: "schema mismatch" }
      )
    );

    expect(result.cases[0]?.diffs.map((item) => item.keyword)).toEqual(["const"]);
  });

  it("Assertion Set 聚合及子组件按展开顺序与完整定义对齐", () => {
    const childPass = {
      type: "equals",
      metric: "child-pass",
      weight: 1,
      value: "actual"
    } as const;
    const childFail = {
      type: "equals",
      metric: "child-fail",
      weight: 3,
      value: "different"
    } as const;
    const assertionSet = {
      type: "assert-set",
      metric: "set-quality",
      weight: 2,
      threshold: 1,
      assertions: [childPass, childFail]
    } as const;
    const childComponents = [
      {
        pass: true,
        score: 1,
        reason: "Assertion passed",
        assertion: { type: "equals", metric: "child-pass", value: "actual" }
      },
      {
        pass: false,
        score: 0,
        reason: "Expected output to equal different",
        assertion: {
          type: "equals",
          metric: "child-fail",
          weight: 3,
          value: "different"
        }
      }
    ];
    const aggregate = {
      pass: false,
      score: 0.25,
      reason: "Aggregate score 0.25 < 1 threshold",
      componentResults: childComponents,
      metadata: {
        assertionSet: {
          type: "assert-set",
          assertionCount: 2,
          metric: "set-quality",
          threshold: 1,
          weight: 2
        }
      }
    };

    const result = importPromptfooResults(
      singleCaseInput(
        [assertionSet],
        [aggregate, ...childComponents],
        { answer: "actual" },
        { pass: false, score: 0.25, reason: "Aggregate score 0.25 < 1 threshold" }
      )
    );

    expect(
      result.cases[0]?.assertions.map((item) => [item.type, item.metric, item.status])
    ).toEqual([
      ["assert-set", "set-quality", "FAIL"],
      ["equals", "child-pass", "PASS"],
      ["equals", "child-fail", "FAIL"]
    ]);
    expect(result.cases[0]?.metrics).toEqual([
      { metric: "child-fail", status: "FAIL" },
      { metric: "child-pass", status: "PASS" },
      { metric: "set-quality", status: "FAIL" }
    ]);
  });

  it("拒绝与子组件 Weight/Threshold 不一致的 Assertion Set 聚合", () => {
    const childPass = {
      type: "equals",
      metric: "child-pass",
      weight: 1,
      value: "actual"
    } as const;
    const childFail = {
      type: "equals",
      metric: "child-fail",
      weight: 3,
      value: "different"
    } as const;
    const children = [
      {
        pass: true,
        score: 1,
        reason: "Assertion passed",
        assertion: { type: "equals", metric: "child-pass", value: "actual" }
      },
      {
        pass: false,
        score: 0,
        reason: "failed",
        assertion: {
          type: "equals",
          metric: "child-fail",
          weight: 3,
          value: "different"
        }
      }
    ];
    const aggregate = {
      pass: true,
      score: 1,
      reason: "tampered",
      componentResults: children,
      metadata: {
        assertionSet: {
          type: "assert-set",
          assertionCount: 2,
          metric: "set-quality",
          threshold: 1,
          weight: 2
        }
      }
    };

    expect(() =>
      importPromptfooResults(
        singleCaseInput(
          [
            {
              type: "assert-set",
              metric: "set-quality",
              weight: 2,
              threshold: 1,
              assertions: [childPass, childFail]
            }
          ],
          [aggregate, ...children],
          { answer: "actual" },
          { pass: true, score: 1, reason: "tampered" }
        )
      )
    ).toThrow("PROMPTFOO_IMPORT_COMPONENT_AGGREGATE:case-1:0");
  });

  it("REST Error 的 NOT_EVALUATED Metric 覆盖 Assertion Set 与全部子组件", () => {
    const base = singleCaseInput(
      [
        {
          type: "assert-set",
          metric: "set-quality",
          weight: 1,
          assertions: [
            { type: "equals", metric: "child-a", weight: 1, value: "a" },
            { type: "equals", metric: "child-b", weight: 1, value: "b" }
          ]
        }
      ],
      [],
      { answer: "actual" },
      { pass: false, score: 0, reason: "unused" }
    );
    const expected = base.cases[0];
    if (expected === undefined) throw new Error("测试输入缺少 Case");
    const result = importPromptfooResults({
      ...base,
      raw: { results: { version: 3, results: [] } },
      cases: [
        {
          ...expected,
          restResult: { status: "ERROR", resultHash: "2".repeat(64) }
        }
      ]
    });

    expect(result.cases[0]?.metrics).toEqual([
      { metric: "child-a", status: "NOT_EVALUATED" },
      { metric: "child-b", status: "NOT_EVALUATED" },
      { metric: "set-quality", status: "NOT_EVALUATED" }
    ]);
  });

  it("Assertion Set 未设置 Threshold 时要求全部子组件通过", () => {
    const child = {
      pass: true,
      score: 1,
      reason: "Assertion passed",
      assertion: { type: "equals", metric: "child", value: "actual" }
    };
    const aggregate = {
      pass: true,
      score: 1,
      reason: "All assertions passed",
      componentResults: [child],
      metadata: {
        assertionSet: {
          type: "assert-set",
          assertionCount: 1,
          metric: "set-quality",
          weight: 1
        }
      }
    };

    const result = importPromptfooResults(
      singleCaseInput(
        [
          {
            type: "assert-set",
            metric: "set-quality",
            weight: 1,
            assertions: [{ type: "equals", metric: "child", weight: 1, value: "actual" }]
          }
        ],
        [aggregate, child],
        { answer: "actual" },
        { pass: true, score: 1, reason: "All assertions passed" }
      )
    );

    expect(result.cases[0]?.status).toBe("PASS");
  });

  it("全部顶层 Weight 为零时按 Promptfoo 规则聚合为零分", () => {
    const result = importPromptfooResults(
      singleCaseInput(
        [{ type: "equals", metric: "ignored", weight: 0, value: "different" }],
        [
          {
            pass: true,
            score: 0,
            reason: "weight zero",
            assertion: { type: "equals", metric: "ignored", weight: 0, value: "different" }
          }
        ],
        { answer: "actual" },
        { pass: false, score: 0, reason: "Aggregate score 0.00 < 0.75 threshold" }
      )
    );

    expect(result.cases[0]).toMatchObject({
      status: "FAIL",
      score: 0,
      assertions: [{ status: "PASS", weight: 0 }]
    });
  });

  it("拒绝锁定 Promptfoo 运行时不能生成的二级 Assertion Set 组件", () => {
    expect(() =>
      importPromptfooResults(
        singleCaseInput(
          [
            {
              type: "assert-set",
              metric: "outer",
              weight: 1,
              assertions: [
                {
                  type: "assert-set",
                  metric: "inner",
                  weight: 1,
                  assertions: [{ type: "equals", metric: "leaf", weight: 1, value: "a" }]
                }
              ]
            }
          ],
          [{}, {}, {}],
          { answer: "actual" },
          { pass: false, score: 0, reason: "invalid runtime shape" }
        )
      )
    ).toThrow("PROMPTFOO_IMPORT_COMPONENT_ALIGNMENT:case-1:0");
  });

  it("逐项拒绝顶层聚合和组件数组的未知结构", () => {
    const base = input();
    expect(() =>
      importPromptfooResults({
        ...base,
        raw: {
          results: {
            version: 3,
            results: [{ ...rawResult("case-1"), success: "false" }]
          }
        }
      })
    ).toThrow("PROMPTFOO_IMPORT_SUCCESS:case-1");

    const passMismatch = rawResult("case-1");
    const passGrading = passMismatch.gradingResult as Record<string, unknown>;
    passGrading.pass = true;
    expect(() =>
      importPromptfooResults({
        ...base,
        raw: { results: { version: 3, results: [passMismatch] } }
      })
    ).toThrow("PROMPTFOO_IMPORT_AGGREGATE:case-1");

    const missingComponents = rawResult("case-1");
    const missingGrading = missingComponents.gradingResult as Record<string, unknown>;
    missingGrading.componentResults = null;
    expect(() =>
      importPromptfooResults({
        ...base,
        raw: { results: { version: 3, results: [missingComponents] } }
      })
    ).toThrow("PROMPTFOO_IMPORT_COMPONENTS:case-1");

    const wrongCount = rawResult("case-1");
    const countGrading = wrongCount.gradingResult as { componentResults: unknown[] };
    countGrading.componentResults = countGrading.componentResults.slice(0, 1);
    expect(() =>
      importPromptfooResults({
        ...base,
        raw: { results: { version: 3, results: [wrongCount] } }
      })
    ).toThrow("PROMPTFOO_IMPORT_COMPONENT_COUNT:case-1");

    const wrongAggregate = rawResult("case-1");
    wrongAggregate.score = 0.5;
    const aggregateGrading = wrongAggregate.gradingResult as Record<string, unknown>;
    aggregateGrading.score = 0.5;
    expect(() =>
      importPromptfooResults({
        ...base,
        raw: { results: { version: 3, results: [wrongAggregate] } }
      })
    ).toThrow("PROMPTFOO_IMPORT_AGGREGATE:case-1");
  });

  it("完整 Definition 对齐保留 Config、Threshold 与 Transform 字段", () => {
    const assertion = {
      type: "javascript",
      metric: "custom",
      weight: 1,
      value: "output !== undefined",
      config: { mode: "strict" },
      threshold: 0.5,
      rubricPrompt: "rubric",
      transform: "output",
      contextTransform: "context"
    } as const;
    const result = importPromptfooResults(
      singleCaseInput(
        [assertion],
        [
          {
            pass: true,
            score: 1,
            reason: "Assertion passed",
            assertion
          }
        ],
        { answer: "actual" },
        { pass: true, score: 1, reason: "All assertions passed" }
      )
    );

    expect(result.cases[0]?.assertions[0]?.definitionHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("拒绝 Provider 覆盖、非对象 Config 和无法解析的字符串 Schema", () => {
    const base = input();
    const providerOverride = rawResult("case-1");
    const providerGrading = providerOverride.gradingResult as {
      componentResults: Record<string, unknown>[];
    };
    const providerComponent = providerGrading.componentResults[0];
    if (providerComponent === undefined) throw new Error("测试输入缺少组件");
    providerGrading.componentResults[0] = {
      ...providerComponent,
      assertion: {
        type: "equals",
        metric: "quality",
        value: "expected",
        provider: "forbidden"
      }
    };
    expect(() =>
      importPromptfooResults({
        ...base,
        raw: { results: { version: 3, results: [providerOverride] } }
      })
    ).toThrow("PROMPTFOO_IMPORT_COMPONENT_ALIGNMENT:case-1:0");

    const invalidConfig = rawResult("case-1");
    const configGrading = invalidConfig.gradingResult as {
      componentResults: Record<string, unknown>[];
    };
    const configComponent = configGrading.componentResults[0];
    if (configComponent === undefined) throw new Error("测试输入缺少组件");
    configGrading.componentResults[0] = {
      ...configComponent,
      assertion: {
        type: "equals",
        metric: "quality",
        value: "expected",
        config: "invalid"
      }
    };
    expect(() =>
      importPromptfooResults({
        ...base,
        raw: { results: { version: 3, results: [invalidConfig] } }
      })
    ).toThrow("PROMPTFOO_IMPORT_COMPONENT_ALIGNMENT:case-1:0");

    const invalidSchema = "[";
    expect(() =>
      importPromptfooResults(
        singleCaseInput(
          [{ type: "is-json", metric: "json", weight: 1, value: invalidSchema }],
          [
            {
              pass: false,
              score: 0,
              reason: "invalid schema",
              assertion: { type: "is-json", metric: "json", value: invalidSchema }
            }
          ],
          { answer: "actual" },
          { pass: false, score: 0, reason: "invalid schema" }
        )
      )
    ).toThrow("PROMPTFOO_IMPORT_JSON_SCHEMA:0");
  });

  it("成功 REST Case 缺少结果时拒绝完整阶段提交", () => {
    const base = input();
    expect(() =>
      importPromptfooResults({ ...base, raw: { results: { version: 3, results: [] } } })
    ).toThrow("PROMPTFOO_IMPORT_CASE_MISSING:case-1");
  });

  it("拒绝不完整的 Raw 根结构和 Case 身份", () => {
    const base = input();
    expect(() => importPromptfooResults({ ...base, raw: null })).toThrow("PROMPTFOO_IMPORT_ROOT");
    expect(() => importPromptfooResults({ ...base, raw: { results: null } })).toThrow(
      "PROMPTFOO_IMPORT_RESULTS"
    );
    expect(() =>
      importPromptfooResults({ ...base, raw: { results: { version: 3, results: null } } })
    ).toThrow("PROMPTFOO_IMPORT_ROWS");
    expect(() =>
      importPromptfooResults({
        ...base,
        raw: { results: { version: 3, results: [{ metadata: { case_id: "" } }] } }
      })
    ).toThrow("PROMPTFOO_IMPORT_CASE_KEY:0");
  });

  it("拒绝冻结 Case 对齐错误和 REST Error 伪造行", () => {
    const base = input();
    const firstCase = base.cases[0];
    if (firstCase === undefined) throw new Error("测试输入缺少首个 Case");
    expect(() =>
      importPromptfooResults({ ...base, cases: [firstCase, { ...firstCase, ordinal: 1 }] })
    ).toThrow("PROMPTFOO_IMPORT_EXPECTED_ALIGNMENT");
    expect(() =>
      importPromptfooResults({
        ...base,
        raw: {
          results: {
            version: 3,
            results: [rawResult("case-1"), rawResult("case-2")]
          }
        }
      })
    ).toThrow("PROMPTFOO_IMPORT_REST_ERROR_ROW:case-2");
  });

  it("拒绝组件结果和运行度量中的脏值", () => {
    const base = input();
    const invalidComponent = rawResult("case-1");
    const grading = invalidComponent.gradingResult as {
      componentResults: Record<string, unknown>[];
    };
    grading.componentResults[0] = { ...grading.componentResults[0], pass: "true" };
    expect(() =>
      importPromptfooResults({
        ...base,
        raw: { results: { version: 3, results: [invalidComponent] } }
      })
    ).toThrow("PROMPTFOO_IMPORT_COMPONENT_PASS:case-1:0");

    const invalidReason = rawResult("case-1");
    const reasonGrading = invalidReason.gradingResult as {
      componentResults: Record<string, unknown>[];
    };
    reasonGrading.componentResults[0] = { ...reasonGrading.componentResults[0], reason: 1 };
    expect(() =>
      importPromptfooResults({
        ...base,
        raw: { results: { version: 3, results: [invalidReason] } }
      })
    ).toThrow("PROMPTFOO_IMPORT_COMPONENT_REASON:case-1:0");

    const invalidLatency = { ...rawResult("case-1"), latencyMs: -1 };
    expect(() =>
      importPromptfooResults({
        ...base,
        raw: { results: { version: 3, results: [invalidLatency] } }
      })
    ).toThrow("PROMPTFOO_IMPORT_LATENCY:case-1");
  });

  it("缺少可选 Token Usage 时不虚构用量", () => {
    const base = input();
    const withoutTokens = rawResult("case-1");
    const grading = withoutTokens.gradingResult as Record<string, unknown>;
    delete grading.tokensUsed;

    const result = importPromptfooResults({
      ...base,
      raw: { results: { version: 3, results: [withoutTokens] } }
    });

    expect(result.cases[0]?.tokenUsage).toBeNull();
  });
});
