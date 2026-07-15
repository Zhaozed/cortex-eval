import {
  assertionDefinitionJson,
  caseDefinitionJson
} from "@cortex-eval/domain/src/domain-case-projection.ts";
import type { AnalysisProposalDraft } from "@cortex-eval/domain/src/domain-analysis.ts";
import type {
  AssertionDefinition,
  CaseDefinition
} from "@cortex-eval/domain/src/domain-evaluation.ts";
import {
  hashAssertionDefinition,
  hashCaseDefinition
} from "@cortex-eval/domain/src/domain-hash-inputs.ts";

/** Stable reason why one frozen Proposal cannot be applied to the current Case. */
export type AnalysisProposalConflictReason =
  "BASE_DEFINITION_CONFLICT" | "CASE_IDENTITY_CONFLICT" | "TARGET_ASSERTION_CONFLICT";

/** Pure Proposal materialization result before the unified Case writer runs. */
export type AnalysisProposalApplyResult =
  | { readonly ok: true; readonly definition: CaseDefinition }
  | { readonly ok: false; readonly reason: AnalysisProposalConflictReason };

// Recompute the semantic Case identity rather than trusting a caller projection.
function definitionHash(definition: CaseDefinition): string {
  return hashCaseDefinition({
    contractVersion: "cortex.case-definition.v1",
    caseKey: definition.caseKey,
    definition: caseDefinitionJson(definition)
  });
}

// Compute the same normalized recursive Assertion identity used by Evaluation.
function assertionHash(assertion: AssertionDefinition): string {
  return hashAssertionDefinition({
    contractVersion: "cortex.assertion-definition.v1",
    definition: assertionDefinitionJson(assertion)
  });
}

// Return the frozen target only when both its position and semantic identity still match.
function targetAssertion(
  definition: CaseDefinition,
  index: number,
  expectedHash: string
): AssertionDefinition | null {
  const target = definition.assertions[index];
  if (target === undefined || assertionHash(target) !== expectedHash) return null;
  return target;
}

/** Materialize one validated Proposal against an exact current Case Definition. */
export function applyAnalysisProposal(
  current: CaseDefinition,
  currentDefinitionHash: string,
  proposal: AnalysisProposalDraft
): AnalysisProposalApplyResult {
  if (
    proposal.baseDefinitionHash !== currentDefinitionHash ||
    definitionHash(current) !== currentDefinitionHash
  ) {
    return { ok: false, reason: "BASE_DEFINITION_CONFLICT" };
  }
  if (proposal.action === "REPLACE_CASE") {
    if (proposal.casePayload.caseKey !== current.caseKey) {
      return { ok: false, reason: "CASE_IDENTITY_CONFLICT" };
    }
    return { ok: true, definition: proposal.casePayload };
  }
  if (proposal.action === "ADD_ASSERTION") {
    if (proposal.targetAssertionIndex > current.assertions.length) {
      return { ok: false, reason: "TARGET_ASSERTION_CONFLICT" };
    }
    const assertions = [...current.assertions];
    assertions.splice(proposal.targetAssertionIndex, 0, proposal.assertion);
    return { ok: true, definition: { ...current, assertions } };
  }
  if (
    targetAssertion(
      current,
      proposal.targetAssertionIndex,
      proposal.targetAssertionDefinitionHash
    ) === null
  ) {
    return { ok: false, reason: "TARGET_ASSERTION_CONFLICT" };
  }
  const assertions = [...current.assertions];
  if (proposal.action === "REPLACE_ASSERTION") {
    assertions[proposal.targetAssertionIndex] = proposal.assertion;
  } else {
    assertions.splice(proposal.targetAssertionIndex, 1);
  }
  return { ok: true, definition: { ...current, assertions } };
}
