import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { repairTodoPlannerCase } from "../../data_scripts/todo-case-repair.ts";
import {
  todoExecutionAssertion,
  todoReplyAssertion
} from "../../data_scripts/todo-e2e-assertions.ts";
import { buildTodoE2ESamples } from "../../data_scripts/todo-e2e-samples.ts";
import { CaseDefinitionV1Schema } from "../../packages/contracts/src/case-contracts.ts";
import {
  first,
  executionFixture,
  executionRule,
  grade,
  replyFixture
} from "../test-support/todo-regression-fixtures.ts";

const assertion = todoExecutionAssertion([executionRule]);

describe("Todo 实际执行证据断言", () => {
  it("正确业务结果与等价UTC时刻通过", () =>
    expect(grade(assertion, executionFixture()).pass).toBe(true));
  it.each([
    ["无parsed_output", { ok: true }],
    ["只有计划", { ok: true, parsed_output: { tools: [{ tool_name: "create_task" }] } }],
    ["非法JSON", "not-json"],
    ["桥接失败", { ...executionFixture(), ok: false }]
  ])("缺证据不能通过：%s", (_label, output) => expect(grade(assertion, output).pass).toBe(false));
  it.each([
    [
      "缺调用",
      (
        e: ReturnType<typeof executionFixture>["parsed_output"]["tool_executions"][number]
      ): void => {
        e.calls = [];
      }
    ],
    [
      "缺终态",
      (
        e: ReturnType<typeof executionFixture>["parsed_output"]["tool_executions"][number]
      ): void => {
        e.terminals = [];
      }
    ],
    [
      "失败状态",
      (
        e: ReturnType<typeof executionFixture>["parsed_output"]["tool_executions"][number]
      ): void => {
        e.status = "FAILED";
      }
    ],
    [
      "请求错配",
      (
        e: ReturnType<typeof executionFixture>["parsed_output"]["tool_executions"][number]
      ): void => {
        first(e.calls).tool_request_id = "other";
      }
    ],
    [
      "终态错配",
      (
        e: ReturnType<typeof executionFixture>["parsed_output"]["tool_executions"][number]
      ): void => {
        first(e.terminals).tool_result.tool_request_id = "other";
      }
    ],
    [
      "工具错配",
      (
        e: ReturnType<typeof executionFixture>["parsed_output"]["tool_executions"][number]
      ): void => {
        first(e.terminals).tool_result.name = "update_task";
      }
    ],
    [
      "空ID",
      (
        e: ReturnType<typeof executionFixture>["parsed_output"]["tool_executions"][number]
      ): void => {
        first(e.terminals).tool_result.result.task.id = "";
      }
    ],
    [
      "错误时间",
      (
        e: ReturnType<typeof executionFixture>["parsed_output"]["tool_executions"][number]
      ): void => {
        first(e.terminals).tool_result.result.task.due = "2026-10-01T00:30:00Z";
      }
    ],
    [
      "无时区",
      (
        e: ReturnType<typeof executionFixture>["parsed_output"]["tool_executions"][number]
      ): void => {
        first(e.terminals).tool_result.result.task.due = "2026-10-01T00:30:00";
      }
    ],
    [
      "参数错误",
      (
        e: ReturnType<typeof executionFixture>["parsed_output"]["tool_executions"][number]
      ): void => {
        first(e.calls).param.title = "wrong";
      }
    ]
  ])("拒绝错误执行：%s", (_label, mutate) => {
    const output = executionFixture();
    mutate(first(output.parsed_output.tool_executions));
    expect(grade(assertion, output).pass).toBe(false);
  });
  it("拒绝重复执行和额外工具", () => {
    const output = executionFixture();
    output.parsed_output.tool_executions.push(
      structuredClone(first(output.parsed_output.tool_executions))
    );
    expect(grade(assertion, output).pass).toBe(false);
  });
  it("拒绝SUCCESS中的部分Provider失败", () => {
    const output = executionFixture();
    Object.assign(first(first(output.parsed_output.tool_executions).terminals).tool_result.result, {
      provider_errors: [{ code: "UNAUTHORIZED" }]
    });
    expect(grade(assertion, output).pass).toBe(false);
  });
  it("目标字段缺失失败，即使同工具返回成功", () => {
    const output = executionFixture();
    Reflect.deleteProperty(
      first(first(output.parsed_output.tool_executions).terminals).tool_result.result.task,
      "title"
    );
    expect(grade(assertion, output).pass).toBe(false);
  });
  it.each([
    ["乱序", ["b", "a"], true],
    ["重复", ["a", "a"], false],
    ["缺少", ["a"], false],
    ["多余", ["a", "b", "c"], false]
  ])("精确无序集合：%s", (_label, values, pass) => {
    const output = executionFixture();
    Object.assign(first(first(output.parsed_output.tool_executions).terminals).tool_result.result, {
      ids: values
    });
    const rule = { ...executionRule, sets: { ids: ["a", "b"] } };
    expect(grade(todoExecutionAssertion([rule]), output).pass).toBe(pass);
  });
  it("fields数组按顺序比较", () => {
    const output = executionFixture();
    Object.assign(first(first(output.parsed_output.tool_executions).terminals).tool_result.result, {
      ids: ["b", "a"]
    });
    expect(
      grade(todoExecutionAssertion([{ ...executionRule, fields: { ids: ["a", "b"] } }]), output)
        .pass
    ).toBe(false);
  });
  it("非法预期时间和重复预期集合报错，不静默通过", () => {
    expect(() =>
      grade(
        todoExecutionAssertion([{ ...executionRule, instants: { "task.due": "tomorrow" } }]),
        executionFixture()
      )
    ).toThrow("TODO_ASSERTION_TIME_CONFIG");
    expect(() =>
      grade(
        todoExecutionAssertion([{ ...executionRule, sets: { ids: ["a", "a"] } }]),
        executionFixture()
      )
    ).toThrow("TODO_ASSERTION_SET_CONFIG");
  });
  it("预期工具失败要求精确终态、错误码及归属", () => {
    const output = executionFixture();
    const e = first(output.parsed_output.tool_executions);
    e.status = "FAILED";
    Object.assign(e, {
      terminals: [
        { type: "ERROR", error: { tool_request_id: "tool_1", error_code: "TOOL_TIMEOUT" } }
      ]
    });
    const failed = todoExecutionAssertion([
      {
        tool: executionRule.tool,
        args: executionRule.args,
        outcome: "failure",
        errorCode: "TOOL_TIMEOUT"
      }
    ]);
    expect(grade(failed, output).pass).toBe(true);
    expect(grade(assertion, output).pass).toBe(false);
    expect(
      grade(
        todoExecutionAssertion([
          {
            tool: executionRule.tool,
            args: executionRule.args,
            outcome: "failure",
            errorCode: "OTHER"
          }
        ]),
        output
      ).pass
    ).toBe(false);
  });
  it("不执行必须有空数组，不能缺数组", () => {
    expect(
      grade(todoExecutionAssertion([]), { ok: true, parsed_output: { tool_executions: [] } }).pass
    ).toBe(true);
    expect(grade(todoExecutionAssertion([]), { ok: true, parsed_output: {} }).pass).toBe(false);
  });
  it("空调用项明确失败", () => {
    const output = executionFixture();
    Object.assign(first(output.parsed_output.tool_executions), { calls: [null] });
    expect(grade(assertion, output).pass).toBe(false);
  });
});

