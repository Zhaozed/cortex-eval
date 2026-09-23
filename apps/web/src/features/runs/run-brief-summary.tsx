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
        row.evaluation?.semanticEvaluation?.planVersion === "cortex.brief-atomic-plan.v1"
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
    <section className="run-result-panel" aria-label="Brief 分类汇总">
      <h3>Brief 分类汇总</h3>
      <p>
        按已加载且含冻结定义的 Case 统计；命中率按原子条目累计，噪音抑制按已判定 Case
        平均。裁判异常单列，不当作内容零分。
      </p>
      <div className="brief-table-scroll">
        <table className="brief-checklist">
          <thead>
            <tr>
              <th>类型</th>
              <th>已判定 / 已加载</th>
              <th>裁判异常</th>
              <th>P0 命中</th>
              <th>P1 命中</th>
              <th>噪音抑制</th>
              <th>幻觉 Case</th>
              <th>容量不合规</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.type}>
                <td>{g.type}</td>
                <td>
                  {g.judged}/{g.total}
                </td>
                <td>{g.errors}</td>
                <td>{g.p0}</td>
                <td>{g.p1}</td>
                <td>{g.noise}</td>
                <td>{g.hallucinations}</td>
                <td>{g.structureFailures}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
