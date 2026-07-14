import { describe, expect, it } from "vitest";

import type { PromptfooImportCase } from "../src/features/evaluation/promptfoo-result-importer.ts";
import { importPartialPromptfooResultRows } from "../src/features/evaluation/promptfoo-row-stream-importer.ts";

const HASH = "a".repeat(64);

function expected(
  caseKey: string,
  ordinal: number,
  status: "SUCCEEDED" | "ERROR"
): PromptfooImportCase {
  const base: PromptfooImportCase = {
    caseKey,
    ordinal,
    caseDefinitionHash: HASH,
    definition: {
      caseKey,
      description: "stream import",
      threshold: 1,
      task: "reply",
      requestBody: { text: "hello" },
      metadata: {
        requestId: `${caseKey}-request`,
        taskId: `${caseKey}-task`,
        businessModule: "stream",
        scenarioTag: "stream"
      },
      assertions: [{ type: "equals", metric: "exact", weight: 1, value: "hello" }]
    },
    restResult:
      status === "SUCCEEDED"
        ? { status, resultHash: HASH, providerOutput: { text: "hello" } }
        : { status, resultHash: HASH }
  };
  return base;
}

function rawRow(caseKey: string): Record<string, unknown> {
  return {
    metadata: { case_id: caseKey },
    response: { output: { text: "hello" } },
    success: true,
    score: 1,
    latencyMs: 1,
    cost: 0,
    gradingResult: {
      pass: true,
      score: 1,
      reason: "matched",
      componentResults: [
        {
          pass: true,
          score: 1,
          reason: "matched",
          assertion: { type: "equals", metric: "exact", weight: 1, value: "hello" }
        }
      ]
    }
  };
}

function rowStream(values: readonly unknown[]): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<unknown> {
      let index = 0;
      return {
        next: (): Promise<IteratorResult<unknown>> => {
          if (index >= values.length) {
            return Promise.resolve({ done: true, value: undefined });
          }
          const value = values[index];
          index += 1;
          return Promise.resolve({ done: false, value });
        }
      };
    }
  };
}

function input(
  rows: readonly unknown[],
  cases: readonly PromptfooImportCase[]
): Parameters<typeof importPartialPromptfooResultRows>[0] {
  return {
    promptfooVersion: "0.121.18" as const,
    rows: rowStream(rows),
    cases,
    rawEvidence: {
      present: true as const,
      path: "runs/run-1/promptfoo-raw.json",
      expectedSha256: HASH,
      expectedSizeBytes: 10
    },
    rubricPromptMaterializations: {}
  };
}

describe("Promptfoo Row stream importer", () => {
  it("imports evaluated Rows incrementally and creates REST-error NOT_EVALUATED facts", async () => {
    await expect(
      importPartialPromptfooResultRows(
        input(
          [rawRow("case-1")],
          [expected("case-1", 0, "SUCCEEDED"), expected("case-2", 1, "ERROR")]
        )
      )
    ).resolves.toMatchObject([
      { caseKey: "case-1", status: "PASS" },
      { caseKey: "case-2", status: "NOT_EVALUATED" }
    ]);
  });

  it("rejects duplicate, unknown, missing and REST-error Rows", async () => {
    const success = expected("case-1", 0, "SUCCEEDED");
    await expect(
      importPartialPromptfooResultRows(input([rawRow("case-1"), rawRow("case-1")], [success]))
    ).rejects.toThrow("PROMPTFOO_IMPORT_CASE_DUPLICATE");
    await expect(
      importPartialPromptfooResultRows(input([rawRow("unknown")], [success]))
    ).rejects.toThrow("PROMPTFOO_IMPORT_CASE_UNKNOWN");
    await expect(importPartialPromptfooResultRows(input([], [success]))).rejects.toThrow(
      "PROMPTFOO_IMPORT_CASE_MISSING"
    );
    await expect(
      importPartialPromptfooResultRows(input([rawRow("case-1")], [expected("case-1", 0, "ERROR")]))
    ).rejects.toThrow("PROMPTFOO_IMPORT_REST_ERROR_ROW:case-1");
  });

  it("rejects dirty Row boundaries and misaligned expected Cases before normalization", async () => {
    const success = expected("case-1", 0, "SUCCEEDED");
    await expect(importPartialPromptfooResultRows(input([null], [success]))).rejects.toThrow(
      "PROMPTFOO_IMPORT_ROW:0"
    );
    await expect(
      importPartialPromptfooResultRows(input([{ metadata: null }], [success]))
    ).rejects.toThrow("PROMPTFOO_IMPORT_METADATA:0");
    await expect(
      importPartialPromptfooResultRows(input([{ metadata: { case_id: "" } }], [success]))
    ).rejects.toThrow("PROMPTFOO_IMPORT_CASE_KEY:0");
    await expect(
      importPartialPromptfooResultRows(input([], [success, { ...success }]))
    ).rejects.toThrow("PROMPTFOO_IMPORT_EXPECTED_ALIGNMENT");
  });
});
