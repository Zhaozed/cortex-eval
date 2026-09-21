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

/** One streamed bubble inside a single assistant message, exactly as the Loona WebUI shows it. */
export interface ReplySegment {
  readonly seq: number | null;
  readonly text: string | null;
  readonly type: string | null;
  readonly emotion: string | null;
}

/**
 * Where the displayed text came from. `USER_VIEW` is the Loona WebUI projection and always wins;
 * the rest is the fallback chain for evidence collected before `user_view` existed.
 */
export type ReplySource =
  "USER_VIEW" | "DELIVERED" | "FINAL_OUTPUT" | "OUTBOUND" | "REPLY_TEXT" | "GENERATED";

/** One assistant message: its streamed segments plus the delivery metadata joined onto them. */
export interface ObservedReply {
  readonly key: string;
  /** Whole message text; the delivered record's text when one matched this message id. */
  readonly text: string | null;
  readonly at: string | null;
  readonly source: ReplySource;
  readonly data: Record<string, unknown>;
  /** Loona message id; one id is one message block. */
  readonly msgId: string | null;
  /** NOTICE / QUESTION / … as the agent classified this message. */
  readonly type: string | null;
  readonly segments: readonly ReplySegment[];
  /** A `delivered_messages` record confirms this message reached the user. */
  readonly delivered: boolean;
  /** A2UI card payloads that belong to this message. */
  readonly cards: readonly unknown[];
  /** True only for the `reply_text` last resort, which carries the final segment alone. */
  readonly partial: boolean;
}

/** A2UI card events in the outbound stream, split by whether a persisted message owns them. */
export interface CardEventSummary {
  readonly total: number;
  readonly attached: number;
  /** Tool/progress cards that were streamed but never persisted as a user-visible message. */
  readonly transient: number;
}

const NO_CARDS: CardEventSummary = { total: 0, attached: 0, transient: 0 };

function assistant(record: Record<string, unknown>): boolean {
  return record.role === undefined || record.role === "assistant";
}
function identity(record: Record<string, unknown>): string | null {
  const id = record.asst_msg_id ?? record.conv_row_id;
  return typeof id === "string" || typeof id === "number"
    ? `${text(record.req_id) ?? ""}/${String(id)}`
    : null;
}
function messageId(record: Record<string, unknown>): string | null {
  return text(record.msg_id) ?? text(record.asst_msg_id);
}
function seqOf(record: Record<string, unknown>): number {
  return typeof record.seq === "number" && Number.isFinite(record.seq)
    ? record.seq
    : Number.MAX_SAFE_INTEGER;
}
function segmentOf(record: Record<string, unknown>): ReplySegment {
  const seq = seqOf(record);
  return {
    seq: seq === Number.MAX_SAFE_INTEGER ? null : seq,
    text: text(record.text),
    type: text(record.type) ?? text(record.kind),
    emotion: text(record.emotion)
  };
}
/** Only explicit card payloads count, not a planner's requested present_mode. */
export function hasCardData(record: Record<string, unknown>): boolean {
  return cardPayloads(record).length > 0;
}
function cardPayloads(record: Record<string, unknown>): unknown[] {
  const card = record.a2ui;
  if (Array.isArray(card)) return card;
  return Object.keys(object(card)).length > 0 ? [card] : [];
}
/**
 * Collapse whitespace before comparing: upstream stores the same segments either concatenated
 * or newline-joined, and both spellings are one message, never two.
 */
