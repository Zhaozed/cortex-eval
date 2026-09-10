// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardPage } from "../src/features/dashboard/dashboard-page.tsx";
import { createResourceApi } from "../src/lib/resource-api.ts";
import { createRunApi } from "../src/lib/run-api.ts";
import { runReviewApi } from "../src/lib/run-review-api.ts";
import { requestUrl } from "./request-fixture.ts";
import {
  RUN_ID,
  runDetail,
  runPage,
  runReportCase,
  runReportOverview
} from "./run-test-fixture.ts";
import type { PlatformRunPage, RunReportCase } from "../src/lib/run-api.ts";

vi.mock("../src/lib/run-review-api.ts", () => ({ runReviewApi: { list: vi.fn() } }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(runReviewApi.list).mockResolvedValue([]);
});
function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
function completed(sourceType: "PLATFORM" | "OFFLINE_IMPORT" = "PLATFORM"): PlatformRunPage {
  const page = runPage(runDetail({ status: "COMPLETED", stage: "DONE" }));
  return {
    ...page,
    items: page.items.map((run) => ({
      ...run,
      name: "待办功能验收",
      description: "验证查询和展示",
      sourceType,
      rest: { total: 1, completed: 1, succeeded: 1, error: 0 },
      evaluation: { total: 1, completed: 1, passed: 1, failed: 0, error: 0, notEvaluated: 0 }
    }))
  };
}
function mount(
  page = completed(),
  cases: readonly RunReportCase[] = [runReportCase]
): {
  client: QueryClient;
  fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
  navigate: ReturnType<typeof vi.fn>;
} {
  const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
    const url = requestUrl(input);
    if (url === "/api/v1/runs?limit=50") return Promise.resolve(response(page));
    if (url === `/api/v1/runs/${RUN_ID}/report`)
      return Promise.resolve(response(runReportOverview));
    if (url.startsWith(`/api/v1/runs/${RUN_ID}/report/cases`))
      return Promise.resolve(response({ items: cases, nextCursor: null }));
    if (url === "/api/v1/test-suites?limit=200")
      return Promise.resolve(
        response({
          items: [
            {
              id: runDetail().suite.id,
              name: "待办",
              description: "",
              caseCount: 4,
              revision: 0,
              updatedAt: runReportOverview.completedAt,
              latestRun: null
            }
          ],
          nextCursor: "next"
        })
      );
    if (url === "/api/v1/test-suites?cursor=next&limit=200")
      return Promise.resolve(
        response({
          items: [
            {
              id: RUN_ID,
              name: "客服",
              description: "",
              caseCount: 3,
              revision: 0,
              updatedAt: runReportOverview.completedAt,
              latestRun: null
            }
          ],
          nextCursor: null
        })
      );
    throw new Error(`Unexpected request: ${url}`);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const navigate = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <DashboardPage
        api={createResourceApi(fetcher)}
        runApi={createRunApi(fetcher)}
        onNavigate={navigate}
      />
    </QueryClientProvider>
  );
  return { client, fetcher, navigate };
}
describe("验收仪表盘", () => {
  it("精确计算两类测试资产，不再请求四类配置数量", async () => {
    const { fetcher } = mount({ items: [], nextCursor: null });
    expect(await screen.findByTestId("count-test-suites")).toHaveTextContent("2");
    expect(screen.getByTestId("count-cases")).toHaveTextContent("7");
    expect(screen.getByRole("heading", { name: "评测仪表盘" })).toBeVisible();
    expect(await screen.findByText("还没有可展示的完整评测")).toBeVisible();
    expect(fetcher.mock.calls.every(([input]) => !requestUrl(input).includes("configs"))).toBe(
      true
    );
  });
  it("展示运行目的、离线来源、场景与真实通过数，并保留报告跳转", async () => {
    const { navigate } = mount(completed("OFFLINE_IMPORT"));
    expect(await screen.findByTestId("quality-pass-count")).toHaveTextContent("1/ 1");
    expect(screen.getByRole("heading", { name: "待办功能验收" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "业务场景表现" })).toBeVisible();
    expect(screen.getByText("所选运行全部通过")).toBeVisible();
    await userEvent.click(screen.getByRole("link", { name: "待办功能验收" }));
    expect(navigate).toHaveBeenCalledWith(`/runs/${RUN_ID}`);
    expect(runReviewApi.list).not.toHaveBeenCalled();
  });
  it("A2UI 自动通过但没有人工批准时计入待处理，不显示全部通过", async () => {
    mount(completed(), [
      {
        ...runReportCase,
        definition: {
          ...runReportCase.definition,
          metadata: { ...runReportCase.definition.metadata, a2ui_capture: true }
        }
      }
    ]);
    expect(await screen.findByTestId("quality-pass-count")).toHaveTextContent("0/ 1");
    expect(screen.getByTestId("quality-pending-count")).toHaveTextContent("1条 Case");
    expect(screen.getByText("自动评测通过 · 等待人工复核")).toBeVisible();
    expect(screen.queryByText("所选运行全部通过")).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "关注结论筛选" }), "PASS");
    expect(screen.getByText("当前筛选下没有 Case")).toBeVisible();
  });
  it("复核接口失败时不发布最终通过率", async () => {
    vi.mocked(runReviewApi.list).mockRejectedValue(new Error("unavailable"));
    mount();
    expect(await screen.findByText("人工复核记录读取失败，暂不展示最终结论。")).toBeVisible();
    expect(screen.queryByTestId("quality-pass-count")).not.toBeInTheDocument();
  });
  it("拒绝部分报告，不拿一部分 Case 冒充整体", async () => {
    mount(completed(), []);
    expect(await screen.findByText("完整评测证据读取失败，暂不展示验收统计。")).toBeVisible();
    expect(screen.queryByTestId("quality-pass-count")).not.toBeInTheDocument();
  });
  it("运行完成后读取报告，运行中不展示伪造的验收数据", async () => {
    const running = runPage(runDetail({ status: "RUNNING", stage: "REPORT" }));
    const { client, fetcher } = mount(running);
    await screen.findByRole("heading", { name: "还没有可展示的完整评测" });
    expect(fetcher.mock.calls.some(([input]) => requestUrl(input).endsWith("/report"))).toBe(false);
    act(() => {
      client.setQueryData(["dashboard", "recent-runs"], completed());
    });
    await waitFor(() => expect(screen.getByTestId("quality-pass-count")).toHaveTextContent("1/ 1"));
  });
});
