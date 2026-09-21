import type { DiagnosticCase } from "@cortex-eval/contracts/src/diagnostic-report-contracts.ts";

export interface DiagnosticCaseScenario {
  /** 业务场景名（来自冻结 Case description 段），无法解析时回退到 caseKey。 */
  readonly scene: string;
  /** 任务类型（task 字段，如 agent-e2e），无法解析时为 null。 */
  readonly taskType: string | null;
  /** 用户原始输入（requestBody.text），无法解析时为 null。 */
  readonly userInput: string | null;
}

const CASE_KEY_RE = /^[A-Za-z0-9_-]+$/;
const PRIORITY_RE = /^[Pp][0-9]$/;
const HARD_QUALITY_RE = /^(硬性|质量)/;
const STRING_VALUE_RE = /:\s*"((?:[^"\\]|\\.)*)"/;

/** 从（可能被截断的）JSON 摘录中定向取字符串字段；取不到返回 null。 */
function extractStringField(jsonish: string, key: string, from = 0): string | null {
  const keyPos = jsonish.indexOf(`"${key}"`, from);
  if (keyPos < 0) return null;
  const match = STRING_VALUE_RE.exec(jsonish.slice(keyPos + key.length + 2));
  if (!match) return null;
  try {
    const value = JSON.parse(`"${match[1]}"`) as unknown;
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

interface CaseDefinitionFields {
  description?: unknown;
  task?: unknown;
  requestBody?: { text?: unknown };
}

/** 从冻结 Case 的 CASE 证据中提取「场景名 + 任务类型 + 用户原始输入」，供人话报告使用。 */
export function diagnosticCaseScenario(
  c: Pick<DiagnosticCase, "caseKey" | "evidence">
): DiagnosticCaseScenario {
  const source = c.evidence.find((e) => e.source === "CASE");
  if (!source) return { scene: c.caseKey, taskType: null, userInput: null };
  let description: unknown = undefined;
  let task: unknown = undefined;
  let requestBodyText: unknown = undefined;
  try {
    const parsed = JSON.parse(source.content) as CaseDefinitionFields;
    description = parsed.description;
    task = parsed.task;
    requestBodyText = parsed.requestBody?.text;
  } catch {
    // 证据受大小限制被截断时，JSON.parse 会失败；所需字段都在摘录头部，定向提取即可。
    description = extractStringField(source.content, "description");
    task = extractStringField(source.content, "task");
    const rbPos = source.content.indexOf('"requestBody"');
    requestBodyText = extractStringField(source.content, "text", rbPos >= 0 ? rbPos : 0);
  }
  let scene = c.caseKey;
  if (typeof description === "string" && description.trim().length > 0) {
    // description 形如：[用户整理]｜P0｜FSU24-01｜按产品组归属找到发布方案｜硬性22·质量2
    const segments = description
      .split("｜")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const start = segments[0]?.startsWith("[") ? 1 : 0;
    const candidate = segments
      .slice(start)
      .find(
        (s) =>
          s.length >= 2 && !CASE_KEY_RE.test(s) && !PRIORITY_RE.test(s) && !HARD_QUALITY_RE.test(s)
      );
    if (candidate) scene = candidate;
  }
  const taskType = typeof task === "string" && task.trim().length > 0 ? task.trim() : null;
  const userInput =
    typeof requestBodyText === "string" && requestBodyText.trim().length > 0
      ? requestBodyText.trim()
      : null;
  return { scene, taskType, userInput };
}
