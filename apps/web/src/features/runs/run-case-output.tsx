import { RunLiveCard } from "./run-live-card.tsx";
import { useState, type ReactElement } from "react";
import type { RunReview } from "@cortex-eval/contracts/src/run-review-contracts.ts";
import type { DashboardCase } from "./run-dashboard-model.ts";
import { object, payload, records } from "./run-evidence-model.ts";
import { hasCardData, observedReplies, visualReviewRequired } from "./run-output-model.ts";
import { ReviewForm } from "./run-case-review.tsx";
import { EvidenceJson } from "./run-trace-panel.tsx";

export function RunCaseOutput({
  row,
  review,
  reviewError,
  mode = "all"
}: {
  readonly row: DashboardCase;
  readonly review: RunReview | undefined;
  readonly reviewError: boolean;
  readonly mode?: "messages" | "cards" | "all";
}): ReactElement {
  const replies = observedReplies(row),
    p = payload(row),
    [rendererVersion, setRendererVersion] = useState<string | null>(null);
  const visual = visualReviewRequired(row);
  const hasUnconfirmed = replies.some((r) => r.source !== "DELIVERED");
  return (
    <section
      className={`run-result-panel run-output-panel${mode === "cards" ? " run-card-workbench" : ""}`}
      aria-label={mode === "cards" ? "卡片与视觉复核" : "实际输出"}
    >
      {mode !== "cards" && (
        <>
          <div className="run-panel-heading">
            <h3>实际输出</h3>
            <span>{replies.length} 条已记录回复</span>
          </div>
          {hasUnconfirmed && (
            <p className="run-output-warning">
              部分回复仅见于生成记录，未找到对应交付证据；不代表用户已收到。
            </p>
          )}
          <div className="run-output-messages">
            {replies.map((reply, index) => (
              <article className="run-output-message" key={reply.key} data-source={reply.source}>
                <header>
                  <strong>{index + 1}. Agent 回复</strong>
                  <span>
                    {reply.source === "DELIVERED"
                      ? "已交付"
                      : reply.source === "GENERATED"
                        ? "已生成 · 交付未确认"
                        : "输出投影 · 交付未确认"}
                  </span>
                </header>
                {reply.at && (
                  <time dateTime={reply.at}>
                    {Number.isFinite(Date.parse(reply.at))
                      ? new Date(reply.at).toLocaleTimeString("zh-CN", { hour12: false })
                      : "时间格式异常"}
                  </time>
                )}
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
            {replies.length === 0 && (
              <p className="run-muted">
                {row.rest.status === "ERROR"
                  ? "请求执行异常；未记录可读回复，见原始响应。"
                  : "未采集可读回复，不代表 Agent 没有输出。"}
              </p>
            )}
          </div>
        </>
      )}
      {mode !== "messages" && (
        <div id="case-a2ui-evidence" tabIndex={-1} className="run-output-capture">
          {reviewError ? (
            <p role="alert">卡片及人工审核记录读取失败，当前仅展示自动结果。</p>
          ) : !review ? (
            <p className="run-muted">正在读取卡片记录…</p>
          ) : (
            <>
              {visual ? (
                <>
                  <RunLiveCard review={review} onReady={setRendererVersion} />
                  <ReviewForm
                    review={review}
                    visual
                    rendererVersion={rendererVersion}
                    canApprove={
                      rendererVersion !== null && rendererVersion === review.live?.rendererVersion
                    }
                  />
                </>
              ) : (
                <p className="run-muted">
                  本次执行未记录 A2UI 卡片，无需视觉复核。要求出卡或禁止出卡由 Case 断言检查。
                </p>
              )}
            </>
          )}
          {(hasCardData(p) ||
            replies.some((r) => hasCardData(r.data)) ||
            Object.keys(object(p.a2ui)).length > 0) && (
            <details>
              <summary>A2UI 原始数据</summary>
              <EvidenceJson
                value={{
                  a2ui: p.a2ui,
                  messages: replies.filter((r) => hasCardData(r.data)).map((r) => r.data)
                }}
              />
            </details>
          )}
        </div>
      )}
    </section>
  );
}
