// @vitest-environment jsdom
import { useState, type ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { RunCaseDrawer, type CaseTab } from "../src/features/runs/run-case-drawer.tsx";
import { Sheet } from "../src/components/ui/sheet.tsx";
import type { DashboardCase } from "../src/features/runs/run-dashboard-model.ts";
import { createRunApi } from "../src/lib/run-api.ts";
import { runReviewApi } from "../src/lib/run-review-api.ts";
import { evidenceRow, reviewFixture } from "./run-case-drawer-fixture.ts";
import { runReportCase, RUN_ID } from "./run-test-fixture.ts";
vi.mock("../src/lib/run-review-api.ts", () => ({
  runReviewApi: {
    get: vi.fn(),
    save: vi.fn(),
    preview: vi.fn()
  }
}));
beforeEach(() => {
  vi.mocked(runReviewApi.get).mockResolvedValue(reviewFixture());
  vi.mocked(runReviewApi.preview).mockResolvedValue({
    runId: RUN_ID,
    caseKey: reviewFixture().caseKey,
    evidenceHash: reviewFixture().evidenceHash,
    origin: "http://127.0.0.1:40000",
    previewPath: `/renderers/${"a".repeat(64)}/preview`,
    rendererSource: "https://dev.example/web_ui/static/",
    rendererVersion: "d".repeat(64),
    payloads: [{ messages: [] }],
    error: null
  });
});
function mount(row: DashboardCase, initial: CaseTab = "result"): void {
  function Wrapper(): ReactElement {
    const [tab, setTab] = useState(initial);
    return (
      <Sheet open>
        <RunCaseDrawer
          api={createRunApi()}
          runId={RUN_ID}
          row={row}
          tab={tab}
          onTab={setTab}
          previous={undefined}
          next={undefined}
          onClose={vi.fn()}
          onNavigate={vi.fn()}
          canRerun={false}
        />
      </Sheet>
    );
  }
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
        })
      }
    >
      <Wrapper />
    </QueryClientProvider>
  );
}
it("merges checks with results and shows generated follow-ups beside delivered output, only two tabs", async () => {
  const row = evidenceRow({
    delivered_messages: [{ asst_msg_id: "ack", text: "正在查询" }],
    timeline: [
      { payload: { asst_msg_id: "final", reply_text: "查到了两条待办", reason: "private thought" } }
    ]
  });
  mount(row);
  expect(screen.getAllByRole("tab")).toHaveLength(2);
  const output = screen.getByRole("region", { name: "实际输出" });
  expect(within(output).getByText("正在查询")).toBeVisible();
  expect(within(output).getByText("查到了两条待办")).toBeVisible();
  expect(within(output).getByText("已生成 · 交付未确认")).toBeVisible();
  expect(screen.queryByText("private thought")).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "分项评测" })).not.toBeInTheDocument();
  const checks = screen.getByRole("region", { name: "验收检查" });
  expect(within(checks).getByText("quality", { exact: true })).toBeVisible();
  expect(checks.querySelector("details.run-check-item")).not.toHaveAttribute("open");
  await screen.findByText(/本次执行未记录 A2UI 卡片/);
});
it("does not silently drop assertions missing a grading result", async () => {
  const row = evidenceRow({});
  mount({
    ...row,
    definition: {
      ...runReportCase.definition,
      assert: [
        ...runReportCase.definition.assert,
        { type: "equals", metric: "未执行的检查", value: true, weight: 1 }
      ]
    }
  });
  expect(screen.getByText("缺少分项结果")).toBeVisible();
  expect(screen.getByText("未执行的检查")).toBeVisible();
  await screen.findByText(/本次执行未记录 A2UI 卡片/);
});
it("opens a live iframe in the result pane without screenshots or another tab", async () => {
  vi.mocked(runReviewApi.get).mockResolvedValue(
    reviewFixture({ live: { required: true, available: true, rendererVersion: "d".repeat(64) } })
  );
  mount(evidenceRow({ a2ui: { surfaceId: "s" } }), "a2ui");
  expect(screen.getByRole("tab", { name: "结果详情" })).toHaveAttribute("aria-selected", "true");
  const frame = await screen.findByTitle("本次执行的 A2UI 动态卡片");
  expect(frame).toHaveAttribute("sandbox", "allow-scripts allow-same-origin");
  expect(frame.getAttribute("src")).toContain(`/renderers/${"a".repeat(64)}/preview?parent=`);
  expect(screen.getByText("https://dev.example/web_ui/static/")).toBeVisible();
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
  expect(screen.getByRole("option", { name: "通过" })).toBeDisabled();
  const target = (frame as HTMLIFrameElement).contentWindow!;
  const send = vi.spyOn(target, "postMessage").mockImplementation(() => undefined);
  fireEvent.load(frame);
  const sent = send.mock.calls.at(-1)?.[0] as { token: string };
  const ready = { type: "cortex-eval-preview", token: sent.token, state: "READY" };
  fireEvent(
    window,
    new MessageEvent("message", {
      origin: "https://untrusted.example",
      source: target,
      data: ready
    })
  );
  expect(screen.getByRole("option", { name: "通过" })).toBeDisabled();
  fireEvent(
    window,
    new MessageEvent("message", {
      origin: "http://127.0.0.1:40000",
      source: target,
      data: { ...ready, token: "wrong" }
    })
  );
  expect(screen.getByRole("option", { name: "通过" })).toBeDisabled();
  fireEvent(
    window,
    new MessageEvent("message", { origin: "http://127.0.0.1:40000", source: target, data: ready })
  );
  expect(screen.getByRole("option", { name: "通过" })).toBeEnabled();
  fireEvent(
    window,
    new MessageEvent("message", {
      origin: "http://127.0.0.1:40000",
      source: target,
      data: { ...ready, state: "ERROR" }
    })
  );
  expect(screen.getByRole("option", { name: "通过" })).toBeDisabled();
  send.mockRestore();
  await userEvent.click(screen.getByRole("button", { name: "放大" }));
  expect(screen.getByRole("region", { name: "A2UI 动态卡片" })).toHaveClass(
    "run-live-card-expanded"
  );
  await userEvent.click(screen.getByRole("button", { name: "收起" }));
  expect(screen.getByTitle("本次执行的 A2UI 动态卡片")).toBe(frame);
});
it("blocks visual approval before live rendering is ready and keeps automatic failure visible", async () => {
  if (runReportCase.evaluation.status !== "PASS") throw new Error("Expected PASS fixture");
  mount({
    ...evidenceRow({ a2ui: { surfaceId: "s" } }),
    evaluation: { ...runReportCase.evaluation, status: "FAIL", promptfooSuccess: false }
  });
  await screen.findByRole("heading", { name: "视觉复核" });
  expect(screen.getByRole("option", { name: "通过" })).toBeDisabled();
  expect(screen.getByText(/自动结论：未通过/)).toBeVisible();
});
it("lists per-call tokens and timing, deduplicates copies, and links to the actual Trace node", async () => {
  const call = {
    call_id: 1,
    task: "router",
    model: "test-model",
    latency_ms: 1200,
    token_usage: { input: 100, output: 20 }
  };
  mount(
    evidenceRow({
      llm_calls: [call, call, { call_id: 2, task: "planner", model: "test-model", latency_ms: 800 }]
    })
  );
  await screen.findByText(/本次执行未记录 A2UI 卡片/);
  await userEvent.click(screen.getByText("评测用量 · Judge", { exact: true }));
  expect(screen.queryByRole("table", { name: "Agent 模型调用" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /查看 Agent 逐模型耗时/ }));
  expect(screen.getByRole("tab", { name: "执行链路" })).toHaveAttribute("aria-selected", "true");
  const node = screen.getByRole("button", { name: /router/ });
  expect(within(node).getByText("1.20 s")).toBeVisible();
  expect(within(node).getByText("120")).toBeVisible();
  expect(document.querySelectorAll(".run-flow-node[data-kind='模型']")).toHaveLength(2);
  await userEvent.click(node);
  const inspector = screen.getByRole("complementary", { name: "节点证据" });
  expect(within(inspector).getAllByText("100")[0]).toBeVisible();
  expect(within(inspector).getAllByText("20")[0]).toBeVisible();
  expect(document.getElementById("case-model--1")).toBeVisible();
});
it("requires every replay frame to render and preserves update prefixes when switching", async () => {
  vi.mocked(runReviewApi.get).mockResolvedValue(
    reviewFixture({ live: { required: true, available: true, rendererVersion: "d".repeat(64) } })
  );
  const first = { messages: [{ createSurface: { surfaceId: "tasks" } }] };
  const second = { messages: [{ updateDataModel: { surfaceId: "tasks", value: { count: 2 } } }] };
  vi.mocked(runReviewApi.preview).mockResolvedValue({
    runId: RUN_ID,
    caseKey: "case-1",
    evidenceHash: reviewFixture().evidenceHash,
    origin: "http://127.0.0.1:40000",
    rendererVersion: "d".repeat(64),
    payloads: [first, second],
    error: null
  });
  mount(evidenceRow({ a2ui: { surfaceId: "tasks" } }), "a2ui");
  async function ready(expected: unknown): Promise<void> {
    const element = await screen.findByTitle("本次执行的 A2UI 动态卡片");
    const target = (element as HTMLIFrameElement).contentWindow!;
    const send = vi.spyOn(target, "postMessage").mockImplementation(() => undefined);
    fireEvent.load(element);
    const sent = send.mock.calls.at(-1)?.[0] as { token: string; payloads: unknown };
    expect(sent.payloads).toEqual(expected);
    fireEvent(
      window,
      new MessageEvent("message", {
        origin: "http://127.0.0.1:40000",
        source: target,
        data: { type: "cortex-eval-preview", token: sent.token, state: "READY" }
      })
    );
    send.mockRestore();
  }
  await screen.findByRole("combobox", { name: "选择 A2UI 卡面或阶段" });
  await userEvent.selectOptions(
    screen.getByRole("combobox", { name: "选择 A2UI 卡面或阶段" }),
    "0"
  );
  await ready([first]);
  expect(screen.getByRole("option", { name: "通过" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "下一项" }));
  await ready([first, second]);
  expect(screen.getByRole("option", { name: "通过" })).toBeEnabled();
});
