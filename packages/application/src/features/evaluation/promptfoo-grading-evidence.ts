/** Versioned, deterministic projection; raw REST evidence and rule assertions stay untouched. */
export const GRADING_EVIDENCE_TRANSFORM = `
// cortex.grading-evidence.v1
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
let root = output;
if (typeof root === 'string') {
  try { root = JSON.parse(root); } catch { return output; }
}
if (!isObject(root) || typeof root.ok !== 'boolean' || !isObject(root.parsed_output)) return output;
const project = evidence => {
  if (!isObject(evidence)) return evidence;
  const result = Object.fromEntries(Object.entries(evidence).filter(([key]) => key !== 'llm_calls'));
  if (Array.isArray(evidence.turns)) {
    result.turns = evidence.turns.map(turn => {
      if (!isObject(turn) || !isObject(turn.parsed_output)) return turn;
      return { ...turn, parsed_output: project(turn.parsed_output) };
    });
  }
  return result;
};
const result = { ...root, parsed_output: project(root.parsed_output) };
return typeof output === 'string' ? JSON.stringify(result) : result;
`;

/** Explicit transforms opt out: specialist rubrics may intentionally inspect model-call traces. */
export function materializeGradingEvidenceTransform(assertion: {
  readonly type: string;
  readonly transform?: string | undefined;
}): string | undefined {
  if (assertion.transform !== undefined) return assertion.transform;
  return ["llm-rubric", "not-llm-rubric"].includes(assertion.type)
    ? GRADING_EVIDENCE_TRANSFORM
    : undefined;
}
