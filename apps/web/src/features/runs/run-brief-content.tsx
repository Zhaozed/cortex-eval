import type { ReactElement } from "react";
import { BriefReplayOutputSchema } from "@cortex-eval/contracts/src/brief-evaluation-contracts.ts";
import type { DashboardCase } from "./run-dashboard-model.ts";
import { EvidenceJson } from "./run-trace-panel.tsx";
import { payload } from "./run-evidence-model.ts";

type Semantic = NonNullable<NonNullable<DashboardCase["evaluation"]>["semanticEvaluation"]>;

/** Replay artifacts are generated content, not delivered messages or rendered card events. */
export function RunBriefContent({
  row,
  mode = "all"
}: {
  readonly row: DashboardCase;
  readonly mode?: "messages" | "cards" | "all";
}): ReactElement | null {
  const result = BriefReplayOutputSchema.safeParse(payload(row));
  if (!result.success) return null;
  const brief = result.data;
  return (
    <section className="run-result-panel" aria-label="Brief 生成内容">
      {mode !== "cards" && (
        <>
          <h3>{brief.brief_type === "daily" ? "Daily" : "Meeting"} Brief · 生成内容</h3>
          <p>
            状态：{brief.generation_status} · 展示：{brief.presentation_status} · LLM：
            {brief.llm_called ? "已调用" : "未调用"} · 未向用户交付
          </p>
          <p className="run-message-text">{brief.output.text || "（空文本）"}</p>
        </>
      )}
      {mode !== "messages" && (
        <>
          <h4>最终卡片（{brief.output.cards.length}）</h4>
          {brief.output.cards.map((card, index) => (
            <details key={index} open>
              <summary>卡片 {index + 1} · 结构化内容（非端侧渲染）</summary>
              <EvidenceJson value={card} />
            </details>
          ))}
        </>
      )}
      {mode !== "cards" && (
        <p className="run-muted">
          评分只针对以上最终内容；model_input / model_result 留在原始响应中用于定位裁剪或生成问题。
        </p>
      )}
    </section>
  );
}

/** Show atomic pass/fail separately from deterministic ratios and gating failures. */
export function RunBriefEvaluation({ semantic }: { readonly semantic: Semantic }): ReactElement {
  const result = semantic.result;
  const metrics = result.decisions.filter((d) => d.questionId.startsWith("brief.metric."));
  const checks = result.decisions.filter((d) => !d.questionId.startsWith("brief.metric."));
  return (
    <section className="run-result-panel" aria-label="Brief 原子评测">
      <h3>
        Brief 原子评测 · {(result.score * 100).toFixed(1)} 分 · {result.passed ? "通过" : "未通过"}
      </h3>
      <p>
        {semantic.model} · {semantic.planVersion}
      </p>
      <div className="run-jev-summary-grid">
        {metrics.map((d) => (
          <div key={d.questionId}>
            <span>
              {d.questionId.endsWith("noise")
                ? "噪音抑制"
                : `${d.questionId.split(".").at(-1) ?? ""} 命中率`}
            </span>
            <strong>{!d.applicable ? "不适用" : `${(Number(d.value) * 100).toFixed(1)}%`}</strong>
          </div>
        ))}
      </div>
      {result.blockingFailures.length > 0 && (
        <ul role="alert">
          {result.blockingFailures.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
      <div className="brief-table-scroll">
        <table className="brief-checklist">
          <thead>
            <tr>
              <th>断言 / 规则</th>
              <th>结果</th>
              <th>裁判理由与输出证据</th>
              <th>来源引用</th>
            </tr>
          </thead>
          <tbody>
            {checks.map((d) => (
              <tr key={d.questionId}>
                <td>
                  <code>{d.questionId}</code>
                  <p>{d.platformReason}</p>
                </td>
                <td>{d.value === true ? "通过" : "未通过"}</td>
                <td>
                  <p>{d.reason}</p>
                  {d.evidence.map((quote, i) => (
                    <blockquote key={i}>{quote}</blockquote>
                  ))}
                </td>
                <td>
                  {d.evidenceRefs.map((ref) => (
                    <p key={ref}>
                      <code>{ref}</code>
                    </p>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {result.warnings.map((warning) => (
        <p key={warning}>{warning}</p>
      ))}
      <details>
        <summary>完整裁判记录</summary>
        <EvidenceJson value={semantic} />
      </details>
    </section>
  );
}
