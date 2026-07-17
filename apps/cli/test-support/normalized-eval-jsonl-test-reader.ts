import { readFile } from "node:fs/promises";

import {
  EvalCaseV1Schema,
  type EvalCaseV1
} from "@cortex-eval/contracts/src/artifact-contracts.ts";

/** Minimal normalized JSONL projection used by CLI integration tests. */
export interface NormalizedEvalJsonlTestValue {
  /** Evaluation identity declared by the header. */
  readonly evaluationContextHash: string;
  /** Strict Case values carried by CASE records. */
  readonly cases: readonly EvalCaseV1[];
}

/** Read one already generated normalized JSONL Artifact for test assertions. */
export async function readNormalizedEvalJsonlForTest(
  path: string
): Promise<NormalizedEvalJsonlTestValue> {
  const records = (await readFile(path, "utf8"))
    .trimEnd()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as {
          readonly recordType: string;
          readonly evaluationContextHash?: string;
          readonly value?: Record<string, unknown>;
        }
    );
  const header = records[0];
  if (header?.evaluationContextHash === undefined) throw new Error("TEST_HEADER_MISSING");
  return {
    evaluationContextHash: header.evaluationContextHash,
    cases: records.flatMap((record) =>
      record.recordType === "CASE" && record.value !== undefined
        ? [EvalCaseV1Schema.parse(record.value)]
        : []
    )
  };
}
