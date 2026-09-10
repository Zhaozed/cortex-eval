// @vitest-environment jsdom

import type { CaseDefinitionV1 } from "@cortex-eval/contracts/src/case-contracts.ts";
import { fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { CaseEditor } from "../src/features/test-suites/case-editor.tsx";
import {
  CaseMultiSelect,
  CaseCreatableSelect
} from "../src/features/test-suites/case-choice-fields.tsx";
import { readCaseFieldRule } from "../src/features/test-suites/case-field-rule.ts";
import { createDefaultCaseDefinition } from "../src/features/test-suites/default-case-definition.ts";

const options = {
  businessModules: ["待办"],
  scenarioTags: ["正常查询"],
  assertionTypes: ["javascript"],
  metrics: ["字段检查"]
};
async function fillBasics(): Promise<void> {
  await userEvent.type(screen.getByRole("textbox", { name: "Case 描述" }), "查询结果真实返回");
  await userEvent.type(screen.getByRole("combobox", { name: "任务" }), "agent-e2e");
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "业务模块" }), "待办");
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "场景标签" }), "正常查询");
}

describe("手动创建不需要编写 JSON", () => {
  it("填写分类、带类型请求和字段检查即可保存；ID 保持长整数精度", async () => {
    const onSave = vi.fn<(definition: CaseDefinitionV1) => void>();
    const { container } = render(
      <CaseEditor
        creating
        options={options}
        initialDefinition={createDefaultCaseDefinition()}
        onSave={onSave}
      />
    );
    await fillBasics();
    await userEvent.click(screen.getByRole("button", { name: "填入 E2E 常用字段" }));
    await userEvent.type(screen.getByRole("textbox", { name: "text" }), "查看今天待办");
    fireEvent.change(screen.getByRole("textbox", { name: "uid" }), {
      target: { value: "2075490654049271808" }
    });
    await userEvent.type(
      screen.getByRole("combobox", { name: "目标字段 1" }),
      "parsed_output.tool_executions"
    );
    await userEvent.click(screen.getByRole("button", { name: "保存 Case" }));
    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0]?.[0];
    if (!saved) throw new Error("SAVED_CASE_REQUIRED");
    expect(saved.vars.request_body).toEqual({
      text: "查看今天待办",
      uid: { __cortex_eval_int64: "2075490654049271808" },
      timezone: "Asia/Shanghai",
      lang: "zh-Hans"
    });
    expect(saved.metadata.business_module).toBe("待办");
    expect(readCaseFieldRule(saved.assert[0]?.value)).toEqual({
      operation: "exists",
      path: "parsed_output.tool_executions",
      expected: null
    });
    expect(container.querySelectorAll("details[open]")).toHaveLength(0);
  });
  it("新增空白不能直接保存；规则漏填在表单提示，不弹出 JSON", async () => {
    const onSave = vi.fn();
    const { container } = render(
      <CaseEditor
        creating
        options={options}
        initialDefinition={createDefaultCaseDefinition()}
        onSave={onSave}
      />
    );
    await userEvent.click(screen.getByRole("button", { name: "保存 Case" }));
    expect(onSave).not.toHaveBeenCalled();
    await fillBasics();
    await userEvent.click(screen.getByRole("button", { name: "保存 Case" }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox", { name: "目标字段 1" })).toHaveFocus();
    expect(container.querySelectorAll("details[open]")).toHaveLength(0);
  });
  it("检查项增删会提交真实集合，空检查集合不可保存", async () => {
    const onSave = vi.fn<(definition: CaseDefinitionV1) => void>();
    render(
      <CaseEditor
        creating
        options={options}
        initialDefinition={createDefaultCaseDefinition()}
        onSave={onSave}
      />
    );
    await fillBasics();
    await userEvent.click(screen.getByRole("button", { name: "删除检查项 1" }));
    await userEvent.click(screen.getByRole("button", { name: "保存 Case" }));
    expect(onSave).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "＋ 添加检查项" }));
    await userEvent.type(screen.getByRole("combobox", { name: "目标字段 1" }), "ok");
    await userEvent.click(screen.getByRole("button", { name: "＋ 添加检查项" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "检查规则 2" }), "contains");
    await userEvent.type(screen.getByRole("textbox", { name: "预期值 2" }), "成功");
    await userEvent.click(screen.getByRole("button", { name: "删除检查项 1" }));
    await userEvent.click(screen.getByRole("button", { name: "保存 Case" }));
    expect(onSave.mock.calls[0]?.[0].assert).toHaveLength(1);
    expect(onSave.mock.calls[0]?.[0].assert[0]).toMatchObject({ type: "contains", value: "成功" });
  });
  it("清空数字不可悄悄保存旧值，重复字段不覆盖；不安全整数转精确 ID", async () => {
    const initial = createDefaultCaseDefinition();
    const onSave = vi.fn<(definition: CaseDefinitionV1) => void>();
    render(
      <CaseEditor
        options={options}
        initialDefinition={{
          ...initial,
          vars: { ...initial.vars, request_body: { count: 2, uid: 0 } }
        }}
        onSave={onSave}
      />
    );
    await userEvent.type(screen.getByRole("combobox", { name: "目标字段 1" }), "ok");
    await userEvent.clear(screen.getByRole("spinbutton", { name: "count" }));
    await userEvent.click(screen.getByRole("button", { name: "保存 Case" }));
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("spinbutton", { name: "count" }), { target: { value: "3" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "uid" }), {
      target: { value: "2075490654049271808" }
    });
    expect(screen.getByRole("textbox", { name: "uid" })).toHaveValue("2075490654049271808");
    await userEvent.type(screen.getByRole("combobox", { name: "请求参数新字段名" }), "count");
    expect(screen.getByRole("button", { name: "添加字段" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "保存 Case" }));
    expect(onSave.mock.calls[0]?.[0].vars.request_body).toEqual({
      count: 3,
      uid: { __cortex_eval_int64: "2075490654049271808" }
    });
  });
});

describe("分类选择交互", () => {
  it("搜索、多选、逗号标签、Escape关闭及移除", async () => {
    function Harness(): ReactElement {
      const [value, setValue] = useState<string[]>([]);
      return (
        <CaseMultiSelect
          label="场景"
          options={["边界,跨日", "空结果"]}
          value={value}
          onChange={setValue}
        />
      );
    }
    const { container } = render(<Harness />);
    await userEvent.click(screen.getByText("全部"));
    await userEvent.type(screen.getByRole("textbox", { name: "搜索场景" }), "边界");
    expect(screen.queryByRole("checkbox", { name: "空结果" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: "边界,跨日" }));
    expect(screen.getByText("已选 1 项")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(container.querySelector("details")).not.toHaveAttribute("open");
    await userEvent.click(screen.getByRole("button", { name: "移除场景：边界,跨日" }));
    expect(screen.getByText("全部")).toBeInTheDocument();
  });
  it("新增分类必须明确点击使用，不隐式保存未提交名称", async () => {
    const onChange = vi.fn();
    render(
      <CaseCreatableSelect label="业务模块" options={["待办"]} value="" onChange={onChange} />
    );
    await userEvent.click(screen.getByRole("button", { name: "新增" }));
    await userEvent.type(screen.getByRole("textbox", { name: "新增业务模块" }), " 日历 ");
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "使用" }));
    expect(onChange).toHaveBeenCalledWith("日历");
  });
});
