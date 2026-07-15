import {
  MetricSummaryV1Schema,
  ReportCaseV1Schema,
  ReportContextV1Schema,
  ReportOwnerV1Schema,
  ReportSummaryV1Schema,
  type ReportCaseV1,
  type ReportContextV1
} from "@cortex-eval/contracts/src/artifact-contracts.ts";
import {
  Sha256Schema,
  UtcDateTimeSchema,
  UuidV7Schema
} from "@cortex-eval/contracts/src/contracts-primitives.ts";
import { WORK_PACKAGE_RUNTIME_LIMITS } from "@cortex-eval/contracts/src/work-package-runtime-contracts.ts";
import { z } from "zod";

import { validateDecodedJsonStringBytes } from "./json-value-runtime-limits.ts";

const CASES_DELIMITER = Buffer.from(',"cases":[', "utf8");
const MAXIMUM_JSON_DEPTH = 256;

const ReportEnvelopeSchema = z.strictObject({
  byMetric: z.array(MetricSummaryV1Schema),
  cases: z.array(z.never()).length(0),
  completedAt: UtcDateTimeSchema,
  context: ReportContextV1Schema,
  contractVersion: z.literal("cortex.report.v1"),
  evaluationContextHash: Sha256Schema,
  evaluationResultSetHash: Sha256Schema,
  owner: ReportOwnerV1Schema,
  packageId: UuidV7Schema.nullable(),
  reportResultSetHash: Sha256Schema,
  summary: ReportSummaryV1Schema
});

/** Fixed identities required to stream one offline Report Artifact. */
export interface WorkPackageReportArtifactExpectation {
  /** Immutable Package owner. */
  readonly packageId: string;
  /** Immutable Execution owner. */
  readonly executionId: string;
  /** Exact frozen Case count. */
  readonly expectedCaseCount: number;
  /** Resolve one frozen Case key without retaining a complete key collection. */
  readonly expectedCaseKey: (ordinal: number) => string | null;
  /** Operation cancellation. */
  readonly signal: AbortSignal;
}

/** Bounded Report envelope returned only after the complete stream validates. */
export interface WorkPackageReportArtifactSummary {
  /** Report completion time. */
  readonly completedAt: string;
  /** Safe frozen Report context. */
  readonly context: ReportContextV1;
  /** Frozen Evaluation invocation identity. */
  readonly evaluationContextHash: string;
  /** Complete Evaluation result-set identity. */
  readonly evaluationResultSetHash: string;
  /** Recomputed summary declared by the Artifact. */
  readonly summary: z.infer<typeof ReportSummaryV1Schema>;
  /** Declared stable Metric summaries. */
  readonly byMetric: readonly z.infer<typeof MetricSummaryV1Schema>[];
  /** Complete Report result-set identity. */
  readonly reportResultSetHash: string;
}

function invalid(cause?: unknown): Error {
  return cause === undefined
    ? new Error("WORK_PACKAGE_INVALID")
    : new Error("WORK_PACKAGE_INVALID", { cause });
}

// Parse one byte-bounded Case after its complete closing object was observed.
function parseCase(parts: readonly Uint8Array[], sizeBytes: number): ReportCaseV1 {
  try {
    const bytes = Buffer.concat(parts, sizeBytes);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const dirty = JSON.parse(text) as unknown;
    validateDecodedJsonStringBytes(dirty, "WORK_PACKAGE_INVALID");
    return ReportCaseV1Schema.parse(dirty);
  } catch (error) {
    if (error instanceof Error && error.message === "WORK_PACKAGE_INVALID") throw error;
    throw invalid(error);
  }
}

