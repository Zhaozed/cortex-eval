import type { ReactElement } from "react";
import type { DashboardCase } from "./run-dashboard-model.ts";

/** Type-specific denominators; evaluation errors and pending results never masquerade as quality zero. */
interface BriefSummary {
  type: "daily" | "meeting";
  total: number;
  judged: number;
  errors: number;
  p0: string;
  p1: string;
  noise: string;
  hallucinations: number;
  structureFailures: number;
}
export function summarizeBriefRows(rows: readonly DashboardCase[]): BriefSummary[] {
  return (["daily", "meeting"] as const)
    .map((type) => {
      const selected = rows.filter(
        (row) => row.definition?.semanticEvaluation?.brief?.briefType === type
      );
      const judged = selected.flatMap((row) =>
        row.evaluation?.semanticEvaluation?.planVersion.startsWith("cortex.brief") === true
          ? [row.evaluation.semanticEvaluation.result]
          : []
      );
      const atomic = (tier: "P0" | "P1"): string => {
        const decisions = judged.flatMap((result) =>
          result.decisions.filter((d) => d.questionId.startsWith(`brief.${tier}.`) && d.applicable)
        );
        return decisions.length === 0
          ? "—"
          : `${decisions.filter((d) => d.value === true).length}/${decisions.length}`;
      };
      const noise = judged.flatMap((result) =>
        result.decisions
          .filter((d) => d.questionId === "brief.metric.noise" && d.applicable)
          .map((d) => Number(d.value))
      );
      return {
        type,
        total: selected.length,
        judged: judged.length,
        errors: selected.filter((row) => row.evaluation?.status === "EVALUATION_ERROR").length,
        p0: atomic("P0"),
        p1: atomic("P1"),
        noise:
          noise.length === 0
            ? "—"
            : `${((noise.reduce((a, b) => a + b, 0) / noise.length) * 100).toFixed(1)}%`,
        hallucinations: judged.filter((result) =>
          result.decisions.some((d) => d.questionId === "brief.grounded" && d.value === false)
        ).length,
        structureFailures: judged.filter((result) =>
          result.decisions.some((d) => d.questionId === "brief.structure" && d.value === false)
        ).length
      };
    })
    .filter((group) => group.total > 0);
}

export function RunBriefSummary({
  rows,
  ready
}: {
  readonly rows: readonly DashboardCase[];
  readonly ready: boolean;
}): ReactElement | null {
  const groups = summarizeBriefRows(rows);
  if (!ready || groups.length === 0) return null;
  return (
    <section className="run-result-panel brief-summary" aria-label="Brief 分类汇总">
      <header className="brief-summary-heading">
        <div>
          <span className="brief-summary-eyebrow">质量概览</span>
          <h3>Brief 分类汇总</h3>
        </div>
        <p>按已加载且含冻结定义的 Case 统计；裁判异常单列，不计入内容命中率。</p>
      </header>
      <div className="brief-summary-groups">
        {groups.map((group) => {
          const coverage = group.total === 0 ? 0 : (group.judged / group.total) * 100;
          return (
            <article className="brief-summary-card" key={group.type}>
              <div className="brief-summary-card-heading">
                <span className="brief-summary-type">
                  {group.type === "daily" ? "Daily Brief" : "Pre-meeting Brief"}
                </span>
                <span className="brief-summary-case-count">{group.total} 个样本</span>
              </div>
              <div className="brief-summary-coverage">
                <strong>
                  {group.judged}
                  <span> / {group.total}</span>
                </strong>
                <span>已判定样本</span>
              </div>
              <div
                className="brief-summary-progress"
                aria-label={`判定覆盖率 ${coverage.toFixed(0)}%`}
              >
                <span style={{ width: `${coverage}%` }} />
              </div>
              <div className="brief-summary-metrics">
                <div className="brief-summary-metric">
                  <span>P0 命中</span>
                  <strong>{group.p0}</strong>
                  <small>原子条目命中 / 适用条目</small>
                </div>
                <div className="brief-summary-metric">
                  <span>P1 命中</span>
                  <strong>{group.p1}</strong>
                  <small>原子条目命中 / 适用条目</small>
                </div>
                <div className="brief-summary-metric">
                  <span>噪音抑制</span>
                  <strong>{group.noise}</strong>
                  <small>已判定样本平均</small>
                </div>
                <div className={`brief-summary-metric${group.errors > 0 ? " is-alert" : ""}`}>
                  <span>裁判异常</span>
                  <strong>{group.errors}</strong>
                  <small>不计入内容评分</small>
                </div>
                <div
                  className={`brief-summary-metric${group.hallucinations > 0 ? " is-alert" : ""}`}
                >
                  <span>幻觉 Case</span>
                  <strong>{group.hallucinations}</strong>
                  <small>未通过事实依据检查</small>
                </div>
                <div
                  className={`brief-summary-metric${group.structureFailures > 0 ? " is-alert" : ""}`}
                >
                  <span>容量不合规</span>
                  <strong>{group.structureFailures}</strong>
                  <small>未通过结构检查</small>
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
