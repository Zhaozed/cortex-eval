import type { DashboardCase } from "./run-dashboard-model.ts";

/** Read only explicit objects in saved evidence; never guess missing fields. */
export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(object) : [];
}
export function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
export function amount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
export function payload(row: DashboardCase): Record<string, unknown> {
  if (!("providerOutput" in row.rest) || !row.rest.providerOutput?.ok) return {};
  return object(row.rest.providerOutput.parsed_output);
}
/** Cortex E2E v1 stores per-call audit records, not an aggregate span tree. */
export function modelCalls(row: DashboardCase): Record<string, unknown>[] {
  const p = payload(row);
  return p.schema_version === 1 ? records(p.llm_calls) : [];
}
export function callUsage(
  call: Record<string, unknown>
): { input: number; output: number; total: number } | null {
  const usage = object(call.token_usage);
  const input = amount(usage.input),
    output = amount(usage.output);
  return input === null || output === null ? null : { input, output, total: input + output };
}
export interface AgentUsage {
  input: number;
  output: number;
  total: number;
  recorded: number;
  calls: number;
  coveredCases: number;
  expectedCases: number;
  complete: boolean;
}
/** Sum unique actual calls, including failed calls; never add cached input or timeline copies. */
export function agentUsage(rows: readonly DashboardCase[]): AgentUsage {
  const sum: AgentUsage = {
    input: 0,
    output: 0,
    total: 0,
    recorded: 0,
    calls: 0,
    coveredCases: 0,
    expectedCases: rows.length,
    complete: rows.length > 0
  };
  for (const row of rows) {
    const p = payload(row);
    const audit = object(object(object(p.coverage).source_coverage).llm_audit);
    const calls = modelCalls(row);
    if (calls.length > 0) sum.coveredCases++;
    if (
      audit.completeness !== "COMPLETE" ||
      object(p.coverage).truncated === true ||
      calls.length === 0
    )
      sum.complete = false;
    const seen = new Map<string, string>();
    for (const call of calls) {
      const id = call.call_id;
      const key =
        typeof id === "number" || typeof id === "string"
          ? `${text(call.req_id) ?? ""}/${String(id)}`
          : null;
      const usage = callUsage(call);
      if (key !== null && seen.has(key)) {
        if (seen.get(key) !== JSON.stringify(usage)) sum.complete = false;
        continue;
      }
      if (key !== null) seen.set(key, JSON.stringify(usage));
      else sum.complete = false;
      sum.calls++;
      if (!usage) {
        sum.complete = false;
        continue;
      }
      sum.recorded++;
      sum.input += usage.input;
      sum.output += usage.output;
      sum.total += usage.total;
    }
  }
  return sum;
}
/** Only explicit observed action records, never internal reasoning. */
export function observable(value: unknown): unknown {
  if (typeof value === "string" && value.trim().startsWith("{")) {
    try {
      return observable(JSON.parse(value));
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map(observable);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            ![
              "reason",
              "reasoning",
              "thinking",
              "thought",
              "thoughts",
              "chain_of_thought"
            ].includes(key)
        )
        .map(([key, item]) => [key, observable(item)])
    );
  return value;
}
export function finalText(row: DashboardCase): string | null {
  const p = payload(row);
  return text(object(p.final_output).text) ?? text(p.reply_text);
}
export function userText(row: DashboardCase): string | null {
  const body = object(row.definition?.vars.request_body);
  const conversation = records(body.conversation)
    .filter((item) => item.role === "user")
    .map((item) => text(item.text) ?? text(item.content))
    .filter(Boolean)
    .join("\n");
  return text(conversation) ?? text(body.text) ?? text(body.message);
}
export function hasTrace(row: DashboardCase): boolean {
  const p = payload(row);
  return (
    modelCalls(row).length > 0 ||
    records(p.timeline).length > 0 ||
    records(p.tool_executions).length > 0
  );
}
/** Known business identifiers keep their original value in the title. */
export function scenarioName(value: string | undefined): string {
  const names: Record<string, string> = {
    "task-search": "待办查询",
    "e2e-readonly-query": "端到端只读查询",
    "e2e-draft": "E2E 样板",
    "task-create": "创建待办",
    "task-update": "修改待办",
    "task-delete": "删除待办",
    "task-clarify": "待办澄清",
    "task-empty": "空结果",
    "task-auth": "授权不足",
    "task-time": "时间边界"
  };
  return value ? (names[value] ?? value) : "未记录";
}

export interface TraceBranch {
  readonly record: Record<string, unknown>;
  readonly children: TraceBranch[];
}
/** Parent links are used only when unambiguous and acyclic; siblings keep source order. */
export function traceBranches(
  values: readonly Record<string, unknown>[],
  idField: string,
  parentField: string
): TraceBranch[] {
  const id = (value: unknown): string | null =>
    typeof value === "number" ? String(value) : text(value);
  const nodes = values.map((record): TraceBranch => ({ record, children: [] }));
  const candidates = new Map<string, TraceBranch[]>();
  for (const node of nodes) {
    const key = id(node.record[idField]);
    if (key !== null) candidates.set(key, [...(candidates.get(key) ?? []), node]);
  }
  const parents = new Map<TraceBranch, TraceBranch>();
  for (const node of nodes) {
    const key = id(node.record[parentField]);
    const parent =
      key === null
        ? undefined
        : candidates.get(key)?.filter((candidate) => {
            const req = id(node.record.req_id),
              parentReq = id(candidate.record.req_id);
            return !req || !parentReq || req === parentReq;
          });
    if (parent?.length === 1 && parent[0] && parent[0] !== node) parents.set(node, parent[0]);
  }
  const roots: TraceBranch[] = [];
  for (const node of nodes) {
    const visited = new Set<TraceBranch>([node]);
    let parent = parents.get(node),
      cycle = false;
    while (parent) {
      if (visited.has(parent)) {
        cycle = true;
        break;
      }
      visited.add(parent);
      parent = parents.get(parent);
    }
    const direct = parents.get(node);
    if (!cycle && direct) direct.children.push(node);
    else roots.push(node);
  }
  return roots;
}
