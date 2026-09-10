// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { expect, it } from "vitest";
import { RunTracePanel } from "../src/features/runs/run-trace-panel.tsx";
import { evidenceRow } from "./run-case-drawer-fixture.ts";

it("opens complete observable node evidence without exposing internal thought or tool tokens", async () => {
  render(
    <RunTracePanel
      row={evidenceRow({
        timeline: [
          {
            step_id: "s1",
            step_idx: 1,
            type: "TOOL_CALL",
            payload: {
              tool_call: { name: "list_tasks", arguments: { status: "open" } },
              thinking: "private thought"
            }
          }
        ],
        llm_calls: [
          {
            call_id: 1,
            related_step_id: "s1",
            model: "recorded-model",
            task: "planner",
            latency_ms: 700,
            token_usage: { input: 100, output: 20 },
            output: "完整响应",
            retry_of: 0
          }
        ]
      })}
    />
  );
  const tool = screen.getByRole("button", { name: /1. 发起工具调用/ });
  expect(within(tool).queryByText(/Token/)).not.toBeInTheDocument();
  await userEvent.click(tool);
  const inspector = screen.getByRole("complementary", { name: "节点证据" });
  expect(within(inspector).getByText("open")).toBeVisible();
  expect(within(inspector).getByText("Tool calling:")).toBeVisible();
  await userEvent.click(within(inspector).getByRole("button", { name: "原始 JSON" }));
  expect(within(inspector).getByText(/"status": "open"/)).toBeVisible();
  expect(screen.queryByText(/private thought/)).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /planner/ }));
  expect(
    within(screen.getByRole("complementary", { name: "节点证据" })).getByText("120")
  ).toBeVisible();
  expect(screen.getByText("完整响应")).toBeVisible();
  expect(screen.getByRole("button", { name: "定位异常" })).toBeDisabled();
});
it("keeps unknown execution state neutral and highlights actual failures", () => {
  render(
    <RunTracePanel
      row={evidenceRow({
        tool_executions: [
          { status: "RUNNING", calls: [{ name: "pending-tool" }] },
          { status: "FAILED", calls: [{ name: "broken-tool" }] }
        ]
      })}
    />
  );
  expect(screen.getByRole("button", { name: /pending-tool/ })).toHaveAttribute(
    "data-error",
    "false"
  );
  expect(screen.getByRole("button", { name: /broken-tool/ })).toHaveAttribute("data-error", "true");
});

it("keeps raw JSON reachable on every node kind and marks only recorded model stages", async () => {
  render(
    <RunTracePanel
      row={evidenceRow({
        route: { decision: "NEW" },
        timeline: [
          { step_id: "input", step_idx: 1, type: "USER_INPUT", payload: { user_text: "你好" } },
          { step_id: "action", step_idx: 2, type: "THINK", payload: { action: "DONE" } }
        ],
        llm_calls: [
          { call_id: 1, task: "planner", model: "saved-model" },
          { call_id: 2, task: "response_gate", model: "saved-gate" },
          { call_id: 3, model: "unknown-stage" }
        ]
      })}
    />
  );
  for (const name of [
    /router/,
    /1. 用户输入/,
    /2. Agent 动作/,
    /planner/,
    /ResponseGate/,
    /unknown-stage/
  ]) {
    await userEvent.click(screen.getByRole("button", { name }));
    const inspector = screen.getByRole("complementary", { name: "节点证据" });
    expect(within(inspector).getByRole("button", { name: "关键信息" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    const raw = within(inspector).getByRole("button", { name: "原始 JSON" });
    expect(raw).toBeVisible();
    await userEvent.click(raw);
    expect(raw).toHaveAttribute("aria-pressed", "true");
    expect(inspector.querySelector(".run-inspector-raw")).toBeVisible();
    expect(within(inspector).getByRole("button", { name: "复制节点 JSON" })).toBeVisible();
  }
});

it("prefixes only recorded stages inline and defaults every node to generic key evidence", async () => {
  render(
    <RunTracePanel
      row={evidenceRow({
        timeline: [
          {
            step_id: "custom",
            step_idx: 1,
            type: "CUSTOM_EVENT",
            component: "retriever",
            payload: {
              documents: [{ source: "docs", score: 0.8 }],
              filters: { namespace: "research" }
            }
          },
          {
            step_id: "plain",
            step_idx: 2,
            type: "ASSISTANT_REPLY",
            payload: { reply_text: "完整的用户回复", extra_output: { calendar: ["event-1"] } }
          }
        ],
        llm_calls: [
          {
            call_id: 4,
            task: "planner",
            model: "test-model",
            input: "搜索资料",
            output: "规划输出"
          }
        ]
      })}
    />
  );
  const custom = screen.getByRole("button", { name: /retriever/ });
  expect(custom.querySelector(".run-flow-title .run-flow-stage")).toHaveTextContent("retriever");
  await userEvent.click(custom);
  const inspector = screen.getByRole("complementary", { name: "节点证据" });
  expect(within(inspector).getByText("documents")).toBeVisible();
  expect(within(inspector).getByText("0.8")).toBeVisible();
  expect(within(inspector).getByText("research")).toBeVisible();
  const reply = screen.getByRole("button", { name: /2. 用户回复/ });
  expect(reply.querySelector(".run-flow-stage")).toBeNull();
  await userEvent.click(reply);
  expect(
    within(screen.getByRole("complementary", { name: "节点证据" })).getByText("完整的用户回复")
  ).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: /planner/ }));
  const model = screen.getByRole("complementary", { name: "节点证据" });
  expect(within(model).getByText("搜索资料")).toBeVisible();
  expect(within(model).getByText("规划输出")).toBeVisible();
});

it("marks AI references separately from real errors and clears stale highlighting", async () => {
  const row = evidenceRow({
    timeline: [
      { step_id: "s1", step_idx: 1, type: "TOOL_CALL", payload: { tool_call: { name: "query" } } }
    ],
    llm_calls: [{ call_id: 1, ok: false }]
  });
  const { traceAnalysisFixture } = await import("./run-trace-analysis-fixture.ts");
  const { RUN_ID } = await import("./run-test-fixture.ts");
  const analysis = traceAnalysisFixture(row);
  const { rerender } = render(<RunTracePanel row={row} runId={RUN_ID} analysis={analysis} />);
  const node = screen.getByRole("button", { name: /1. 发起工具调用/ });
  expect(node).toHaveAttribute("data-ai", "true");
  expect(node).toHaveAttribute("data-error", "false");
  await userEvent.click(screen.getByRole("button", { name: "AI 关联 · 1" }));
  expect(
    within(screen.getByRole("complementary", { name: "节点证据" })).getByText(
      "AI 关联证据 · 待确认"
    )
  ).toBeVisible();
  expect(screen.getByRole("button", { name: /模型调用/ })).toHaveAttribute("data-error", "true");
  rerender(
    <RunTracePanel
      row={row}
      runId={RUN_ID}
      analysis={{ ...analysis, finalCaseResultHash: "b".repeat(64) }}
    />
  );
  expect(node).toHaveAttribute("data-ai", "false");
  expect(screen.queryByText("AI 关联证据 · 待确认")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "原始 JSON" })).toBeVisible();
});
