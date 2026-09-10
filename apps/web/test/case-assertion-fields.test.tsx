// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { CaseAssertionFields } from "../src/features/test-suites/case-assertion-fields.tsx";

function Harness({ assertion }: { readonly assertion: object }): ReactElement {
  const [text, setText] = useState(JSON.stringify(assertion));
  return (
    <CaseAssertionFields
      text={text}
      index={0}
      metrics={["quality", "业务结果"]}
      error={false}
      rawRef={vi.fn()}
      onRemove={vi.fn()}
      onChange={setText}
    />
  );
}

describe("已有检查规则无损表单编辑", () => {
  it("null 预期不误显示为空字符串", () => {
    render(<Harness assertion={{ type: "equals", metric: "quality", value: null }} />);
    expect(screen.getByRole("combobox", { name: "预期值 1类型" })).toHaveValue("null");
    expect(screen.queryByRole("textbox", { name: "预期值 1" })).not.toBeInTheDocument();
  });
  it("无 Schema 的 is-json 不冒充 object 约束", async () => {
    render(<Harness assertion={{ type: "is-json", metric: "quality" }} />);
    expect(screen.getByText("仅验证 JSON 格式，未设置额外结构约束。")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "添加结构约束" }));
    expect(screen.getByRole("combobox", { name: "结构约束 1类型" })).toHaveValue("object");
  });
  it("改指标保留自定义代码和扩展项，指标不能改成空选项", async () => {
    render(
      <Harness
        assertion={{
          type: "javascript",
          metric: "quality",
          value: "return output === 'ok';",
          config: { retained: true },
          weight: 0.5,
          threshold: 0.8
        }}
      />
    );
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "评测指标 1" }), "业务结果");
    await userEvent.click(screen.getByText("高级配置 · 权重、阈值与原始 JSON"));
    const raw = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Assertion JSON 1" });
    expect(JSON.parse(raw.value)).toEqual({
      type: "javascript",
      metric: "业务结果",
      value: "return output === 'ok';",
      config: { retained: true },
      weight: 0.5,
      threshold: 0.8
    });
    expect(screen.getByRole("option", { name: "请选择" })).toBeDisabled();
  });
  it("未知已有类型不自动转写为其他规则", async () => {
    render(
      <Harness
        assertion={{ type: "custom-legacy-check", metric: "quality", value: { legacy: true } }}
      />
    );
    expect(screen.getByRole("combobox", { name: "检查规则 1" })).toHaveValue("custom-legacy-check");
    await userEvent.click(screen.getByText("高级配置 · 权重、阈值与原始 JSON"));
    const raw = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Assertion JSON 1" });
    expect(JSON.parse(raw.value)).toEqual({
      type: "custom-legacy-check",
      metric: "quality",
      value: { legacy: true }
    });
  });
});
