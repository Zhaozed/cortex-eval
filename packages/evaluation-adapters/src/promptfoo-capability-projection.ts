/** SHA-256 of the exact locked Promptfoo 0.121.18 capability-matrix file. */
export const PROMPTFOO_CAPABILITY_MATRIX_HASH =
  "b54aa14dad492c544a3be72776f41b64cd70d0d658758cbcdff717bdadd9f3d3";

// This is a dependency projection, not an Assertion construction whitelist.
const EVALUATOR_ASSERTION_TYPES: ReadonlySet<string> = new Set([
  "agent-rubric",
  "answer-relevance",
  "context-faithfulness",
  "context-recall",
  "context-relevance",
  "conversation-relevance",
  "factuality",
  "g-eval",
  "llm-rubric",
  "model-graded-closedqa",
  "model-graded-factuality",
  "trajectory:goal-success",
  "search-rubric",
  "not-agent-rubric",
  "not-answer-relevance",
  "not-context-faithfulness",
  "not-context-recall",
  "not-context-relevance",
  "not-conversation-relevance",
  "not-factuality",
  "not-g-eval",
  "not-llm-rubric",
  "not-model-graded-closedqa",
  "not-model-graded-factuality",
  "not-trajectory:goal-success",
  "not-search-rubric",
  "select-best"
]);

/** Interpreter dependency used only for stage preflight, never Assertion admission. */
export type PromptfooAssertionRuntimeDependency = "PYTHON" | "RUBY" | null;

/** Project the locked interpreter dependency without restricting Assertion construction. */
export function promptfooAssertionRuntimeDependency(
  assertionType: string
): PromptfooAssertionRuntimeDependency {
  if (assertionType === "python" || assertionType === "not-python") return "PYTHON";
  if (assertionType === "ruby" || assertionType === "not-ruby") return "RUBY";
  return null;
}

/** Return only whether the locked capability declares an Evaluator dependency. */
export function promptfooAssertionRequiresEvaluator(assertionType: string): boolean {
  return EVALUATOR_ASSERTION_TYPES.has(assertionType);
}

/** Expose the sorted dependency projection only for matrix drift verification. */
export function promptfooEvaluatorAssertionTypes(): readonly string[] {
  return [...EVALUATOR_ASSERTION_TYPES].sort((left, right) => left.localeCompare(right));
}
