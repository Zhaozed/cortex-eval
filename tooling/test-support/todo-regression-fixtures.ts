import { runInNewContext } from "node:vm";

import type { AssertionDefinitionV1 } from "../../packages/contracts/src/case-contracts.ts";
import type { TodoExecutionExpectation } from "../../data_scripts/todo-e2e-assertions.ts";

/** Golden execution rule for a bounded one-call tool request. */
export const executionRule: TodoExecutionExpectation = {
  tool: "create_task",
  args: { provider: "todo", title: "[EVAL] task" },
  outcome: "success",
  fields: { "task.title": "[EVAL] task" },
  instants: { "task.due": "2026-10-01T00:30:00+08:00" },
  resourceIds: ["task.id"]
};

/** Synthetic persisted execution, never sent to Cortex. */
const executionGolden = {
  ok: true,
  parsed_output: {
    tool_executions: [
      {
        tool_request_id: "tool_1",
        status: "SUCCEEDED",
        calls: [
          {
            name: "create_task",
            param: { provider: "todo", title: "[EVAL] task" },
            tool_request_id: "tool_1"
          }
        ],
        terminals: [
          {
            type: "TOOL_RESULT",
            tool_result: {
              name: "create_task",
              status: "SUCCESS",
              tool_request_id: "tool_1",
              result: {
                task: { id: "task_1", title: "[EVAL] task", due: "2026-09-30T16:30:00Z" }
              }
            }
          }
        ]
      }
    ]
  }
};

export function executionFixture(): typeof executionGolden {
  return structuredClone(executionGolden);
}

/** Matching terminal reply and delivery; unrelated progress messages are not completion evidence. */
const final = { req_id: "req_1", asst_msg_id: "asst_1", text: "已创建", kind: "NOTICE" };
const replyGolden = {
  ok: true,
  parsed_output: {
    request_identity: { root_req_id: "req_1" },
    reply_text: "已创建",
    reply_type: "NOTICE",
    final_output: final,
    delivered_messages: [{ ...final }]
  }
};

export function replyFixture(): typeof replyGolden {
  return structuredClone(replyGolden);
}

/** Execute only generated local assertions; no I/O, Promptfoo or model call. */
export function grade(
  assertion: AssertionDefinitionV1,
  output: unknown
): { pass: boolean; score: number; reason: string } {
  if (typeof assertion.value !== "string") throw new Error("INLINE_ASSERTION_REQUIRED");
  return runInNewContext(
    `(function(output) { ${assertion.value}\n})(output)`,
    { output },
    { timeout: 1000 }
  ) as { pass: boolean; score: number; reason: string };
}

/** Extract a required fixture row without hiding absent data. */
export function first<T>(items: readonly T[]): T {
  const value = items[0];
  if (value === undefined) throw new Error("FIXTURE_ROW_MISSING");
  return value;
}
