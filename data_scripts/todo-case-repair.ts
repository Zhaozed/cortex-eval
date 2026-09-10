import {
  CaseDefinitionV1Schema,
  type AssertionDefinitionV1,
  type CaseDefinitionV1
} from "../packages/contracts/src/case-contracts.ts";
import type { JsonValue } from "../packages/contracts/src/contracts-primitives.ts";

const mutationTools = [
  "create_task",
  "update_task",
  "delete_tasks",
  "ios_reminder_create",
  "ios_reminder_update",
  "ios_reminder_delete"
];

function object(value: JsonValue | undefined): Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("TODO_SCHEMA_SHAPE");
  return value;
}

/** Add string types without weakening pattern checks or changing negative schema predicates. */
function typedPatterns(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(typedPatterns);
  if (value === null || typeof value !== "object") return value;
  const result = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, typedPatterns(item)])
  );
  if (typeof result.pattern === "string" && result.type === undefined) result.type = "string";
  return result;
}

/** Online identity belongs to the trusted execution context, never Planner-generated arguments. */
function plannerIdentitySchema(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(plannerIdentitySchema);
  if (value === null || typeof value !== "object") return value;
  const result = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, plannerIdentitySchema(item)])
  );
  if (result.properties === undefined) return result;
  const properties = object(result.properties);
  if (properties.tool_name === undefined || properties.args_json === undefined) return result;
  const name = object(properties.tool_name).const;
  if (
    typeof name !== "string" ||
    !["list_tasks", "search_tasks", "create_task", "update_task", "delete_tasks"].includes(name)
  )
    return result;
  const args = object(properties.args_json);
  if (Array.isArray(args.required))
    args.required = args.required.filter((field) => field !== "user_id");
  if (args.properties !== undefined) delete object(args.properties).user_id;
  // A separate allOf preserves existing negative predicates (time windows etc.).
  const noIdentity = { not: { required: ["user_id"] } };
  const allOf = Array.isArray(args.allOf) ? args.allOf : [];
  if (!allOf.some((item) => JSON.stringify(item) === JSON.stringify(noIdentity)))
    args.allOf = [...allOf, noIdentity];
  return result;
}

/** Wrap one required field assertion in the existing ProviderOutput contract. */
export function parsedAssertion(
  metric: string,
  fields: Record<string, JsonValue>
): AssertionDefinitionV1 {
  return {
    type: "is-json",
    metric,
    weight: 1,
    value: {
      type: "object",
      required: ["parsed_output"],
      properties: {
        parsed_output: { type: "object", required: Object.keys(fields), properties: fields }
      }
    }
  };
}

