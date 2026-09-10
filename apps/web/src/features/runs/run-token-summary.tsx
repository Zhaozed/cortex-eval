import type { ReactElement } from "react";
import { useState } from "react";
import type { DashboardCase } from "./run-dashboard-model.ts";
import { judgeUsage } from "./run-dashboard-model.ts";
import { agentUsage } from "./run-evidence-model.ts";

/** Compact factual usage: recorded consumption is useful even when the audit is incomplete. */
export function RunTokenSummary({
  rows,
  ready
}: {
  readonly rows: readonly DashboardCase[];
  readonly ready: boolean;
}): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const agent = agentUsage(rows),
    judge = judgeUsage(rows);
  const agentKnown = ready && agent.recorded > 0,
    judgeKnown = ready && judge.recorded > 0;
  const complete = ready && agent.complete && judge.recorded === judge.expected;
  const any = agentKnown || judgeKnown;
  const format = (n: number, known: boolean): string => (known ? n.toLocaleString() : "未采集");
  return (
    <section className="run-usage" aria-label="Token 汇总">
      <div className="run-usage-main">
        <span>Token 用量</span>
        <strong>
          {any
            ? ((agentKnown ? agent.total : 0) + (judgeKnown ? judge.total : 0)).toLocaleString()
            : "未采集"}
        </strong>
        {any && !complete && <span className="run-usage-note">已记录部分</span>}
      </div>
      <div className="run-usage-part">
        <span>Agent</span>
        <strong>{format(agent.total, agentKnown)}</strong>
      </div>
      <div className="run-usage-part">
        <span>评测模型</span>
        <strong>{format(judge.total, judgeKnown)}</strong>
      </div>
      <button
        className="run-usage-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? "收起明细" : "用量明细"} {expanded ? "⌃" : "⌄"}
      </button>
      {expanded && (
        <div className="run-usage-details">
          <table>
            <thead>
              <tr>
                <th>来源</th>
                <th>输入</th>
                <th>输出</th>
                <th>合计</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Agent</td>
                <td>{format(agent.input, agentKnown)}</td>
                <td>{format(agent.output, agentKnown)}</td>
                <td>{format(agent.total, agentKnown)}</td>
              </tr>
              <tr>
                <td>评测模型</td>
                <td>{format(judge.input, judgeKnown)}</td>
                <td>{format(judge.output, judgeKnown)}</td>
                <td>{format(judge.total, judgeKnown)}</td>
              </tr>
            </tbody>
          </table>
          <p>
            当前结果所关联的执行与评测用量。{!complete && "部分调用未完整采集。"}
            {judge.reused > 0 && "复用的评测用量不重复统计。"}{" "}
            {rows.some((row) => "provenance" in row.rest && row.rest.provenance !== null) &&
              "Agent 包含复用执行记录，并非本次新增消耗。"}
            缓存不额外累加。
          </p>
        </div>
      )}
    </section>
  );
}
