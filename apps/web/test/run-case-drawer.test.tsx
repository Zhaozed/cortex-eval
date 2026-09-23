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
  expect(within(output).getByText("链路生成记录")).toBeVisible();
  expect(screen.queryByText("private thought")).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "分项评测" })).not.toBeInTheDocument();
  const checks = screen.getByRole("region", { name: "验收检查" });
  expect(within(checks).getByRole("heading", { name: /未分类/ })).toBeVisible();
  expect(checks.querySelector("details.run-check-item")).toBeNull();
  await screen.findByText(/本次执行未记录 A2UI 卡片/);
});
it("shows every user round separately for a multi-turn Case", () => {
  const row = evidenceRow({});
  if (!row.definition) throw new Error("Missing fixture definition");
  const definition = {
    ...row.definition,
    vars: {
      ...row.definition.vars,
      request_body: {
        conversation: [
          { role: "user", text: "创建边界-多轮删除链路" },
          { role: "user", text: "把它删掉" }
        ]
      }
    }
  };
  mount({ ...row, definition });
  expect(screen.getByText("多轮 · 2 轮")).toBeVisible();
  expect(screen.getByText("第 1 轮")).toBeVisible();
  expect(screen.getByText("创建边界-多轮删除链路")).toBeVisible();
  expect(screen.getByText("第 2 轮")).toBeVisible();
  expect(screen.getByText("把它删掉")).toBeVisible();
});
it("labels a single request as one round without a turn list", () => {
  const row = evidenceRow({});
  if (!row.definition) throw new Error("Missing fixture definition");
  mount({
    ...row,
    definition: {
      ...row.definition,
      vars: { ...row.definition.vars, request_body: { text: "我在ClickUp里有哪些任务清单？" } }
    }
  });
  expect(screen.getByText("单轮")).toBeVisible();
  expect(screen.getByText("我在ClickUp里有哪些任务清单？")).toBeVisible();
  expect(document.querySelector(".run-input-turns")).toBeNull();
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
  // 结论条的「失败项 top1」会重复一次项名，所以只校验它作为检查项行渲染出来了。
  const checks = screen.getByRole("region", { name: "验收检查" });
  expect(within(checks).getByText("未执行的检查", { selector: ".run-check-name" })).toBeVisible();
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
  // Rendering state is provenance, not a gate: the reviewer can decide at any point.
  expect(screen.getByRole("option", { name: "通过" })).toBeEnabled();
  expect(screen.getByText("正在渲染卡片…")).toBeVisible();
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
  expect(screen.getByText("正在渲染卡片…")).toBeVisible();
  fireEvent(
    window,
    new MessageEvent("message", {
      origin: "http://127.0.0.1:40000",
      source: target,
      data: { ...ready, token: "wrong" }
    })
  );
  expect(screen.getByText("正在渲染卡片…")).toBeVisible();
  fireEvent(
    window,
    new MessageEvent("message", { origin: "http://127.0.0.1:40000", source: target, data: ready })
  );
  expect(screen.getByText("已渲染 · 待人工检查")).toBeVisible();
  fireEvent(
    window,
    new MessageEvent("message", {
      origin: "http://127.0.0.1:40000",
      source: target,
      data: { ...ready, state: "ERROR", code: "RESOURCE" }
    })
  );
  expect(screen.getByText("卡片依赖资源加载失败，请检查资源服务后重新加载。")).toBeVisible();
  expect(screen.getByRole("option", { name: "通过" })).toBeEnabled();
  send.mockRestore();
  await userEvent.click(screen.getByRole("button", { name: "放大" }));
  expect(screen.getByRole("region", { name: "A2UI 动态卡片" })).toHaveClass(
    "run-live-card-expanded"
  );
  await userEvent.click(screen.getByRole("button", { name: "收起" }));
  expect(screen.getByTitle("本次执行的 A2UI 动态卡片")).toBe(frame);
});
it("keeps an automatic failure visible without gating the human verdict on rendering", async () => {
  if (runReportCase.evaluation.status !== "PASS") throw new Error("Expected PASS fixture");
  mount({
    ...evidenceRow({ a2ui: { surfaceId: "s" } }),
    evaluation: { ...runReportCase.evaluation, status: "FAIL", promptfooSuccess: false }
  });
  await screen.findByRole("heading", { name: "视觉复核" });
  expect(screen.getByRole("option", { name: "通过" })).toBeEnabled();
  expect(screen.getByText(/自动结论：未通过/)).toBeVisible();
  // Overturning automation stays attributable, but never waits for the cards to load.
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "视觉复核结论" }), "PASS");
  expect(screen.getByRole("combobox", { name: "覆盖归因（必填）" })).toBeVisible();
  expect(screen.getByRole("button", { name: "保存复核" })).toBeDisabled();
});
it("asks for no visual review when this round captured no card, even with capture opted in", async () => {
  vi.mocked(runReviewApi.get).mockResolvedValue(
    reviewFixture({ live: { required: false, available: false, rendererVersion: null } })
  );
  const row = evidenceRow({});
  if (!row.definition) throw new Error("Missing fixture definition");
  mount(
    {
      ...row,
      definition: {
        ...row.definition,
        metadata: { ...row.definition.metadata, a2ui_capture: true }
      }
    },
    "a2ui"
  );
  await screen.findByText(/本次执行未记录 A2UI 卡片/);
  expect(screen.queryByRole("heading", { name: "视觉复核" })).not.toBeInTheDocument();
  // Zero-card Cases carry nothing a human eye must settle: no review form at all.
  expect(screen.queryByText(/人工复核 \/ 归因备注/)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "保存复核" })).not.toBeInTheDocument();
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
  await userEvent.click(screen.getByText("评测用量 · 断言评测", { exact: true }));
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
it("preserves update prefixes when switching frames and never gates approval on frame count", async () => {
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
  expect(screen.getByText("已渲染 · 待人工检查")).toBeVisible();
  expect(screen.getByRole("option", { name: "通过" })).toBeEnabled();
  await userEvent.click(screen.getByRole("button", { name: "下一项" }));
  await ready([first, second]);
  expect(screen.getByRole("option", { name: "通过" })).toBeEnabled();
});

