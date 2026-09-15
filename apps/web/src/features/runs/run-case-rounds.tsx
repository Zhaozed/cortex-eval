import type { ReactElement } from "react";
import type { DashboardCase } from "./run-dashboard-model.ts";
import { duration } from "./run-call-model.ts";
import { hasTrace, records } from "./run-evidence-model.ts";
import { executionIssue } from "./run-execution-issue.ts";
import { conversationRounds, hasCardData } from "./run-output-model.ts";
import { EvidenceJson } from "./run-trace-panel.tsx";

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
    hasUnconfirmed = rounds.some((round) =>
      round.replies.some((reply) => reply.source !== "DELIVERED")
    );
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
      {hasUnconfirmed && (
        <p className="run-output-warning">
          部分回复仅见于生成记录，未找到对应交付证据；不代表用户已收到。
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
                      <article
                        className="run-output-message"
                        key={reply.key}
                        data-source={reply.source}
                      >
                        {reply.text && <p className="run-message-text">{reply.text}</p>}
                        {hasCardData(reply.data) && (
                          <p className="run-card-marker">含 A2UI 卡片数据 · 动态卡片见下方</p>
                        )}
                        {records(reply.data.links).length > 0 && (
                          <details>
                            <summary>关联附件 / 卡片记录</summary>
                            <EvidenceJson value={reply.data.links} />
                          </details>
                        )}
                      </article>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
