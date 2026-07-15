import type {
  CompleteCurrentAnalysisInput,
  CurrentAnalysisMutationResult,
  CurrentCaseAnalysis,
  RecordProposalApplicationInput,
  ReplaceCurrentAnalysisInput
} from "./case-analysis-models.ts";
import type {
  ImportedAnalysisIdentity,
  ImportedAnalysisRunContext,
  ReconcileStagedAnalysisInput,
  StagedImportedAnalysisCase
} from "./case-analysis-models.ts";
import type { ApplicationTransaction } from "../../application-ports.ts";

/** Transaction-bound current Analysis persistence operations. */
export interface CaseAnalysisRepository {
  /** Locate one already imported complete Report Run by offline Execution identity. */
  readonly getImportedRunContext: (
    executionId: string
  ) => Promise<ImportedAnalysisRunContext | null>;
  /** Replace the latest whole-Artifact import identity after every Case mutation succeeds. */
  readonly setImportedAnalysisIdentity: (
    executionId: string,
    identity: ImportedAnalysisIdentity
  ) => Promise<boolean>;
  /** Read one Run/Case current Analysis. */
  readonly getCurrent: (runId: string, caseKey: string) => Promise<CurrentCaseAnalysis | null>;
  /** Insert a first Analysis or conditionally replace it for reanalysis. */
  readonly replaceCurrent: (
    input: ReplaceCurrentAnalysisInput
  ) => Promise<CurrentAnalysisMutationResult>;
  /** Conditionally claim one PENDING Analysis for external model work. */
  readonly claim: (
    id: string,
    expectedRevision: number,
    timestamp: string
  ) => Promise<CurrentAnalysisMutationResult>;
  /** Conditionally commit one complete success or isolated Case error. */
  readonly complete: (
    input: CompleteCurrentAnalysisInput
  ) => Promise<CurrentAnalysisMutationResult>;
  /** Conditionally reject one current pending Proposal. */
  readonly rejectProposal: (
    id: string,
    expectedRevision: number,
    timestamp: string
  ) => Promise<CurrentAnalysisMutationResult>;
  /** Record the accepted Proposal outcome inside the same transaction as the Case write. */
  readonly recordProposalApplication: (
    input: RecordProposalApplicationInput
  ) => Promise<CurrentAnalysisMutationResult>;
  /** Recover every stale PENDING/RUNNING Analysis into a stable ERROR. */
  readonly recoverUnfinished: (
    timestamp: string,
    errorCode: string,
    errorMessage: string
  ) => Promise<number>;
  /** Recover stale PENDING/RUNNING Analysis rows owned by one exact Run. */
  readonly recoverUnfinishedForRun: (
    runId: string,
    timestamp: string,
    errorCode: string,
    errorMessage: string
  ) => Promise<number>;
}

/** Repository set exposed inside one short Analysis transaction. */
export interface CaseAnalysisTransaction extends ApplicationTransaction {
  /** Current Analysis repository. */
  readonly analyses: CaseAnalysisRepository;
}

/** Managed short transaction boundary for current Analysis facts. */
export interface CaseAnalysisTransactionManager {
  /** Execute database-only Analysis work. */
  readonly execute: <T>(work: (transaction: CaseAnalysisTransaction) => Promise<T>) => Promise<T>;
}

/** Transaction-bound deterministic reconciliation over a closed Analysis staging database. */
export interface StagedAnalysisRepository {
  /** Reconcile all staged terminal Cases into current Analysis rows. */
  readonly reconcileCurrent: (
    input: ReconcileStagedAnalysisInput
  ) => Promise<{ readonly ok: true; readonly importedCount: number } | { readonly ok: false }>;
}

/** One bounded external workspace for cleaned Analysis import rows. */
export interface AnalysisImportStagingSession {
  /** Persist one clean Case or reject a duplicate Case key. */
  readonly stage: (value: StagedImportedAnalysisCase) => Promise<"STAGED" | "CASE_KEY_DUPLICATE">;
  /** Attach the closed staging database and execute one main database transaction. */
  readonly withStagedTransaction: <T>(
    work: (
      transaction: CaseAnalysisTransaction,
      stagedAnalyses: StagedAnalysisRepository
    ) => Promise<T>
  ) => Promise<T>;
  /** Close handles and remove only this owned workspace. */
  readonly cleanup: () => Promise<void>;
}

/** Factory for isolated Analysis import staging sessions. */
export interface AnalysisImportStagingFactory {
  /** Create one owner-identified staging workspace. */
  readonly open: () => Promise<AnalysisImportStagingSession>;
}
