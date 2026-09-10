import { parse } from "acorn";
import type { AssertionDefinitionV1 } from "../case-contracts.ts";
import payloads from "./promptfoo-payloads.json" with { type: "json" };
import { readCaseFieldRule } from "./field-rules.ts";

/** Stable, non-sensitive validation reasons; never include submitted JS or credentials. */
export const ASSERTION_ISSUES = {
  UNKNOWN_TYPE: "未识别的断言类型，请选择支持的检查规则。",
  INVALID_VALUE: "预期值缺失或类型不符合该断言要求。",
  INVALID_THRESHOLD: "该检查需要有效的非负阈值。",
  INVALID_PATH: "请填写有效的目标字段路径，使用点分隔字段或列表下标。",
  INVALID_COUNT: "列表数量必须是非负整数。",
  INVALID_FIELD_TYPE: "请选择有效的字段类型。",
  INVALID_REGEX: "正则表达式无效，请检查语法。",
  INVALID_JAVASCRIPT: "JavaScript 语法无效，请检查代码；预检不会执行自定义代码。",
  EMPTY_RUBRIC: "请填写语义评分标准或引用已有评分 Prompt。",
  NO_SCORING_RULE: "至少需要一个有效参与判定的检查项，不能全部设置为零权重。"
} as const;
export type AssertionIssueCode = keyof typeof ASSERTION_ISSUES;
export interface AssertionAuthoringIssue {
  readonly code: AssertionIssueCode;
  readonly path: readonly (string | number)[];
}

function valueKind(value: unknown): string {
  if (value === undefined) return "NONE";
  if (value === null) return "NULL";
  if (Array.isArray(value))
    return value.every((item) => typeof item === "string") ? "STRING_LIST" : "ARRAY";
  return typeof value === "object"
    ? "OBJECT"
    : typeof value === "string"
      ? "STRING"
      : typeof value === "number"
        ? "NUMBER"
        : "BOOLEAN";
}

/** Syntax only. Never eval/new Function/import user code during authoring or preflight. */
function javascriptValid(source: string): boolean {
  try {
    parse(`async function check(output, context) {\n${source}\n}`, { ecmaVersion: "latest" });
    return true;
  } catch {
    return false;
  }
}

/** Same validation for guided editing, API writes, JSON imports and offline lint. */
export function assertionAuthoringIssue(
  assertion: AssertionDefinitionV1
): AssertionAuthoringIssue | null {
  const issue = (code: AssertionIssueCode, field = "value"): AssertionAuthoringIssue => ({
    code,
    path: [field]
  });
  const type = assertion.type;
  const capability = Object.hasOwn(payloads, type) ? payloads[type as keyof typeof payloads] : null;
  // Keep plugin-defined redteam payloads compatible; runtime availability remains a separate check.
  const dynamic = /^promptfoo:redteam:[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(type);
  if (type.includes("*") || (!capability && !dynamic)) return issue("UNKNOWN_TYPE", "type");
  if (capability && type !== "assert-set") {
    const kind = valueKind(assertion.value);
    const kinds: readonly string[] = capability.acceptedKinds;
    const stringAlias =
      typeof assertion.value === "string" && (kinds.includes("SCRIPT") || kinds.includes("URL"));
    if (
      (!kinds.includes(kind) && !stringAlias) ||
      (capability.valueRequired && assertion.value === undefined)
    )
      return issue("INVALID_VALUE");
    if (
      capability.thresholdRequired &&
      (typeof assertion.threshold !== "number" ||
        !Number.isFinite(assertion.threshold) ||
        assertion.threshold < 0)
    )
      return issue("INVALID_THRESHOLD", "threshold");
  }
  if (
    assertion.threshold !== undefined &&
    (!Number.isFinite(assertion.threshold) || assertion.threshold < 0)
  )
    return issue("INVALID_THRESHOLD", "threshold");
  const base = type.replace(/^not-/, "");
  if (base === "equals" && assertion.value === undefined) return issue("INVALID_VALUE");
  if (
    ["contains", "icontains", "regex", "starts-with"].includes(base) &&
    typeof assertion.value === "string" &&
    !assertion.value.length
  )
    return issue("INVALID_VALUE");
  if (base === "regex" && typeof assertion.value === "string") {
    try {
      new RegExp(assertion.value);
    } catch {
      return issue("INVALID_REGEX");
    }
  }
  if (
    base === "llm-rubric" &&
    assertion.rubricPrompt === undefined &&
    (assertion.value === undefined ||
      (typeof assertion.value === "string" && !assertion.value.trim()))
  )
    return issue("EMPTY_RUBRIC");
  if (base === "javascript" && typeof assertion.value === "string") {
    if (!assertion.value.trim() || !javascriptValid(assertion.value))
      return issue("INVALID_JAVASCRIPT");
    const rule = readCaseFieldRule(assertion.value);
    if (rule) {
      if (!rule.path.trim() || rule.path.split(".").some((part) => !part.trim()))
        return issue("INVALID_PATH");
      if (
        rule.operation === "count" &&
        (typeof rule.expected !== "number" ||
          !Number.isSafeInteger(rule.expected) ||
          rule.expected < 0)
      )
        return issue("INVALID_COUNT");
      if (
        rule.operation === "type" &&
        !["string", "number", "boolean", "object", "array", "null"].some(
          (type) => type === rule.expected
        )
      )
        return issue("INVALID_FIELD_TYPE");
    }
  }
  for (const field of ["transform", "contextTransform"] as const) {
    if (assertion[field] !== undefined && !javascriptValid(assertion[field]))
      return issue("INVALID_JAVASCRIPT", field);
  }
  for (const [index, child] of (assertion.assert ?? []).entries()) {
    const nested = assertionAuthoringIssue(child);
    if (nested) return { ...nested, path: ["assert", index, ...nested.path] };
  }
  return null;
}

/** All-zero observation-only cases cannot act as business acceptance cases. */
export function caseAssertionsIssue(
  assertions: readonly AssertionDefinitionV1[]
): AssertionAuthoringIssue | null {
  for (const [index, assertion] of assertions.entries()) {
    const issue = assertionAuthoringIssue(assertion);
    if (issue) return { ...issue, path: ["assert", index, ...issue.path] };
  }
  const contributes = (a: AssertionDefinitionV1): boolean =>
    (a.weight ?? 1) > 0 && (a.assert === undefined || a.assert.some(contributes));
  return assertions.some(contributes) ? null : { code: "NO_SCORING_RULE", path: ["assert"] };
}
