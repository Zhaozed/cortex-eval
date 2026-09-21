import type { ReactElement } from "react";
import type { DashboardCase } from "./run-dashboard-model.ts";
import { duration } from "./run-call-model.ts";
import { hasTrace } from "./run-evidence-model.ts";
import { executionIssue } from "./run-execution-issue.ts";
import { conversationRounds, outputDegraded } from "./run-output-model.ts";
import { CardEventNote, ReplyMessage } from "./run-case-output.tsx";

/** Round-pivoted result view: each executed turn pairs its input with its replies. */
export function RunCaseRounds({
  row,
  onTrace
}: {
  readonly row: DashboardCase;
  readonly onTrace: (target: string) => void;
}): ReactElement {
  const rounds = conversationRounds(row),
    issue = executionIssue(row),
    traceAvailable = hasTrace(row),
    degraded = outputDegraded(row) && rounds.some((round) => round.replies.length > 0);
  return (
    <section className="run-rounds-panel run-result-panel" aria-label="对话轮次">
      <div className="run-panel-heading">
        <h3>对话轮次</h3>
        <span>多轮 · {rounds.length} 轮</span>
      </div>
      {issue && (
        <p className="run-output-warning" role="alert">
          {issue}
        </p>
      )}
      {degraded && (
        <p className="run-output-warning">
          该 Case 未采集到 WebUI 用户视角与交付记录，以下回复来自上游生成/出站记录，可能不完整。
        </p>
      )}
      <ol className="run-rounds">
        {rounds.map((round) => (
          <li
            className="run-round"
            key={`round-${round.round}`}
            aria-label={`第 ${round.round} 轮`}
          >
            <div className="run-round-bar">
              <span className="run-round-badge">第 {round.round} 轮</span>
              {round.usage && (
                <span className="run-round-stats">
                  Agent {round.usage.total.toLocaleString()} Token
                  {round.usage.calls > 0 && ` · ${round.usage.calls} 次模型调用`}
                  {round.elapsedMs !== null && ` · ${duration(round.elapsedMs)}`}
                </span>
              )}
              <span className="run-round-spacer" />
              <button
                type="button"
                className="run-round-link"
                disabled={!traceAvailable}
                title={traceAvailable ? "查看该轮执行链路" : "未记录执行链路"}
                onClick={() => onTrace(`turn:${round.round}`)}
              >
                查看链路
              </button>
            </div>
            <div className="run-round-grid">
              <div className="run-round-side run-round-input">
                <h4>用户输入</h4>
                {round.input ? (
                  <p className="run-round-input-text">{round.input}</p>
                ) : (
                  <p className="run-muted">
                    {round.paired
                      ? "未记录该轮输入"
                      : "执行轮次与保存的对话未一一对应，无法配对输入"}
                  </p>
                )}
              </div>
              <div className="run-round-side run-round-output">
                <h4>Agent 输出</h4>
                {round.coverageNote && <p className="run-coverage-note">{round.coverageNote}</p>}
                {round.replies.length === 0 ? (
                  <p className="run-muted">该轮未记录可读回复，不代表 Agent 没有输出。</p>
                ) : (
                  <div className="run-round-replies">
                    {round.replies.map((reply) => (
                      <ReplyMessage heading={null} key={reply.key} reply={reply} />
                    ))}
                  </div>
                )}
                <CardEventNote cards={round.cards} />
              </div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
