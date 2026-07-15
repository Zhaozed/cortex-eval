import { assertionDefinitionJson, caseDefinitionJson } from "./domain-case-projection.ts";
import type { DomainJsonObject } from "./domain-canonical-hash.ts";
import type { AnalysisProposalDraft } from "./domain-analysis.ts";

/** Map one complete pure Domain Proposal into stable JSON hash input. */
export function analysisProposalJson(value: AnalysisProposalDraft): DomainJsonObject {
  if (value.action === "REPLACE_CASE") {
    return {
      action: value.action,
      baseDefinitionHash: value.baseDefinitionHash,
      casePayload: caseDefinitionJson(value.casePayload)
    };
  }
  if (value.action === "ADD_ASSERTION") {
    return {
      action: value.action,
      baseDefinitionHash: value.baseDefinitionHash,
      targetAssertionIndex: value.targetAssertionIndex,
      assertion: assertionDefinitionJson(value.assertion)
    };
  }
  if (value.action === "REPLACE_ASSERTION") {
    return {
      action: value.action,
      baseDefinitionHash: value.baseDefinitionHash,
      targetAssertionIndex: value.targetAssertionIndex,
      targetAssertionDefinitionHash: value.targetAssertionDefinitionHash,
      assertion: assertionDefinitionJson(value.assertion)
    };
  }
  return {
    action: value.action,
    baseDefinitionHash: value.baseDefinitionHash,
    targetAssertionIndex: value.targetAssertionIndex,
    targetAssertionDefinitionHash: value.targetAssertionDefinitionHash
  };
}
