// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { expect, it } from "vitest";
import { TraceInspector } from "../src/features/runs/run-trace-inspector.tsx";

function show(evidence: unknown): void {
  render(
    <TraceInspector
      node={{ id: "tool", title: "工具节点", kind: "工具", summary: "", error: false, evidence }}
      onClose={() => undefined}
    />
  );
}

it("shows actual task results without opening payload, keeps complete lists accessible", async () => {
  show({
    type: "TOOL_RESULT",
    payload: {
      tool_ret: {
        name: "list_tasks",
        status: "SUCCESS",
        result: {
          provider: "todo",
          total: 6,
          tasks: Array.from({ length: 6 }, (_, i) => ({
            title: `待办 ${i + 1}`,
            status: "open",
            due: "2026-09-10T09:00:00+08:00",
            id: `id-${i}`
          }))
        }
      }
    }
  });
  expect(screen.getByText("list_tasks")).toBeVisible();
  expect(screen.getByText("SUCCESS")).toBeVisible();
  expect(screen.getByText("total")).toBeVisible();
  expect(screen.getByText("6")).toBeVisible();
  expect(screen.getByText("待办 1")).toBeVisible();
  expect(screen.queryByText("待办 6")).not.toBeInTheDocument();
  expect(screen.getAllByText("2026-09-10T09:00:00+08:00")[0]).toBeVisible();
  expect(screen.getByRole("button", { name: "原始 JSON" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "展开其余 1 项" }));
  expect(screen.getByText("待办 6")).toBeVisible();
});

it("shows all actual calls and terminal errors, filters thought in encoded arguments", () => {
  show({
    status: "FAILED",
    calls: [
      { name: "list_tasks", args_json: '{"provider":"todo","thinking":"secret-thought"}' },
      { name: "custom_tool", param: { query: "项目文档", extra_filter: false } }
    ],
    terminals: [
      {
        type: "TOOL_RESULT",
        tool_result: { name: "list_tasks", status: "SUCCESS", result: { tasks: [] } }
      },
      { type: "ERROR", error: { error_code: "AUTH_REQUIRED", message: "请先授权" } }
    ]
  });
  expect(screen.getByText("项目文档")).toBeVisible();
  expect(screen.getByText("extra_filter")).toBeVisible();
  expect(screen.getByText("0 项")).toBeVisible();
  expect(screen.getByText("AUTH_REQUIRED")).toBeVisible();
  expect(screen.getByText("请先授权")).toBeVisible();
  expect(screen.queryByText(/secret-thought/)).not.toBeInTheDocument();
  expect(screen.getByRole("region", { name: "工具返回 2" })).toHaveAttribute("data-error", "true");
});

it("does not infer execution success or empty results from missing evidence", () => {
  show({ type: "TOOL_RESULT", payload: { tool_ret: { name: "list_tasks" } } });
  expect(screen.getByText("未记录")).toBeVisible();
  expect(
    within(screen.getByRole("region", { name: "工具返回 1" })).getByText("result: 未记录")
  ).toBeVisible();
  expect(screen.queryByText("SUCCESS")).not.toBeInTheDocument();
  expect(screen.queryByText("0 项")).not.toBeInTheDocument();
});

it("shows tool errors directly and preserves scalar false and zero results", () => {
  show({
    calls: [{ name: "check", arguments: {} }],
    terminals: [
      { type: "TOOL_ERROR", error: { message: "工具不可用", error_code: "UNAVAILABLE" } },
      { tool_result: { name: "check", result: false } },
      { tool_result: { name: "count", result: 0 } }
    ]
  });
  expect(screen.getByText("工具不可用")).toBeVisible();
  expect(screen.getByText("UNAVAILABLE")).toBeVisible();
  expect(screen.getByText("false")).toBeVisible();
  expect(screen.getByText("0")).toBeVisible();
  expect(screen.getByText("0 字段")).toBeVisible();
});

it("keeps call filters and identifiers visible, with persistent raw and summary switching", async () => {
  show({
    type: "TOOL_CALL",
    payload: {
      tool_call: {
        name: "update_task",
        tool_request_id: "request-123",
        timeout_ms: 10000,
        version: 2,
        param: {
          provider: ["todo"],
          task_id: "task-123",
          collection_id: "collection-123",
          title: "准备周报"
        }
      }
    }
  });
  expect(screen.getByText("task-123")).toBeVisible();
  expect(screen.getByText("collection-123")).toBeVisible();
  await userEvent.click(screen.getByText(/调用元数据/));
  expect(screen.getByText("request-123")).toBeVisible();
  expect(screen.queryByText("本记录包含 1 项")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "原始 JSON" }));
  expect(screen.getByText(/"version": 2/)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "关键信息" }));
  expect(screen.getByText("准备周报")).toBeVisible();
});

it("parses an unknown tool's function arguments without a business dictionary", () => {
  show({
    type: "TOOL_CALL",
    payload: {
      tool_call: {
        type: "function",
        function: {
          name: "book_room",
          arguments: { room: "A-101", attendees: ["甲", "乙"], enabled: false, capacity: 0 }
        }
      }
    }
  });
  expect(screen.getAllByText("book_room")[0]).toBeVisible();
  const args = screen.getByText("Arguments").parentElement;
  if (!args) throw new Error("missing arguments group");
  expect(within(args).getByText("room")).toBeVisible();
  expect(within(args).getByText("A-101")).toBeVisible();
  expect(within(args).getByText('["甲","乙"]')).toBeVisible();
  expect(within(args).getByText("false")).toBeVisible();
  expect(within(args).getByText("0")).toBeVisible();
  expect(screen.queryByText(/不代表工具/)).not.toBeInTheDocument();
});

it("lays nested objects and collections out as full-width groups without changing scalar arguments", async () => {
  show({
    type: "TOOL_RESULT",
    payload: {
      tool_ret: {
        name: "search_documents",
        result: {
          groups: [
            { documents: [{ metadata: { title: "说明文档", enabled: false }, id: "doc-1" }] }
          ],
          providers: ["internal", "external"]
        }
      }
    }
  });
  for (const field of ["groups", "documents", "metadata"])
    expect(screen.getByText(field).parentElement).toHaveAttribute("data-structured", "true");
  expect(screen.getByText("providers").parentElement).toHaveAttribute("data-structured", "false");
  for (const summary of document.querySelectorAll(".trace-value-more > summary"))
    await userEvent.click(summary);
  expect(screen.getByText("说明文档")).toBeVisible();
  expect(screen.getByText("false")).toBeVisible();
  expect(screen.getByText("doc-1")).toBeVisible();
  expect(screen.getByRole("button", { name: "原始 JSON" })).toBeVisible();
});