it("pairs every executed turn with its own input, output, usage and links that round's trace", async () => {
  const row = evidenceRow({
    turns: [
      {
        req_id: "req-1",
        parsed_output: {
          delivered_messages: [{ asst_msg_id: "a", req_id: "req-1", text: "已创建" }],
          llm_calls: [
            {
              call_id: 1,
              req_id: "req-1",
              task: "router",
              model: "test-model",
              token_usage: { input: 100, output: 20 }
            }
          ],
          timeline: [
            {
              req_id: "req-1",
              created_at: "2026-09-07T06:16:29Z",
              payload: { asst_msg_id: "a", reply_text: "已创建", reason: "private" }
            }
          ]
        }
      },
      {
        req_id: "req-2",
        parsed_output: {
          delivered_messages: [{ asst_msg_id: "b", req_id: "req-2", text: "确定要删除吗？" }],
          llm_calls: [
            {
              call_id: 2,
              req_id: "req-2",
              task: "planner",
              model: "test-model",
              token_usage: { input: 50, output: 10 }
            }
          ],
          timeline: [
            {
              req_id: "req-2",
              created_at: "2026-09-07T06:17:29Z",
              payload: { asst_msg_id: "b", reply_text: "确定要删除吗？", reason: "private" }
            }
          ]
        }
      }
    ]
  });
  if (!row.definition) throw new Error("Missing fixture definition");
  mount({
    ...row,
    definition: {
      ...row.definition,
      vars: {
        ...row.definition.vars,
        request_body: {
          conversation: [
            { role: "user", text: "创建边界-多轮删除链路" },
            { role: "user", text: "把它删掉" }
          ]
        }
      }
    }
  });
  // Multi-turn evidence pivots to per-round rows: no legacy input list or flat output panel.
  expect(screen.queryByRole("region", { name: "实际输出" })).not.toBeInTheDocument();
  expect(document.querySelector(".run-input-turns")).toBeNull();
  const first = screen.getByRole("listitem", { name: "第 1 轮" }),
    second = screen.getByRole("listitem", { name: "第 2 轮" });
  expect(within(first).getByText("创建边界-多轮删除链路")).toBeVisible();
  expect(within(first).getByText("已创建")).toBeVisible();
  expect(within(first).getByText(/Agent 120 Token/)).toBeVisible();
  expect(within(second).getByText("把它删掉")).toBeVisible();
  expect(within(second).getByText("确定要删除吗？")).toBeVisible();
  expect(within(second).getByText(/Agent 60 Token/)).toBeVisible();
  expect(within(first).queryByText("private")).not.toBeInTheDocument();
  // The overall acceptance check stays as the whole-task verdict.
  expect(screen.getByRole("region", { name: "验收检查" })).toBeVisible();
  // Clicking a round opens the shared Trace tab anchored at that round's chain.
  await userEvent.click(within(first).getByRole("button", { name: "查看链路" }));
  expect(screen.getByRole("tab", { name: "执行链路" })).toHaveAttribute("aria-selected", "true");
  const anchor = await screen.findByTestId("turn-anchor-1");
  expect(anchor).toBeVisible();
});
