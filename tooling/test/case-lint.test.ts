import { expect, it } from "vitest";
import { validateCasesText } from "../../data_scripts/validate-cases.ts";
const value = {
  description: "查询",
  threshold: 1,
  vars: { task: "chat", request_body: {} },
  metadata: {
    case_id: "c1",
    req_id: "r",
    task_id: "t",
    business_module: "todo",
    scenario_tag: "query"
  },
  assert: [{ type: "contains", metric: "reply", value: "ok" }]
};
it("同一契约校验 JSON/JSONL，默认版本，重复 ID 与错误断言失败", () => {
  expect(validateCasesText(JSON.stringify([value]))).toEqual({ count: 1, errors: [] });
  expect(validateCasesText(`\n${JSON.stringify(value)}\n`, true)).toEqual({ count: 1, errors: [] });
  expect(validateCasesText(JSON.stringify([value, value])).errors[0]).toContain("编号重复");
  expect(
    validateCasesText(JSON.stringify([{ ...value, assert: [{ type: "oops", metric: "x" }] }]))
      .errors[0]
  ).toContain("未识别");
  expect(validateCasesText("{}").errors).toHaveLength(1);
  expect(validateCasesText("{", true).errors[0]).toContain("第 1 行");
});
