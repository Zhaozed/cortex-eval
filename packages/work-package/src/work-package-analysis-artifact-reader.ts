import { analysisResultFromBoundary } from "@cortex-eval/application/src/features/case-analysis/case-analysis-model-boundary.ts";
import {
  AnalysisResultCaseV1Schema,
  type AnalysisResultCaseV1
} from "@cortex-eval/contracts/src/artifact-contracts.ts";
import {
  Sha256Schema,
  UtcDateTimeSchema,
  UuidV7Schema
} from "@cortex-eval/contracts/src/contracts-primitives.ts";
import { WORK_PACKAGE_RUNTIME_LIMITS } from "@cortex-eval/contracts/src/work-package-runtime-contracts.ts";
import { analysisProposalJson } from "@cortex-eval/domain/src/domain-analysis-projection.ts";
import {
  hashAnalysisResult,
  OrderedAnalysisFinalCaseResultSetHasher,
  OrderedAnalysisResultSetHasher,
  type AnalysisSelector
} from "@cortex-eval/domain/src/domain-hash-inputs.ts";
import { z } from "zod";

import { validateDecodedJsonStringBytes } from "./json-value-runtime-limits.ts";

const CASES_DELIMITER = Buffer.from('{"cases":[', "utf8");
const MAXIMUM_JSON_DEPTH = 256;

const AnalysisEnvelopeSchema = z.strictObject({
  cases: z.array(z.never()).length(0),
  completedAt: UtcDateTimeSchema,
  contractVersion: z.literal("cortex.analysis-results.v1"),
  executionId: UuidV7Schema,
  finalCaseResultSetHash: Sha256Schema,
  packageId: UuidV7Schema,
  selector: z.enum(["failed", "errors", "all"]),
  analysisResultSetHash: Sha256Schema
});

/** Fixed identities required to stream one offline Analysis Artifact. */
export interface WorkPackageAnalysisArtifactExpectation {
  /** Immutable Package owner. */
  readonly packageId: string;
  /** Immutable Execution owner. */
  readonly executionId: string;
  /** Explicit frozen Analysis selection rule. */
  readonly selector?: AnalysisSelector | undefined;
  /** Resolve one Manifest Case key without retaining the complete key collection. */
  readonly expectedCaseKey: (ordinal: number) => string | null;
  /** Operation cancellation. */
  readonly signal: AbortSignal;
}

/** Bounded Analysis envelope returned after every Case and Hash validates. */
export interface WorkPackageAnalysisArtifactSummary {
  /** Offline Analysis completion time. */
  readonly completedAt: string;
  /** Explicit frozen selection rule. */
  readonly selector: AnalysisSelector;
  /** Exact selected final Case dependency identity. */
  readonly finalCaseResultSetHash: string;
  /** Complete Analysis result version identity. */
  readonly analysisResultSetHash: string;
  /** Number of selected sparse Case results. */
  readonly selectedCount: number;
}

interface CompactAnalysisResultIdentity {
  readonly caseKey: string;
  readonly ordinal: number;
  readonly analysisResultHash: string;
}

function invalid(cause?: unknown): Error {
  return cause === undefined
    ? new Error("WORK_PACKAGE_INVALID")
    : new Error("WORK_PACKAGE_INVALID", { cause });
}

// Parse one byte-bounded Case after its complete closing object was observed.
function parseCase(parts: readonly Uint8Array[], sizeBytes: number): AnalysisResultCaseV1 {
  try {
    const bytes = Buffer.concat(parts, sizeBytes);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const dirty = JSON.parse(text) as unknown;
    validateDecodedJsonStringBytes(dirty, "WORK_PACKAGE_INVALID");
    return AnalysisResultCaseV1Schema.parse(dirty);
  } catch (error) {
    if (error instanceof Error && error.message === "WORK_PACKAGE_INVALID") throw error;
    throw invalid(error);
  }
}

// Recompute one semantic Case Analysis result without localized error text.
function expectedAnalysisResultHash(value: AnalysisResultCaseV1): string {
  if (value.status === "ERROR") {
    return hashAnalysisResult({
      contractVersion: "cortex.analysis-result.v1",
      caseKey: value.caseKey,
      finalCaseResultHash: value.finalCaseResultHash,
      analysisInputHash: value.analysisInputHash,
      result: { status: value.status, errorCode: value.error.code }
    });
  }
  const mapped = analysisResultFromBoundary({
    contractVersion: "cortex.analysis-output.v1",
    classification: value.classification,
    confidence: value.confidence,
    evidence: value.evidence,
    explanation: value.explanation,
    recommendedAction: value.recommendedAction,
    proposal: value.proposal
  });
  if (mapped === null) throw invalid();
  return hashAnalysisResult({
    contractVersion: "cortex.analysis-result.v1",
    caseKey: value.caseKey,
    finalCaseResultHash: value.finalCaseResultHash,
    analysisInputHash: value.analysisInputHash,
    result: {
      status: value.status,
      classification: mapped.classification,
      confidence: mapped.confidence,
      evidence: mapped.evidence,
      explanation: mapped.explanation,
      recommendedAction: mapped.recommendedAction,
      proposal: mapped.proposal === undefined ? null : analysisProposalJson(mapped.proposal)
    }
  });
}

