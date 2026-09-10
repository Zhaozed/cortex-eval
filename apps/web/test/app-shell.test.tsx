// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AppShell } from "../src/components/app-shell.tsx";

describe("P5 应用外壳", () => {
  it("呈现已闭环 Run 与资源导航和可读小屏提示", () => {
    render(
      <AppShell activePath="/" onNavigate={vi.fn()}>
        <h1>仪表盘内容</h1>
      </AppShell>
    );

    expect(screen.getByRole("navigation", { name: "主导航" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "仪表盘" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "测试集" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "评测运行" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "配置中心" })).not.toBeInTheDocument();
    for (const name of ["Endpoint 配置", "LLM 配置", "Rubric 提示词", "分析提示词配置"]) {
      expect(screen.getAllByRole("link", { name })).toHaveLength(1);
    }
    expect(screen.queryByRole("link", { name: "报告" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "失败分析" })).not.toBeInTheDocument();
    expect(
      screen.getByText("当前界面需要至少 1024px 宽度，请扩大窗口后继续。")
    ).toBeInTheDocument();
  });

  it("键盘激活导航时交给显式 History 路由", async () => {
    const onNavigate = vi.fn();
    render(
      <AppShell activePath="/" onNavigate={onNavigate}>
        <h1>仪表盘内容</h1>
      </AppShell>
    );

    await userEvent.click(screen.getByRole("link", { name: "测试集" }));

    expect(onNavigate).toHaveBeenCalledWith("/test-suites");
  });
  it.each([
    ["/endpoint-configs", "Endpoint 配置"],
    ["/llm-configs", "LLM 配置"],
    ["/rubric-prompts", "Rubric 提示词"],
    ["/analysis-prompts", "分析提示词配置"],
    ["/runs/run-1", "评测运行"],
    ["/test-suites/suite-1", "测试集"]
  ])("%s 只有当前入口高亮，且没有重复配置导航", (path, label) => {
    render(
      <AppShell activePath={path} onNavigate={vi.fn()}>
        <h1>内容</h1>
      </AppShell>
    );
    expect(screen.getAllByRole("navigation")).toHaveLength(1);
    expect(screen.getAllByRole("link", { current: "page" })).toHaveLength(1);
    expect(screen.getByRole("link", { name: label })).toHaveAttribute("aria-current", "page");
  });

  it("配置入口直接导航，保留修饰键的新标签行为", async () => {
    const onNavigate = vi.fn();
    render(
      <AppShell activePath="/" onNavigate={onNavigate}>
        <h1>内容</h1>
      </AppShell>
    );
    await userEvent.click(screen.getByRole("link", { name: "Endpoint 配置" }));
    expect(onNavigate).toHaveBeenCalledWith("/endpoint-configs");
    onNavigate.mockClear();
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true });
    screen.getByRole("link", { name: "LLM 配置" }).dispatchEvent(event);
    expect(onNavigate).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});
