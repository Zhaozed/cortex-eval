import type {
  AnalysisProposalDraft,
  AnalysisResultDraft
} from "@cortex-eval/domain/src/domain-analysis.ts";
import type {
  AnalysisApplyStatus,
  AnalysisDecision,
  AnalysisStatus
} from "@cortex-eval/domain/src/domain-analysis-state.ts";
import type { DomainJsonObject } from "@cortex-eval/domain/src/domain-canonical-hash.ts";

import type { FrozenAnalysisExecutionLimits } from "./case-analysis-input-builder.ts";

/** Frozen Analysis Prompt facts retained by one current Analysis. */
export interface StoredAnalysisPromptSnapshot {
  /** Current resource identity for platform starts, absent for offline import. */
  readonly sourceId: string | null;
  /** Stable Prompt key. */
  readonly promptKey: string;
  /** Semantic Prompt hash. */
  readonly promptHash: string;
  /** Redacted versioned Prompt snapshot. */
  readonly snapshot: DomainJsonObject;
}

/** Frozen Analyzer facts retained by one current Analysis. */
export interface StoredAnalyzerSnapshot {
  /** Current resource identity for platform starts, absent for offline import. */
  readonly sourceId: string | null;
  /** Semantic Analyzer config hash. */
  readonly configHash: string;
  /** Frozen provider discriminator. */
  readonly provider: "GOOGLE_GEMINI" | "OPENAI_COMPATIBLE";
  /** Frozen model identifier. */
  readonly model: string;
  /** Redacted versioned Analyzer snapshot. */
  readonly snapshot: DomainJsonObject;
}

/** Current Run/Case Analysis persisted without history rows. */
export interface CurrentCaseAnalysis {
  /** Current Analysis invocation identity. */
  readonly id: string;
  /** Owning immutable Run version. */
  readonly runId: string;
  /** Frozen Case key. */
  readonly caseKey: string;
  /** Bound final Case result identity. */
  readonly finalCaseResultHash: string;
  /** Current optimistic Analysis revision. */
  readonly revision: number;
  /** Frozen Analysis Prompt. */
  readonly prompt: StoredAnalysisPromptSnapshot;
  /** Frozen Analyzer. */
  readonly analyzer: StoredAnalyzerSnapshot;
  /** Input contract identity. */
  readonly analysisInputContractVersion: "cortex.analysis-input.v1";
  /** Output contract identity. */
  readonly analysisOutputContractVersion: "cortex.analysis-output.v1";
  /** Complete Analysis Input identity. */
  readonly analysisInputHash: string;
  /** Frozen Analysis execution limits. */
  readonly analysisExecutionLimits: FrozenAnalysisExecutionLimits;
  /** Current lifecycle status. */
  readonly status: AnalysisStatus;
  /** Successful structured output, absent otherwise. */
  readonly output: AnalysisResultDraft | null;
  /** Complete semantic Analysis result identity, absent before terminal output. */
  readonly analysisResultHash: string | null;
  /** Current Proposal decision. */
  readonly decision: AnalysisDecision;
  /** Current Proposal apply status. */
  readonly applyStatus: AnalysisApplyStatus;
  /** Proposal base Case Definition identity. */
  readonly baseDefinitionHash: string | null;
  /** Applied Case Definition identity. */
  readonly appliedDefinitionHash: string | null;
  /** Stable terminal Case error code. */
  readonly errorCode: string | null;
  /** Safe externalized terminal Case error message. */
  readonly errorMessage: string | null;
  /** Current Analysis creation time. */
  readonly createdAt: string;
  /** Latest current Analysis update time. */
  readonly updatedAt: string;
}

/** Pending Analysis facts frozen before the model side effect. */
export interface ReplaceCurrentAnalysisInput {
  /** New Analysis invocation identity. */
  readonly id: string;
  /** Owning immutable Run. */
  readonly runId: string;
  /** Frozen Case key. */
  readonly caseKey: string;
  /** Exact analyzable final Case result. */
  readonly finalCaseResultHash: string;
  /** Null for first Analysis; exact current revision for reanalysis. */
  readonly expectedRevision: number | null;
  /** Frozen Analysis Prompt. */
  readonly prompt: StoredAnalysisPromptSnapshot;
  /** Frozen Analyzer. */
  readonly analyzer: StoredAnalyzerSnapshot;
  /** Complete Analysis Input identity. */
  readonly analysisInputHash: string;
  /** Frozen Analysis execution limits. */
  readonly analysisExecutionLimits: FrozenAnalysisExecutionLimits;
  /** Current Analysis creation/update timestamp. */
  readonly timestamp: string;
}

