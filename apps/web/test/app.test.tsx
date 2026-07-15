// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/app.tsx";

const suiteId = "018f0f4e-7b7a-7cc0-8000-000000000001";
const secondSuiteId = "018f0f4e-7b7a-7cc0-8000-000000000002";

vi.mock("../src/features/dashboard/dashboard-page.tsx", () => ({
  DashboardPage: (): ReactElement => <h1>Dashboard Mock</h1>
}));
vi.mock("../src/features/test-suites/test-suite-list-page.tsx", () => ({
  TestSuiteListPage: ({
    onNavigate,
    onLeaveBlockedChange
  }: {
    readonly onNavigate: (path: string) => void;
    readonly onLeaveBlockedChange: (blocked: boolean) => void;
  }): ReactElement => (
    <>
      <button type="button" onClick={() => onNavigate(`/test-suites/${suiteId}`)}>
        Suite List Mock
      </button>
      <button type="button" onClick={() => onLeaveBlockedChange(true)}>
        Block Suite Leave
      </button>
    </>
  )
}));
vi.mock("../src/features/test-suites/test-suite-detail-page.tsx", () => ({
  TestSuiteDetailPage: ({ suiteId: selected }: { readonly suiteId: string }): ReactElement => {
    const [marker, setMarker] = useState(0);
    return (
      <section>
        <h1>Suite Detail Mock {selected}</h1>
        <button type="button" onClick={() => setMarker((value) => value + 1)}>
          Suite Detail Marker {marker}
        </button>
      </section>
    );
  }
}));
vi.mock("../src/features/configurations/configuration-list-page.tsx", () => ({
  ConfigurationListPage: ({
    kind,
    onLeaveBlockedChange
  }: {
    readonly kind: string;
    readonly onLeaveBlockedChange: (blocked: boolean) => void;
  }): ReactElement => {
    const [marker, setMarker] = useState(0);
    return (
      <section>
        <h1>Config Mock {kind}</h1>
        <button type="button" onClick={() => setMarker((value) => value + 1)}>
          Config Marker {marker}
        </button>
        <button type="button" onClick={() => onLeaveBlockedChange(true)}>
          Block Config Leave
        </button>
        <button type="button" onClick={() => onLeaveBlockedChange(false)}>
          Resolve Config Leave
        </button>
      </section>
    );
  }
}));
vi.mock("../src/features/runs/run-list-page.tsx", () => ({
  RunListPage: (): ReactElement => <h1>Run List Mock</h1>
}));
vi.mock("../src/features/runs/run-detail-page.tsx", () => ({
  RunDetailPage: ({ runId }: { readonly runId: string }): ReactElement => (
    <h1>Run Detail Mock {runId}</h1>
  )
}));
vi.mock("../src/features/analysis/analysis-page.tsx", () => ({
  AnalysisPage: ({ runId }: { readonly runId: string }): ReactElement => (
    <h1>Analysis Mock {runId}</h1>
  )
}));

beforeEach(() => {
  Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
  Object.defineProperty(window, "navigation", {
    configurable: true,
    value: { currentEntry: { index: 0 } }
  });
});
afterEach(() => cleanup());

