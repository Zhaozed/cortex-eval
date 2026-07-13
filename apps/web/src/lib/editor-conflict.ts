import type { CaseDefinitionV1 } from "@cortex-eval/contracts/src/case-contracts.ts";

/** Latest server Case facts displayed beside a preserved Draft. */
export interface CaseConflictSnapshot {
  /** Latest complete Case definition. */
  readonly definition: CaseDefinitionV1;
  /** Latest Case revision. */
  readonly revision: number;
}

/** Case conflict with an existing latest server snapshot. */
export interface PresentCaseEditorConflict {
  /** Explicit latest remote state. */
  readonly remoteState: "PRESENT";
  /** Unsaved local Case Draft. */
  readonly draft: CaseDefinitionV1;
  /** Latest server Case snapshot. */
  readonly serverCase: CaseConflictSnapshot;
  /** Latest aggregate Test Suite revision. */
  readonly serverSuiteRevision: number;
}

/** Case conflict whose latest remote fact is deletion. */
export interface DeletedCaseEditorConflict {
  /** Explicit latest remote state. */
  readonly remoteState: "REMOTE_CASE_DELETED";
  /** Unsaved local Case Draft retained until an explicit decision. */
  readonly draft: CaseDefinitionV1;
  /** Latest aggregate Test Suite revision. */
  readonly serverSuiteRevision: number;
}

/** Case conflict state with independent local and remote facts. */
export type CaseEditorConflict = PresentCaseEditorConflict | DeletedCaseEditorConflict;

/** Input used to create one Case conflict. */
export interface CreateCaseConflictInput {
  /** Unsaved local Case Draft. */
  readonly draft: CaseDefinitionV1;
  /** Refetched latest server Case. */
  readonly serverCase: CaseConflictSnapshot;
  /** Refetched latest Test Suite revision. */
  readonly serverSuiteRevision: number;
}

/** Input used when the latest remote Case fact is deletion. */
export interface CreateDeletedCaseConflictInput {
  /** Unsaved local Case Draft. */
  readonly draft: CaseDefinitionV1;
  /** Refetched latest Test Suite revision. */
  readonly serverSuiteRevision: number;
}

/** Safe Case retry command built from Draft plus latest revisions. */
export interface RetryCaseDraftCommand {
  /** Latest aggregate revision. */
  readonly expectedSuiteRevision: number;
  /** Latest Case revision. */
  readonly expectedCaseRevision: number;
  /** Preserved local definition. */
  readonly definition: CaseDefinitionV1;
}

/** Freeze one explicit Case conflict comparison state. */
export function createCaseConflict(input: CreateCaseConflictInput): PresentCaseEditorConflict {
  return {
    remoteState: "PRESENT",
    draft: structuredClone(input.draft),
    serverCase: input.serverCase,
    serverSuiteRevision: input.serverSuiteRevision
  };
}

/** Preserve a Case Draft without fabricating a retryable remote Case revision. */
export function createDeletedCaseConflict(
  input: CreateDeletedCaseConflictInput
): DeletedCaseEditorConflict {
  return {
    remoteState: "REMOTE_CASE_DELETED",
    draft: structuredClone(input.draft),
    serverSuiteRevision: input.serverSuiteRevision
  };
}

/** Retry the preserved Case Draft against the latest refetched revisions. */
export function retryCaseDraft(conflict: PresentCaseEditorConflict): RetryCaseDraftCommand {
  return {
    expectedSuiteRevision: conflict.serverSuiteRevision,
    expectedCaseRevision: conflict.serverCase.revision,
    definition: conflict.draft
  };
}

/** Explicitly discard a Case Draft and accept the refetched server definition. */
export function acceptCaseSnapshot(conflict: PresentCaseEditorConflict): CaseDefinitionV1 {
  return conflict.serverCase.definition;
}

/** Current Configuration server snapshot carrying a Revision. */
export interface RevisionedConfigurationSnapshot<Definition> {
  /** Resource display name. */
  readonly name: string;
  /** Complete current definition. */
  readonly definition: Definition;
  /** Latest resource revision. */
  readonly revision: number;
}

/** Unsaved Configuration Draft. */
export interface ConfigurationDraft<Definition> {
  /** Locally edited display name. */
  readonly name: string;
  /** Locally edited definition. */
  readonly definition: Definition;
}

/** Configuration conflict state with separate local and server facts. */
export interface ConfigurationEditorConflict<Definition> {
  /** Unsaved local Draft. */
  readonly draft: ConfigurationDraft<Definition>;
  /** Latest refetched server snapshot. */
  readonly serverSnapshot: RevisionedConfigurationSnapshot<Definition>;
}

/** Create one explicit Configuration conflict comparison state. */
export function createConfigurationConflict<Definition>(input: {
  /** Unsaved local Draft. */
  readonly draft: ConfigurationDraft<Definition>;
  /** Latest refetched server snapshot. */
  readonly serverSnapshot: RevisionedConfigurationSnapshot<Definition>;
}): ConfigurationEditorConflict<Definition> {
  return { draft: structuredClone(input.draft), serverSnapshot: input.serverSnapshot };
}

/** Retry a Configuration Draft against the latest refetched revision. */
export function retryConfigurationDraft<Definition>(
  conflict: ConfigurationEditorConflict<Definition>
): ConfigurationDraft<Definition> & { readonly expectedRevision: number } {
  return { ...conflict.draft, expectedRevision: conflict.serverSnapshot.revision };
}

/** Explicitly discard a Configuration Draft and accept the server snapshot. */
export function acceptConfigurationSnapshot<Definition>(
  conflict: ConfigurationEditorConflict<Definition>
): RevisionedConfigurationSnapshot<Definition> {
  return conflict.serverSnapshot;
}
