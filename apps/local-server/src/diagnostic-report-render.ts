import {
  DIAGNOSTIC_FAULT_DOMAIN_LABELS,
  DIAGNOSTIC_STATUS_LABELS,
  type DiagnosticReport
} from "@cortex-eval/contracts/src/diagnostic-report-contracts.ts";
import { diagnosticCaseScenario } from "./diagnostic-report-case-scene.ts";
const escape = (s: string): string =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
const md = (s: string): string =>
  escape(s)
    .replaceAll(/([\\`*_[\]{}()#+!|~])/g, "\\$1")
    .replaceAll(/\r?\n/g, " ");
const rate = (v: number | null): string => (v === null ? "不适用" : `${(v * 100).toFixed(2)}%`);

/** Deterministic report outline shared by Markdown and the standalone printable document. */
function reportMarkdownSource(report: DiagnosticReport): string {
  const s = report.snapshot;
  const lines = [
    `# ${md(s?.title ?? "评测运行")}｜归因报告`,
    "",
    `> AI 辅助诊断草稿 · ${DIAGNOSTIC_STATUS_LABELS[report.status]} · v${report.version} · 请核验证据后交付`,
    "",
    `- 生成时间：${report.createdAt}（ISO 8601 UTC）`,
    `- 模型：${md(report.model.name)} / ${md(report.model.model)}`,
    `- 归因进度：${report.completedCases}/${report.totalCases}`,
    ...(report.error ? [`- 生成说明：${md(report.error)}`] : []),
    ""
  ];
  if (!s) return [...lines, "评测事实尚未整理完成。", ""].join("\n");
  if (s.narrative !== null) {
    lines.push(
      "## 正文",
      "",
      "<!--NARRATIVE-->",
      s.narrative.trim(),
      "<!--/NARRATIVE-->",
      "",
      "## 限制与未覆盖项",
      "",
      ...s.limitations.map((x) => `- ${md(x)}`),
      "",
      "> 本报告仅基于本次运行已冻结的事实；逐项断言、证据与 Hash 明细可回到评测系统核验。",
      ""
    );
    return `${lines.join("\n")}\n`;
  }
  const count = s.cases.filter((c) => c.diagnosis !== null).length;
  const attributionCounts = new Map<string, number>();
  for (const c of s.cases) {
    const domain = c.diagnosis?.attribution.domain;
    if (domain) attributionCounts.set(domain, (attributionCounts.get(domain) ?? 0) + 1);
  }
  lines.push(
    "## 1. 结论与范围",
    "",
    `本次 ${s.summary.total} 个 Case，自动通过 ${s.summary.evalPass}，未通过 ${s.summary.evalFail}，评测异常 ${s.summary.evalError}，未评测 ${s.summary.notEvaluated}。`,
    `共 ${s.cases.length} 个待关注 Case（包括 PASS 中的非通过断言），完成诊断 ${count} 个。`,
    "本结论仅适用于本次运行，不代表发布验收；AI 原因解释不改变原始判定。",
    "",
    `- 测试集：${md(s.suiteName)}`,
    `- 测试时间：${s.startedAt ?? "未记录"} — ${s.completedAt ?? "未记录"}（ISO 8601 UTC）`,
    "",
    "## 2. 结果概览",
    "",
    "| Case 总数 | 自动通过 | 未通过 | 评测异常 | 未评测 | 执行异常（独立维度） |",
    "| ---: | ---: | ---: | ---: | ---: | ---: |",
    `| ${s.summary.total} | ${s.summary.evalPass} | ${s.summary.evalFail} | ${s.summary.evalError} | ${s.summary.notEvaluated} | ${s.summary.restError} |`,
    "",
    `- 有效通过率（PASS / 全部）：${rate(s.summary.effectivePassRate)}`,
    `- 已评测通过率（PASS / PASS+FAIL）：${rate(s.summary.evaluatedPassRate)}`,
    `- 覆盖率（PASS+FAIL / 全部）：${rate(s.summary.coverageRate)}`,
    "",
    "### 2.1 归因责任域分布",
    "",
    "| 责任域 | 待关注 Case 数 |",
    "| --- | ---: |",
    ...[...attributionCounts.entries()].map(
      ([domain, value]) =>
        `| ${DIAGNOSTIC_FAULT_DOMAIN_LABELS[domain as keyof typeof DIAGNOSTIC_FAULT_DOMAIN_LABELS]} | ${value} |`
    ),
    ...(attributionCounts.size === 0 ? ["| 尚无完成归因 | 0 |"] : []),
    "",
    "## 3. 待关注项",
    "",
    "每项一行，只说明涉及的业务现象与归因结论；完整断言、证据与 Hash 明细请回到评测系统查看。",
    ""
  );
  if (!s.cases.length) lines.push("本次没有待归因项；未调用模型，也不据此推断未覆盖场景正常。");
  for (const c of s.cases) {
    const { scene, taskType, userInput } = diagnosticCaseScenario(c);
    const name = scene !== c.caseKey ? `${md(c.caseKey)} ${md(scene)}` : md(c.caseKey);
    const kind = taskType ? `（任务类型：${md(taskType)}）` : "";
    const input = userInput ? `，用户原话：${md(userInput)}` : "";
    lines.push(
      `- ${name}${kind}（${c.status}${input}）：${
        c.diagnosis
          ? md(c.diagnosis.title)
          : `归因未完成：${md(c.diagnosisError ?? "待生成或已取消")}`
      }`
    );
  }
  lines.push("", "## 4. 未覆盖项与限制", "", ...s.limitations.map((x) => `- ${md(x)}`), "");
  return `${lines.join("\n")}\n`;
}

/** Exported Markdown is the human-readable body: internal narrative markers stay internal. */
export function diagnosticReportMarkdown(report: DiagnosticReport): string {
  return reportMarkdownSource(report)
    .split("\n")
    .filter((line) => line !== "<!--NARRATIVE-->" && line !== "<!--/NARRATIVE-->")
    .join("\n");
}

/** Safe no-script HTML; Markdown is rendered with a tiny closed grammar, not trusted raw HTML.
 *  Human-readable narrative (model output) is treated as untrusted: every inline fragment is
 *  HTML-escaped before formatting, and only a closed set of Markdown constructs is interpreted. */
function renderNarrativeHtml(markdown: string): string {
  const lines = markdown.split("\n");
  const body: string[] = [];
  const inlineRaw = (v: string): string =>
    escape(v)
      .replaceAll(/\\([\\`*_[\]{}()#+!|~])/g, "$1")
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  let fence: string | null = null;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li] ?? "";
    if (fence !== null) {
      if (line.trim() === fence) {
        body.push("</pre>");
        fence = null;
      } else body.push(escape(line) + "\n");
      continue;
    }
    if (/^`{3,}\s*$/.test(line)) {
      fence = line.trim();
      body.push("<pre>");
      continue;
    }
    if (line.startsWith(">")) {
      const buf = [line.slice(1).trim()];
      while (li + 1 < lines.length && lines[li + 1]!.startsWith(">"))
        buf.push((lines[++li] ?? "").slice(1).trim());
      body.push(`<blockquote><p>${inlineRaw(buf.join(" "))}</p></blockquote>`);
      continue;
    }
    if (/^[-*] /.test(line)) {
      const buf = [line.slice(2).trim()];
      while (li + 1 < lines.length && /^[-*] /.test(lines[li + 1]!))
        buf.push((lines[++li] ?? "").slice(2).trim());
      body.push(`<ol>${buf.map((x) => `<li>${inlineRaw(x)}</li>`).join("")}</ol>`);
      continue;
    }
    if (/^#{1,4} /.test(line)) {
      const level = line.indexOf(" ");
      body.push(`<h${level}>${inlineRaw(line.slice(level + 1))}</h${level}>`);
      continue;
    }
    if (!line.trim()) continue;
    const buf = [line];
    while (
      li + 1 < lines.length &&
      lines[li + 1]!.trim() !== "" &&
      !lines[li + 1]!.startsWith(">") &&
      !/^[-*] /.test(lines[li + 1]!) &&
      !/^`{3,}/.test(lines[li + 1]!)
    )
      buf.push(lines[++li] ?? "");
    body.push(`<p>${inlineRaw(buf.join(" "))}</p>`);
  }
  return `<section class="narrative">${body.join("\n")}</section>`;
}

export function diagnosticReportHtml(report: DiagnosticReport): string {
  const source = reportMarkdownSource(report);
  const lines = source.split("\n");
  let fence: string | null = null;
  let table = false;
  const body: string[] = [];
  const inline = (v: string): string =>
    v
      .replaceAll(/\\([\\`*_[\]{}()#+!|~])/g, "$1")
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line === "<!--NARRATIVE-->") {
      const inner: string[] = [];
      while (i + 1 < lines.length && lines[i + 1] !== "<!--/NARRATIVE-->")
        inner.push(lines[++i] ?? "");
      ++i; // skip closing marker
      body.push(renderNarrativeHtml(inner.join("\n")));
      continue;
    }
    if (fence !== null) {
      if (line === fence) {
        body.push("</pre>");
        fence = null;
      } else body.push(escape(line) + "\n");
      continue;
    }
    if (/^`{3,}(?:text)?\s*$/.test(line)) {
      fence = line.replace(/text\s*$/i, "").trim();
      body.push("<pre>");
      continue;
    }
    const isTable = line.startsWith("| ");
    if (!isTable && table) {
      body.push("</tbody></table></div>");
      table = false;
    }
    if (isTable) {
      if (/^\|[\s:|-]+\|$/.test(line)) continue;
      if (!table) {
        body.push('<div class="table"><table><tbody>');
        table = true;
      }
      body.push(
        `<tr>${line
          .slice(1, -1)
          .split(/(?<!\\)\|/)
          .map((x) => `<td>${inline(x.trim())}</td>`)
          .join("")}</tr>`
      );
    } else if (/^#{1,4} /.test(line)) {
      const level = line.indexOf(" ");
      body.push(`<h${level}>${inline(line.slice(level + 1))}</h${level}>`);
    } else if (line) body.push(`<p>${inline(line)}</p>`);
  }
  if (table) body.push("</tbody></table></div>");
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>归因报告 v${report.version}</title><style>body{font:15px/1.7 system-ui,sans-serif;color:#202522;max-width:1000px;margin:36px auto;padding:0 28px}h1{font-size:28px}h2{border-bottom:1px solid #ccc;padding-top:24px}h3{font-size:20px}p,blockquote{margin:8px 0}blockquote{border-left:3px solid #bbb;padding-left:12px;color:#444}ol,ul{padding-left:24px}table{border-collapse:collapse;width:100%}td{border:1px solid #ccc;padding:8px;vertical-align:top}tr:first-child{background:#f1f3f1;font-weight:600}pre{font:12px/1.6 monospace;white-space:pre-wrap;overflow-wrap:anywhere;background:#f6f7f6;padding:12px}p,td{overflow-wrap:anywhere}.table{overflow:auto}@media print{body{margin:0;max-width:none;font-size:10pt}h2,h3,h4{break-after:avoid}pre{font-size:8pt}.table{overflow:visible}@page{margin:16mm}}</style><body><p>可使用浏览器「打印」保存为 PDF。本文件可离线阅读；不包含外部资源。</p>${body.join("\n")}</body></html>`;
}
