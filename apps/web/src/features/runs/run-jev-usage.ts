import type { DashboardCase } from "./run-dashboard-model.ts";

/** JEV usage is separate from deterministic/rubric assertions; never count reused evaluations twice. */
export function jevUsage(rows: readonly DashboardCase[]): {
  input: number;
  output: number;
  total: number;
  inputKnown: boolean;
  outputKnown: boolean;
  recorded: number;
  expected: number;
  complete: boolean;
} {
  const result = {
    input: 0,
    output: 0,
    total: 0,
    inputKnown: false,
    outputKnown: false,
    recorded: 0,
    expected: 0,
    complete: true
  };
  for (const row of rows) {
    if (row.evaluation?.provenance) continue;
    const semantic = row.evaluation?.semanticEvaluation;
    if (!semantic && !row.definition?.semanticEvaluation) continue;
    result.expected += 1;
    const metrics = semantic?.metrics;
    result.complete &&= metrics?.usageComplete === true;
    if (metrics?.inputTokens !== undefined) {
      result.inputKnown = true;
      result.input += metrics.inputTokens;
    }
    if (metrics?.outputTokens !== undefined) {
      result.outputKnown = true;
      result.output += metrics.outputTokens;
    }
    if (metrics?.inputTokens !== undefined || metrics?.outputTokens !== undefined)
      result.recorded += 1;
  }
  result.total = result.input + result.output;
  return result;
}
