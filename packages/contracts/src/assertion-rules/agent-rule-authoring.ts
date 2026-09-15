import { z } from "zod";
import type { AssertionDefinitionV1 } from "../case-contracts.ts";
import { JsonValueSchema } from "../contracts-primitives.ts";
import {
  agentExecutionAssertion,
  agentReplyAssertion,
  type AgentExecutionExpectation
} from "./agent-rules.ts";

const path = z
  .string()
  .trim()
  .min(1)
  .refine((v) => v.split(".").every((p) => p.trim().length > 0));
const name = z
  .string()
  .min(1)
  .refine((v) => v === v.trim());
const instant = z
  .string()
  .refine((v) => /(Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v)));
// Canonical comparison is only used on JSON configuration, never on executable user code.
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item
  );
const expectationSchema = z
  .object({
    tool: name,
    args: z.record(z.string().min(1), JsonValueSchema),
    outcome: z.enum(["success", "failure"]),
    fields: z.record(path, JsonValueSchema).optional(),
    sets: z
      .record(
        path,
        z.array(JsonValueSchema).refine((v) => new Set(v.map(canonical)).size === v.length)
      )
      .optional(),
    instants: z.record(path, instant).optional(),
    resourceIds: z.array(path).optional(),
    errorCode: name.optional()
  })
  .strict()
  .refine((v) => v.outcome !== "failure" || Boolean(v.errorCode), "失败场景必须填写错误码")
  .refine(
    (v) =>
      v.outcome !== "failure" ||
      ![v.fields, v.sets, v.instants, v.resourceIds].some((x) => x && Object.keys(x).length),
    "失败场景不支持成功结果检查"
  );
export type AgentReplyOptions = Parameters<typeof agentReplyAssertion>[0];
export interface AgentCallPolicy {
  readonly tools: readonly string[];
  readonly mode: "forbid" | "limit";
  readonly maxCalls: number;
}
export type AgentAuthoringRule =
  | {
      readonly kind: "agent-executions";
      readonly expectations: readonly AgentExecutionExpectation[];
    }
  | { readonly kind: "agent-reply"; readonly options: AgentReplyOptions }
  | { readonly kind: "agent-call-policy"; readonly policy: AgentCallPolicy };
export const AgentAuthoringRuleSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("agent-executions"), expectations: z.array(expectationSchema) })
    .strict(),
  z
    .object({
      kind: z.literal("agent-reply"),
      options: z
        .object({
          type: z.enum(["QUESTION", "NOTICE"]),
          delivered: z.boolean(),
          exactText: z.string().trim().min(1).optional()
        })
        .strict()
    })
    .strict(),
  z
    .object({
      kind: z.literal("agent-call-policy"),
      policy: z
        .object({
          tools: z
            .array(name)
            .min(1)
            .refine((v) => new Set(v).size === v.length),
          mode: z.enum(["forbid", "limit"]),
          maxCalls: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
        })
        .strict()
    })
    .strict()
]);

