import type { JsonValue } from "../contracts-primitives.ts";

/** Shared deterministic rules are ordinary portable Promptfoo JavaScript assertions. */
export interface CaseFieldRule {
  readonly operation: "exists" | "equals" | "type" | "count";
  readonly path: string;
  readonly expected: JsonValue;
}
const PREFIX = "// cortex-eval field-rule v1 ";

/** Generate a fail-closed field check; distinguish a missing property from null/false/zero. */
export function compileCaseFieldRule(rule: CaseFieldRule): string {
  return `${PREFIX}${JSON.stringify(rule)}\nconst rule = ${JSON.stringify(rule)};
const fail = reason => ({pass:false,score:0,reason});
let actual = output;
if (typeof actual === 'string') { try { actual = JSON.parse(actual); } catch { return fail('输出不是合法 JSON，无法检查字段'); } }
const parts = rule.path.split('.');
if (!rule.path.trim() || parts.some(part => !part.trim())) throw new Error('字段路径不能为空；使用点分隔字段或列表下标');
for (const part of parts) {
  if (actual === null || typeof actual !== 'object' || !Object.hasOwn(actual,part)) return fail('缺少目标字段：' + rule.path);
  actual = actual[part];
}
const equal = (a,b) => {
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b,k) && equal(a[k],b[k]));
};
let pass = false;
if (rule.operation === 'exists') pass = true;
else if (rule.operation === 'equals') pass = equal(actual,rule.expected);
else if (rule.operation === 'type') pass = (actual === null ? 'null' : Array.isArray(actual) ? 'array' : typeof actual) === rule.expected;
else if (rule.operation === 'count') pass = Array.isArray(actual) && actual.length === rule.expected;
else throw new Error('未知字段检查类型');
return {pass,score:pass ? 1 : 0,reason:pass ? '字段检查通过：' + rule.path : '字段不符合预期：' + rule.path};`;
}

/** Only recognize unmodified generated code; edited/custom code remains untouched in advanced mode. */
export function readCaseFieldRule(value: unknown): CaseFieldRule | null {
  if (typeof value !== "string" || !value.startsWith(PREFIX)) return null;
  try {
    const rule = JSON.parse(value.slice(PREFIX.length).split("\n")[0] ?? "") as CaseFieldRule;
    if (
      !["exists", "equals", "type", "count"].includes(rule.operation) ||
      typeof rule.path !== "string" ||
      !Object.hasOwn(rule, "expected")
    )
      return null;
    return compileCaseFieldRule(rule) === value ? rule : null;
  } catch {
    return null;
  }
}
