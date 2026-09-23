import { RunBriefContent } from "./run-brief-content.tsx";
import { BriefReplayOutputSchema } from "@cortex-eval/contracts/src/brief-evaluation-contracts.ts";
import { executionIssue } from "./run-execution-issue.ts";
import { RunLiveCard } from "./run-live-card.tsx";
import { useState, type ReactElement } from "react";
import type { RunReview } from "@cortex-eval/contracts/src/run-review-contracts.ts";
import type { DashboardCase } from "./run-dashboard-model.ts";
import { conversationTurns, object, payload, records } from "./run-evidence-model.ts";
import {
  cardEventSummary,
  hasCardData,
  observedReplies,
  outputDegraded,
  visualReviewRequired,
  type CardEventSummary,
  type ObservedReply
} from "./run-output-model.ts";
import { ReviewForm } from "./run-case-review.tsx";
import { EvidenceJson } from "./run-trace-panel.tsx";

/** Only sources that are not the persisted user view need to say where they came from. */
const SOURCE_NOTE: Record<ObservedReply["source"], string | null> = {
  USER_VIEW: null,
  DELIVERED: null,
  FINAL_OUTPUT: "final_output 记录",
  OUTBOUND: "出站流分段拼接",
  REPLY_TEXT: "仅上游 reply_text（末段）",
  GENERATED: "链路生成记录"
};

function clock(value: string): string {
  return Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleTimeString("zh-CN", { hour12: false })
    : "时间格式异常";
}

/**
 * One assistant message rendered the way the Loona WebUI shows it: a block header plus one bubble
 * per streamed segment. Segments are the message, not separate replies.
 */
export function ReplyMessage({
  reply,
  heading
}: {
  readonly reply: ObservedReply;
  readonly heading: string | null;
}): ReactElement {
  const segments = reply.segments.filter((segment) => segment.text !== null),
    note = SOURCE_NOTE[reply.source],
    badges = [
      ...(reply.type ? [reply.type] : []),
      ...(reply.delivered ? ["已交付"] : []),
      ...(segments.length > 1 ? [`${segments.length} 段`] : []),
      ...(note ? [note] : [])
    ];
  return (
    <article
      className="run-output-message"
      data-source={reply.source}
      data-partial={reply.partial ? "true" : undefined}
    >
      {(heading !== null || badges.length > 0) && (
        <header>
          {heading !== null && <strong>{heading}</strong>}
          <span className="run-output-badges">
            {badges.map((badge, index) => (
              <i className="run-output-badge" key={`${badge}-${index}`}>
                {badge}
              </i>
            ))}
          </span>
        </header>
      )}
      {reply.at && <time dateTime={reply.at}>{clock(reply.at)}</time>}
      {segments.length > 1 ? (
        <div className="run-output-segments">
          {segments.map((segment, index) => (
            <p className="run-output-segment" key={index}>
              {segment.seq !== null && <i className="run-output-seq">#{segment.seq}</i>}
              {segment.text}
            </p>
          ))}
        </div>
      ) : (
        reply.text && <p className="run-message-text">{reply.text}</p>
      )}
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
  );
}

/** Streamed tool cards that were never persisted as a message; the card tab still replays them. */
export function CardEventNote({
  cards
}: {
  readonly cards: CardEventSummary;
}): ReactElement | null {
  if (cards.total === 0) return null;
  const parts = [
    `${cards.total} 个 A2UI 卡片事件`,
    cards.attached > 0 ? `${cards.attached} 个附在上方消息` : null,
    cards.transient > 0 ? `${cards.transient} 个为过程态工具卡（未留存为消息）` : null
  ].filter((part) => part !== null);
  return <p className="run-output-cardnote">{parts.join(" · ")} · 卡面见卡片复核</p>;
}

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
  const issue = executionIssue(row);
  const degraded = outputDegraded(row);
  const cards = cardEventSummary(row);
  const segments = replies.reduce((total, reply) => total + reply.segments.length, 0);
  // Replies are labelled by round only when execution turns map 1:1 onto the sent user rounds.
  const rounds = conversationTurns(row).filter((turn) => turn.kind === "user").length,
    perRound = rounds > 1 && records(p.turns).length === rounds;
  if (BriefReplayOutputSchema.safeParse(p).success)
    return <RunBriefContent row={row} mode={mode} />;
  return (
    <section
      className={`run-result-panel run-output-panel${mode === "cards" ? " run-card-workbench" : ""}`}
      aria-label={mode === "cards" ? "卡片与视觉复核" : "实际输出"}
    >
      {mode !== "cards" && (
        <>
          <div className="run-panel-heading">
            <h3>实际输出</h3>
            <span>
              {replies.length} 条消息{segments > replies.length ? ` · ${segments} 段` : ""}
            </span>
          </div>
          {issue && (
            <p className="run-output-warning" role="alert">
              {issue}
            </p>
          )}
          {degraded && replies.length > 0 && (
            <p className="run-output-warning">
              该 Case 未采集到 WebUI 用户视角与交付记录，以下为上游生成/出站记录，可能不完整。
            </p>
          )}
          <div className="run-output-messages">
            {replies.map((reply, index) => (
              <ReplyMessage
                heading={
                  perRound && typeof reply.data._eval_turn_index === "number"
                    ? `第 ${reply.data._eval_turn_index + 1} 轮 · Agent 回复`
                    : `${index + 1}. Agent 回复`
                }
                key={reply.key}
                reply={reply}
              />
            ))}
            {replies.length === 0 && (
              <p className="run-muted">
                {row.rest.status === "ERROR"
                  ? "请求执行异常；未记录可读回复，见原始响应。"
                  : "未采集可读回复，不代表 Agent 没有输出。"}
              </p>
            )}
            <CardEventNote cards={cards} />
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
                    autoStatus={row.evaluation?.status}
                  />
                </>
              ) : (
                <p className="run-muted">
                  本次执行未记录 A2UI 卡片。要求出卡或禁止出卡由 Case 断言检查。
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
