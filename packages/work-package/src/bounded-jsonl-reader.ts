import { WORK_PACKAGE_RUNTIME_LIMITS } from "@cortex-eval/contracts/src/work-package-runtime-contracts.ts";

/** Limits for one canonical JSONL stream. */
export interface BoundedJsonlLimits {
  /** Largest line bytes, excluding LF, or a phase-aware limit selected before parsing. */
  readonly maxLineBytes: number | ((lineIndex: number) => number);
  /** Largest complete file size, including LF bytes. */
  readonly maxTotalBytes: number;
  /** Registered immutable file size, when available. */
  readonly expectedSizeBytes?: number;
  /** Cancellation signal. */
  readonly signal: AbortSignal;
}

/** Parsed JSON value plus its raw encoded size before the LF delimiter. */
export interface BoundedJsonlLine {
  readonly value: unknown;
  readonly sizeBytes: number;
}

function invalid(cause?: unknown): Error {
  return cause === undefined
    ? new Error("WORK_PACKAGE_INVALID")
    : new Error("WORK_PACKAGE_INVALID", { cause });
}

function validateLimits(limits: BoundedJsonlLimits): void {
  const fixedLineLimit = typeof limits.maxLineBytes === "number" ? limits.maxLineBytes : undefined;
  if (
    (fixedLineLimit !== undefined &&
      (!Number.isSafeInteger(fixedLineLimit) || fixedLineLimit < 1)) ||
    !Number.isSafeInteger(limits.maxTotalBytes) ||
    limits.maxTotalBytes < 1 ||
    (limits.expectedSizeBytes !== undefined &&
      (!Number.isSafeInteger(limits.expectedSizeBytes) ||
        limits.expectedSizeBytes < 1 ||
        limits.expectedSizeBytes > limits.maxTotalBytes))
  ) {
    throw invalid();
  }
}

function lineByteLimit(limits: BoundedJsonlLimits, lineIndex: number): number {
  const maximum =
    typeof limits.maxLineBytes === "number" ? limits.maxLineBytes : limits.maxLineBytes(lineIndex);
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw invalid();
  }
  return maximum;
}

/** Read strict UTF-8 JSONL lines with LF termination and pre-parse byte ceilings. */
export async function* readBoundedJsonlLines(
  input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  limits: BoundedJsonlLimits
): AsyncGenerator<BoundedJsonlLine> {
  validateLimits(limits);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let parts: Uint8Array[] = [];
  let lineBytes = 0;
  let totalBytes = 0;
  let lineIndex = 0;

  for await (const chunk of input) {
    if (limits.signal.aborted) throw new Error("REQUEST_ABORTED");
    totalBytes += chunk.byteLength;
    if (totalBytes > limits.maxTotalBytes) throw invalid();
    let start = 0;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (chunk[index] !== 0x0a) continue;
      const part = chunk.subarray(start, index);
      lineBytes += part.byteLength;
      if (lineBytes < 1 || lineBytes > lineByteLimit(limits, lineIndex)) throw invalid();
      parts.push(part);
      try {
        const bytes = Buffer.concat(parts, lineBytes);
        if (bytes.at(-1) === 0x0d) throw invalid();
        const text = decoder.decode(bytes);
        const parsed = { value: JSON.parse(text) as unknown, sizeBytes: lineBytes };
        lineIndex += 1;
        yield parsed;
      } catch (error) {
        if (error instanceof Error && error.message === "WORK_PACKAGE_INVALID") throw error;
        throw invalid(error);
      }
      parts = [];
      lineBytes = 0;
      start = index + 1;
    }
    if (start < chunk.byteLength) {
      const part = chunk.subarray(start);
      lineBytes += part.byteLength;
      if (lineBytes > lineByteLimit(limits, lineIndex)) throw invalid();
      parts.push(part);
    }
  }
  if (limits.signal.aborted) throw new Error("REQUEST_ABORTED");
  if (lineBytes !== 0 || parts.length !== 0) throw invalid();
  if (limits.expectedSizeBytes !== undefined && totalBytes !== limits.expectedSizeBytes) {
    throw invalid();
  }
}

/** Derive the largest allowed JSONL file from its exact expected Case count. */
export function jsonlTotalByteLimit(expectedCaseCount: number, caseLineBytes: number): number {
  const controlLineBytes = 2 * (WORK_PACKAGE_RUNTIME_LIMITS.jsonlControlLineBytes + 1);
  const total = controlLineBytes + expectedCaseCount * (caseLineBytes + 1);
  if (
    !Number.isSafeInteger(expectedCaseCount) ||
    expectedCaseCount < 1 ||
    !Number.isSafeInteger(caseLineBytes) ||
    caseLineBytes < 1 ||
    !Number.isSafeInteger(total)
  ) {
    throw invalid();
  }
  return total;
}