// Validate the small outer document and both independently recomputed set hashes.
function parseEnvelope(
  trailerParts: readonly Uint8Array[],
  trailerBytes: number,
  expectation: WorkPackageAnalysisArtifactExpectation,
  finalHasher: OrderedAnalysisFinalCaseResultSetHasher,
  resultIdentities: readonly CompactAnalysisResultIdentity[]
): WorkPackageAnalysisArtifactSummary {
  try {
    const bytes = Buffer.concat([
      Buffer.from('{"cases":[]', "utf8"),
      Buffer.concat(trailerParts, trailerBytes)
    ]);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const dirty = JSON.parse(text) as unknown;
    validateDecodedJsonStringBytes(dirty, "WORK_PACKAGE_INVALID");
    const clean = AnalysisEnvelopeSchema.parse(dirty);
    if (
      clean.packageId !== expectation.packageId ||
      clean.executionId !== expectation.executionId ||
      (expectation.selector !== undefined && clean.selector !== expectation.selector)
    ) {
      throw invalid();
    }
    const finalCaseResultSetHash = finalHasher.finish(clean.selector);
    if (clean.finalCaseResultSetHash !== finalCaseResultSetHash) throw invalid();
    const resultHasher = new OrderedAnalysisResultSetHasher(
      { kind: "EXECUTION", id: clean.executionId },
      clean.selector,
      finalCaseResultSetHash
    );
    for (const identity of resultIdentities) resultHasher.add(identity);
    if (clean.analysisResultSetHash !== resultHasher.finish()) throw invalid();
    return {
      completedAt: clean.completedAt,
      selector: clean.selector,
      finalCaseResultSetHash,
      analysisResultSetHash: clean.analysisResultSetHash,
      selectedCount: resultIdentities.length
    };
  } catch (error) {
    if (error instanceof Error && error.message === "WORK_PACKAGE_INVALID") throw error;
    throw invalid(error);
  }
}

/** Stream one canonical sparse Analysis Artifact without materializing Case bodies. */
export async function* readWorkPackageAnalysisArtifact(
  input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  expectation: WorkPackageAnalysisArtifactExpectation
): AsyncGenerator<AnalysisResultCaseV1, WorkPackageAnalysisArtifactSummary> {
  if (
    !UuidV7Schema.safeParse(expectation.packageId).success ||
    !UuidV7Schema.safeParse(expectation.executionId).success ||
    (expectation.selector !== undefined &&
      !["failed", "errors", "all"].includes(expectation.selector))
  ) {
    throw invalid();
  }
  let phase: "HEADER" | "VALUE_OR_END" | "VALUE" | "COMMA_OR_END" | "TRAILER" = "HEADER";
  let header = Buffer.alloc(0);
  let itemParts: Uint8Array[] = [];
  let itemBytes = 0;
  let priorOrdinal = -1;
  let collecting = false;
  let depth = 0;
  let inString = false;
  let escaped = false;
  const trailerParts: Uint8Array[] = [];
  let trailerBytes = 0;
  const finalHasher = new OrderedAnalysisFinalCaseResultSetHasher();
  const resultIdentities: CompactAnalysisResultIdentity[] = [];

  for await (const inputChunk of input) {
    if (expectation.signal.aborted) throw new Error("REQUEST_ABORTED");
    let chunk = inputChunk;
    if (phase === "HEADER") {
      header = Buffer.concat([header, chunk]);
      if (header.byteLength > WORK_PACKAGE_RUNTIME_LIMITS.executionBytes) throw invalid();
      const delimiterIndex = header.indexOf(CASES_DELIMITER);
      if (delimiterIndex < 0) continue;
      if (delimiterIndex !== 0) throw invalid();
      chunk = header.subarray(CASES_DELIMITER.byteLength);
      header = Buffer.alloc(0);
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
        if (itemBytes > WORK_PACKAGE_RUNTIME_LIMITS.analysisResultCaseBytes) throw invalid();
        itemParts.push(part);
        const item = parseCase(itemParts, itemBytes);
        if (
          item.ordinal <= priorOrdinal ||
          expectation.expectedCaseKey(item.ordinal) !== item.caseKey ||
          expectedAnalysisResultHash(item) !== item.analysisResultHash
        ) {
          throw invalid();
        }
        finalHasher.add({
          caseKey: item.caseKey,
          ordinal: item.ordinal,
          finalCaseResultHash: item.finalCaseResultHash
        });
        resultIdentities.push({
          caseKey: item.caseKey,
          ordinal: item.ordinal,
          analysisResultHash: item.analysisResultHash
        });
        priorOrdinal = item.ordinal;
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
      if (itemBytes > WORK_PACKAGE_RUNTIME_LIMITS.analysisResultCaseBytes) throw invalid();
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
  if (phase !== "TRAILER" || collecting || trailerBytes === 0) throw invalid();
  return parseEnvelope(trailerParts, trailerBytes, expectation, finalHasher, resultIdentities);
}
