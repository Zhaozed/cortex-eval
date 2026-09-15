// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { agentExecutionAssertion } from "@cortex-eval/contracts/src/assertion-rules/agent-rules.ts";
import { readAgentAuthoringRule } from "@cortex-eval/contracts/src/assertion-rules/agent-rule-authoring.ts";
import { CaseAssertionFields } from "../src/features/test-suites/case-assertion-fields.tsx";
import { newCaseAssertion } from "../src/features/test-suites/case-field-rule.ts";

function Harness({ initial = newCaseAssertion() }) {
  const [text, setText] = useState(JSON.stringify(initial));
  return (
    <>
      <CaseAssertionFields
        text={text}
        index={0}
        metrics={[]}
        error={false}
        onChange={setText}
        onRemove={vi.fn()}
        rawRef={vi.fn()}
      />
      <output data-testid="value">{text}</output>
    </>
  );
}
function currentRule() {
  return readAgentAuthoringRule(JSON.parse(screen.getByTestId("value").textContent!).value);
}

describe("全部 Agent 共享规则表单配置", () => {
  it("下拉选实际执行、填写参数与失败错误码，无需编辑代码", async () => {
    render(<Harness />);
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "检查规则 1" }),
      "agent-executions"
    );
    await userEvent.type(screen.getByRole("textbox", { name: "工具名称 1" }), "create_item");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "预期终态 1" }), "failure");
    await userEvent.type(screen.getByRole("textbox", { name: "预期错误码 1" }), "DENIED");
    expect(currentRule()).toEqual({
      kind: "agent-executions",
      expectations: [{ tool: "create_item", args: {}, outcome: "failure", errorCode: "DENIED" }]
    });
    expect(screen.queryByRole("textbox", { name: "检查代码 1" })).not.toBeInTheDocument();
  });
  it("禁止工具和次数限制可填；切换需确认，不默默清除旧参数", async () => {
    render(<Harness />);
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "检查规则 1" }),
      "agent-forbid"
    );
    await userEvent.type(screen.getByRole("textbox", { name: "禁止工具 1" }), "delete_item");
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "检查规则 1" }),
      "agent-limit"
    );
    expect(currentRule()).toMatchObject({ policy: { tools: ["delete_item"], mode: "forbid" } });
    await userEvent.click(screen.getByRole("button", { name: "保留当前规则" }));
    expect(currentRule()).toMatchObject({ policy: { mode: "forbid" } });
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "检查规则 1" }),
      "agent-limit"
    );
    await userEvent.click(screen.getByRole("button", { name: "确认切换" }));
    await userEvent.type(screen.getByRole("textbox", { name: "受限工具 1" }), "list_items");
    fireEvent.change(screen.getByRole("spinbutton", { name: "每个工具最多调用次数" }), {
      target: { value: "2" }
    });
    expect(currentRule()).toMatchObject({
      policy: { tools: ["list_items"], mode: "limit", maxCalls: 2 }
    });
  });
  it("回复类型、交付、固定文案均可编辑", async () => {
    render(<Harness />);
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "检查规则 1" }),
      "agent-reply"
    );
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "回复类型" }), "QUESTION");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "交付要求" }), "decision");
    await userEvent.click(screen.getByRole("checkbox", { name: "精确匹配固定文案" }));
    await userEvent.type(screen.getByRole("textbox", { name: "固定回复文案" }), "几点？");
    expect(currentRule()).toMatchObject({
      options: { type: "QUESTION", delivered: false, exactText: "几点？" }
    });
  });
  it("历史生成规则恢复完整表单，改工具名不丢失业务检查", async () => {
    const initial = agentExecutionAssertion([
      {
        tool: "old",
        args: { done: false },
        outcome: "success",
        fields: { count: 2 },
        sets: { ids: ["a", "b"] },
        instants: { time: "2026-09-10T09:00:00+08:00" },
        resourceIds: ["id"]
      }
    ]);
    render(<Harness initial={initial} />);
    fireEvent.change(screen.getByRole("textbox", { name: "工具名称 1" }), {
      target: { value: "new" }
    });
    expect(currentRule()).toEqual({
      kind: "agent-executions",
      expectations: [
        {
          tool: "new",
          args: { done: false },
          outcome: "success",
          fields: { count: 2 },
          sets: { ids: ["a", "b"] },
          instants: { time: "2026-09-10T09:00:00+08:00" },
          resourceIds: ["id"]
        }
      ]
    });
    expect(screen.getByRole("textbox", { name: "时间字段 time" })).toHaveValue(
      "2026-09-10T09:00:00+08:00"
    );
  });
});
