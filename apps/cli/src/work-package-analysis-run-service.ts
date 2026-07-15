import type { AnalysisModelClient } from "@cortex-eval/application/src/features/case-analysis/case-analysis-model-client.ts";
import type { AnalysisCaseFacts } from "@cortex-eval/application/src/features/case-analysis/case-analysis-input-builder.ts";
import {
  FrozenAnalysisEngine,
  type FrozenAnalysisCaseSource
} from "@cortex-eval/application/src/features/case-analysis/frozen-analysis-engine.ts";
import type { ImportedExecutionReportCase } from "@cortex-eval/application/src/features/execution-imports/execution-import-models.ts";
import { ERROR_CODES, type ErrorCode } from "@cortex-eval/contracts/src/error-contracts.ts";
import {
  OrderedAnalysisFinalCaseResultSetHasher,
  type AnalysisSelector
} from "@cortex-eval/domain/src/domain-hash-inputs.ts";
import {
  openWorkPackageExecutionSession,
  type PublishedStageArtifact,
  type WorkPackageExecutionContextHasher
} from "@cortex-eval/work-package/src/work-package-execution-session.ts";
import type { WorkPackageCaseDefinitionHasher } from "@cortex-eval/work-package/src/work-package-input-reader.ts";
import type { WorkPackageEvalSemanticHashing } from "@cortex-eval/work-package/src/work-package-evaluation-retry-reader.ts";
import { WorkPackageAnalysisArtifactWriter } from "@cortex-eval/work-package/src/work-package-analysis-artifact-writer.ts";
import type { WorkPackageRestSemanticHashing } from "@cortex-eval/work-package/src/work-package-rest-retry-reader.ts";

import type { CliProcessIdentity } from "./package-command-service.ts";

const ERROR_CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES);

/** Explicit dependencies for one package-local Analysis stage. */
export interface WorkPackageAnalysisRunServiceDependencies {
  /** Pure Execution context hash Port. */
  readonly contextHasher: WorkPackageExecutionContextHasher;
  /** Pure Case Definition hash Port. */
  readonly caseHasher: WorkPackageCaseDefinitionHasher;
  /** Pure REST semantic hash Ports. */
  readonly restHashing: WorkPackageRestSemanticHashing;
  /** Pure Evaluation and Final Case semantic hash Ports. */
  readonly evalHashing: WorkPackageEvalSemanticHashing;
  /** Direct no-retry structured Analyzer client. */
  readonly modelClient: AnalysisModelClient;
  /** Operating-system process identity adapter. */
  readonly processIdentity: CliProcessIdentity;
  /** Collision-resistant package temporary-name source. */
  readonly nonce: () => string;
  /** UTC clock used by durable transitions and Artifact identity. */
  readonly now: () => string;
  /** Externalized safe isolated Analyzer error message resolver. */
  readonly errorMessage: (code: string) => string;
}

/** Input for one independent Analysis stage on a reported Execution. */
export interface WorkPackageAnalysisRunInput {
  /** Existing validated Work Package directory. */
  readonly packagePath: string;
  /** Existing Execution whose Report stage succeeded. */
  readonly executionId: string;
  /** Explicit analyzable result selector. */
  readonly selector: AnalysisSelector;
  /** Command cancellation signal. */
  readonly signal: AbortSignal;
}

/** Non-sensitive facts returned after the Analysis Artifact is registered. */
export interface WorkPackageAnalysisRunResult {
  /** Immutable Work Package identity. */
  readonly packageId: string;
  /** Immutable offline Execution version identity. */
  readonly executionId: string;
  /** Explicit frozen selection rule. */
  readonly selector: AnalysisSelector;
  /** Number of selected analyzable Cases. */
  readonly selectedCount: number;
  /** Number of successful structured Analyzer outputs. */
  readonly succeededCount: number;
  /** Number of isolated Case-level Analyzer errors. */
  readonly errorCount: number;
  /** Exact selected final Case dependency identity. */
  readonly finalCaseResultSetHash: string;
  /** Complete Analysis result version identity. */
  readonly analysisResultSetHash: string;
  /** Fixed Analysis Artifact path. */
  readonly artifactPath: string;
}

