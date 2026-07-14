import {
  WorkPackageExportEventV1Schema,
  WORK_PACKAGE_EXPORT_LINE_MAX_BYTES,
  type WorkPackageExportEventV1
} from "@cortex-eval/contracts/src/work-package-runtime-contracts.ts";

const NEWLINE = 0x0a;

// Stop at each asynchronous boundary after cancellation is observable.
function rejectCancellation(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new Error("REQUEST_ABORTED");
}

// Decode one already byte-bounded line and clean the external event before use.
function parseEvent(parts: readonly Uint8Array[], totalBytes: number): WorkPackageExportEventV1 {
  if (totalBytes === 0) throw new Error("EXPORT_EVENT_INVALID");
  const bytes = Buffer.concat(parts, totalBytes);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("EXPORT_UTF8_INVALID");
  }
  let dirty: unknown;
  try {
    dirty = JSON.parse(text) as unknown;
  } catch {
    throw new Error("EXPORT_EVENT_INVALID");
  }
  const parsed = WorkPackageExportEventV1Schema.safeParse(dirty);
  if (!parsed.success) throw new Error("EXPORT_EVENT_INVALID");
  return parsed.data;
}

/** Read strictly LF-terminated export events without accumulating an oversized line. */
export async function* readWorkPackageExportEvents(
  input: AsyncIterable<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<WorkPackageExportEventV1> {
  let parts: Uint8Array[] = [];
  let lineBytes = 0;
  rejectCancellation(signal);
  for await (const chunk of input) {
    rejectCancellation(signal);
    let segmentStart = 0;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (chunk[index] !== NEWLINE) continue;
      const segment = chunk.subarray(segmentStart, index);
      const completedBytes = lineBytes + segment.byteLength + 1;
      if (completedBytes > WORK_PACKAGE_EXPORT_LINE_MAX_BYTES) {
        throw new Error("EXPORT_LINE_TOO_LARGE");
      }
      if (segment.byteLength > 0) parts.push(segment);
      rejectCancellation(signal);
      yield parseEvent(parts, completedBytes - 1);
      parts = [];
      lineBytes = 0;
      segmentStart = index + 1;
    }
    const remainder = chunk.subarray(segmentStart);
    if (remainder.byteLength === 0) continue;
    lineBytes += remainder.byteLength;
    if (lineBytes + 1 > WORK_PACKAGE_EXPORT_LINE_MAX_BYTES) {
      throw new Error("EXPORT_LINE_TOO_LARGE");
    }
    parts.push(remainder);
  }
  rejectCancellation(signal);
  if (lineBytes !== 0) throw new Error("EXPORT_STREAM_TRUNCATED");
}
