import messages from "../messages/zh-CN.json" with { type: "json" };

import {
  canonicalJson,
  type DomainJsonValue
} from "@cortex-eval/domain/src/domain-canonical-hash.ts";

import type { ReportMetricSummary, ReportOwner, ReportSummary } from "./report-aggregation.ts";

/** Bounded facts needed before streaming Markdown Case sections. */
export interface ReportMarkdownHeaderInput {
  /** Immutable report execution identity. */
  readonly owner: ReportOwner;
  /** Report completion timestamp. */
  readonly completedAt: string;
  /** Complete overall report statistics. */
  readonly summary: ReportSummary;
  /** Complete stable By Metric statistics. */
  readonly byMetric: readonly ReportMetricSummary[];
}

/** One normalized Assertion rendered without reinterpreting its outcome. */
export interface ReportMarkdownAssertion {
  /** Frozen Assertion component index. */
  readonly index: number;
  /** Promptfoo Assertion type. */
  readonly type: string;
  /** Stable Metric name. */
  readonly metric: string;
  /** Normalized component status. */
  readonly status: "PASS" | "FAIL" | "ERROR" | "SKIPPED";
  /** Normalized component score when present. */
  readonly score: number | null;
  /** Normalized component reason when present. */
  readonly reason: string | null;
}

/** One existing JSON Schema explanation fact rendered without recomputation. */
export interface ReportMarkdownDiff {
  /** Assertion component owning this Diff. */
  readonly assertionIndex: number;
  /** JSON instance path. */
  readonly instancePath: string;
  /** JSON Schema path. */
  readonly schemaPath: string;
  /** Validator keyword. */
  readonly keyword: string;
  /** Frozen expected constraint. */
  readonly expectedConstraint: DomainJsonValue;
  /** Frozen actual value or explicit Missing object. */
  readonly actual: DomainJsonValue;
  /** Existing safe explanation. */
  readonly reason: string;
}

/** One report Case projection for the one-way Markdown renderer. */
export interface ReportMarkdownCaseInput {
  /** Stable Suite-local Case key. */
  readonly caseKey: string;
  /** Frozen zero-based Case order. */
  readonly ordinal: number;
  /** Normalized Evaluation status. */
  readonly status: "PASS" | "FAIL" | "EVALUATION_ERROR" | "NOT_EVALUATED";
  /** Existing aggregate reason when present. */
  readonly reason: string | null;
  /** Stable Evaluation system-error code when present. */
  readonly evaluationErrorCode: string | null;
  /** Ordered normalized Assertion facts. */
  readonly assertions: readonly ReportMarkdownAssertion[];
  /** Ordered existing Diff facts. */
  readonly diffs: readonly ReportMarkdownDiff[];
}

// Normalize external text to one Markdown line before context-specific escaping.
function normalizeMarkdownInline(value: string): string {
  return value.replaceAll(/\r\n|\r|\n/g, " ");
}

