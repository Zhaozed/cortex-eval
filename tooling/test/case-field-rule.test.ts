import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { caseAssertionAuthoringError } from "../../apps/web/src/features/test-suites/case-authoring-validation.ts";
import {
  compileCaseFieldRule,
  newCaseAssertion,
  readCaseFieldRule,
  type CaseFieldRule
} from "../../apps/web/src/features/test-suites/case-field-rule.ts";

function check(
  rule: CaseFieldRule,
  output: unknown
): { pass: boolean; score: number; reason: string } {
  return runInNewContext(`(function(output) { ${compileCaseFieldRule(rule)} })(output)`, {
    output
  }) as { pass: boolean; score: number; reason: string };
}

describe("表单字段规则（普通 Promptfoo JavaScript）", () => {
  it.each([null, false, 0, "", [], {}])("存在性不把 %j 当作缺失", (value) => {
    expect(
      check({ operation: "exists", path: "result.value", expected: null }, { result: { value } })
        .pass
    ).toBe(true);
  });
  it.each(["exists", "equals", "type", "count"] as const)("%s 对缺失证据失败", (operation) => {
    const result = check({ operation, path: "result.items", expected: 0 }, {});
    expect(result).toMatchObject({ pass: false, score: 0 });
    expect(result.reason).toContain("缺少目标字段");
  });
  it("不读取继承属性或把非 JSON 文本当作证据", () => {
    const rule: CaseFieldRule = { operation: "exists", path: "toString", expected: null };
    expect(check(rule, {}).pass).toBe(false);
    expect(check(rule, "not json").pass).toBe(false);
  });
  it("支持 JSON 字符串输出及列表下标", () => {
    expect(
      check(
        { operation: "equals", path: "items.0.title", expected: "周报" },
        JSON.stringify({ items: [{ title: "周报" }] })
      ).pass
    ).toBe(true);
    expect(
      check(
        { operation: "equals", path: "items.1.title", expected: "周报" },
        { items: [{ title: "周报" }] }
      ).pass
    ).toBe(false);
  });
  it("对象键顺序无关，数组顺序和重复项必须一致", () => {
    const rule: CaseFieldRule = {
      operation: "equals",
      path: "value",
      expected: { a: 1, b: [1, 2, 2] }
    };
    expect(check(rule, { value: { b: [1, 2, 2], a: 1 } }).pass).toBe(true);
    expect(check(rule, { value: { b: [2, 1, 2], a: 1 } }).pass).toBe(false);
    expect(check(rule, { value: { b: [1, 2], a: 1 } }).pass).toBe(false);
    expect(check(rule, { value: { b: [1, 2, 2], a: "1" } }).pass).toBe(false);
  });
  it("类型区分 null/对象/列表；数量只认数组", () => {
    expect(check({ operation: "type", path: "a", expected: "array" }, { a: [] }).pass).toBe(true);
    expect(check({ operation: "type", path: "a", expected: "object" }, { a: null }).pass).toBe(
      false
    );
    expect(check({ operation: "count", path: "a", expected: 0 }, { a: [] }).pass).toBe(true);
    expect(check({ operation: "count", path: "a", expected: 0 }, { a: { length: 0 } }).pass).toBe(
      false
    );
  });
  it("仅回读未经修改的生成代码", () => {
    const rule: CaseFieldRule = { operation: "exists", path: "ok", expected: null };
    const code = compileCaseFieldRule(rule);
    expect(readCaseFieldRule(code)).toEqual(rule);
    expect(readCaseFieldRule(`${code}\nreturn true;`)).toBeNull();
    expect(readCaseFieldRule("return true")).toBeNull();
  });
  it("默认断言不可直接保存，字段路径及类型数量配置必须有效", () => {
    expect(caseAssertionAuthoringError(newCaseAssertion())).toContain("目标字段");
    for (const rule of [
      { operation: "exists", path: "a..b", expected: null },
      { operation: "count", path: "items", expected: -1 },
      { operation: "count", path: "items", expected: 0.5 },
      { operation: "type", path: "a", expected: "invalid" }
    ] as const) {
      expect(
        caseAssertionAuthoringError({
          type: "javascript",
          metric: "检查",
          value: compileCaseFieldRule(rule)
        })
      ).not.toBeNull();
    }
  });
  it("文本、正则、语义标准缺失时明确拦截，不执行自定义代码", () => {
    for (const type of ["contains", "not-contains", "regex", "llm-rubric", "equals"]) {
      expect(caseAssertionAuthoringError({ type, metric: "检查" })).not.toBeNull();
    }
    expect(caseAssertionAuthoringError({ type: "regex", metric: "检查", value: "[" })).toContain(
      "正则"
    );
    expect(
      caseAssertionAuthoringError({
        type: "llm-rubric",
        metric: "检查",
        rubricPrompt: "prompt://quality.default"
      })
    ).toBeNull();
    expect(
      caseAssertionAuthoringError({
        type: "javascript",
        metric: "检查",
        value: "throw new Error('not run')"
      })
    ).toBeNull();
  });
});
