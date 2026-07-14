import {
  RestArtifactCaseV1Schema,
  type RestArtifactCaseV1
} from "@cortex-eval/contracts/src/artifact-contracts.ts";
import {
  Sha256Schema,
  UtcDateTimeSchema,
  UuidV7Schema
} from "@cortex-eval/contracts/src/contracts-primitives.ts";
import { WORK_PACKAGE_RUNTIME_LIMITS } from "@cortex-eval/contracts/src/work-package-runtime-contracts.ts";
import { z } from "zod";

import { validateDecodedJsonStringBytes } from "./json-value-runtime-limits.ts";

const PREFIX = Buffer.from('{"cases":[', "utf8");
const MAXIMUM_JSON_DEPTH = 256;

type ReaderPhase = "PREFIX" | "VALUE_OR_END" | "COMMA_OR_END" | "TRAILER";

const RestArtifactEnvelopeSchema = z.strictObject({
  cases: z.array(z.never()).length(0),
  completedAt: UtcDateTimeSchema,
  contractVersion: z.literal("cortex.rest-results.v1"),
  executionId: UuidV7Schema,
  packageId: UuidV7Schema,
  resultSetHash: Sha256Schema
});

/** Expected fixed identity for one streamed REST Artifact. */
export interface WorkPackageRestArtifactExpectation {
  /** Immutable package owner. */
  readonly packageId: string;
  /** Immutable Execution owner. */
  readonly executionId: string;
  /** Exact Manifest Case count. */
  readonly expectedCaseCount: number;
  /** Cancellation signal. */
  readonly signal: AbortSignal;
}

/** Bounded outer facts returned only after the complete stream validates. */
export interface WorkPackageRestArtifactSummary {
  /** Artifact completion timestamp. */
  readonly completedAt: string;
  /** Declared complete semantic Result Set hash. */
  readonly resultSetHash: string;
}

function invalid(cause?: unknown): Error {
  return cause === undefined
    ? new Error("WORK_PACKAGE_INVALID")
    : new Error("WORK_PACKAGE_INVALID", { cause });
}

// Parse one raw-byte-bounded Case only after its closing object was observed.
function parseCase(parts: readonly Uint8Array[], sizeBytes: number): RestArtifactCaseV1 {
  try {
    const bytes = Buffer.concat(parts, sizeBytes);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const dirty = JSON.parse(text) as unknown;
    validateDecodedJsonStringBytes(dirty, "WORK_PACKAGE_INVALID");
    return RestArtifactCaseV1Schema.parse(dirty);
  } catch (error) {
    if (error instanceof Error && error.message === "WORK_PACKAGE_INVALID") throw error;
    throw invalid(error);
  }
}

// Validate the bounded non-Case envelope without materializing the Case array.
function parseEnvelope(
  trailerParts: readonly Uint8Array[],
  trailerBytes: number,
  expectation: WorkPackageRestArtifactExpectation
): WorkPackageRestArtifactSummary {
  try {
    const trailer = Buffer.concat(trailerParts, trailerBytes);
    const bytes = Buffer.concat([Buffer.from('{"cases":[]', "utf8"), trailer]);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const dirty = JSON.parse(text) as unknown;
    validateDecodedJsonStringBytes(dirty, "WORK_PACKAGE_INVALID");
    const clean = RestArtifactEnvelopeSchema.parse(dirty);
    if (
      clean.packageId !== expectation.packageId ||
      clean.executionId !== expectation.executionId
    ) {
      throw invalid();
    }
    return { completedAt: clean.completedAt, resultSetHash: clean.resultSetHash };
  } catch (error) {
    if (error instanceof Error && error.message === "WORK_PACKAGE_INVALID") throw error;
    throw invalid(error);
  }
}

/** Stream one canonical REST Artifact with per-Case pre-parse byte enforcement. */
export async function* readWorkPackageRestArtifact(
  input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  expectation: WorkPackageRestArtifactExpectation
): AsyncGenerator<RestArtifactCaseV1, WorkPackageRestArtifactSummary> {
  if (
    !UuidV7Schema.safeParse(expectation.packageId).success ||
    !UuidV7Schema.safeParse(expectation.executionId).success ||
    !Number.isSafeInteger(expectation.expectedCaseCount) ||
    expectation.expectedCaseCount < 1
  ) {
    throw invalid();
  }
  let phase: ReaderPhase = "PREFIX";
  let prefixOffset = 0;
  let itemParts: Uint8Array[] = [];
  let itemBytes = 0;
  let itemCount = 0;
  let collecting = false;
  let depth = 0;
  let inString = false;
  let escaped = false;
  const caseKeys = new Set<string>();
  const trailerParts: Uint8Array[] = [];
  let trailerBytes = 0;

  for await (const chunk of input) {
    if (expectation.signal.aborted) throw new Error("REQUEST_ABORTED");
    let segmentStart = collecting ? 0 : -1;
    let trailerStart = phase === "TRAILER" ? 0 : -1;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      const byte = chunk[index];
      if (byte === undefined) throw invalid();
      if (phase === "TRAILER") continue;
      if (phase === "PREFIX") {
        if (byte !== PREFIX[prefixOffset]) throw invalid();
        prefixOffset += 1;
        if (prefixOffset === PREFIX.byteLength) phase = "VALUE_OR_END";
        continue;
      }
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
        if (itemBytes > WORK_PACKAGE_RUNTIME_LIMITS.restResultCaseBytes) throw invalid();
        itemParts.push(part);
        const item = parseCase(itemParts, itemBytes);
        if (
          item.ordinal !== itemCount ||
          caseKeys.has(item.caseKey) ||
          itemCount >= expectation.expectedCaseCount
        ) {
          throw invalid();
        }
        caseKeys.add(item.caseKey);
        itemCount += 1;
        collecting = false;
        phase = "COMMA_OR_END";
        segmentStart = -1;
        itemParts = [];
        itemBytes = 0;
        yield item;
        continue;
      }
      if (phase === "VALUE_OR_END") {
        if (byte === 0x7d) throw invalid();
        if (byte === 0x5d) {
          phase = "TRAILER";
          trailerStart = index + 1;
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
      if (byte === 0x2c) {
        phase = "VALUE_OR_END";
        continue;
      }
      if (byte === 0x5d) {
        phase = "TRAILER";
        trailerStart = index + 1;
        continue;
      }
      throw invalid();
    }
    if (collecting && segmentStart >= 0) {
      const part = chunk.subarray(segmentStart);
      itemBytes += part.byteLength;
      if (itemBytes > WORK_PACKAGE_RUNTIME_LIMITS.restResultCaseBytes) throw invalid();
      itemParts.push(part);
    }
    if (phase === "TRAILER" && trailerStart >= 0) {
      const part = chunk.subarray(trailerStart);
      trailerBytes += part.byteLength;
      if (trailerBytes > WORK_PACKAGE_RUNTIME_LIMITS.executionBytes) throw invalid();
      trailerParts.push(part);
    }
  }
  if (expectation.signal.aborted) throw new Error("REQUEST_ABORTED");
  if (
    phase !== "TRAILER" ||
    collecting ||
    itemCount !== expectation.expectedCaseCount ||
    trailerBytes === 0
  ) {
    throw invalid();
  }
  return parseEnvelope(trailerParts, trailerBytes, expectation);
}
