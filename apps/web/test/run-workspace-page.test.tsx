// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { RunWorkspacePage } from "../src/features/workspace/run-workspace-page.tsx";
vi.mock("../src/lib/run-review-api.ts", () => ({
  runReviewApi: {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockRejectedValue(new Error("not collected"))
  }
}));
import { createRunApi } from "../src/lib/run-api.ts";
import {
  RUN_ID,
  runCaseDetail,
  runCasePage,
  runDetail,
  runReportCase
} from "./run-test-fixture.ts";

for (const status of ["PRESENT", "MISSING", "CORRUPTED"] as const) {
  it(`keeps the same dashboard with ${status} report, uses only available evidence`, async () => {
    const api = createRunApi();
    vi.spyOn(api, "getRun").mockResolvedValue({
      ...runDetail({
        status: "COMPLETED",
        stage: "DONE",
        rest: { total: 1, completed: 1, succeeded: 1, error: 0 },
        evaluation: {
          total: 1,
          completed: status === "PRESENT" ? 1 : 0,
          passed: status === "PRESENT" ? 1 : 0,
          failed: 0,
          error: 0,
          notEvaluated: 0
        }
      }),
      suite: { ...runDetail().suite, caseCount: 1 },
      artifactAvailability: [{ kind: "REPORT_JSON", path: "report.json", status }]
    });
    const reports = vi
      .spyOn(api, "listReportCases")
      .mockResolvedValue({ items: [runReportCase], nextCursor: null });
    vi.spyOn(api, "listCases").mockResolvedValue(runCasePage);
    vi.spyOn(api, "listEvaluations").mockResolvedValue({ items: [], nextCursor: null });
    vi.spyOn(api, "getCase").mockResolvedValue(runCaseDetail);
    render(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
          })
        }
      >
        <RunWorkspacePage api={api} runId={RUN_ID} onNavigate={vi.fn()} />
      </QueryClientProvider>
    );
    expect(await screen.findByRole("heading", { name: "客服回归集" })).toBeVisible();
    expect(await screen.findByText("客服请求")).toBeVisible();
    for (const label of ["Agent 名称", "Agent 模型", "Agent Prompt 版本", "评测器 / 版本"]) {
      expect(screen.queryByText(label, { exact: true })).not.toBeInTheDocument();
    }
    const config = screen.getByRole("region", { name: "运行配置" });
    expect(within(config).getByText("客服 Endpoint", { exact: true })).toBeVisible();
    expect(within(config).getByText(/suiteHash/)).not.toBeVisible();
    expect(screen.queryByRole("navigation", { name: "运行视图" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Token 汇总" })).toHaveTextContent("Agent未采集");
    expect(screen.getByText("Agent 分支 / 版本")).toBeVisible();
    expect(within(config).getByText("评测模型")).toBeVisible();
    expect(reports).toHaveBeenCalledTimes(status === "PRESENT" ? 1 : 0);
    if (status === "PRESENT") {
      await userEvent.click(screen.getByRole("button", { name: /未通过\s*0/ }));
      expect(screen.queryByText("客服请求")).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "重置" }));
      expect(screen.getByText("客服请求")).toBeVisible();
      await userEvent.click(screen.getByRole("button", { name: "详情" }));
      expect(await screen.findByRole("dialog")).toHaveTextContent("客服请求");
    } else {
      expect(within(screen.getByRole("table")).getByText("待评测")).toBeVisible();
    }
  });
}
it("does not show zero classifications when loading Case evidence fails", async () => {
  const api = createRunApi();
  vi.spyOn(api, "getRun").mockResolvedValue(runDetail());
  vi.spyOn(api, "listCases").mockRejectedValue(new Error("unavailable"));
  vi.spyOn(api, "listEvaluations").mockResolvedValue({ items: [], nextCursor: null });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <RunWorkspacePage api={api} runId={RUN_ID} onNavigate={vi.fn()} />
    </QueryClientProvider>
  );
  expect(await screen.findByText("Case 记录加载失败，统计暂不可用。")).toBeVisible();
  expect(screen.getByRole("button", { name: /^通过\s*—$/ })).toBeDisabled();
});

it("pipeline handoff keeps polling without offering manual start of an automatic stage", async () => {
  const api = createRunApi();
  const getRun = vi
    .spyOn(api, "getRun")
    .mockResolvedValue({
      ...runDetail({ status: "READY", stage: "EVALUATION" }),
      runMode: "PIPELINE"
    });
  vi.spyOn(api, "listCases").mockResolvedValue(runCasePage);
  vi.spyOn(api, "listEvaluations").mockResolvedValue({ items: [], nextCursor: null });
  vi.spyOn(api, "getCase").mockResolvedValue(runCaseDetail);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <RunWorkspacePage api={api} runId={RUN_ID} onNavigate={vi.fn()} />
    </QueryClientProvider>
  );
  expect(await screen.findByText("等待自动继续")).toBeVisible();
  expect(screen.queryByRole("button", { name: /开始阶段/ })).not.toBeInTheDocument();
  await new Promise((resolve) => setTimeout(resolve, 1150));
  expect(getRun.mock.calls.length).toBeGreaterThan(1);
  view.unmount();
  client.clear();
});