function flat(value: string | null): string {
  return value === null ? "" : value.replace(/\s+/g, "");
}
function joinSegments(segments: readonly ReplySegment[]): string | null {
  const parts = segments
    .map((segment) => segment.text)
    .filter((value): value is string => value !== null);
  return parts.length > 0 ? parts.join("\n") : null;
}
interface MessageGroup {
  readonly id: string;
  readonly items: Record<string, unknown>[];
  readonly position: number;
}
/** Group streamed records into messages, keeping first-seen order and ascending `seq` inside. */
function groupByMessage(list: readonly Record<string, unknown>[]): MessageGroup[] {
  const groups: MessageGroup[] = [],
    byId = new Map<string, MessageGroup>();
  list.forEach((record, position) => {
    const id = messageId(record) ?? `#${position}`;
    const existing = byId.get(id);
    if (existing) existing.items.push(record);
    else {
      const group: MessageGroup = { id, items: [record], position };
      byId.set(id, group);
      groups.push(group);
    }
  });
  for (const group of groups) group.items.sort((a, b) => seqOf(a) - seqOf(b));
  return groups;
}
/** WebUI projection first; older evidence falls back in a fixed order and says which it used. */
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
  const result = scopeReplies(p);
  appendGenerated(result, p);
  // Do not guess chronology from IDs or timestamps that are absent or invalid.
  if (result.length > 1 && result.every((r) => r.at !== null && Number.isFinite(Date.parse(r.at))))
    result.sort((a, b) => Date.parse(a.at ?? "") - Date.parse(b.at ?? ""));
  return result;
}
function scopeReplies(p: Record<string, unknown>): ObservedReply[] {
  const delivered = records(p.delivered_messages).filter(assistant),
    view = records(object(p.user_view).messages).filter(
      (record) => text(record.text) !== null || cardPayloads(record).length > 0
    ),
    outbound = records(p.outbound_records);
  if (view.length > 0) return userViewReplies(view, delivered, outbound);
  if (
    delivered.some(
      (record) =>
        text(record.text) !== null ||
        cardPayloads(record).length > 0 ||
        records(record.links).length > 0
    )
  )
    return deliveredReplies(delivered);
  const final = object(p.final_output);
  if (
    assistant(final) &&
    (text(final.text) !== null || cardPayloads(final).length > 0 || records(final.links).length > 0)
  )
    return [singleBlock(final, "FINAL_OUTPUT", text(final.text), false)];
  const spoken = outbound.filter((record) => assistant(record) && text(record.text) !== null);
  if (spoken.length > 0) return outboundReplies(spoken);
  const reply = text(p.reply_text);
  if (reply)
    return [
      {
        ...singleBlock({ reply_text: reply, reply_type: p.reply_type }, "REPLY_TEXT", reply, false),
        partial: true
      }
    ];
  return [];
}
/** The Loona WebUI user view: one message block per `msg_id`, one bubble per `seq`. */
function userViewReplies(
  view: Record<string, unknown>[],
  delivered: Record<string, unknown>[],
  outbound: Record<string, unknown>[]
): ObservedReply[] {
  const result: ObservedReply[] = [];
  groupByMessage(view).forEach((group, index) => {
    const match = delivered.find((record) => messageId(record) === group.id),
      segments = group.items.map(segmentOf),
      cards = [
        ...(match ? cardPayloads(match) : []),
        ...outbound
          .filter((record) => messageId(record) === group.id)
          .flatMap((record) => cardPayloads(record))
      ],
      body = text(match?.text) ?? joinSegments(segments),
      kind =
        text(match?.kind) ??
        segments.map((segment) => segment.type).find((value) => value !== null) ??
        null;
    result.push({
      key: `${group.id}/${index}`,
      text: body,
      at: text(match?.created_at),
      source: "USER_VIEW",
      data: {
        ...(match ?? {}),
        msg_id: group.id,
        asst_msg_id: group.id,
        role: "assistant",
        text: body,
        kind,
        created_at: text(match?.created_at),
        links: records(match?.links),
        a2ui: cards,
        user_view_messages: group.items
      },
      msgId: group.id,
      type: kind,
      segments,
      delivered: match !== undefined,
      cards,
      partial: false
    });
  });
  return result;
}
/** Legacy evidence: every persisted delivery record stays its own message, retries included. */
function deliveredReplies(delivered: Record<string, unknown>[]): ObservedReply[] {
  const result: ObservedReply[] = [],
    seen = new Set<string>();
  delivered.forEach((record, position) => {
    const body = text(record.text) ?? text(record.reply_text),
      cards = cardPayloads(record),
      links = records(record.links),
      id = identity(record);
    if (!body && cards.length === 0 && links.length === 0) return;
    const signature = JSON.stringify([id, body, record.a2ui ?? null, links]);
    if (id && seen.has(signature)) return;
    if (id) seen.add(signature);
    result.push({
      ...singleBlock(record, "DELIVERED", body, true),
      key: `${id ?? "delivered"}/${position}`,
      msgId: messageId(record),
      segments: body === null ? [] : [segmentOf({ ...record, text: body })]
    });
  });
  return result;
}
/** Legacy evidence: rebuild messages from the raw outbound stream, grouped by id then `seq`. */
function outboundReplies(spoken: Record<string, unknown>[]): ObservedReply[] {
  return groupByMessage(spoken).map((group, index) => {
    const segments = group.items.map(segmentOf);
    return {
      ...singleBlock(
        group.items[group.items.length - 1] ?? {},
        "OUTBOUND",
        joinSegments(segments),
        false
      ),
      key: `${group.id}/${index}`,
      msgId: messageId(group.items[0] ?? {}),
      type: segments.map((segment) => segment.type).find((value) => value !== null) ?? null,
      segments
    };
  });
}
function singleBlock(
  record: Record<string, unknown>,
  source: ReplySource,
  body: string | null,
  delivered: boolean
): ObservedReply {
  const cards = cardPayloads(record),
    kind = text(record.kind) ?? text(record.type) ?? text(record.reply_type);
  return {
    key: `${source.toLowerCase()}/${body === null ? "card" : flat(body).length}`,
    text: body,
    at: text(record.created_at),
    source,
    data: record,
    msgId: messageId(record),
    type: kind,
    segments: body === null ? [] : [{ seq: null, text: body, type: kind, emotion: null }],
    delivered,
    cards,
    partial: false
  };
}
/**
 * Timeline copies are generation records, not delivery proof. They are added only when they carry
 * text no message block shows; older evidence keeps the real answer here and only an ack in
 * `delivered_messages`, while a truncated or per-segment copy is a substring of what is shown.
 */
