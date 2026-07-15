import {
  validateAnalysisResult,
  type AnalysisProposalDraft
} from "@cortex-eval/domain/src/domain-analysis.ts";

import type { Clock } from "../../application-ports.ts";
import type { CaseDefinitionWriter } from "../test-suites/case-definition-writer.ts";
import type { StoredTestCase } from "../test-suites/test-suite-models.ts";
import { applyAnalysisProposal } from "./analysis-proposal-applier.ts";
import type { CurrentCaseAnalysis } from "./case-analysis-models.ts";
import type {
  CaseAnalysisRepository,
  CaseAnalysisTransaction,
  CaseAnalysisTransactionManager
} from "./case-analysis-ports.ts";

/** Shared identity of the current Proposal decision target. */
export interface ProposalDecisionTarget {
  /** Immutable Run version. */
  readonly runId: string;
  /** Frozen Case key. */
  readonly caseKey: string;
  /** Current Analysis invocation identity. */
  readonly analysisId: string;
  /** Exact optimistic Analysis revision. */
  readonly expectedAnalysisRevision: number;
}

/** Accept command carrying every fact displayed to the user before mutation. */
export interface AcceptAnalysisProposalCommand extends ProposalDecisionTarget {
  /** Exact frozen final Case result identity. */
  readonly expectedFinalCaseResultHash: string;
  /** Exact frozen Analysis Input identity. */
  readonly expectedAnalysisInputHash: string;
  /** Exact frozen Analysis Prompt identity. */
  readonly expectedPromptHash: string;
  /** Exact frozen Analyzer identity. */
  readonly expectedAnalyzerConfigHash: string;
  /** Current owning Suite identity. */
  readonly suiteId: string;
  /** Exact current Suite revision. */
  readonly expectedSuiteRevision: number;
  /** Internal Case identity guarding delete-and-recreate races. */
  readonly expectedCaseId: string;
  /** Exact current Case revision. */
  readonly expectedCaseRevision: number;
  /** Optional complete user-edited Proposal; absent means accept the frozen original. */
  readonly editedProposal?: AnalysisProposalDraft | undefined;
}

/** Stable conflict fact saved when an otherwise-current decision cannot apply. */
export type AnalysisApplyConflictReason =
  | "CASE_VERSION_CHANGED"
  | "ASSERTION_VERSION_CHANGED"
  | "PROMPT_VERSION_CHANGED"
  | "ANALYZER_VERSION_CHANGED"
  | "RUBRIC_PROMPT_CHANGED";

/** Decision result exposed by Application without presentation strings. */
export type AnalysisDecisionResult =
  | {
      readonly ok: true;
      readonly analysis: CurrentCaseAnalysis;
      readonly case?: StoredTestCase | undefined;
    }
  | {
      readonly ok: false;
      readonly error:
        | { readonly code: "ANALYSIS_NOT_FOUND" }
        | {
            readonly code: "ANALYSIS_REVISION_CONFLICT" | "ANALYSIS_STATE_CONFLICT";
            readonly actualRevision: number;
          }
        | { readonly code: "ANALYSIS_PROPOSAL_INVALID"; readonly path: string }
        | {
            readonly code: "ANALYSIS_APPLY_CONFLICT";
            readonly reason: AnalysisApplyConflictReason;
          };
      readonly analysis: CurrentCaseAnalysis | null;
    };

/** Dependencies for short, database-only Proposal decisions. */
export interface CaseAnalysisDecisionServiceDependencies {
  /** Transaction exposing Analysis and current resource repositories together. */
  readonly transactionManager: CaseAnalysisTransactionManager;
  /** Unified Case writer reused inside the existing transaction. */
  readonly caseWriter: CaseDefinitionWriter;
  /** Timestamp source called before entering the transaction. */
  readonly clock: Clock;
}

// Map a conditional repository miss without losing the current visible Analysis fact.
function mutationFailure(
  reason:
    | "RUN_NOT_FOUND"
    | "FINAL_RESULT_MISMATCH"
    | "ANALYSIS_REVISION_CONFLICT"
    | "ANALYSIS_STATE_CONFLICT",
  current: CurrentCaseAnalysis | null
): AnalysisDecisionResult {
  if (current === null) {
    return { ok: false, error: { code: "ANALYSIS_NOT_FOUND" }, analysis: null };
  }
  const code =
    reason === "ANALYSIS_REVISION_CONFLICT"
      ? "ANALYSIS_REVISION_CONFLICT"
      : "ANALYSIS_STATE_CONFLICT";
  return {
    ok: false,
    error: { code, actualRevision: current.revision },
    analysis: current
  };
}