/** Repair Planner cases only; never convert simulated permissions/history into E2E state. */
export function repairTodoPlannerCase(input: unknown): CaseDefinitionV1 {
  const c = structuredClone(CaseDefinitionV1Schema.parse(input));
  if (c.vars.task !== "planner" || !c.metadata.case_id.startsWith("TODO-"))
    throw new Error("TODO_PLANNER_SOURCE_REQUIRED");
  c.threshold = 1;
  c.metadata.scenario_tag = `planner-${c.metadata.scenario_tag.replace(/^planner-/, "")}`;
  c.assert = c.assert
    .filter(
      (a) =>
        ![
          "口径｜仅Planner输出",
          "规划｜禁止重复写调用",
          "规划｜Task不混入Reminder",
          "规划｜普通Task查询默认未完成",
          "规划｜查询不得写入",
          "回复｜提问或说明必须有正文"
        ].includes(a.metric)
    )
    .map((a) => {
      const result = { ...a, weight: 1 };
      if (result.type === "is-json" && result.value !== undefined) {
        result.value = plannerIdentitySchema(typedPatterns(result.value));
        const parsed = object(object(object(result.value).properties).parsed_output);
        // Existing properties describe expected output projections, not optional input fields.
        parsed.required = [
          ...new Set([
            ...(Array.isArray(parsed.required) ? parsed.required : []),
            ...Object.keys(object(parsed.properties ?? {})),
            ...(parsed.not && Array.isArray(object(parsed.not).required)
              ? (object(parsed.not).required as JsonValue[])
              : [])
          ])
        ];
      }
      return result;
    });
  const id = c.metadata.case_id;
  if (["TODO-S-01", "TODO-S-02", "TODO-S-03", "TODO-S-05", "TODO-S-06", "TODO-S-12"].includes(id)) {
    c.assert = c.assert.filter((a) => !a.metric.includes("iOS") && a.metric !== "不应过滤完成状态");
    c.assert.push(
      parsedAssertion("规划｜Task不混入Reminder", {
        tools: {
          type: "array",
          not: {
            contains: {
              type: "object",
              required: ["tool_name"],
              properties: { tool_name: { type: "string", pattern: "^ios_reminder_" } }
            }
          }
        }
      })
    );
  }
  if (id === "TODO-S-01")
    c.description = "Planner｜待办｜最近默认三天窗口（当天±1，默认未完成；仅检查规划）";
  if (id === "TODO-S-02") {
    // Original input is “看看我的待办”, not “所有完成状态”; do not silently alter user input.
    c.description = "Planner｜待办｜普通查询（无时间窗口、默认未完成；仅检查规划）";
    const first = c.assert[0];
    if (first?.value === undefined) throw new Error("TODO_S02_SCHEMA_REQUIRED");
    const args = object(
      object(
        object(
          object(object(object(object(first.value).properties).parsed_output).properties).tools
        ).contains
      ).properties
    ).args_json;
    object(args).not = { anyOf: [{ required: ["due_after"] }, { required: ["due_before"] }] };
  }
  if (["TODO-S-01", "TODO-S-02", "TODO-S-03", "TODO-S-04"].includes(id)) {
    c.assert.push(
      parsedAssertion("规划｜普通Task查询默认未完成", {
        tools: {
          type: "array",
          contains: {
            type: "object",
            required: ["tool_name", "args_json"],
            properties: {
              tool_name: { const: "list_tasks" },
              args_json: {
                type: "object",
                required: ["status"],
                properties: { status: { const: "open" } }
              }
            }
          }
        }
      })
    );
  }
  // For every query, ban all mutation families, not only selected unified-task tools.
  if (id.startsWith("TODO-S-")) {
    c.assert = c.assert.filter((a) => a.metric !== "不应触发增删改");
    c.assert.push(
      parsedAssertion("规划｜查询不得写入", {
        tools: {
          type: "array",
          not: {
            contains: {
              type: "object",
              required: ["tool_name"],
              properties: { tool_name: { enum: mutationTools } }
            }
          }
        }
      })
    );
  }
  c.assert.unshift({
    type: "is-json",
    metric: "口径｜仅Planner输出",
    weight: 1,
    value: {
      type: "object",
      required: ["ok", "task_name", "parsed_output"],
      properties: {
        ok: { const: true },
        task_name: { const: "planner" },
        parsed_output: { type: "object", not: { required: ["tool_executions"] } }
      }
    }
  });
  c.assert.push({
    type: "javascript",
    metric: "规划｜禁止重复写调用",
    weight: 1,
    value: `
const p = (typeof output === 'string' ? JSON.parse(output) : output)?.parsed_output; const writes=${JSON.stringify(mutationTools)}; if (!Array.isArray(p?.tools) || p.tools.some(t => !t || typeof t.tool_name !== 'string')) return {pass:false,score:0,reason:'缺少合法tools规划证据'}; const count=p.tools.filter(t => writes.includes(t.tool_name)).length; return {pass:count<=1,score:count<=1?1:0,reason:count<=1?'写调用数量符合单目标/单批次Planner样例约束':'重复或额外写调用'};`
  });
  // Tool-only Planner rounds may legitimately have null text. Questions/explanations may not.
  if (c.assert.some((a) => a.metric.includes("应为提问") || a.metric === "应有回复说明")) {
    c.assert.push(
      parsedAssertion("回复｜提问或说明必须有正文", {
        reply_text: { type: "string", minLength: 1, pattern: "\\S" }
      })
    );
  }
  return CaseDefinitionV1Schema.parse(c);
}
