import type { DashboardCase } from "./run-dashboard-model.ts";
import {
  callUsage,
  conversationTurns,
  modelCalls,
  object,
  payload,
  records,
  text
} from "./run-evidence-model.ts";

export interface ObservedReply {
  readonly key: string;
  readonly text: string | null;
  readonly at: string | null;
  readonly source: "DELIVERED" | "GENERATED" | "PROJECTION";
  readonly data: Record<string, unknown>;
}
function identity(record: Record<string, unknown>): string | null {
  const id = record.asst_msg_id ?? record.conv_row_id;
  return typeof id === "string" || typeof id === "number"
    ? `${text(record.req_id) ?? ""}/${String(id)}`
    : null;
}
/** Outbound records are authoritative; timeline replies are generated, not proof of delivery. */
export function observedReplies(row: DashboardCase): ObservedReply[] {
  return repliesFromPayload(payload(row));
}
function repliesFromPayload(p: Record<string, unknown>): ObservedReply[] {
  const turns = records(p.turns);
  if (turns.length)
    return turns.flatMap((turn, index) =>
      repliesFromPayload(object(turn.parsed_output)).map((reply) => ({
        ...reply,
        key: `${index}/${reply.key}`,
        data: { ...reply.data, _eval_turn_index: index }
      }))
    );
  const result: ObservedReply[] = [],
    seen = new Set<string>();
  const add = (record: Record<string, unknown>, source: ObservedReply["source"]): void => {
    if (record.role !== undefined && record.role !== "assistant") return;
    const body = text(record.text) ?? text(record.reply_text);
    const id = identity(record);
    const signature = JSON.stringify([id, body, record.a2ui ?? null, record.links ?? []]);
    const key = `${id ?? source}/${result.length}`;
    if (id && seen.has(signature)) return;
    if (!body && !hasCardData(record) && records(record.links).length === 0) return;
    if (id) seen.add(signature);
    result.push({ key, text: body, at: text(record.created_at), source, data: record });
  };
  const delivered = records(p.delivered_messages);
  for (const record of delivered) add(record, "DELIVERED");
  const final = object(p.final_output);
  if (
    !result.some((r) =>
      identity(final)
        ? identity(final) === identity(r.data) && r.text === text(final.text)
        : r.text === text(final.text)
    )
  )
    add(final, "PROJECTION");
  const timeline = [...records(p.timeline)].sort((a, b) =>
    typeof a.step_idx === "number" && typeof b.step_idx === "number" ? a.step_idx - b.step_idx : 0
  );
  for (const step of timeline) {
    const body = object(step.payload);
    if (text(body.reply_text))
      add({ ...body, req_id: step.req_id, created_at: step.created_at }, "GENERATED");
  }
  if (text(p.reply_text) && !result.some((reply) => reply.text === text(p.reply_text)))
    add({ text: p.reply_text }, "PROJECTION");
  // Do not guess chronology from IDs or timestamps that are absent or invalid.
  if (result.every((r) => r.at !== null && Number.isFinite(Date.parse(r.at))))
    result.sort((a, b) => Date.parse(a.at ?? "") - Date.parse(b.at ?? ""));
  return result;
}
/** Only explicit card payloads count, not a planner's requested present_mode. */
export function hasCardData(record: Record<string, unknown>): boolean {
  const card = record.a2ui;
  return Array.isArray(card) ? card.length > 0 : Object.keys(object(card)).length > 0;
}
export function hasObservedCards(row: DashboardCase): boolean {
  const p = payload(row);
  return hasCardData(p) || records(p.delivered_messages).some(hasCardData);
}
/** Only real cards create a visual review; the capture opt-in flag alone does not. */
export function visualReviewRequired(row: DashboardCase): boolean {
  return row.review?.live ? row.review.live.required : hasObservedCards(row);
}

/** Agent token usage recorded for one executed turn. */
export interface RoundUsage {
  readonly input: number;
  readonly output: number;
  readonly total: number;
  readonly calls: number;
}

/** One executed turn of a multi-turn Case: its sent input and the replies it produced. */
export interface ConversationRound {
  /** 1-based round; matches the Trace flow divider "第 N 轮". */
  readonly round: number;
  /** User input, paired only when executed turns align 1:1 with the frozen conversation. */
  readonly input: string | null;
  readonly paired: boolean;
  readonly replies: readonly ObservedReply[];
  readonly usage: RoundUsage | null;
  /** Wall-clock span of the turn's timeline, when timestamps allow it. */
  readonly elapsedMs: number | null;
  /** Recorded coverage caveat; absent coverage is unknown, never sold as complete. */
  readonly coverageNote: string | null;
}

/**
 * Per-turn view of a multi-turn execution. Empty when evidence has no per-turn
 * `turns` envelope; legacy flat payloads keep the single-round rendering path.
 */
export function conversationRounds(row: DashboardCase): ConversationRound[] {
  const p = payload(row),
    turns = records(p.turns);
  if (turns.length === 0) return [];
  const replies = observedReplies(row),
    userInputs = conversationTurns(row).filter((turn) => turn.kind === "user"),
    paired = userInputs.length === turns.length,
    timeline = records(p.timeline),
    calls = modelCalls(row);
  return turns.map((turn, index) => {
    const turnReplies = replies.filter((reply) => reply.data._eval_turn_index === index),
      coverage = object(object(object(turn).parsed_output).coverage),
      llmAudit = object(object(coverage.source_coverage).llm_audit),
      completeness = text(llmAudit.completeness);
    let inputTokens = 0,
      outputTokens = 0,
      callsInTurn = 0;
    for (const call of calls) {
      if (call._eval_turn_index !== index) continue;
      callsInTurn += 1;
      const usage = callUsage(call);
      if (!usage) continue;
      inputTokens += usage.input;
      outputTokens += usage.output;
    }
    const stamps = timeline
      .filter((step) => step._eval_turn_index === index)
      .map((step) => Date.parse(text(step.created_at) ?? ""))
      .filter((value) => Number.isFinite(value));
    return {
      round: index + 1,
      input: paired ? (userInputs[index]?.text ?? null) : null,
      paired,
      replies: turnReplies,
      usage:
        callsInTurn === 0
          ? null
          : {
              input: inputTokens,
              output: outputTokens,
              total: inputTokens + outputTokens,
              calls: callsInTurn
            },
      elapsedMs: stamps.length >= 2 ? Math.max(0, Math.max(...stamps) - Math.min(...stamps)) : null,
      // UNKNOWN 是上游从未成功输出的占位值（全量数据均如此），无信息量，不展示；
      // 只有真实的缺失/截断才提示。
      coverageNote:
        coverage.truncated === true
          ? "该轮执行证据采集被截断"
          : completeness !== null && completeness !== "COMPLETE" && completeness !== "UNKNOWN"
            ? `该轮模型调用采集不完整（${completeness}）`
            : null
    };
  });
}