// Preserve public input errors and collapse internal stage failures.
function stableAnalysisError(error: unknown): { readonly code: ErrorCode; readonly error: Error } {
  if (error instanceof Error && ERROR_CODE_SET.has(error.message)) {
    return { code: error.message as ErrorCode, error };
  }
  return {
    code: "ANALYSIS_STAGE_FAILED",
    error: new Error("ANALYSIS_STAGE_FAILED", { cause: error })
  };
}

// Keep pre-claim cancellation non-mutating.
function requireActive(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("REQUEST_ABORTED");
}

// Return whether one normalized Evaluation result is selected explicitly.
function selected(value: ImportedExecutionReportCase, selector: AnalysisSelector): boolean {
  if (selector === "failed") return value.evaluation.status === "FAIL";
  if (selector === "errors") return value.evaluation.status === "EVALUATION_ERROR";
  return value.evaluation.status === "FAIL" || value.evaluation.status === "EVALUATION_ERROR";
}

// Map one fully reconciled Report row into the provider-neutral Analysis source.
function analysisCase(value: ImportedExecutionReportCase): AnalysisCaseFacts {
  const providerOutput =
    value.rest.status === "SUCCEEDED"
      ? value.rest.providerOutput
      : { ok: false as const, errorMessage: value.rest.errorMessage };
  return {
    caseKey: value.testCase.caseKey,
    ordinal: value.testCase.ordinal,
    definitionHash: value.testCase.definitionHash,
    definition: value.testCase.definition,
    providerOutput,
    evaluation: {
      status: value.evaluation.status,
      finalCaseResultHash: value.evaluation.finalCaseResultHash,
      assertions: value.evaluation.assertions,
      diffs: value.evaluation.diffs
    }
  };
}

// Expose a fresh strict Report pass for every Analysis Engine pass.
function analysisSource(
  openCases: () => AsyncIterable<ImportedExecutionReportCase>
): FrozenAnalysisCaseSource {
  return {
    open: async function* (): AsyncGenerator<AnalysisCaseFacts> {
      for await (const value of openCases()) yield analysisCase(value);
    }
  };
}

// Precompute the exact selected dependency identity before claiming the mutable stage.
async function selectedFinalCaseResultSetHash(
  openCases: () => AsyncIterable<ImportedExecutionReportCase>,
  selector: AnalysisSelector,
  signal: AbortSignal
): Promise<string> {
  const hasher = new OrderedAnalysisFinalCaseResultSetHasher();
  for await (const value of openCases()) {
    requireActive(signal);
    if (!selected(value, selector)) continue;
    hasher.add({
      caseKey: value.testCase.caseKey,
      ordinal: value.testCase.ordinal,
      finalCaseResultHash: value.evaluation.finalCaseResultHash
    });
  }
  return hasher.finish(selector);
}

/** Locked offline Analysis orchestration over a previously committed Report. */
export class WorkPackageAnalysisRunService {
  /** Complete explicit service dependencies. */
  readonly #dependencies: WorkPackageAnalysisRunServiceDependencies;

  /** Bind secure file, semantic hashing, Analyzer and time boundaries. */
  public constructor(dependencies: WorkPackageAnalysisRunServiceDependencies) {
    this.#dependencies = dependencies;
  }

