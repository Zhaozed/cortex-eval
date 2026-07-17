import {
  CaseDefinitionV1Schema,
  type CaseDefinitionV1
} from "@cortex-eval/contracts/src/case-contracts.ts";
import { WORK_PACKAGE_RUNTIME_LIMITS } from "@cortex-eval/contracts/src/work-package-runtime-contracts.ts";

import { readBoundedJsonlLines } from "./bounded-jsonl-reader.ts";
import { validateDecodedJsonStringBytes } from "./json-value-runtime-limits.ts";

function invalid(cause?: unknown): Error {
  return cause === undefined
    ? new Error("WORK_PACKAGE_INVALID")
    : new Error("WORK_PACKAGE_INVALID", { cause });
}

/** Stream and clean canonical Tests JSONL one Case per line. */
export async function* readCanonicalTests(
  input: AsyncIterable<Uint8Array>,
  signal: AbortSignal = new AbortController().signal,
  expectedSizeBytes?: number
): AsyncGenerator<CaseDefinitionV1> {
  let itemCount = 0;
  for await (const line of readBoundedJsonlLines(input, {
    maxLineBytes: WORK_PACKAGE_RUNTIME_LIMITS.canonicalCaseBytes,
    maxTotalBytes: WORK_PACKAGE_RUNTIME_LIMITS.canonicalTestsBytes,
    ...(expectedSizeBytes === undefined ? {} : { expectedSizeBytes }),
    signal
  })) {
    try {
      validateDecodedJsonStringBytes(line.value, "WORK_PACKAGE_INVALID");
      yield CaseDefinitionV1Schema.parse(line.value);
      itemCount += 1;
    } catch (error) {
      if (error instanceof Error && error.message === "WORK_PACKAGE_INVALID") throw error;
      throw invalid(error);
    }
  }
  if (itemCount === 0) throw invalid();
}
