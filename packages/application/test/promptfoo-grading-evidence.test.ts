import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import {
  GRADING_EVIDENCE_TRANSFORM,
  materializeGradingEvidenceTransform
} from "../src/features/evaluation/promptfoo-grading-evidence.ts";

function project(output: unknown): unknown {
  return runInNewContext(`(function(output) { ${GRADING_EVIDENCE_TRANSFORM} })(input)`, {
    input: output
  });
}

const evidence = {
  ok: true,
  task_name: "e2e",
  parsed_output: {
    llm_calls: [{ system_prompt: "INTERNAL_PROMPT", messages: ["internal history"] }],
    request: { received_at: "2026-09-11T00:00:00Z", timezone: "Asia/Shanghai" },
    reply_text: "Task created",
    tool_executions: [{ task_id: "123", result: { llm_calls: "business data: keep me" } }],
    errors: ["provider error"],
    a2ui: { task_id: "123" },
    conversation_execution: { complete: false },
    turns: [
      {
        execution_ready: false,
        parsed_output: {
          llm_calls: [{ system_prompt: "TURN_INTERNAL_PROMPT" }],
          reply_text: "Failed",
          tool_executions: [{ status: "failed", task_id: "123" }]
        }
      },
      null,
      { parsed_output: null }
    ]
  }
};

describe("模型裁判证据投影 v1", () => {
  it("仅删除 Cortex 证据节点的 llm_calls，不递归误删工具业务字段，不修改原件", () => {
    const before = structuredClone(evidence);
    const projected = project(evidence);
    const expected = structuredClone(evidence);
    Reflect.deleteProperty(expected.parsed_output, "llm_calls");
    const firstTurn = expected.parsed_output.turns[0]?.parsed_output;
    if (firstTurn === undefined || firstTurn === null) throw new Error("Missing test turn");
    Reflect.deleteProperty(firstTurn, "llm_calls");
    expect(projected).toEqual(expected);
    expect(evidence).toEqual(before);
    expect(JSON.stringify(projected)).not.toContain("INTERNAL_PROMPT");
    expect(JSON.stringify(projected)).toContain("business data: keep me");
  });

  it("JSON 字符串保持字符串，重复执行幂等，错误响应也保留失败证据", () => {
    const result = project(JSON.stringify({ ...evidence, ok: false }));
    expect(typeof result).toBe("string");
    expect(JSON.parse(result as string)).toEqual(project({ ...evidence, ok: false }));
    expect(project(result)).toBe(result);
  });

  it.each([null, 4, "plain reply", "{broken", "[]", {}, { parsed_output: { llm_calls: [1] } }])(
    "非 Cortex 输出不裁剪：%j",
    (value) => expect(project(value)).toEqual(value)
  );

  it("只默认覆盖正反 llm-rubric；显式变换及确定性断言保持原样", () => {
    for (const type of ["llm-rubric", "not-llm-rubric"]) {
      expect(materializeGradingEvidenceTransform({ type })).toBe(GRADING_EVIDENCE_TRANSFORM);
      expect(materializeGradingEvidenceTransform({ type, transform: "output" })).toBe("output");
    }
    for (const type of ["javascript", "equals", "assert-set", "model-graded-factuality"]) {
      expect(materializeGradingEvidenceTransform({ type })).toBeUndefined();
    }
  });
});
