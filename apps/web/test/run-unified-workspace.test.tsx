// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RunDashboardPage } from "../src/features/runs/run-dashboard-page.tsx";
import { RunAnalysisControl } from "../src/features/runs/run-analysis-control.tsx";
import { ApiClientError } from "../src/lib/api-client.ts";
import { createRunApi } from "../src/lib/run-api.ts";
import { createResourceApi } from "../src/lib/resource-api.ts";
import { runReviewApi } from "../src/lib/run-review-api.ts";
import { RUN_ID, runDetail, runReportCase, runReportOverview } from "./run-test-fixture.ts";

vi.mock("../src/lib/run-review-api.ts", () => ({ runReviewApi: { list: vi.fn() } }));
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(runReviewApi.list).mockResolvedValue([]);
  window.history.replaceState(null, "", `/runs/${RUN_ID}`);
});
function mount(element: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
  return client;
}
it("shows imported evidence in the same dashboard, without invented platform actions or old page links", async () => {
  const api = {
    ...createRunApi(),
    getRun: vi.fn().mockRejectedValue(new ApiClientError("RUN_NOT_FOUND", { statusCode: 404 })),
    getReport: vi
      .fn()
      .mockResolvedValue({
        ...runReportOverview,
        sourceType: "OFFLINE_IMPORT",
        summary: { ...runReportOverview.summary, total: 1 }
      }),
    listReportCases: vi.fn().mockResolvedValue({ items: [runReportCase], nextCursor: null })
  };
  mount(<RunDashboardPage api={api} runId={RUN_ID} onNavigate={vi.fn()} />);
  expect(await screen.findByRole("button", { name: "详情" })).toBeVisible();
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("客服回归集");
  expect(screen.getByText("离线导入", { exact: true })).toBeVisible();
  expect(screen.queryByRole("button", { name: "再次运行" })).not.toBeInTheDocument();
  expect(screen.queryByText("统计概览", { exact: true })).not.toBeInTheDocument();
  expect(screen.queryByText("执行与配置", { exact: true })).not.toBeInTheDocument();
  expect(screen.queryByText("运行报告", { exact: true })).not.toBeInTheDocument();
  expect(api.getRun).toHaveBeenCalledTimes(1);
});
it("does not hide a platform service error behind an imported-report fallback", async () => {
  const api = {
    ...createRunApi(),
    getRun: vi.fn().mockRejectedValue(new ApiClientError("INTERNAL_ERROR", { statusCode: 500 })),
    getReport: vi.fn()
  };
  // Explicitly disable the page's bounded retry for this failure assertion by waiting for the final state.
  mount(<RunDashboardPage api={api} runId={RUN_ID} onNavigate={vi.fn()} />);
  expect(await screen.findByRole("alert", {}, { timeout: 2500 })).toBeVisible();
  expect(api.getReport).not.toHaveBeenCalled();
});
it("keeps platform results, snapshot and controls on a single page", async () => {
  const api = {
    ...createRunApi(),
    getRun: vi.fn().mockResolvedValue(runDetail({ status: "COMPLETED", stage: "DONE" })),
    listReportCases: vi.fn().mockResolvedValue({ items: [runReportCase], nextCursor: null }),
    listCases: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listEvaluations: vi.fn().mockResolvedValue({ items: [], nextCursor: null })
  };
  mount(<RunDashboardPage api={api} runId={RUN_ID} onNavigate={vi.fn()} />);
  expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("客服回归集");
  expect(screen.getByText("Agent 分支 / 版本")).toBeVisible();
  expect(screen.getAllByText("评测模型", { exact: true })[0]).toBeVisible();
  expect(screen.queryByText("执行与配置", { exact: true })).not.toBeInTheDocument();
});
it("only starts explicitly selected Run-wide analysis and invalidates Case evidence without navigating", async () => {
  const startAnalysis = vi
    .fn()
    .mockResolvedValue({ selectedCount: 2, succeededCount: 1, errorCount: 1 });
  const resourceApi = {
    ...createResourceApi(),
    listConfigurations: vi
      .fn()
      .mockImplementation(async (kind) => ({
        items: [
          {
            id: kind === "LLM" ? "model" : "prompt",
            name: kind === "LLM" ? "分析模型配置" : "定位证据"
          }
        ],
        nextCursor: null
      }))
  };
  const client = mount(
    <RunAnalysisControl
      api={{ ...createRunApi(), startAnalysis }}
      resourceApi={resourceApi}
      runId={RUN_ID}
    />
  );
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const button = await screen.findByRole("button", { name: "开始分析" });
  expect(button).toBeDisabled();
  expect(startAnalysis).not.toHaveBeenCalled();
  await userEvent.selectOptions(screen.getByLabelText("分析模型"), "model");
  await userEvent.selectOptions(screen.getByLabelText("分析 Prompt"), "prompt");
  await userEvent.selectOptions(screen.getByLabelText("分析范围"), "errors");
  await userEvent.click(button);
  expect(startAnalysis).toHaveBeenCalledWith(
    RUN_ID,
    { analyzerConfigId: "model", analysisPromptId: "prompt", selector: "errors" },
    expect.any(AbortSignal)
  );
  expect(await screen.findByRole("status")).toHaveTextContent(
    "本批次 2 条 · 分析完成 1 条 · 分析异常 1 条"
  );
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["runs", "analysis", RUN_ID] });
});
