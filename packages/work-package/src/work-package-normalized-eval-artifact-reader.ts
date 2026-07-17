import type { EvalCaseV1 } from "@cortex-eval/contracts/src/artifact-contracts.ts";
import { UuidV7Schema } from "@cortex-eval/contracts/src/contracts-primitives.ts";
import { WORK_PACKAGE_RUNTIME_LIMITS } from "@cortex-eval/contracts/src/work-package-runtime-contracts.ts";
import {
  WorkPackageNormalizedEvalJsonlCaseV1Schema,
  WorkPackageNormalizedEvalJsonlFooterV1Schema,
  WorkPackageNormalizedEvalJsonlHeaderV1Schema
} from "@cortex-eval/contracts/src/work-package-contracts.ts";

import { jsonlTotalByteLimit, readBoundedJsonlLines } from "./bounded-jsonl-reader.ts";
import { validateDecodedJsonStringBytes } from "./json-value-runtime-limits.ts";

/** Expected fixed identity for one streamed Normalized Eval Artifact. */
export interface WorkPackageNormalizedEvalArtifactExpectation {
  /** Immutable package owner. */
  readonly packageId: string;
  /** Immutable Execution owner. */
  readonly executionId: string;
  /** Exact Manifest Case count. */
  readonly expectedCaseCount: number;
  /** Registered immutable file size. */
  readonly expectedSizeBytes?: number;
  /** Cancellation signal. */
  readonly signal: AbortSignal;
}

/** Bounded outer facts returned after the complete Normalized stream validates. */
export interface WorkPackageNormalizedEvalArtifactSummary {
  /** Frozen Evaluation context identity. */
  readonly evaluationContextHash: string;
  /** Declared complete semantic Eval Result Set hash. */
  readonly resultSetHash: string;
}

function invalid(cause?: unknown): Error {
  return cause === undefined
    ? new Error("WORK_PACKAGE_INVALID")
    : new Error("WORK_PACKAGE_INVALID", { cause });
}

/** Stream one canonical Normalized Eval JSONL Artifact without materializing Cases. */
export async function* readWorkPackageNormalizedEvalArtifact(
  input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  expectation: WorkPackageNormalizedEvalArtifactExpectation
): AsyncGenerator<EvalCaseV1, WorkPackageNormalizedEvalArtifactSummary> {
  if (
    !UuidV7Schema.safeParse(expectation.packageId).success ||
    !UuidV7Schema.safeParse(expectation.executionId).success ||
    !Number.isSafeInteger(expectation.expectedCaseCount) ||
    expectation.expectedCaseCount < 1
  ) {
    throw invalid();
  }
  const maximumBytes = jsonlTotalByteLimit(
    expectation.expectedCaseCount,
    WORK_PACKAGE_RUNTIME_LIMITS.normalizedEvalCaseBytes
  );
  let lineIndex = 0;
  const caseKeys = new Set<string>();
  let evaluationContextHash: string | null = null;
  let resultSetHash: string | null = null;

  for await (const line of readBoundedJsonlLines(input, {
    maxLineBytes: (index): number =>
      index === 0 || index >= expectation.expectedCaseCount + 1
        ? WORK_PACKAGE_RUNTIME_LIMITS.jsonlControlLineBytes
        : WORK_PACKAGE_RUNTIME_LIMITS.normalizedEvalCaseBytes,
    maxTotalBytes: maximumBytes,
    ...(expectation.expectedSizeBytes === undefined
      ? {}
      : { expectedSizeBytes: expectation.expectedSizeBytes }),
    signal: expectation.signal
  })) {
    try {
      validateDecodedJsonStringBytes(line.value, "WORK_PACKAGE_INVALID");
      if (lineIndex === 0) {
        if (line.sizeBytes > WORK_PACKAGE_RUNTIME_LIMITS.jsonlControlLineBytes) throw invalid();
        const header = WorkPackageNormalizedEvalJsonlHeaderV1Schema.parse(line.value);
        if (
          header.packageId !== expectation.packageId ||
          header.executionId !== expectation.executionId
        ) {
          throw invalid();
        }
        evaluationContextHash = header.evaluationContextHash;
      } else if (lineIndex <= expectation.expectedCaseCount) {
        const record = WorkPackageNormalizedEvalJsonlCaseV1Schema.parse(line.value);
        const item = record.value;
        const ordinal = lineIndex - 1;
        if (item.ordinal !== ordinal || caseKeys.has(item.caseKey)) throw invalid();
        caseKeys.add(item.caseKey);
        yield item;
      } else if (lineIndex === expectation.expectedCaseCount + 1) {
        if (line.sizeBytes > WORK_PACKAGE_RUNTIME_LIMITS.jsonlControlLineBytes) throw invalid();
        const footer = WorkPackageNormalizedEvalJsonlFooterV1Schema.parse(line.value);
        if (evaluationContextHash === null) throw invalid();
        resultSetHash = footer.resultSetHash;
      } else {
        throw invalid();
      }
      lineIndex += 1;
    } catch (error) {
      if (error instanceof Error && error.message === "REQUEST_ABORTED") throw error;
      if (error instanceof Error && error.message === "WORK_PACKAGE_INVALID") throw error;
      throw invalid(error);
    }
  }
  if (
    lineIndex !== expectation.expectedCaseCount + 2 ||
    evaluationContextHash === null ||
    resultSetHash === null
  ) {
    throw invalid();
  }
  return { evaluationContextHash, resultSetHash };
}
