import { describe, expect, it } from "vitest";
import {
  AgentAuthoringRuleSchema,
  agentCallPolicyAssertion,
  compileAgentAuthoringRule,
  readAgentAuthoringRule,
  type AgentAuthoringRule
} from "../src/assertion-rules/agent-rule-authoring.ts";
import {
  agentExecutionAssertion,
  agentReplyAssertion
} from "../src/assertion-rules/agent-rules.ts";
import { assertionAuthoringIssue } from "../src/assertion-rules/authoring-validation.ts";

const call = (name: string, id = "r1") => ({
  tool_request_id: id,
  calls: [{ name, tool_request_id: id, param: {} }]
});
const runPolicy = (
  tools: string[],
  executions: unknown,
  mode: "forbid" | "limit" = "forbid",
  maxCalls = 1
) => {
  const assertion = agentCallPolicyAssertion({ tools, mode, maxCalls });
  // Execute only our generated fixture source, never imported user scripts during validation.
  return new Function("output", String(assertion.value))({
    ok: true,
    parsed_output: { tool_executions: executions }
  });
};

describe("共享 Agent 规则表单契约", () => {
  const fixtures: AgentAuthoringRule[] = [
    {
      kind: "agent-executions",
      expectations: [
        {
          tool: "create_item",
          args: { title: "中文", done: false },
          outcome: "success",
          fields: { count: 1 },
          sets: { ids: ["a", "b"] },
          instants: { due: "2026-09-10T09:00:00+08:00" },
          resourceIds: ["id"]
        }
      ]
    },
    {
      kind: "agent-executions",
      expectations: [{ tool: "create_item", args: {}, outcome: "failure", errorCode: "DENIED" }]
    },
    { kind: "agent-executions", expectations: [] },
    {
      kind: "agent-reply",
      options: { type: "QUESTION", delivered: true, exactText: "请问几点？" }
    },
    { kind: "agent-call-policy", policy: { tools: ["create_item"], mode: "forbid", maxCalls: 0 } },
    { kind: "agent-call-policy", policy: { tools: ["list_items"], mode: "limit", maxCalls: 1 } }
  ];
  it.each(fixtures)("生成、识别、保存校验往返：$kind", (rule) => {
    const assertion = compileAgentAuthoringRule(rule);
    expect(readAgentAuthoringRule(assertion.value)).toEqual(rule);
    expect(assertionAuthoringIssue(assertion)).toBeNull();
    expect(AgentAuthoringRuleSchema.safeParse(rule).success).toBe(true);
  });
  it("原有执行与回复 JS 无须迁移，编辑过的自定义 JS 不强制转换", () => {
    const original = agentExecutionAssertion([
      { tool: "list_items", args: {}, outcome: "success" }
    ]);
    expect(readAgentAuthoringRule(original.value)?.kind).toBe("agent-executions");
    expect(
      readAgentAuthoringRule(agentReplyAssertion({ type: "NOTICE", delivered: false }).value)?.kind
    ).toBe("agent-reply");
    expect(readAgentAuthoringRule(original.value + "\n// changed")).toBeNull();
    expect(readAgentAuthoringRule("\nconst expected = null;\n")).toBeNull();
  });
  it.each([
    { kind: "agent-executions", expectations: [{ tool: "", args: {}, outcome: "success" }] },
    { kind: "agent-executions", expectations: [{ tool: "create", args: {}, outcome: "failure" }] },
    {
      kind: "agent-executions",
      expectations: [{ tool: "create", args: {}, outcome: "success", fields: { "a..b": 1 } }]
    },
    {
      kind: "agent-executions",
      expectations: [{ tool: "create", args: {}, outcome: "success", sets: { items: [1, 1] } }]
    },
    {
      kind: "agent-executions",
      expectations: [
        { tool: "create", args: {}, outcome: "success", instants: { due: "2026-09-10T09:00:00" } }
      ]
    },
    { kind: "agent-reply", options: { type: "NOTICE", delivered: true, exactText: "" } },
    { kind: "agent-call-policy", policy: { tools: [], mode: "forbid", maxCalls: 0 } },
    {
      kind: "agent-call-policy",
      policy: { tools: ["write", "write"], mode: "forbid", maxCalls: 0 }
    },
    { kind: "agent-call-policy", policy: { tools: [" write"], mode: "limit", maxCalls: 1.5 } }
  ] as AgentAuthoringRule[])("错误配置保存前拒绝：%j", (rule) => {
    expect(assertionAuthoringIssue(compileAgentAuthoringRule(rule))?.code).toBe(
      "INVALID_AGENT_RULE"
    );
  });
});

describe("禁止写入和次数限制读取实际证据", () => {
  it("空执行列表可证明未调用，缺失列表不可以", () => {
    expect(runPolicy(["write"], []).pass).toBe(true);
    expect(runPolicy(["write"], undefined).pass).toBe(false);
    expect(runPolicy(["write"], null).pass).toBe(false);
  });
  it("检查指定写工具，允许其他工具；不靠名称猜写入类型", () => {
    expect(runPolicy(["write"], [call("read")]).pass).toBe(true);
    expect(runPolicy(["write"], [call("write")]).pass).toBe(false);
  });
  it("不去重调用次数，重试也占用次数；参数不同仍是两次", () => {
    expect(runPolicy(["read"], [call("read")], "limit", 1).pass).toBe(true);
    expect(runPolicy(["read"], [call("read"), call("read", "r2")], "limit", 1).pass).toBe(false);
    expect(runPolicy(["read"], [call("read"), call("read", "r2")], "limit", 2).pass).toBe(true);
  });
  it("tool_name 兼容、请求关联缺失或冲突明确失败", () => {
    expect(
      runPolicy(
        ["write"],
        [{ tool_request_id: "r1", calls: [{ tool_name: "write", tool_request_id: "r1" }] }]
      ).pass
    ).toBe(false);
    expect(runPolicy(["write"], [call("read"), call("read")]).pass).toBe(false);
    expect(runPolicy(["write"], [{ tool_request_id: "r1", calls: [{ name: "read" }] }]).pass).toBe(
      false
    );
    expect(runPolicy(["write"], [{ tool_request_id: "r1", calls: [] }]).pass).toBe(false);
  });
});