/** Terminal successful or failed Case result committed after RUNNING. */
export type CompleteCurrentAnalysisInput =
  | {
      readonly id: string;
      readonly expectedRevision: number;
      readonly analysisResultHash: string;
      readonly result: { readonly status: "SUCCEEDED"; readonly output: AnalysisResultDraft };
      readonly errorMessage: null;
      readonly timestamp: string;
    }
  | {
      readonly id: string;
      readonly expectedRevision: number;
      readonly analysisResultHash: string;
      readonly result: { readonly status: "ERROR"; readonly errorCode: string };
      readonly errorMessage: string;
      readonly timestamp: string;
    };

/** Terminal accepted Proposal decision recorded with the atomic Case write outcome. */
export interface RecordProposalApplicationInput {
  /** Current Analysis invocation identity. */
  readonly id: string;
  /** Exact current Analysis revision. */
  readonly expectedRevision: number;
  /** Whether the original or a user-edited Proposal was accepted. */
  readonly decision: "ACCEPTED" | "EDITED_AND_ACCEPTED";
  /** Atomic Case write result. */
  readonly applyStatus: "APPLIED" | "CONFLICT";
  /** New Case Definition hash only when the Case write committed. */
  readonly appliedDefinitionHash: string | null;
  /** Current Analysis update timestamp. */
  readonly timestamp: string;
}

/** Exact conditional current Analysis mutation result. */
export type CurrentAnalysisMutationResult =
  | { readonly ok: true; readonly analysis: CurrentCaseAnalysis }
  | {
      readonly ok: false;
      readonly reason:
        | "RUN_NOT_FOUND"
        | "FINAL_RESULT_MISMATCH"
        | "ANALYSIS_REVISION_CONFLICT"
        | "ANALYSIS_STATE_CONFLICT";
      readonly current: CurrentCaseAnalysis | null;
    };

/** Proposal payload stored in a current successful Analysis. */
export type StoredAnalysisProposal = AnalysisProposalDraft;

/** Exact immutable identity of the latest offline Analysis Artifact imported for one Execution. */
export interface ImportedAnalysisIdentity {
  /** Explicit frozen selection rule. */
  readonly selector: "failed" | "errors" | "all";
  /** Report version that supplied the final Case facts. */
  readonly reportResultSetHash: string;
  /** Exact selected final Case dependency identity. */
  readonly finalCaseResultSetHash: string;
  /** Complete Analysis result version identity. */
  readonly analysisResultSetHash: string;
  /** Controlled Analysis Artifact path. */
  readonly artifactPath: string;
  /** Exact Analysis Artifact byte identity. */
  readonly artifactSha256: string;
  /** Exact Analysis Artifact byte size. */
  readonly artifactSizeBytes: number;
}

/** Existing imported Report Run and its optional latest Analysis import identity. */
export interface ImportedAnalysisRunContext {
  /** Platform Run identity allocated by Report import. */
  readonly runId: string;
  /** Immutable Work Package identity. */
  readonly packageId: string;
  /** Complete imported Report identity. */
  readonly reportResultSetHash: string;
  /** Latest imported Analysis Artifact, absent before the first Analysis import. */
  readonly analysisIdentity: ImportedAnalysisIdentity | null;
}

interface ImportedAnalysisCaseBase {
  /** Stable Suite-local Case key. */
  readonly caseKey: string;
  /** Exact final Evaluation fact identity. */
  readonly finalCaseResultHash: string;
  /** Complete Analysis input identity. */
  readonly analysisInputHash: string;
  /** Complete Analysis result identity. */
  readonly analysisResultHash: string;
}

/** Clean terminal Analysis Case accepted by the Application import boundary. */
export type ImportedAnalysisCase =
  | (ImportedAnalysisCaseBase & {
      /** Successful result discriminator. */
      readonly status: "SUCCEEDED";
      /** Validated structured Analysis output. */
      readonly output: AnalysisResultDraft;
    })
  | (ImportedAnalysisCaseBase & {
      /** Isolated error discriminator. */
      readonly status: "ERROR";
      /** Stable closed Analyzer error code. */
      readonly errorCode: string;
      /** Safe localized Analyzer error message. */
      readonly errorMessage: string;
    });

/** One imported Analysis Case with its preallocated replacement identity. */
export type StagedImportedAnalysisCase = ImportedAnalysisCase & {
  /** Replacement Analysis identity allocated before the write transaction. */
  readonly id: string;
};

/** Common frozen facts used to reconcile all staged Analysis Cases. */
export interface ReconcileStagedAnalysisInput {
  /** Existing imported Report Run identity. */
  readonly runId: string;
  /** Frozen Analysis Prompt snapshot. */
  readonly prompt: StoredAnalysisPromptSnapshot;
  /** Frozen Analyzer snapshot. */
  readonly analyzer: StoredAnalyzerSnapshot;
  /** Frozen Analysis execution limits. */
  readonly analysisExecutionLimits: FrozenAnalysisExecutionLimits;
  /** Single import timestamp. */
  readonly timestamp: string;
}
