import {
  importPartialPromptfooResults,
  type ImportedEvalCase,
  type PromptfooImportCase,
  type PromptfooImportInput
} from "./promptfoo-result-importer.ts";

/** Strict streaming import input after the fixed Raw envelope has been validated. */
export interface PromptfooRowImportInput extends Omit<PromptfooImportInput, "raw"> {
  /** Untrusted Promptfoo Rows delivered with per-item backpressure. */
  readonly rows: AsyncIterable<unknown>;
}

function rowRecord(value: unknown, index: number): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`PROMPTFOO_IMPORT_ROW:${index}`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function rowCaseKey(row: Readonly<Record<string, unknown>>, index: number): string {
  const metadata = row.metadata;
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error(`PROMPTFOO_IMPORT_METADATA:${index}`);
  }
  const caseKey = (metadata as Readonly<Record<string, unknown>>).case_id;
  if (typeof caseKey !== "string" || caseKey.trim() === "") {
    throw new Error(`PROMPTFOO_IMPORT_CASE_KEY:${index}`);
  }
  return caseKey;
}

/** Read one strict Promptfoo Row identity before any storage lookup. */
export function promptfooResultRowCaseKey(value: unknown, index: number): string {
  return rowCaseKey(rowRecord(value, index), index);
}

export function importPromptfooCaseResultRows(
  input: Omit<PromptfooRowImportInput, "cases" | "rows">,
  expected: PromptfooImportCase,
  rows: readonly unknown[]
): ImportedEvalCase {
  const [imported] = importPartialPromptfooResults({
    promptfooVersion: input.promptfooVersion,
    raw: { results: { version: 3, results: rows } },
    cases: [expected],
    rawEvidence: input.rawEvidence,
    rubricPromptMaterializations: input.rubricPromptMaterializations
  });
  if (imported === undefined) throw new Error("PROMPTFOO_IMPORT_CASE_MISSING");
  return imported;
}

/** Strictly import Promptfoo Rows without retaining the aggregate Raw document. */
export async function importPartialPromptfooResultRows(
  input: PromptfooRowImportInput
): Promise<readonly ImportedEvalCase[]> {
  if (input.promptfooVersion !== "0.121.18") throw new Error("PROMPTFOO_IMPORT_VERSION");
  const expectedByKey = new Map(input.cases.map((item) => [item.caseKey, item]));
  if (
    expectedByKey.size !== input.cases.length ||
    input.cases.some(
      (item, index) =>
        item.ordinal < 0 ||
        (index > 0 && item.ordinal <= (input.cases[index - 1]?.ordinal ?? -1)) ||
        item.definition.caseKey !== item.caseKey
    )
  ) {
    throw new Error("PROMPTFOO_IMPORT_EXPECTED_ALIGNMENT");
  }
  const importedByKey = new Map<string, ImportedEvalCase>();
  let index = 0;
  for await (const rawRow of input.rows) {
    const caseKey = promptfooResultRowCaseKey(rawRow, index);
    const expected = expectedByKey.get(caseKey);
    if (expected === undefined) throw new Error("PROMPTFOO_IMPORT_CASE_UNKNOWN");
    if (importedByKey.has(caseKey)) throw new Error("PROMPTFOO_IMPORT_CASE_DUPLICATE");
    importedByKey.set(caseKey, importPromptfooCaseResultRows(input, expected, [rawRow]));
    index += 1;
  }
  return input.cases.map((expected) => {
    const imported = importedByKey.get(expected.caseKey);
    return imported ?? importPromptfooCaseResultRows(input, expected, []);
  });
}
