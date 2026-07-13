// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AppShell } from "../src/components/app-shell.tsx";

describe("P4 应用外壳", () => {
  it("只呈现已闭环资源导航和可读小屏提示", () => {
    render(
      <AppShell activePath="/" onNavigate={vi.fn()}>
        <h1>仪表盘内容</h1>
      </AppShell>
    );

    expect(screen.getByRole("navigation", { name: "主导航" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "仪表盘" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "测试集" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Endpoint 配置" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "LLM 配置" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Rubric 提示词" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "分析提示词配置" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "运行" })).not.toBeInTheDocument();
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
});
