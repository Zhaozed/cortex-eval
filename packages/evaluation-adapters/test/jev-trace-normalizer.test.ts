import { describe, expect, it } from "vitest";
import { normalizeAgentTrace } from "../src/jev-trace-normalizer.ts";

describe("JEV trace normalization", () => {
  it("sends bounded evidence instead of the full provider payload", () => {
    const hugeSchema = {
      properties: Object.fromEntries(
        Array.from({ length: 200 }, (_, i) => [`field_${i}`, "x".repeat(500)])
      )
    };
    const trace = normalizeAgentTrace({
      task: "查询任务",
      parsed_output: {
        task: "查询任务",
        reply_text: "已完成",
        tool_schema: hugeSchema,
        tool_executions: Array.from({ length: 300 }, (_, i) => ({
          tool_request_id: `request-${i}`,
          calls: [
            {
              name: "feishu_task.list",
              param: { query: "x".repeat(5000) },
              outcome: "success"
            }
          ]
        })),
        conversation: Array.from({ length: 300 }, () => ({
          role: "assistant",
          text: "y".repeat(5000)
        }))
      }
    });

    const serialized = JSON.stringify(trace);
    expect(serialized.length).toBeLessThan(150_000);
    expect(serialized).not.toContain("field_199");
    expect(trace.toolCalls.length).toBeLessThanOrEqual(100);
    expect(trace.messages.length).toBeLessThanOrEqual(80);
    expect(trace.finalAnswer).toBe("已完成");
  });

  it("extracts final output and A2UI component names", () => {
    const trace = normalizeAgentTrace({
      task: "展示任务",
      parsed_output: {
        final_output: { text: "卡片已展示", kind: "text" },
        a2ui: [
          {
            messages: [
              { createSurface: { surfaceId: "surface-1", catalogId: "basic" } },
              {
                updateComponents: {
                  surfaceId: "surface-1",
                  components: [{ id: "c1", component: "TaskList" }]
                }
              }
            ]
          }
        ]
      }
    });

    expect(trace.finalAnswer).toBe("卡片已展示");
    expect(trace.a2ui.map((item) => item.component)).toEqual(["surface", "TaskList"]);
  });
  it("normalizes Feishu terminal status/result, object routes, and derived facts", () => {
    const trace = normalizeAgentTrace({
      task: "查询明天任务",
      parsed_output: {
        route: { decision: "NEW", facts: { domain: "other", tools: ["list_tasks"] } },
        tool_executions: [
          {
            tool_request_id: "call-1",
            status: "SUCCEEDED",
            calls: [{ name: "list_tasks", param: { status: "open" } }],
            terminals: [
              {
                tool_result: {
                  status: "SUCCESS",
                  result: { total: 1, tasks: [{ title: "发布" }] }
                }
              }
            ]
          }
        ],
        final_answer: "明天有发布。"
      }
    });

    expect(trace.router).toEqual({ selected: "NEW", candidates: ["list_tasks"] });
    expect(trace.toolCalls[0]?.outcome).toBe("success");
    expect(trace.toolCalls[0]?.result).toMatchObject({
      status: "SUCCESS",
      result: { total: 1, tasks: [{ title: "发布" }] }
    });
    expect(trace.facts).toMatchObject({
      calledTools: ["list_tasks"],
      toolCallCount: 1,
      failedToolCallCount: 0,
      retryCount: 0
    });
  });

});