function appendGenerated(result: ObservedReply[], p: Record<string, unknown>): void {
  const timeline = [...records(p.timeline)].sort((a, b) =>
    typeof a.step_idx === "number" && typeof b.step_idx === "number" ? a.step_idx - b.step_idx : 0
  );
  const shown = new Set<string>();
  for (const reply of result) {
    for (const value of [reply.text, ...reply.segments.map((segment) => segment.text)]) {
      const key = flat(value);
      if (key) shown.add(key);
    }
  }
  for (const step of timeline) {
    const body = object(step.payload),
      value = text(body.reply_text);
    if (!value) continue;
    const key = flat(value);
    if (!key || shown.has(key)) continue;
    if ([...shown].some((entry) => entry.includes(key))) continue;
    shown.add(key);
    const record = { ...body, req_id: step.req_id, created_at: step.created_at };
    result.push({
      ...singleBlock(record, "GENERATED", value, false),
      key: `timeline/${result.length}`,
      msgId: messageId(body),
      at: text(step.created_at)
    });
  }
}
/** Card events that no persisted message owns are streamed tool cards, not extra replies. */
function scopeCardSummary(p: Record<string, unknown>): CardEventSummary {
  const events = records(p.outbound_records).filter((record) => cardPayloads(record).length > 0);
  if (events.length === 0) return NO_CARDS;
  const owned = new Set<string>();
  for (const record of [
    ...records(object(p.user_view).messages),
    ...records(p.delivered_messages)
  ]) {
    const id = messageId(record);
    if (id) owned.add(id);
  }
  const attached = events.filter((record) => owned.has(messageId(record) ?? "")).length;
  return { total: events.length, attached, transient: events.length - attached };
}
function sumCards(values: readonly CardEventSummary[]): CardEventSummary {
  return values.reduce(
    (total, item) => ({
      total: total.total + item.total,
      attached: total.attached + item.attached,
      transient: total.transient + item.transient
    }),
    NO_CARDS
  );
}
/** Card-event counts for the whole Case, summed over executed turns. */
export function cardEventSummary(row: DashboardCase): CardEventSummary {
  const p = payload(row),
    turns = records(p.turns);
  return sumCards(
    (turns.length ? turns.map((turn) => object(turn.parsed_output)) : [p]).map(scopeCardSummary)
  );
}
function scopes(p: Record<string, unknown>): Record<string, unknown>[] {
  const turns = records(p.turns);
  return turns.length ? turns.map((turn) => object(turn.parsed_output)) : [p];
}
/**
 * True when a turn has neither the WebUI projection nor delivery records. Only then is the panel
 * showing best-effort upstream text, and only then does it say so.
 */
export function outputDegraded(row: DashboardCase): boolean {
  return scopes(payload(row)).some(
    (scope) =>
      records(object(scope.user_view).messages).length === 0 &&
      records(scope.delivered_messages).filter(assistant).length === 0
  );
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
  /** A2UI card events streamed in this turn. */
  readonly cards: CardEventSummary;
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
      turnPayload = object(turn.parsed_output),
      coverage = object(turnPayload.coverage),
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
            : null,
      cards: scopeCardSummary(turnPayload)
    };
  });
}