// Rebuild only the small outer object with an empty Cases array and validate it strictly.
function parseEnvelope(
  header: Uint8Array,
  trailerParts: readonly Uint8Array[],
  trailerBytes: number,
  expectation: WorkPackageReportArtifactExpectation
): WorkPackageReportArtifactSummary {
  try {
    const bytes = Buffer.concat([
      header,
      Buffer.from(',"cases":[]', "utf8"),
      Buffer.concat(trailerParts, trailerBytes)
    ]);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const dirty = JSON.parse(text) as unknown;
    validateDecodedJsonStringBytes(dirty, "WORK_PACKAGE_INVALID");
    const clean = ReportEnvelopeSchema.parse(dirty);
    if (
      clean.owner.kind !== "EXECUTION" ||
      clean.owner.id !== expectation.executionId ||
      clean.packageId !== expectation.packageId ||
      clean.summary.total !== expectation.expectedCaseCount
    ) {
      throw invalid();
    }
    return {
      completedAt: clean.completedAt,
      context: clean.context,
      evaluationContextHash: clean.evaluationContextHash,
      evaluationResultSetHash: clean.evaluationResultSetHash,
      summary: clean.summary,
      byMetric: clean.byMetric,
      reportResultSetHash: clean.reportResultSetHash
    };
  } catch (error) {
    if (error instanceof Error && error.message === "WORK_PACKAGE_INVALID") throw error;
    throw invalid(error);
  }
}

/** Stream one canonical Report Artifact without materializing its Case array. */
export async function* readWorkPackageReportArtifact(
  input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  expectation: WorkPackageReportArtifactExpectation
): AsyncGenerator<ReportCaseV1, WorkPackageReportArtifactSummary> {
  if (
    !UuidV7Schema.safeParse(expectation.packageId).success ||
    !UuidV7Schema.safeParse(expectation.executionId).success ||
    !Number.isSafeInteger(expectation.expectedCaseCount) ||
    expectation.expectedCaseCount < 1
  ) {
    throw invalid();
  }
  let phase: "HEADER" | "VALUE_OR_END" | "VALUE" | "COMMA_OR_END" | "TRAILER" = "HEADER";
  let header = Buffer.alloc(0);
  let itemParts: Uint8Array[] = [];
  let itemBytes = 0;
  let itemCount = 0;
  let collecting = false;
  let depth = 0;
  let inString = false;
  let escaped = false;
  const trailerParts: Uint8Array[] = [];
  let trailerBytes = 0;

  for await (const inputChunk of input) {
    if (expectation.signal.aborted) throw new Error("REQUEST_ABORTED");
    let chunk = inputChunk;
    if (phase === "HEADER") {
      header = Buffer.concat([header, chunk]);
      if (header.byteLength > WORK_PACKAGE_RUNTIME_LIMITS.executionBytes) throw invalid();
      const delimiterIndex = header.indexOf(CASES_DELIMITER);
      if (delimiterIndex < 0) continue;
      chunk = header.subarray(delimiterIndex + CASES_DELIMITER.byteLength);
      header = header.subarray(0, delimiterIndex);
      phase = "VALUE_OR_END";
    }
    if (phase === "TRAILER") {
      trailerBytes += chunk.byteLength;
      if (trailerBytes > WORK_PACKAGE_RUNTIME_LIMITS.executionBytes) throw invalid();
      trailerParts.push(chunk);
      continue;
    }
    let segmentStart = collecting ? 0 : -1;
    let trailerStart = -1;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      const byte = chunk[index];
      if (byte === undefined) throw invalid();
      if (phase === "TRAILER") continue;
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
        if (itemBytes > WORK_PACKAGE_RUNTIME_LIMITS.reportCaseBytes) throw invalid();
        itemParts.push(part);
        const item = parseCase(itemParts, itemBytes);
        if (
          item.ordinal !== itemCount ||
          expectation.expectedCaseKey(item.ordinal) !== item.caseKey ||
          itemCount >= expectation.expectedCaseCount
        ) {
          throw invalid();
        }
        itemCount += 1;
        collecting = false;
        phase = "COMMA_OR_END";
        segmentStart = -1;
        itemParts = [];
        itemBytes = 0;
        yield item;
        continue;
      }
      if (phase === "VALUE_OR_END" || phase === "VALUE") {
        if (byte === 0x5d) {
          if (phase === "VALUE") throw invalid();
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
        phase = "VALUE";
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
      if (itemBytes > WORK_PACKAGE_RUNTIME_LIMITS.reportCaseBytes) throw invalid();
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
    header.byteLength === 0 ||
    trailerBytes === 0
  ) {
    throw invalid();
  }
  return parseEnvelope(header, trailerParts, trailerBytes, expectation);
}
