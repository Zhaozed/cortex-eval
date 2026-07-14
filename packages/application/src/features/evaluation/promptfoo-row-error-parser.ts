// Read one exact JSON object from the untrusted fixed-version Row boundary.
function rowObject(value: unknown, code: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

// Require one nonnegative finite number without coercion.
function rowNumber(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(code);
  return value;
}

/** Validate the closed Promptfoo 0.121.18 Row Error shape before sanitizing it. */
export function validatePromptfooRowError(
  row: Readonly<Record<string, unknown>>,
  caseKey: string
): void {
  const code = `PROMPTFOO_IMPORT_ROW_ERROR:${caseKey}`;
  const namedScores = rowObject(row.namedScores, code);
  const tokenUsage = rowObject(row.tokenUsage, code);
  if (
    row.success !== false ||
    typeof row.error !== "string" ||
    row.error.trim() === "" ||
    row.gradingResult !== null ||
    row.score !== 0 ||
    row.response !== undefined ||
    Object.keys(namedScores).length !== 0
  ) {
    throw new Error(code);
  }
  rowNumber(row.latencyMs, code);
  rowNumber(row.cost, code);
  rowNumber(tokenUsage.prompt, code);
  rowNumber(tokenUsage.completion, code);
  rowNumber(tokenUsage.total, code);
}
