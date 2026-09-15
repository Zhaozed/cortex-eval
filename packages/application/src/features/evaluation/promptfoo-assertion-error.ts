import type { AssertionDefinition } from "@cortex-eval/domain/src/domain-evaluation.ts";

// Promptfoo 0.121.18 encodes inline interpreter faults only through fixed component reasons.
export function isAssertionExecutionFailure(
  definition: AssertionDefinition,
  component: Record<string, unknown>
): boolean {
  if (component.pass !== false || component.score !== 0 || typeof component.reason !== "string") {
    return false;
  }
  // Promptfoo marks provider/JSON-grading faults explicitly; these are not quality failures.
  const metadata = component.metadata;
  if (
    metadata !== null &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    (metadata as Record<string, unknown>).graderError === true
  )
    return true;
  const type = definition.type.startsWith("not-")
    ? definition.type.slice("not-".length)
    : definition.type;
  if (type === "javascript") {
    return (
      component.reason.startsWith("Custom function threw error:") &&
      component.reason.includes("\nStack Trace:")
    );
  }
  if (type === "python") return component.reason.startsWith("Python code execution failed:");
  if (type === "ruby") return component.reason.startsWith("Ruby code execution failed:");
  return false;
}

/** Separator the Evaluator Bridge puts between one stable code and its bounded detail. */
const GRADER_ERROR_DETAIL_SEPARATOR = "｜";

/** Maximum characters of provider detail kept in one operator-visible assertion reason. */
const GRADER_ERROR_DETAIL_LIMIT = 180;

const CLOSED_GRADER_ERROR_CODES = [
  "PROVIDER_REQUEST_FAILED",
  "PROVIDER_CAPABILITY_UNSUPPORTED",
  "EVALUATOR_TIMEOUT",
  "EVALUATOR_CANCELLED",
  "EVALUATOR_PROVIDER_RESPONSE_INVALID",
  "EVALUATOR_CAPABILITY_INVALID",
  "EVALUATOR_BINDING_MISMATCH",
  "EVALUATOR_BUDGET_EXCEEDED"
] as const;

// Split one Bridge reason into its closed code and its already-sanitized bounded detail.
function splitGraderErrorReason(reason: unknown): { code: string; detail: string | null } | null {
  if (typeof reason !== "string") return null;
  const separator = reason.indexOf(GRADER_ERROR_DETAIL_SEPARATOR);
  const code = separator === -1 ? reason : reason.slice(0, separator);
  if (!(CLOSED_GRADER_ERROR_CODES as readonly string[]).includes(code)) return null;
  if (separator === -1) return { code, detail: null };
  const detail = reason
    .slice(separator + 1)
    .replace(/\s+/g, " ")
    .trim();
  if (detail === "") return { code, detail: null };
  return {
    code,
    detail:
      detail.length <= GRADER_ERROR_DETAIL_LIMIT
        ? detail
        : `${detail.slice(0, GRADER_ERROR_DETAIL_LIMIT)}…`
  };
}

// Keep the closed code machine-readable and append the bounded provider diagnostic.
function graderErrorSuffix(reason: unknown): string {
  const parsed = splitGraderErrorReason(reason);
  if (parsed === null) return "";
  return parsed.detail === null ? `（${parsed.code}）` : `（${parsed.code}：${parsed.detail}）`;
}

// Keep actionable closed grader errors, without storing raw provider messages or prompts.
export function assertionExecutionErrorReason(component: Record<string, unknown>): string {
  const metadata = component.metadata;
  if (
    metadata !== null &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    (metadata as Record<string, unknown>).graderError === true
  ) {
    return `评测模型调用或评分响应异常${graderErrorSuffix(component.reason)}；不是 Agent 质量不通过。`;
  }
  // Recognize closed evidence/precondition blockers without leaking thrown payloads or stacks.
  if (typeof component.reason === "string") {
    if (component.reason.startsWith("Custom function threw error: EVIDENCE_INSUFFICIENT:"))
      return "执行证据不足（EVIDENCE_INSUFFICIENT）；查看本分项规则的证据要求，不能用末轮记录证明完整多轮行为。";
    if (component.reason.startsWith("Custom function threw error: ACCEPTANCE_RULE_UNDEFINED:"))
      return "验收规则尚未确定（ACCEPTANCE_RULE_UNDEFINED）；需先确认本分项的产品预期，不能判定业务通过。";
  }
  return "断言脚本执行异常，请检查脚本语法和运行环境。";
}
