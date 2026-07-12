import { describe, expect, it } from "vitest";

import {
  classifyRestResult,
  validateCaseDefinition,
  validateEvalResult,
  type CaseDefinition,
  type ProviderOutput
} from "../src/domain-evaluation.ts";

const HASH = "e".repeat(64);

describe("Domain Case 与运行事实", () => {
  const validCase: CaseDefinition = {
    caseKey: "case-1",
    description: "示例",
    threshold: 0.5,
    task: "route",
    requestBody: {},
    metadata: {
      requestId: "req-1",
      taskId: "task-1",
      businessModule: "Slack",
      scenarioTag: "reply"
    },
    assertions: [{ type: "equals", metric: "answer", weight: 1, value: "ok" }]
  };

  it("拒绝重复 Metric 身份缺失和负权重", () => {
    const value: CaseDefinition = {
      caseKey: "case-1",
      description: "示例",
      threshold: 0.5,
      task: "route",
      requestBody: { text: "hello" },
      metadata: {
        requestId: "req-1",
        taskId: "task-1",
        businessModule: "Slack",
        scenarioTag: "reply"
      },
      assertions: [{ type: "equals", metric: "answer", weight: -1, value: "ok" }]
    };
    expect(validateCaseDefinition(value)).toEqual({
      ok: false,
      error: { code: "CASE_DEFINITION_INVALID", path: "assertions[0].weight" }
    });
  });

  it("递归校验 Assertion Set，不允许空身份藏在子级", () => {
    const value: CaseDefinition = {
      caseKey: "case-1",
      description: "示例",
      threshold: 0.5,
      task: "route",
      requestBody: {},
      metadata: {
        requestId: "req-1",
        taskId: "task-1",
        businessModule: "Slack",
        scenarioTag: "reply"
      },
      assertions: [
        {
          type: "assert-set",
          metric: "set",
          weight: 1,
          assertions: [{ type: "equals", metric: "", weight: 1, value: "ok" }]
        }
      ]
    };
    expect(validateCaseDefinition(value)).toEqual({
      ok: false,
      error: { code: "CASE_DEFINITION_INVALID", path: "assertions[0].assertions[0].metric" }
    });
  });

  it("逐项拒绝 Case 和 Assertion 的非法业务不变量", () => {
    const invalidCases: CaseDefinition[] = [
      { ...validCase, caseKey: " " },
      { ...validCase, description: " " },
      { ...validCase, threshold: Number.NaN },
      { ...validCase, threshold: -1 },
      { ...validCase, threshold: 2 },
      { ...validCase, assertions: [] },
      { ...validCase, task: " " },
      { ...validCase, metadata: { ...validCase.metadata, requestId: " " } },
      { ...validCase, assertions: [{ type: "", metric: "answer", weight: 1 }] },
      { ...validCase, assertions: [{ type: "equals", metric: "answer", weight: Number.NaN }] },
      {
        ...validCase,
        assertions: [{ type: "equals", metric: "answer", weight: 1, threshold: -1 }]
      },
      { ...validCase, assertions: [{ type: "assert-set", metric: "set", weight: 1 }] },
      {
        ...validCase,
        assertions: [{ type: "equals", metric: "answer", weight: 1, assertions: [] }]
      },
      {
        ...validCase,
        assertions: [{ type: "assert-set", metric: "set", weight: 1, assertions: [] }]
      }
    ];
    for (const value of invalidCases) {
      expect(validateCaseDefinition(value).ok).toBe(false);
    }
    expect(
      validateCaseDefinition({
        ...validCase,
        assertions: [
          {
            type: "assert-set",
            metric: "set",
            weight: 1,
            assertions: [{ type: "equals", metric: "answer", weight: 1, value: "ok" }]
          }
        ]
      }).ok
    ).toBe(true);
  });

  it("业务 ok=false 仍是 REST SUCCEEDED，结构错误是 ERROR", () => {
    const output: ProviderOutput = { ok: false, errorMessage: "业务失败" };
    expect(classifyRestResult({ kind: "HTTP_2XX", providerOutput: output })).toEqual({
      status: "SUCCEEDED",
      providerOutput: output
    });
    expect(classifyRestResult({ kind: "PROVIDER_OUTPUT_INVALID" })).toEqual({
      status: "ERROR",
      errorType: "PROVIDER_OUTPUT_INVALID"
    });
  });

  it("Eval 分支保持事实互斥并要求最终哈希", () => {
    expect(
      validateEvalResult({
        status: "PASS",
        score: 1,
        reason: "通过",
        error: null,
        evalResultHash: HASH,
        finalCaseResultHash: HASH
      }).ok
    ).toBe(true);
    expect(
      validateEvalResult({
        status: "NOT_EVALUATED",
        score: 0,
        reason: null,
        error: null,
        evalResultHash: HASH,
        finalCaseResultHash: HASH
      })
    ).toEqual({ ok: false, error: { code: "EVAL_RESULT_INVALID", path: "score" } });
  });

  it("逐项拒绝 Eval 状态与事实错配", () => {
    const valid = {
      status: "PASS" as const,
      score: 1,
      reason: "通过",
      error: null,
      evalResultHash: HASH,
      finalCaseResultHash: HASH
    };
    const invalid = [
      { ...valid, evalResultHash: "bad" },
      { ...valid, finalCaseResultHash: "bad" },
      { ...valid, score: null },
      { ...valid, score: Number.NaN },
      { ...valid, error: "unexpected" },
      { ...valid, status: "NOT_EVALUATED" as const, score: 0 },
      { ...valid, status: "EVALUATION_ERROR" as const, score: null, error: null },
      { ...valid, status: "FAIL" as const, error: "unexpected" }
    ];
    for (const value of invalid) {
      expect(validateEvalResult(value).ok).toBe(false);
    }
    expect(
      validateEvalResult({
        ...valid,
        status: "EVALUATION_ERROR",
        score: null,
        error: "provider failed"
      }).ok
    ).toBe(true);
  });
});
