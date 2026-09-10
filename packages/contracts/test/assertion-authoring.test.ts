import { describe, expect, it } from "vitest";
import { CaseAuthoringV1Schema } from "../src/case-authoring-contracts.ts";
import { CaseDefinitionV1Schema, type AssertionDefinitionV1 } from "../src/case-contracts.ts";
import {
  assertionAuthoringIssue,
  caseAssertionsIssue
} from "../src/assertion-rules/authoring-validation.ts";
import { compileCaseFieldRule } from "../src/assertion-rules/field-rules.ts";
import payloads from "../src/assertion-rules/promptfoo-payloads.json" with { type: "json" };
import matrix from "../../../tooling/facts/promptfoo-0.121.18-capabilities.json" with { type: "json" };

const rule = (input: Partial<AssertionDefinitionV1>): AssertionDefinitionV1 => ({
  type: "contains",
  metric: "quality",
  value: "expected",
  ...input
});

describe("共享断言编写边界", () => {
  it("类型与 payload 投影必须和锁定的 SDK 矩阵一致", () => {
    expect(payloads).toEqual(
      Object.fromEntries(matrix.capabilities.map((item) => [item.type, item.payload]))
    );
  });
  it.each([
    [rule({ type: "made-up" }), "UNKNOWN_TYPE"],
    [rule({ type: "promptfoo:redteam:*" }), "UNKNOWN_TYPE"],
    [rule({ value: undefined }), "INVALID_VALUE"],
    [rule({ value: "" }), "INVALID_VALUE"],
    [rule({ type: "regex", value: "[" }), "INVALID_REGEX"],
    [rule({ type: "javascript", value: "return (" }), "INVALID_JAVASCRIPT"],
    [rule({ type: "latency", value: undefined }), "INVALID_THRESHOLD"],
    [rule({ type: "llm-rubric", value: undefined }), "EMPTY_RUBRIC"]
  ])("拒绝错误配置 %#", (assertion, code) => {
    expect(assertionAuthoringIssue(assertion)?.code).toBe(code);
  });
  it.each([
    rule({}),
    rule({ type: "equals", value: false }),
    rule({ type: "equals", value: 0 }),
    rule({ type: "javascript", value: "output.includes('expected')" }),
    rule({ type: "javascript", value: "return output.includes('expected');" }),
    rule({ type: "llm-rubric", value: undefined, rubricPrompt: "prompt://quality" })
  ])("接受有效配置 %#", (assertion) => expect(assertionAuthoringIssue(assertion)).toBeNull());
  it("不执行用户代码", () => {
    expect(
      assertionAuthoringIssue(
        rule({ type: "javascript", value: "throw new Error('MUST_NOT_EXECUTE');" })
      )
    ).toBeNull();
  });
  it("字段缺失及嵌套错误保留具体位置，零权重不能独自成为验收", () => {
    const emptyPath = rule({
      type: "javascript",
      value: compileCaseFieldRule({ operation: "exists", path: "", expected: null })
    });
    expect(assertionAuthoringIssue(emptyPath)?.code).toBe("INVALID_PATH");
    expect(
      caseAssertionsIssue([
        rule({ type: "assert-set", value: undefined, assert: [rule({ type: "oops" })] })
      ])
    ).toEqual({ code: "UNKNOWN_TYPE", path: ["assert", 0, "assert", 0, "type"] });
    expect(caseAssertionsIssue([rule({ weight: 0 })])?.code).toBe("NO_SCORING_RULE");
    expect(caseAssertionsIssue([rule({ weight: 0 }), rule({ weight: 1 })])).toBeNull();
  });
  it("新写入拒绝未知规则，历史快照仍可读取", () => {
    const definition = {
      contractVersion: "cortex.case-definition.v1",
      description: "历史用例",
      threshold: 1,
      vars: { task: "chat", request_body: {} },
      metadata: {
        case_id: "c1",
        req_id: "r1",
        task_id: "t1",
        business_module: "chat",
        scenario_tag: "smoke"
      },
      assert: [rule({ type: "legacy-custom" })]
    };
    expect(CaseDefinitionV1Schema.safeParse(definition).success).toBe(true);
    expect(CaseAuthoringV1Schema.safeParse(definition).success).toBe(false);
  });
});
