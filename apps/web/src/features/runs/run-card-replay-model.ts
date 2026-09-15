import { object, records, text } from "./run-evidence-model.ts";

export interface CardReplayFrame {
  readonly label: string;
  readonly batch: number;
  readonly surface: string | null;
  readonly payloads: readonly Record<string, unknown>[];
}
function surfaceOf(message: Record<string, unknown>): string | null {
  for (const key of [
    "createSurface",
    "updateComponents",
    "updateDataModel",
    "deleteSurface",
    "surfaceUpdate",
    "dataModelUpdate",
    "beginRendering"
  ])
    if (text(object(message[key]).surfaceId)) return text(object(message[key]).surfaceId);
  return null;
}
/** A new createSurface in a later outbound batch begins a new incarnation of that ID.
 * Keep earlier stages inspectable, but do not feed earlier incarnations into this replay.
 * Deltas within an incarnation remain ordered; the stored evidence is never changed.
 */
function replayPrefix(payloads: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const starts = new Map<string, number>();
  payloads.forEach((p, index) => {
    for (const message of records(p.messages)) {
      const id = text(object(message.createSurface).surfaceId);
      if (id) starts.set(id, index);
    }
  });
  return payloads
    .map((p, index) => ({
      ...p,
      messages: records(p.messages).filter((message) => {
        const id = surfaceOf(message);
        return id === null || index >= (starts.get(id) ?? 0);
      })
    }))
    .filter((p) => p.messages.length > 0);
}
/** Replay prefixes, never isolated delta messages. Keep original ordering and global messages. */
export function cardReplayFrames(payloads: readonly Record<string, unknown>[]): CardReplayFrame[] {
  // Surface IDs may repeat across turns; never apply another turn's deltas to this card.
  if (payloads.some((p) => typeof p._eval_turn_index === "number")) {
    const groups = new Map<number, Record<string, unknown>[]>();
    for (const payload of payloads) {
      const index = typeof payload._eval_turn_index === "number" ? payload._eval_turn_index : 0;
      const { _eval_turn_index: _turn, ...card } = payload;
      void _turn;
      groups.set(index, [...(groups.get(index) ?? []), card]);
    }
    return [...groups].flatMap(([turn, cards]) =>
      cardReplayFrames(cards).map((frame) => ({
        ...frame,
        label: `第 ${turn + 1} 轮 · ${frame.label}`
      }))
    );
  }
  const active = new Set<string>();
  const frames: CardReplayFrame[] = [];
  payloads.forEach((payload, batch) => {
    const changed = new Set<string>();
    for (const message of records(payload.messages)) {
      const surface = surfaceOf(message);
      if (surface) {
        changed.add(surface);
        if (object(message.deleteSurface).surfaceId === surface) active.delete(surface);
        else active.add(surface);
      }
    }
    const prefix = replayPrefix(payloads.slice(0, batch + 1));
    const candidates = changed.size ? changed : active;
    for (const surface of candidates) {
      if (!active.has(surface)) continue;
      frames.push({
        batch,
        surface,
        label: `出站 ${batch + 1} · ${surface}`,
        payloads: prefix
          .map((p) => ({
            ...p,
            messages: records(p.messages).filter(
              (m) => surfaceOf(m) === null || surfaceOf(m) === surface
            )
          }))
          .filter((p) => p.messages.length > 0)
      });
    }
    // Unknown protocols remain inspectable. Deletions stay in the source JSON, not empty cards.
    if (changed.size === 0 && active.size === 0)
      frames.push({
        batch,
        surface: null,
        label: `出站 ${batch + 1} · 完整状态`,
        payloads: prefix
      });
  });
  // Keep an explicitly labeled composite replay; no original message-layout metadata is available.
  if (active.size > 1)
    frames.push({
      batch: payloads.length - 1,
      surface: null,
      label: "当前卡面组合 · 回放",
      payloads: replayPrefix(payloads)
    });
  return frames;
}
