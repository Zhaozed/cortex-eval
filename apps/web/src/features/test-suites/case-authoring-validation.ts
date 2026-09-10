import type { AssertionDefinitionV1 } from "@cortex-eval/contracts/src/case-contracts.ts";
import {
  ASSERTION_ISSUES,
  assertionAuthoringIssue
} from "@cortex-eval/contracts/src/assertion-rules/authoring-validation.ts";

/** Guided and advanced editors use the same rule checks as the server. */
export function caseAssertionAuthoringError(assertion: AssertionDefinitionV1): string | null {
  const issue = assertionAuthoringIssue(assertion);
  return issue ? ASSERTION_ISSUES[issue.code] : null;
}
