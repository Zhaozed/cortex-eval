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
/** Replay prefixes, never isolated delta messages. Keep original ordering and global messages. */
export function cardReplayFrames(payloads: readonly Record<string, unknown>[]): CardReplayFrame[] {
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
    const prefix = payloads.slice(0, batch + 1);
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
  // Keep the real combined layout available; isolated surfaces must not replace final composition.
  if (active.size > 1)
    frames.push({
      batch: payloads.length - 1,
      surface: null,
      label: "最终完整状态 · 同屏布局",
      payloads: [...payloads]
    });
  return frames;
}