// Return the exact current target or a stable precondition failure.
function targetFailure(
  analysis: CurrentCaseAnalysis | null,
  command: ProposalDecisionTarget
): AnalysisDecisionResult | null {
  if (analysis?.id !== command.analysisId) {
    return { ok: false, error: { code: "ANALYSIS_NOT_FOUND" }, analysis };
  }
  if (analysis.revision !== command.expectedAnalysisRevision) {
    return mutationFailure("ANALYSIS_REVISION_CONFLICT", analysis);
  }
  if (
    analysis.status !== "SUCCEEDED" ||
    analysis.decision !== "PENDING" ||
    analysis.applyStatus !== "NOT_APPLIED" ||
    analysis.output?.proposal === undefined
  ) {
    return mutationFailure("ANALYSIS_STATE_CONFLICT", analysis);
  }
  return null;
}

/** Coordinate reject, accept and edited-accept decisions with exact current identities. */
export class CaseAnalysisDecisionService {
  readonly #dependencies: CaseAnalysisDecisionServiceDependencies;

  /** Bind explicit transaction, writer and time boundaries. */
  public constructor(dependencies: CaseAnalysisDecisionServiceDependencies) {
    this.#dependencies = dependencies;
  }

  /** Reject one still-current Proposal without touching the current Case. */
  public rejectProposal(command: ProposalDecisionTarget): Promise<AnalysisDecisionResult> {
    const timestamp = this.#dependencies.clock.now();
    return this.#dependencies.transactionManager.execute(async (transaction) => {
      const analysis = await transaction.analyses.getCurrent(command.runId, command.caseKey);
      const failure = targetFailure(analysis, command);
      if (failure !== null) return failure;
      const rejected = await transaction.analyses.rejectProposal(
        command.analysisId,
        command.expectedAnalysisRevision,
        timestamp
      );
      if (!rejected.ok) return mutationFailure(rejected.reason, rejected.current);
      return { ok: true, analysis: rejected.analysis };
    });
  }

  /** Accept the original or edited Proposal with atomic Case and decision persistence. */
  public acceptProposal(command: AcceptAnalysisProposalCommand): Promise<AnalysisDecisionResult> {
    const timestamp = this.#dependencies.clock.now();
    return this.#dependencies.transactionManager.execute(async (transaction) => {
      const analysis = await transaction.analyses.getCurrent(command.runId, command.caseKey);
      const failure = targetFailure(analysis, command);
      if (failure !== null) return failure;
      if (analysis?.output?.proposal === undefined) {
        throw new Error("CASE_ANALYSIS_TARGET_NARROWING_FAILED");
      }
      const proposal = command.editedProposal ?? analysis.output.proposal;
      const proposalValidation = validateAnalysisResult({ ...analysis.output, proposal });
      if (!proposalValidation.ok) {
        return {
          ok: false,
          error: { code: "ANALYSIS_PROPOSAL_INVALID", path: proposalValidation.error.path },
          analysis
        };
      }
      const identityConflict = await this.#findIdentityConflict(transaction, analysis, command);
      if (identityConflict !== null) {
        return this.#recordConflict(
          transaction.analyses,
          analysis,
          command.editedProposal !== undefined,
          identityConflict,
          timestamp
        );
      }
      const suite = await transaction.testSuites.getSuite(command.suiteId);
      const currentCase = await transaction.testSuites.getCase(command.suiteId, command.caseKey);
      if (
        suite === null ||
        currentCase === null ||
        suite.revision !== command.expectedSuiteRevision ||
        currentCase.id !== command.expectedCaseId ||
        currentCase.revision !== command.expectedCaseRevision
      ) {
        return this.#recordConflict(
          transaction.analyses,
          analysis,
          command.editedProposal !== undefined,
          "CASE_VERSION_CHANGED",
          timestamp
        );
      }
      const materialized = applyAnalysisProposal(
        currentCase.definition,
        currentCase.definitionHash,
        proposal
      );
      if (!materialized.ok) {
        const reason =
          materialized.reason === "TARGET_ASSERTION_CONFLICT"
            ? "ASSERTION_VERSION_CHANGED"
            : "CASE_VERSION_CHANGED";
        return this.#recordConflict(
          transaction.analyses,
          analysis,
          command.editedProposal !== undefined,
          reason,
          timestamp
        );
      }
      const written = await this.#dependencies.caseWriter.editCaseWithinTransaction(
        transaction,
        {
          suiteId: command.suiteId,
          caseKey: command.caseKey,
          expectedSuiteRevision: command.expectedSuiteRevision,
          expectedCaseRevision: command.expectedCaseRevision,
          definition: materialized.definition
        },
        timestamp
      );
      if (!written.ok) {
        const reason =
          written.error.code === "RUBRIC_PROMPT_NOT_FOUND"
            ? "RUBRIC_PROMPT_CHANGED"
            : "CASE_VERSION_CHANGED";
        return this.#recordConflict(
          transaction.analyses,
          analysis,
          command.editedProposal !== undefined,
          reason,
          timestamp
        );
      }
      const decided = await transaction.analyses.recordProposalApplication({
        id: analysis.id,
        expectedRevision: analysis.revision,
        decision: command.editedProposal === undefined ? "ACCEPTED" : "EDITED_AND_ACCEPTED",
        applyStatus: "APPLIED",
        appliedDefinitionHash: written.case.definitionHash,
        timestamp
      });
      if (!decided.ok) throw new Error("CASE_ANALYSIS_ATOMIC_DECISION_CONFLICT");
      return { ok: true, analysis: decided.analysis, case: written.case };
    });
  }

  // Validate immutable displayed facts and still-current Prompt/Analyzer resources.
  async #findIdentityConflict(
    transaction: CaseAnalysisTransaction,
    analysis: CurrentCaseAnalysis,
    command: AcceptAnalysisProposalCommand
  ): Promise<AnalysisApplyConflictReason | null> {
    if (
      analysis.finalCaseResultHash !== command.expectedFinalCaseResultHash ||
      analysis.analysisInputHash !== command.expectedAnalysisInputHash
    ) {
      return "CASE_VERSION_CHANGED";
    }
    if (analysis.prompt.promptHash !== command.expectedPromptHash) {
      return "PROMPT_VERSION_CHANGED";
    }
    if (analysis.analyzer.configHash !== command.expectedAnalyzerConfigHash) {
      return "ANALYZER_VERSION_CHANGED";
    }
    if (analysis.prompt.sourceId !== null) {
      const prompt = await transaction.configurations.getResource(
        "CASE_ANALYSIS_PROMPT",
        analysis.prompt.sourceId
      );
      if (prompt?.semanticHash !== analysis.prompt.promptHash) {
        return "PROMPT_VERSION_CHANGED";
      }
    }
    if (analysis.analyzer.sourceId !== null) {
      const analyzer = await transaction.configurations.getResource(
        "LLM",
        analysis.analyzer.sourceId
      );
      if (analyzer?.semanticHash !== analysis.analyzer.configHash) {
        return "ANALYZER_VERSION_CHANGED";
      }
    }
    return null;
  }

  // Persist a user-visible conflict decision without mutating the Case aggregate.
  async #recordConflict(
    repository: CaseAnalysisRepository,
    analysis: CurrentCaseAnalysis,
    edited: boolean,
    reason: AnalysisApplyConflictReason,
    timestamp: string
  ): Promise<AnalysisDecisionResult> {
    const decided = await repository.recordProposalApplication({
      id: analysis.id,
      expectedRevision: analysis.revision,
      decision: edited ? "EDITED_AND_ACCEPTED" : "ACCEPTED",
      applyStatus: "CONFLICT",
      appliedDefinitionHash: null,
      timestamp
    });
    if (!decided.ok) return mutationFailure(decided.reason, decided.current);
    return {
      ok: false,
      error: { code: "ANALYSIS_APPLY_CONFLICT", reason },
      analysis: decided.analysis
    };
  }
}
