import {
  CaseDefinitionV1Schema,
  type CaseDefinitionV1
} from "@cortex-eval/contracts/src/case-contracts.ts";
import { WORK_PACKAGE_RUNTIME_LIMITS } from "@cortex-eval/contracts/src/work-package-runtime-contracts.ts";

import { validateDecodedJsonStringBytes } from "./json-value-runtime-limits.ts";

const MAXIMUM_JSON_DEPTH = 256;

type ReaderPhase = "BEFORE_ARRAY" | "VALUE_OR_END" | "COMMA_OR_END" | "DONE";

function isWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function invalid(cause?: unknown): Error {
  return cause === undefined
    ? new Error("WORK_PACKAGE_INVALID")
    : new Error("WORK_PACKAGE_INVALID", { cause });
}

function parseCase(parts: readonly Uint8Array[], sizeBytes: number): CaseDefinitionV1 {
  try {
    const bytes = Buffer.concat(parts, sizeBytes);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const dirty = JSON.parse(text) as unknown;
    validateDecodedJsonStringBytes(dirty, "WORK_PACKAGE_INVALID");
    return CaseDefinitionV1Schema.parse(dirty);
  } catch (error) {
    if (error instanceof Error && error.message === "WORK_PACKAGE_INVALID") throw error;
    throw invalid(error);
  }
}

/** Stream and clean a bounded Canonical Tests JSON array one Case at a time. */
export async function* readCanonicalTests(
  input: AsyncIterable<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<CaseDefinitionV1> {
  let phase: ReaderPhase = "BEFORE_ARRAY";
  let totalBytes = 0;
  let itemParts: Uint8Array[] = [];
  let itemBytes = 0;
  let itemCount = 0;
  let collecting = false;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for await (const chunk of input) {
    if (signal?.aborted === true) throw new Error("REQUEST_ABORTED");
    totalBytes += chunk.byteLength;
    if (totalBytes > WORK_PACKAGE_RUNTIME_LIMITS.canonicalTestsBytes) throw invalid();
    let segmentStart = collecting ? 0 : -1;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      const byte = chunk[index];
      if (byte === undefined) throw invalid();
      if (collecting) {
        if (inString) {
          if (escaped) escaped = false;
          else if (byte === 0x5c) escaped = true;
          else if (byte === 0x22) inString = false;
          continue;
        }
        if (byte === 0x22) {
          inString = true;
          continue;
        }
        if (byte === 0x7b || byte === 0x5b) {
          depth += 1;
          if (depth > MAXIMUM_JSON_DEPTH) throw invalid();
          continue;
        }
        if (byte !== 0x7d && byte !== 0x5d) continue;
        depth -= 1;
        if (depth < 0) throw invalid();
        if (depth !== 0) continue;
        if (byte !== 0x7d || segmentStart < 0) throw invalid();
        const part = chunk.subarray(segmentStart, index + 1);
        itemBytes += part.byteLength;
        if (itemBytes > WORK_PACKAGE_RUNTIME_LIMITS.canonicalCaseBytes) throw invalid();
        itemParts.push(part);
        const item = parseCase(itemParts, itemBytes);
        itemCount += 1;
        collecting = false;
        phase = "COMMA_OR_END";
        segmentStart = -1;
        itemParts = [];
        itemBytes = 0;
        yield item;
        continue;
      }

      if (isWhitespace(byte)) continue;
      if (phase === "BEFORE_ARRAY") {
        if (byte !== 0x5b) throw invalid();
        phase = "VALUE_OR_END";
        continue;
      }
      if (phase === "VALUE_OR_END") {
        if (byte === 0x5d) {
          phase = "DONE";
          continue;
        }
        if (byte !== 0x7b) throw invalid();
        collecting = true;
        depth = 1;
        inString = false;
        escaped = false;
        segmentStart = index;
        continue;
      }
      if (phase === "COMMA_OR_END") {
        if (byte === 0x2c) {
          phase = "VALUE_OR_END";
          continue;
        }
        if (byte === 0x5d) {
          phase = "DONE";
          continue;
        }
        throw invalid();
      }
      throw invalid();
    }
    if (collecting && segmentStart >= 0) {
      const part = chunk.subarray(segmentStart);
      itemBytes += part.byteLength;
      if (itemBytes > WORK_PACKAGE_RUNTIME_LIMITS.canonicalCaseBytes) throw invalid();
      itemParts.push(part);
    }
  }
  if (signal?.aborted === true) throw new Error("REQUEST_ABORTED");
  if (phase !== "DONE" || collecting || itemCount === 0) throw invalid();
}