// Escape Markdown controls and raw HTML in user-controlled non-code text.
function escapeMarkdown(value: string): string {
  const normalized = normalizeMarkdownInline(value);
  const markdownEscaped = normalized.replaceAll(/([\\`*_[\]{}()#$+!|~])/g, "\\$1");
  return markdownEscaped
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// Render external text as inline code with a delimiter absent from its body.
function inlineCode(value: string): string {
  const body = normalizeMarkdownInline(value);
  let delimiter = "`";
  while (body.includes(delimiter)) delimiter += "`";
  const needsPadding = body.startsWith("`") || body.endsWith("`");
  return `${delimiter}${needsPadding ? ` ${body} ` : body}${delimiter}`;
}

// Render an optional Rate without inventing zero for an empty denominator.
function rate(value: number | null): string {
  return value === null ? messages.EMPTY : `${(value * 100).toFixed(2)}%`;
}

// Render one JSON fact as safe inline code using a delimiter absent from its body.
function jsonCode(value: DomainJsonValue): string {
  const body = canonicalJson(value);
  let delimiter = "`";
  while (body.includes(delimiter)) delimiter += "`";
  return `${delimiter}${body}${delimiter}`;
}

// Render one scalar or absent value for a Markdown table cell.
function cell(value: string | number | null): string {
  return value === null ? messages.EMPTY : escapeMarkdown(String(value));
}

/** Render the complete bounded Markdown prefix before Case details stream. */
export function renderReportMarkdownHeader(input: ReportMarkdownHeaderInput): string {
  const ownerLabel = input.owner.kind === "RUN" ? messages.OWNER_RUN : messages.OWNER_EXECUTION;
  const summary = input.summary;
  const lines = [
    `# ${messages.TITLE}`,
    "",
    `- ${ownerLabel}: ${inlineCode(input.owner.id)}`,
    `- ${messages.COMPLETED_AT}: ${escapeMarkdown(input.completedAt)}`,
    "",
    `## ${messages.SUMMARY}`,
    "",
    `| ${messages.TOTAL} | ${messages.REST_SUCCEEDED} | ${messages.REST_ERROR} | ${messages.EVAL_PASS} | ${messages.EVAL_FAIL} | ${messages.EVAL_ERROR} | ${messages.NOT_EVALUATED} |`,
    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    `| ${summary.total} | ${summary.restSucceeded} | ${summary.restError} | ${summary.evalPass} | ${summary.evalFail} | ${summary.evalError} | ${summary.notEvaluated} |`,
    "",
    `- ${messages.EFFECTIVE_PASS_RATE}: ${rate(summary.effectivePassRate)}`,
    `- ${messages.EVALUATED_PASS_RATE}: ${rate(summary.evaluatedPassRate)}`,
    `- ${messages.COVERAGE_RATE}: ${rate(summary.coverageRate)}`,
    "",
    `## ${messages.BY_METRIC}`,
    "",
    `| ${messages.METRIC} | ${messages.PASS} | ${messages.FAIL} | ${messages.ERROR} | ${messages.SKIPPED} | ${messages.NOT_EVALUATED} | ${messages.PASS_RATE} |`,
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |"
  ];
  for (const metric of input.byMetric) {
    lines.push(
      `| ${escapeMarkdown(metric.metric)} | ${metric.pass} | ${metric.fail} | ${metric.error} | ${metric.skipped} | ${metric.notEvaluated} | ${rate(metric.passRate)} |`
    );
  }
  lines.push("", `## ${messages.FAILED_CASES}`, "");
  return `${lines.join("\n")}\n`;
}

/** Render one non-PASS Case from normalized facts without deriving new outcomes. */
export function renderReportMarkdownCase(input: ReportMarkdownCaseInput): string {
  if (input.status === "PASS") return "";
  const reason = input.evaluationErrorCode ?? input.reason;
  const lines = [
    `### ${messages.CASE} ${input.ordinal + 1}: ${escapeMarkdown(input.caseKey)}`,
    "",
    `- ${messages.STATUS}: ${input.status}`,
    `- ${messages.REASON}: ${cell(reason)}`,
    "",
    `#### ${messages.ASSERTIONS}`,
    "",
    `| ${messages.ASSERTION} | ${messages.TYPE} | ${messages.METRIC} | ${messages.STATUS} | ${messages.SCORE} | ${messages.REASON} |`,
    "| ---: | --- | --- | --- | ---: | --- |"
  ];
  for (const assertion of input.assertions) {
    lines.push(
      `| ${assertion.index} | ${escapeMarkdown(assertion.type)} | ${escapeMarkdown(assertion.metric)} | ${assertion.status} | ${cell(assertion.score)} | ${cell(assertion.reason)} |`
    );
  }
  if (input.diffs.length > 0) {
    lines.push("", `#### ${messages.DIFFS}`, "");
    for (const diff of input.diffs) {
      lines.push(
        `- ${messages.ASSERTION} ${diff.assertionIndex}; ${messages.INSTANCE_PATH}: ${inlineCode(diff.instancePath)}; ${messages.SCHEMA_PATH}: ${inlineCode(diff.schemaPath)}; ${messages.KEYWORD}: ${inlineCode(diff.keyword)}`,
        `  - ${messages.EXPECTED}: ${jsonCode(diff.expectedConstraint)}`,
        `  - ${messages.ACTUAL}: ${jsonCode(diff.actual)}`,
        `  - ${messages.REASON}: ${escapeMarkdown(diff.reason)}`
      );
    }
  }
  return `${lines.join("\n")}\n\n`;
}