describe("Todo 终局回复证据", () => {
  const reply = todoReplyAssertion({ type: "NOTICE", delivered: true });
  it("按脱敏存量trace的root_req_id契约核对交付", async () => {
    const output: unknown = JSON.parse(
      await readFile("tooling/test-support/todo-delivery-evidence.json", "utf8")
    );
    expect(grade(reply, output).pass).toBe(true);
  });
  it("同请求终局交付通过", () => expect(grade(reply, replyFixture()).pass).toBe(true));
  it.each(["缺正文", "过渡回复", "错请求", "无交付"])("拒绝%s", (kind) => {
    const output = replyFixture();
    if (kind === "缺正文") output.parsed_output.reply_text = " ";
    if (kind === "过渡回复") output.parsed_output.final_output.text = "正在处理";
    if (kind === "错请求") output.parsed_output.request_identity.root_req_id = "other";
    if (kind === "无交付") output.parsed_output.delivered_messages = [];
    expect(grade(reply, output).pass).toBe(false);
  });
});

describe("Todo Case修复", () => {
  it("36例修复幂等、不改源、关键断言均为正权重", async () => {
    const source = (await readFile("tooling/test-support/todo-planner-legacy.jsonl", "utf8"))
      .trim()
      .split("\n")
      .map((s) => CaseDefinitionV1Schema.parse(JSON.parse(s)));
    expect(source).toHaveLength(36);
    for (const c of source) {
      const original = structuredClone(c);
      const fixed = repairTodoPlannerCase(c);
      expect(c).toEqual(original);
      expect(repairTodoPlannerCase(fixed)).toEqual(fixed);
      expect(fixed.assert.every((a) => a.weight === 1)).toBe(true);
      expect(fixed.assert.some((a) => a.metric === "口径｜仅Planner输出")).toBe(true);
    }
  });
  it("8例草稿严格契约可读，不伪造权限与时钟，不冒充视觉验收", () => {
    const samples = buildTodoE2ESamples();
    expect(samples).toHaveLength(8);
    for (const c of samples) {
      expect(CaseDefinitionV1Schema.safeParse(c).success).toBe(true);
      expect(c.vars.request_body.uid).toBe(0);
      for (const key of ["tools", "task_history", "time"])
        expect(c.vars.request_body).not.toHaveProperty(key);
      expect(c.assert.every((a) => a.weight === 1)).toBe(true);
      expect(c.assert.some((a) => a.metric.includes("没有业务卡"))).toBe(false);
    }
  });
});
