import {
  validateAssertionDefinition,
  validateCaseDefinition,
  type AssertionDefinition,
  type CaseDefinition
} from "./domain-evaluation.ts";

/** Fixed Case analysis classifications. */
export type AnalysisClassification =
  "LABEL_ERROR" | "ADDITIONAL_VALID_RESULT" | "NORMAL_FAILURE" | "PARAMETER_VARIANCE";

/** Closed Analysis Input facts that can support an evidence conclusion. */
export type AnalysisEvidenceSource =
  | "case_definition"
  | "provider_output"
  | "failed_assertions"
  | "expected_actual_diffs"
  | "llm_rubric_results"
  | "run_context";

/** Pure Domain evidence fact after the protocol boundary has been cleaned. */
export interface AnalysisEvidenceDraft {
  /** Analysis Input fact that supports this conclusion. */
  readonly source: AnalysisEvidenceSource;
  /** RFC 6901 pointer inside the source, or null when the source as a whole is referenced. */
  readonly fieldPath: string | null;
  /** Non-empty human-readable conclusion derived from the referenced fact. */
  readonly conclusion: string;
}

/** Complete recursive Assertion already cleaned by an outer Mapper. */
export type AnalysisAssertionDraft = AssertionDefinition;

/** Replace the complete Case Definition. */
export interface ReplaceCaseProposalDraft {
  /** Discriminator. */
  action: "REPLACE_CASE";
  /** Base Case Definition hash. */
  baseDefinitionHash: string;
  /** Complete replacement Case payload. */
  casePayload: CaseDefinition;
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
  /** Structured concrete evidence list. */
  evidence: readonly AnalysisEvidenceDraft[];
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
const JSON_POINTER_PATTERN = /^(?:\/(?:[^~/]|~[01])*)*$/;
const ANALYSIS_EVIDENCE_SOURCES = new Set<AnalysisEvidenceSource>([
  "case_definition",
  "provider_output",
  "failed_assertions",
  "expected_actual_diffs",
  "llm_rubric_results",
  "run_context"
]);

// Return whether one already-mapped evidence fact still satisfies Domain invariants.
function isValidEvidence(value: AnalysisEvidenceDraft): boolean {
  return (
    ANALYSIS_EVIDENCE_SOURCES.has(value.source) &&
    (value.fieldPath === null || JSON_POINTER_PATTERN.test(value.fieldPath)) &&
    value.conclusion.trim() !== ""
  );
}

// Return whether a runtime object contains any field forbidden by its discriminator.
function hasAnyField(value: object, fields: readonly string[]): boolean {
  return fields.some((field) => Object.hasOwn(value, field));
}

// Guard dirty Mapper bypasses before calling strongly typed Case validators.
function isCaseDefinitionShape(value: unknown): value is CaseDefinition {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const source = value as Partial<CaseDefinition>;
  const metadata = source.metadata as Partial<CaseDefinition["metadata"]> | undefined;
  const requestBody: unknown = source.requestBody;
  return (
    typeof source.caseKey === "string" &&
    typeof source.description === "string" &&
    typeof source.threshold === "number" &&
    typeof source.task === "string" &&
    requestBody !== null &&
    typeof requestBody === "object" &&
    metadata !== undefined &&
    typeof metadata.requestId === "string" &&
    typeof metadata.taskId === "string" &&
    typeof metadata.businessModule === "string" &&
    typeof metadata.scenarioTag === "string" &&
    Array.isArray(source.assertions)
  );
}

// Guard dirty Mapper bypasses before calling the recursive Assertion validator.
function isAssertionDefinitionShape(value: unknown): value is AssertionDefinition {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const source = value as Partial<AssertionDefinition>;
  return (
    typeof source.type === "string" &&
    typeof source.metric === "string" &&
    typeof source.weight === "number"
  );
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
    result.evidence.some((item) => !isValidEvidence(item)) ||
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
    if (
      !isCaseDefinitionShape(proposal.casePayload) ||
      !validateCaseDefinition(proposal.casePayload).ok
    ) {
      return proposalError("proposal.casePayload");
    }
  }
  if (proposal.action === "ADD_ASSERTION") {
    if (!Object.hasOwn(proposal, "assertion") || !Object.hasOwn(proposal, "targetAssertionIndex")) {
      return proposalError("proposal.assertion");
    }
    if (hasAnyField(proposal, ["casePayload", "targetAssertionDefinitionHash"])) {
      return proposalError("proposal.action");
    }
    if (
      !isAssertionDefinitionShape(proposal.assertion) ||
      validateAssertionDefinition(proposal.assertion) !== null
    ) {
      return proposalError("proposal.assertion");
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
    if (
      !isAssertionDefinitionShape(proposal.assertion) ||
      validateAssertionDefinition(proposal.assertion) !== null
    ) {
      return proposalError("proposal.assertion");
    }
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
  if (targetIndex !== undefined && (!Number.isInteger(targetIndex) || targetIndex < 0)) {
    return proposalError("proposal.targetAssertionIndex");
  }
  return { ok: true, value: result };
}
