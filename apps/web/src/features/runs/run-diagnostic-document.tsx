import { createElement, type ReactElement, type ReactNode } from "react";
import {
  DIAGNOSTIC_EVIDENCE_LABELS,
  DIAGNOSTIC_FAULT_DOMAIN_LABELS,
  DIAGNOSTIC_FAULT_LOCATION_LABELS,
  DIAGNOSTIC_CONFIDENCE_LABELS,
  type DiagnosticReport
} from "@cortex-eval/contracts/src/diagnostic-report-contracts.ts";
import { parseAssertionMetric } from "../../lib/assertion-metric.ts";

const rate = (v: number | null): string => (v === null ? "不适用" : `${(v * 100).toFixed(1)}%`);
const category = {
  PRODUCT: "产品行为",
  ASSERTION: "规则 / 标注",
  ENVIRONMENT: "环境 / 执行",
  UNKNOWN: "待定位"
};

/** Parse the model-authored narrative (untrusted) with a closed grammar; React escapes all text. */
function NarrativeMarkdown({ markdown }: { markdown: string }): ReactElement {
  const lines = markdown.split(/\r?\n/);
  const nodes: ReactNode[] = [];
  let key = 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (/^`{3,}\s*$/.test(line)) {
      const fence = line.trim();
      const buf: string[] = [];
      while (i + 1 < lines.length && (lines[i + 1] ?? "").trim() !== fence)
        buf.push(lines[++i] ?? "");
      if (i + 1 < lines.length) i += 1;
      nodes.push(
        <pre className="diagnostic-pre" key={key++}>
          {buf.join("\n")}
        </pre>
      );
      i += 1;
      continue;
    }
    if (line.startsWith(">")) {
      const buf: string[] = [line.slice(1).trim()];
      while (i + 1 < lines.length && (lines[i + 1] ?? "").startsWith(">"))
        buf.push((lines[++i] ?? "").slice(1).trim());
      nodes.push(<blockquote key={key++}>{<p>{escapeInline(buf.join(" "))}</p>}</blockquote>);
      i += 1;
      continue;
    }
    if (/^[-*] /.test(line)) {
      const buf: string[] = [line.slice(2).trim()];
      while (i + 1 < lines.length && /^[-*] /.test(lines[i + 1] ?? ""))
        buf.push((lines[++i] ?? "").slice(2).trim());
      nodes.push(
        <ul key={key++}>
          {buf.map((item, j) => (
            <li key={j}>{escapeInline(item)}</li>
          ))}
        </ul>
      );
      i += 1;
      continue;
    }
    if (/^#{1,4} /.test(line)) {
      const level = line.indexOf(" ");
      nodes.push(
        createElement(`h${level}`, { key: key++ }, ...escapeInline(line.slice(level + 1)))
      );
      i += 1;
      continue;
    }
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const buf: string[] = [line];
    while (
      i + 1 < lines.length &&
      (lines[i + 1] ?? "").trim() !== "" &&
      !(lines[i + 1] ?? "").startsWith(">") &&
      !/^[-*] /.test(lines[i + 1] ?? "") &&
      !/^`{3,}/.test(lines[i + 1] ?? "")
    )
      buf.push(lines[++i] ?? "");
    nodes.push(<p key={key++}>{escapeInline(buf.join(" "))}</p>);
    i += 1;
  }
  return <>{nodes}</>;
}

function escapeInline(text: string): ReactNode[] {
  return text
    .split(/\*\*([^*\n]+)\*\*/g)
    .map((part, i) => (i % 2 === 1 ? <strong key={i}>{part}</strong> : part));
}