/** Counts actual executions by explicit tool names. Never infers write behavior from a name. */
export function agentCallPolicyAssertion(policy: AgentCallPolicy): AssertionDefinitionV1 {
  return {
    type: "javascript",
    metric: policy.mode === "forbid" ? "执行｜禁止工具调用" : "执行｜调用次数上限",
    weight: 1,
    value: `
const policy = ${JSON.stringify(policy)};
const fail = reason => ({pass:false,score:0,reason});
if (!Array.isArray(policy.tools) || !policy.tools.length || policy.tools.some(t => typeof t !== 'string' || !t.trim() || t !== t.trim()) || new Set(policy.tools).size !== policy.tools.length || !['forbid','limit'].includes(policy.mode) || !Number.isSafeInteger(policy.maxCalls) || policy.maxCalls < 0) throw new Error('INVALID_CALL_POLICY');
let root = output;
if (typeof root === 'string') { try { root = JSON.parse(root); } catch { return fail('证据：输出不是 JSON'); } }
const executions = root?.parsed_output?.tool_executions;
if (root?.ok !== true || !Array.isArray(executions)) return fail('证据：缺少实际工具执行记录，不能证明没有调用');
const counts = Object.fromEntries(policy.tools.map(t => [t,0]));
const ids = new Set();
for (const e of executions) {
  if (!e || typeof e.tool_request_id !== 'string' || !e.tool_request_id.trim() || ids.has(e.tool_request_id) || !Array.isArray(e.calls) || e.calls.length !== 1) return fail('证据：调用记录缺失、请求 ID 缺失或重复');
  ids.add(e.tool_request_id);
  const call = e.calls[0];
  const tool = call?.name ?? call?.tool_name;
  if (typeof tool !== 'string' || !tool.trim() || call.tool_request_id !== e.tool_request_id) return fail('证据：工具名称缺失或调用关联不一致');
  if (Object.hasOwn(counts,tool)) counts[tool]++;
}
const max = policy.mode === 'forbid' ? 0 : policy.maxCalls;
for (const [tool,count] of Object.entries(counts)) if (count > max) return fail('执行：' + tool + ' 实际调用 ' + count + ' 次，允许至多 ' + max + ' 次');
return {pass:true,score:1,reason:'指定工具调用次数符合约束；不证明业务结果成功'};
`
  };
}

export function compileAgentAuthoringRule(rule: AgentAuthoringRule): AssertionDefinitionV1 {
  if (rule.kind === "agent-executions") return agentExecutionAssertion(rule.expectations);
  if (rule.kind === "agent-reply") return agentReplyAssertion(rule.options);
  return agentCallPolicyAssertion(rule.policy);
}

// Drafts may have empty required values, but must still be structurally safe to render.
const DraftRuleSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("agent-executions"),
      expectations: z.array(
        z
          .object({
            tool: z.string(),
            args: z.record(z.string(), JsonValueSchema),
            outcome: z.enum(["success", "failure"]),
            fields: z.record(z.string(), JsonValueSchema).optional(),
            sets: z.record(z.string(), z.array(JsonValueSchema)).optional(),
            instants: z.record(z.string(), z.string()).optional(),
            resourceIds: z.array(z.string()).optional(),
            errorCode: z.string().optional()
          })
          .strict()
      )
    })
    .strict(),
  z
    .object({
      kind: z.literal("agent-reply"),
      options: z
        .object({
          type: z.enum(["QUESTION", "NOTICE"]),
          delivered: z.boolean(),
          exactText: z.string().optional()
        })
        .strict()
    })
    .strict(),
  z
    .object({
      kind: z.literal("agent-call-policy"),
      policy: z
        .object({
          tools: z.array(z.string()),
          mode: z.enum(["forbid", "limit"]),
          maxCalls: z.number()
        })
        .strict()
    })
    .strict()
]);

/** Recognize only exact generated source, including pre-existing rules. Never evaluate JS. */
export function readAgentAuthoringRule(source: unknown): AgentAuthoringRule | null {
  if (typeof source !== "string") return null;
  const match = /^\nconst (expected|rule|policy) = (.+);\n/.exec(source);
  if (!match) return null;
  try {
    const value: unknown = JSON.parse(match[2] ?? "null");
    const candidate =
      match[1] === "expected"
        ? { kind: "agent-executions", expectations: value }
        : match[1] === "rule"
          ? { kind: "agent-reply", options: value }
          : { kind: "agent-call-policy", policy: value };
    // Schema validation happens on save, so incomplete form drafts remain editable.
    const parsed = DraftRuleSchema.safeParse(candidate);
    return parsed.success &&
      compileAgentAuthoringRule(candidate as AgentAuthoringRule).value === source
      ? (candidate as AgentAuthoringRule)
      : null;
  } catch {
    return null;
  }
}