describe("P5 根路由", () => {
  it.each([
    ["/", "Dashboard Mock"],
    ["/runs", "Run List Mock"],
    [`/runs/${suiteId}`, `Run Detail Mock ${suiteId}`],
    [`/runs/${suiteId}/analysis`, `Analysis Mock ${suiteId}`],
    ["/test-suites", "Suite List Mock"],
    [`/test-suites/${suiteId}`, `Suite Detail Mock ${suiteId}`],
    ["/endpoint-configs", "Config Mock ENDPOINT"],
    ["/llm-configs", "Config Mock LLM"],
    ["/rubric-prompts", "Config Mock LLM_RUBRIC_PROMPT"],
    ["/analysis-prompts", "Config Mock CASE_ANALYSIS_PROMPT"]
  ])("只渲染已闭环路径 %s", async (path, expected) => {
    window.history.replaceState(null, "", path);
    render(<App />);

    expect(await screen.findByText(expected)).toBeInTheDocument();
  });

  it("缺少 Navigation API 时停止挂载资源能力并显示明确错误", async () => {
    Reflect.deleteProperty(window, "navigation");
    window.history.replaceState(null, "", "/");

    render(<App />);

    expect(
      await screen.findByText("当前浏览器缺少安全导航能力，资源界面未启动。")
    ).toBeInTheDocument();
    expect(screen.queryByText("Dashboard Mock")).not.toBeInTheDocument();
  });

  it("显式导航和浏览器返回都重新解析闭合路径", async () => {
    window.history.replaceState(null, "", "/test-suites");
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Suite List Mock" }));
    expect(await screen.findByText(`Suite Detail Mock ${suiteId}`)).toBeInTheDocument();

    window.history.pushState(null, "", "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(await screen.findByText("Dashboard Mock")).toBeInTheDocument();
  });

  it("未知未来路径保持 404，并可返回 Dashboard", async () => {
    window.history.replaceState(null, "", "/reports");
    render(<App />);

    expect(await screen.findByText("页面不存在")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "返回仪表盘" }));
    expect(await screen.findByText("Dashboard Mock")).toBeInTheDocument();
  });

  it("切换配置 Feature 时重建路由级状态", async () => {
    window.history.replaceState(null, "", "/endpoint-configs");
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Config Marker 0" }));
    expect(screen.getByRole("button", { name: "Config Marker 1" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("link", { name: "LLM 配置" }));
    expect(await screen.findByText("Config Mock LLM")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Config Marker 0" })).toBeInTheDocument();
  });

  it("相邻 Test Suite 详情路由不会复用上一 Suite 的页面状态", async () => {
    window.history.replaceState({ cortexEvalHistoryPosition: 0 }, "", `/test-suites/${suiteId}`);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Suite Detail Marker 0" }));
    expect(screen.getByRole("button", { name: "Suite Detail Marker 1" })).toBeInTheDocument();

    window.history.pushState({ cortexEvalHistoryPosition: 1 }, "", `/test-suites/${secondSuiteId}`);
    window.dispatchEvent(new PopStateEvent("popstate"));

    expect(await screen.findByText(`Suite Detail Mock ${secondSuiteId}`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Suite Detail Marker 0" })).toBeInTheDocument();
  });

  it("写入或冲突待决时阻止侧栏、浏览器历史与页面卸载，显式解决后恢复导航", async () => {
    window.history.replaceState(null, "", "/endpoint-configs");
    render(<App />);
    await screen.findByText("Config Mock ENDPOINT");

    await userEvent.click(screen.getByRole("link", { name: "LLM 配置" }));
    await screen.findByText("Config Mock LLM");
    await userEvent.click(screen.getByRole("link", { name: "Rubric 提示词" }));
    await screen.findByText("Config Mock LLM_RUBRIC_PROMPT");
    const historyLength = window.history.length;

    window.history.go(-2);
    await screen.findByText("Config Mock ENDPOINT");
    await userEvent.click(screen.getByRole("button", { name: "Block Config Leave" }));

    await userEvent.click(screen.getByRole("link", { name: "LLM 配置" }));
    expect(screen.getByText("Config Mock ENDPOINT")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/endpoint-configs");

    window.history.forward();
    await waitFor(() => expect(window.location.pathname).toBe("/endpoint-configs"));
    expect(window.history.length).toBe(historyLength);

    const beforeUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(beforeUnload);
    expect(beforeUnload.defaultPrevented).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "Resolve Config Leave" }));
    window.history.forward();
    expect(await screen.findByText("Config Mock LLM")).toBeInTheDocument();
    window.history.forward();
    expect(await screen.findByText("Config Mock LLM_RUBRIC_PROMPT")).toBeInTheDocument();
  });

  it("未知 History state 从前进或后退进入时都恢复原位置", async () => {
    const navigationDescriptor = Object.getOwnPropertyDescriptor(window, "navigation");
    const indexByPath = new Map([
      ["/endpoint-configs", 0],
      ["/llm-configs", 1],
      ["/rubric-prompts", 2]
    ]);
    Object.defineProperty(window, "navigation", {
      configurable: true,
      value: {
        get currentEntry(): { readonly index: number } {
          return { index: indexByPath.get(window.location.pathname) ?? -1 };
        }
      }
    });

    try {
      window.history.replaceState(null, "", "/endpoint-configs");
      render(<App />);
      await screen.findByText("Config Mock ENDPOINT");

      window.history.pushState(null, "", "/llm-configs");
      window.history.back();
      await waitFor(() => expect(window.location.pathname).toBe("/endpoint-configs"));
      await userEvent.click(screen.getByRole("button", { name: "Block Config Leave" }));
      window.history.forward();
      await waitFor(() => expect(window.location.pathname).toBe("/endpoint-configs"));

      await userEvent.click(screen.getByRole("button", { name: "Resolve Config Leave" }));
      window.history.forward();
      expect(await screen.findByText("Config Mock LLM")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("link", { name: "Rubric 提示词" }));
      await screen.findByText("Config Mock LLM_RUBRIC_PROMPT");

      await userEvent.click(screen.getByRole("button", { name: "Block Config Leave" }));
      window.history.back();
      await waitFor(() => expect(window.location.pathname).toBe("/rubric-prompts"));
      await userEvent.click(screen.getByRole("button", { name: "Resolve Config Leave" }));
      window.history.back();
      expect(await screen.findByText("Config Mock LLM")).toBeInTheDocument();
    } finally {
      if (navigationDescriptor === undefined) {
        Reflect.deleteProperty(window, "navigation");
      } else {
        Object.defineProperty(window, "navigation", navigationDescriptor);
      }
    }
  });
});