  /** Reconcile Report facts, execute Analysis and register one immutable sparse Artifact. */
  public async run(input: WorkPackageAnalysisRunInput): Promise<WorkPackageAnalysisRunResult> {
    const processStartedAt = await this.#dependencies.processIdentity.processStartedAt(process.pid);
    if (processStartedAt === null) throw new Error("WORK_PACKAGE_LOCKED");
    const session = await openWorkPackageExecutionSession({
      rootPath: input.packagePath,
      owner: {
        pid: process.pid,
        processStartedAt,
        executionId: input.executionId,
        acquiredAt: this.#dependencies.now()
      },
      contextHasher: this.#dependencies.contextHasher,
      nonce: this.#dependencies.nonce,
      validationOptions: { allowRawEvidenceUnavailable: true }
    });
    let stageStarted = false;
    let stageCompleted = false;
    let writer: WorkPackageAnalysisArtifactWriter | undefined;
    let published: PublishedStageArtifact | undefined;
    try {
      requireActive(input.signal);
      const execution = session.readExecution(input.executionId);
      if (execution === null) throw new Error("WORK_PACKAGE_INVALID");
      const [report, analysisInputs] = await Promise.all([
        session.prepareReportImport(
          input.executionId,
          this.#dependencies.caseHasher,
          this.#dependencies.restHashing,
          this.#dependencies.evalHashing,
          input.signal
        ),
        session.inputs.readAnalysisInputs()
      ]);
      const finalCaseResultSetHash = await selectedFinalCaseResultSetHash(
        report.openCases,
        input.selector,
        input.signal
      );
      requireActive(input.signal);
      await session.startStage(input.executionId, "ANALYSIS", this.#dependencies.now());
      stageStarted = true;
      writer = await WorkPackageAnalysisArtifactWriter.create({
        session,
        executionId: input.executionId,
        selector: input.selector,
        finalCaseResultSetHash,
        errorMessage: this.#dependencies.errorMessage
      });
      const engine = new FrozenAnalysisEngine(this.#dependencies.modelClient);
      const summary = await engine.execute({
        binding: { kind: "EXECUTION", id: input.executionId },
        source: analysisSource(report.openCases),
        selector: input.selector,
        runContextHash: execution.executionContextHash,
        runContext: {
          packageId: report.packageId,
          executionId: report.executionId,
          executionContextHash: execution.executionContextHash,
          reportResultSetHash: report.reportResultSetHash
        },
        analyzer: analysisInputs.analyzer,
        prompt: analysisInputs.prompt,
        analysisExecutionLimits: execution.analysisExecutionLimits,
        signal: input.signal,
        onResult: (result): Promise<void> => writer?.append(result) ?? Promise.reject(new Error())
      });
      if (summary.finalCaseResultSetHash !== finalCaseResultSetHash) {
        throw new Error("ANALYSIS_STAGE_FAILED");
      }
      requireActive(input.signal);
      const completedAt = this.#dependencies.now();
      const committed = await writer.commit(completedAt);
      published = committed.artifact;
      await session.completeStage(input.executionId, "ANALYSIS", completedAt, [published]);
      stageCompleted = true;
      return {
        packageId: session.packageSummary.packageId,
        executionId: input.executionId,
        selector: input.selector,
        selectedCount: summary.selectedCount,
        succeededCount: summary.succeededCount,
        errorCount: summary.errorCount,
        finalCaseResultSetHash,
        analysisResultSetHash: committed.analysisResultSetHash,
        artifactPath: published.path
      };
    } catch (error) {
      await writer?.abort().catch(() => undefined);
      const stable = stableAnalysisError(
        input.signal.aborted
          ? new Error(stageStarted ? "ANALYSIS_CANCELLED" : "REQUEST_ABORTED", { cause: error })
          : error
      );
      if (published !== undefined && !stageCompleted) {
        await session
          .discardUnregisteredStageArtifact(input.executionId, "ANALYSIS", published)
          .catch(() => undefined);
      }
      if (stageStarted && !stageCompleted) {
        await session.failStage(
          input.executionId,
          "ANALYSIS",
          this.#dependencies.now(),
          stable.code
        );
      }
      throw stable.error;
    } finally {
      await session.close();
    }
  }
}
