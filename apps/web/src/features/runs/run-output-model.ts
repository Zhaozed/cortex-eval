import type { DashboardCase } from "./run-dashboard-model.ts";
import { object, payload, records, text } from "./run-evidence-model.ts";

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
  const p = payload(row),
    result: ObservedReply[] = [],
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
export function visualReviewRequired(row: DashboardCase): boolean {
  return (
    row.review?.live?.required ??
    (row.definition?.metadata.a2ui_capture === true || hasObservedCards(row))
  );
}
