import type { ReactElement } from "react";
import type { DashboardCase } from "./run-dashboard-model.ts";
import { duration } from "./run-call-model.ts";
import { Button } from "../../components/ui/button.tsx";

/** Agent per-call evidence lives in Trace; Judge belongs to the evaluation. */
export function RunCaseUsage({
  row,
  onTrace
}: {
  readonly row: DashboardCase;
  readonly onTrace: (target: string) => void;
}): ReactElement {
  const evaluation = row.evaluation;
  const num = (v: number | null | undefined): string => (v == null ? "未采集" : v.toLocaleString());
  return (
    <details className="run-usage-detail">
      <summary>
        <strong>评测用量 · Judge</strong>
        <span>
          {num(evaluation?.tokenUsage?.totalTokens)} Token · {duration(evaluation?.latencyMs)}
        </span>
      </summary>
      <div className="run-usage-content">
        <div className="run-usage-table-wrap">
          <table className="run-usage-table">
            <caption>Judge 评测{evaluation?.provenance ? " · 历史复用记录" : ""}</caption>
            <thead>
              <tr>
                <th>记录范围</th>
                <th>耗时</th>
                <th>输入</th>
                <th>输出</th>
                <th>总 Token</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>本 Case 评测汇总</td>
                <td>{duration(evaluation?.latencyMs)}</td>
                <td>{num(evaluation?.tokenUsage?.inputTokens)}</td>
                <td>{num(evaluation?.tokenUsage?.outputTokens)}</td>
                <td>{num(evaluation?.tokenUsage?.totalTokens)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <p className="run-muted">Judge 按本 Case 已采集的评测记录汇总，暂无逐 Rubric 用量。</p>
        <Button size="sm" variant="link" onClick={() => onTrace("case-trace-usage")}>
          查看 Agent 逐模型耗时与 Token → 执行链路
        </Button>
      </div>
    </details>
  );
}
