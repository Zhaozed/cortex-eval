import {
  CanonicalExportEventV1Schema,
  type CanonicalExportEventV1
} from "@cortex-eval/contracts/src/canonical-export-contracts.ts";
import { WORK_PACKAGE_EXPORT_LINE_MAX_BYTES } from "@cortex-eval/contracts/src/work-package-runtime-contracts.ts";

const NEWLINE = 0x0a;

// Observe cancellation at every external-stream boundary.
function requireActive(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new Error("REQUEST_ABORTED");
}

// Decode one byte-bounded external line and validate its complete event shape.
function parseEvent(parts: readonly Uint8Array[], totalBytes: number): CanonicalExportEventV1 {
  if (totalBytes === 0) throw new Error("CANONICAL_EXPORT_EVENT_INVALID");
  const bytes = Buffer.concat(parts, totalBytes);
  let dirty: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    dirty = JSON.parse(text) as unknown;
  } catch {
    throw new Error("CANONICAL_EXPORT_EVENT_INVALID");
  }
  const parsed = CanonicalExportEventV1Schema.safeParse(dirty);
  if (!parsed.success) throw new Error("CANONICAL_EXPORT_EVENT_INVALID");
  return parsed.data;
}

/** Read strict LF-terminated Canonical Export events under the fixed one-chunk line ceiling. */
export async function* readCanonicalExportEvents(
  input: AsyncIterable<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<CanonicalExportEventV1> {
  let parts: Uint8Array[] = [];
  let lineBytes = 0;
  requireActive(signal);
  for await (const chunk of input) {
    requireActive(signal);
    let segmentStart = 0;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (chunk[index] !== NEWLINE) continue;
      const segment = chunk.subarray(segmentStart, index);
      const completedBytes = lineBytes + segment.byteLength + 1;
      if (completedBytes > WORK_PACKAGE_EXPORT_LINE_MAX_BYTES) {
        throw new Error("CANONICAL_EXPORT_LINE_TOO_LARGE");
      }
      if (segment.byteLength > 0) parts.push(segment);
      requireActive(signal);
      yield parseEvent(parts, completedBytes - 1);
      parts = [];
      lineBytes = 0;
      segmentStart = index + 1;
    }
    const remainder = chunk.subarray(segmentStart);
    if (remainder.byteLength === 0) continue;
    lineBytes += remainder.byteLength;
    if (lineBytes + 1 > WORK_PACKAGE_EXPORT_LINE_MAX_BYTES) {
      throw new Error("CANONICAL_EXPORT_LINE_TOO_LARGE");
    }
    parts.push(remainder);
  }
  requireActive(signal);
  if (lineBytes !== 0) throw new Error("CANONICAL_EXPORT_STREAM_TRUNCATED");
}