/** Render typed facts, never model-supplied HTML/Markdown. */
export function RunDiagnosticDocument({ report }: { report: DiagnosticReport }): ReactElement {
  const s = report.snapshot;
  if (!s) return <p className="run-muted">正在整理冻结评测事实，尚无可预览内容。</p>;
  const diagnosed = s.cases.filter((c) => c.diagnosis).length;
  const hard = s.cases
    .flatMap((c) => c.assertions)
    .filter((a) => a.status === "FAIL" && parseAssertionMetric(a.metric).tier === "HARD").length;
  const soft = s.cases
    .flatMap((c) => c.assertions)
    .filter((a) => a.status === "FAIL" && parseAssertionMetric(a.metric).tier === "SOFT").length;
  const attributionCounts = new Map<string, number>();
  for (const item of s.cases) {
    const domain = item.diagnosis?.attribution.domain;
    if (domain) attributionCounts.set(domain, (attributionCounts.get(domain) ?? 0) + 1);
  }
  const narrative = s.narrative ?? null;
  const narrativeError = s.narrativeError ?? null;
  const perCaseSections = (
    <>
      <section>
        <h3>03 · 问题总表</h3>
        <p className="run-muted">每个待关注 Case 一行；同类失败不代表相同根因。</p>
        {s.cases.length > 0 ? (
          <div className="diagnostic-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Case / 原始判定</th>
                  <th>问题摘要</th>
                  <th>非通过断言</th>
                  <th>责任域</th>
                  <th>首查位置</th>
                  <th>归因状态</th>
                </tr>
              </thead>
              <tbody>
                {s.cases.map((c) => (
                  <tr key={c.caseKey}>
                    <td>
                      <a href={`#diagnostic-case-${c.ordinal}`}>{c.caseKey}</a>
                      <small>{c.status}</small>
                    </td>
                    <td>{c.diagnosis?.title ?? c.reason ?? "待关注"}</td>
                    <td>{c.assertions.length}</td>
                    <td>
                      {c.diagnosis
                        ? DIAGNOSTIC_FAULT_DOMAIN_LABELS[c.diagnosis.attribution.domain]
                        : "—"}
                    </td>
                    <td>
                      {c.diagnosis
                        ? DIAGNOSTIC_FAULT_LOCATION_LABELS[c.diagnosis.attribution.location]
                        : "—"}
                    </td>
                    <td>
                      {c.diagnosis
                        ? DIAGNOSTIC_EVIDENCE_LABELS[c.diagnosis.evidenceStatus]
                        : c.diagnosisError
                          ? "归因失败"
                          : "待分析"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p>没有待关注项。</p>
        )}
      </section>
      <section>
        <h3>04 · 问题详情与归因</h3>
        {s.cases.map((c) => (
          <section className="diagnostic-issue" key={c.caseKey} id={`diagnostic-case-${c.ordinal}`}>
            <div className="diagnostic-issue-heading">
              <h4>
                {c.caseKey} · {c.diagnosis?.title ?? "失败与异常事实"}
              </h4>
              <a
                href={`${window.location.pathname}?case=${encodeURIComponent(c.caseKey)}&tab=trace`}
                target="_blank"
                rel="noreferrer"
              >
                查看原 Case ↗
              </a>
            </div>
            <p>
              自动判定：<strong>{c.status}</strong> · 执行状态：{c.restStatus}
            </p>
            <p>判定原因：{c.reason ?? "未提供"}</p>
            <ul className="diagnostic-assertions">
              {c.assertions.map((a) => (
                <li key={a.index}>
                  <strong>
                    {parseAssertionMetric(a.metric).tierLabel} · {a.metric} · {a.status}
                  </strong>
                  <p>{a.reason ?? "规则未提供结构化解释"}</p>
                </li>
              ))}
            </ul>
            {c.diagnosis ? (
              <>
                <p className="diagnostic-evidence-status">
                  {category[c.diagnosis.category]} ·{" "}
                  {DIAGNOSTIC_EVIDENCE_LABELS[c.diagnosis.evidenceStatus]}
                </p>
                <div className="diagnostic-attribution" aria-label="具体归因定位">
                  <div>
                    <span>责任域</span>
                    <strong>
                      {DIAGNOSTIC_FAULT_DOMAIN_LABELS[c.diagnosis.attribution.domain]}
                    </strong>
                  </div>
                  <div>
                    <span>建议首查</span>
                    <strong>
                      {DIAGNOSTIC_FAULT_LOCATION_LABELS[c.diagnosis.attribution.location]}
                    </strong>
                  </div>
                  <div>
                    <span>定位信心</span>
                    <strong>
                      {DIAGNOSTIC_CONFIDENCE_LABELS[c.diagnosis.attribution.confidence]}
                    </strong>
                  </div>
                  <p>
                    <b>定位依据：</b>
                    {c.diagnosis.attribution.rationale}
                  </p>
                </div>
                <dl className="diagnostic-findings">
                  <dt>观测现象</dt>
                  <dd>{c.diagnosis.observation}</dd>
                  <dt>候选原因</dt>
                  <dd>{c.diagnosis.cause}</dd>
                </dl>
                <p>
                  证据引用：
                  {c.diagnosis.evidenceIds.length
                    ? c.diagnosis.evidenceIds.map((id) => (
                        <a
                          className="diagnostic-citation"
                          key={id}
                          href={`#diagnostic-evidence-${id}`}
                          onClick={() => {
                            const node = document.getElementById(`diagnostic-evidence-${id}`);
                            if (node instanceof HTMLDetailsElement) node.open = true;
                          }}
                        >
                          {id}
                        </a>
                      ))
                    : "无"}
                </p>
                {c.diagnosis.alternatives.length > 0 && (
                  <>
                    <h5>替代解释 / 待排除项</h5>
                    <ul>
                      {c.diagnosis.alternatives.map((x, i) => (
                        <li key={i}>{x}</li>
                      ))}
                    </ul>
                  </>
                )}
                <div className="diagnostic-next-steps">
                  <div>
                    <h5>建议修复</h5>
                    <ol>
                      {c.diagnosis.recommendations.map((x, i) => (
                        <li key={i}>{x}</li>
                      ))}
                    </ol>
                  </div>
                  <div>
                    <h5>回归验证</h5>
                    <ol>
                      {c.diagnosis.verification.map((x, i) => (
                        <li key={i}>{x}</li>
                      ))}
                    </ol>
                  </div>
                </div>
              </>
            ) : (
              <p role={c.diagnosisError ? "alert" : "status"}>
                {c.diagnosisError ?? "等待归因；已有事实不受影响。"}
              </p>
            )}
            <h5>冻结证据摘录</h5>
            {c.evidence.map((e) => (
              <details
                className="diagnostic-evidence"
                id={`diagnostic-evidence-${e.id}`}
                key={e.id}
              >
                <summary>
                  {e.id} · {e.label}
                  {e.truncated ? "（已截断）" : ""}
                </summary>
                <pre>{e.content}</pre>
              </details>
            ))}
          </section>
        ))}
      </section>
    </>
  );
  return (
    <article className="diagnostic-document" aria-label="归因报告正文">
      <header className="diagnostic-document-heading">
        <p className="diagnostic-eyebrow">EVALUATION REPORT · v{report.version}</p>
        <h2>{s.title}</h2>
        <p>AI 归因报告 · 待人工核验</p>
        <dl className="diagnostic-metadata">
          <div>
            <dt>测试集</dt>
            <dd>{s.suiteName}</dd>
          </div>
          <div>
            <dt>分析模型</dt>
            <dd>
              {report.model.name} / {report.model.model}
            </dd>
          </div>
          <div>
            <dt>测试时间（UTC）</dt>
            <dd>
              {s.startedAt ?? "未记录"} — {s.completedAt ?? "未记录"}
            </dd>
          </div>
          <div>
            <dt>Agent 版本</dt>
            <dd>{s.agentRevision}</dd>
          </div>
        </dl>
      </header>
      {narrativeError ? (
        <p className="diagnostic-notice" role="alert">
          人话版正文生成失败，以下展示逐项归因与事实明细：{narrativeError}
        </p>
      ) : null}
      <section>
        <h3>01 · 结论与范围</h3>
        <p>
          本次 {s.summary.total} 个 Case，自动通过 {s.summary.evalPass} 个，未通过{" "}
          {s.summary.evalFail} 个，评测异常 {s.summary.evalError} 个，未评测{" "}
          {s.summary.notEvaluated} 个。
        </p>
        <p>
          共 {s.cases.length} 个待关注 Case，已完成 {diagnosed} 个诊断。
          {s.cases.length === 0
            ? "本次没有待归因项，未调用模型。"
            : "下文保留全部非通过断言，包括 PASS Case 中的质量告警。"}
        </p>
        <div className="diagnostic-notice">
          这是本次样本的评测结论，不是发布验收结论。AI 解释不会更改原始 PASS / FAIL。
        </div>
      </section>
      <section>
        <h3>02 · 结果概览</h3>
        <div className="diagnostic-stats">
          <div>
            <span>有效通过率</span>
            <strong>{rate(s.summary.effectivePassRate)}</strong>
            <small>PASS / 全部 Case</small>
          </div>
          <div>
            <span>评测覆盖率</span>
            <strong>{rate(s.summary.coverageRate)}</strong>
            <small>(PASS + FAIL) / 全部</small>
          </div>
          <div>
            <span>硬性失败断言</span>
            <strong>{hard}</strong>
            <small>按规则标记统计，不等于 Case 数</small>
          </div>
          <div>
            <span>质量失败断言</span>
            <strong>{soft}</strong>
            <small>不自动升级为 Case 失败</small>
          </div>
        </div>
        <p className="run-muted">
          已评测通过率 {rate(s.summary.evaluatedPassRate)} · 执行异常 {s.summary.restError}
          （独立维度，不与评测异常相加）
        </p>
        <div className="diagnostic-attribution-summary">
          <h4>归因责任域分布</h4>
          {attributionCounts.size ? (
            [...attributionCounts.entries()].map(([domain, count]) => (
              <span key={domain}>
                {
                  DIAGNOSTIC_FAULT_DOMAIN_LABELS[
                    domain as keyof typeof DIAGNOSTIC_FAULT_DOMAIN_LABELS
                  ]
                }{" "}
                · {count} 个
              </span>
            ))
          ) : (
            <span>尚无完成归因</span>
          )}
        </div>
      </section>
      {narrative ? (
        <section className="diagnostic-narrative">
          <h3>正文 · 问题归因</h3>
          <NarrativeMarkdown markdown={narrative} />
        </section>
      ) : null}
      {narrative ? (
        <details className="diagnostic-appendix">
          <summary>附录 · 逐项归因与证据（核验用，含断言原句与 Hash）</summary>
          {perCaseSections}
        </details>
      ) : (
        perCaseSections
      )}
      <section>
        <h3>05 · 未覆盖项与限制</h3>
        <ul>
          {s.limitations.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      </section>
      <details className="diagnostic-evidence">
        <summary>06 · 全量 Case 索引与版本信息</summary>
        <ul>
          {s.caseIndex.map((c) => (
            <li key={c.caseKey}>
              {c.caseKey} — {c.status}
            </li>
          ))}
        </ul>
        <p>Run：{report.runId}</p>
        <p>报告：{report.id}</p>
        <p>事实 Hash：{s.reportHash}</p>
        <p>模型配置 Hash：{report.model.configHash}</p>
        <p>提示词版本：{report.promptVersion}</p>
      </details>
    </article>
  );
}
