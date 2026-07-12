import type { DomainJsonObject, DomainJsonValue } from "./domain-canonical-hash.ts";

/** Fixed Case analysis classifications. */
export type AnalysisClassification =
  "LABEL_ERROR" | "ADDITIONAL_VALID_RESULT" | "NORMAL_FAILURE" | "PARAMETER_VARIANCE";

/** Typed Assertion draft already cleaned by an outer Mapper. */
export interface AnalysisAssertionDraft {
  /** Assertion type. */
  type: string;
  /** Metric name. */
  metric: string;
  /** Optional JSON-compatible value. */
  value?: DomainJsonValue;
}

/** Replace the complete Case Definition. */
export interface ReplaceCaseProposalDraft {
  /** Discriminator. */
  action: "REPLACE_CASE";
  /** Base Case Definition hash. */
  baseDefinitionHash: string;
  /** Complete replacement Case payload. */
  casePayload: Readonly<DomainJsonObject>;
}

/** Insert one Assertion. */
export interface AddAssertionProposalDraft {
  /** Discriminator. */
  action: "ADD_ASSERTION";
  /** Base Case Definition hash. */
  baseDefinitionHash: string;
  /** Insertion index. */
  targetAssertionIndex: number;
  /** New Assertion. */
  assertion: AnalysisAssertionDraft;
}

/** Replace one identified Assertion. */
export interface ReplaceAssertionProposalDraft {
  /** Discriminator. */
  action: "REPLACE_ASSERTION";
  /** Base Case Definition hash. */
  baseDefinitionHash: string;
  /** Target index. */
  targetAssertionIndex: number;
  /** Target Assertion hash. */
  targetAssertionDefinitionHash: string;
  /** Replacement Assertion. */
  assertion: AnalysisAssertionDraft;
}

/** Remove one identified Assertion. */
export interface RemoveAssertionProposalDraft {
  /** Discriminator. */
  action: "REMOVE_ASSERTION";
  /** Base Case Definition hash. */
  baseDefinitionHash: string;
  /** Target index. */
  targetAssertionIndex: number;
  /** Target Assertion hash. */
  targetAssertionDefinitionHash: string;
}

/** Action-safe Proposal discriminated union. */
export type AnalysisProposalDraft =
  | ReplaceCaseProposalDraft
  | AddAssertionProposalDraft
  | ReplaceAssertionProposalDraft
  | RemoveAssertionProposalDraft;

/** Typed analysis result candidate. */
export interface AnalysisResultDraft {
  /** Fixed classification. */
  classification: AnalysisClassification;
  /** Model self-assessed confidence. */
  confidence: number;
  /** Concrete evidence list. */
  evidence: readonly string[];
  /** Explanation. */
  explanation: string;
  /** Recommended action text. */
  recommendedAction: string;
  /** Optional single Proposal. */
  proposal?: AnalysisProposalDraft;
}

/** Analysis validation failure. */
export interface AnalysisValidationError {
  /** Stable error code. */
  code: "ANALYSIS_OUTPUT_INVALID" | "ANALYSIS_PROPOSAL_INVALID";
  /** Stable fact path. */
  path: string;
}

/** Precise validation result. */
export type AnalysisValidationResult =
  { ok: true; value: AnalysisResultDraft } | { ok: false; error: AnalysisValidationError };

const HASH_PATTERN = /^[0-9a-f]{64}$/;

// Return whether a runtime object contains any field forbidden by its discriminator.
function hasAnyField(value: object, fields: readonly string[]): boolean {
  return fields.some((field) => Object.hasOwn(value, field));
}

// Return a stable Proposal error path.
function proposalError(path: string): AnalysisValidationResult {
  return { ok: false, error: { code: "ANALYSIS_PROPOSAL_INVALID", path } };
}

/** Validate analysis invariants after boundary mapping. */
export function validateAnalysisResult(result: AnalysisResultDraft): AnalysisValidationResult {
  if (
    !Number.isFinite(result.confidence) ||
    result.confidence < 0 ||
    result.confidence > 1 ||
    result.evidence.length === 0 ||
    result.evidence.some((item) => item.trim() === "") ||
    result.explanation.trim() === "" ||
    result.recommendedAction.trim() === ""
  ) {
    return { ok: false, error: { code: "ANALYSIS_OUTPUT_INVALID", path: "analysis" } };
  }
  const proposal = result.proposal;
  if (proposal === undefined) {
    return { ok: true, value: result };
  }
  if (!HASH_PATTERN.test(proposal.baseDefinitionHash)) {
    return proposalError("proposal.baseDefinitionHash");
  }
  if (proposal.action === "REPLACE_CASE") {
    if (!Object.hasOwn(proposal, "casePayload")) return proposalError("proposal.casePayload");
    if (
      hasAnyField(proposal, ["assertion", "targetAssertionIndex", "targetAssertionDefinitionHash"])
    ) {
      return proposalError("proposal.action");
    }
  }
  if (proposal.action === "ADD_ASSERTION") {
    if (!Object.hasOwn(proposal, "assertion") || !Object.hasOwn(proposal, "targetAssertionIndex")) {
      return proposalError("proposal.assertion");
    }
    if (hasAnyField(proposal, ["casePayload", "targetAssertionDefinitionHash"])) {
      return proposalError("proposal.action");
    }
  }
  if (proposal.action === "REPLACE_ASSERTION") {
    if (
      !Object.hasOwn(proposal, "assertion") ||
      !Object.hasOwn(proposal, "targetAssertionIndex") ||
      !Object.hasOwn(proposal, "targetAssertionDefinitionHash")
    ) {
      return proposalError("proposal.assertion");
    }
    if (hasAnyField(proposal, ["casePayload"])) return proposalError("proposal.action");
  }
  if (proposal.action === "REMOVE_ASSERTION") {
    if (hasAnyField(proposal, ["assertion"])) return proposalError("proposal.assertion");
    if (
      !Object.hasOwn(proposal, "targetAssertionIndex") ||
      !Object.hasOwn(proposal, "targetAssertionDefinitionHash")
    ) {
      return proposalError("proposal.targetAssertionIndex");
    }
    if (hasAnyField(proposal, ["casePayload"])) return proposalError("proposal.action");
  }
  const targetHash =
    "targetAssertionDefinitionHash" in proposal
      ? proposal.targetAssertionDefinitionHash
      : undefined;
  if (targetHash !== undefined && !HASH_PATTERN.test(targetHash)) {
    return proposalError("proposal.targetAssertionDefinitionHash");
  }
  const targetIndex =
    "targetAssertionIndex" in proposal ? proposal.targetAssertionIndex : undefined;
  if (targetIndex !== undefined && targetIndex < 0) {
    return proposalError("proposal.targetAssertionIndex");
  }
  return { ok: true, value: result };
}
