import { ERROR_CODES, type ErrorCode } from "@cortex-eval/contracts/src/error-contracts.ts";
import {
  openWorkPackageExecutionSession,
  type WorkPackageExecutionContextHasher
} from "@cortex-eval/work-package/src/work-package-execution-session.ts";
import type { WorkPackageCaseDefinitionHasher } from "@cortex-eval/work-package/src/work-package-input-reader.ts";
import type { WorkPackageEvalSemanticHashing } from "@cortex-eval/work-package/src/work-package-evaluation-retry-reader.ts";
import {
  WorkPackageReportArtifactWriter,
  type ReportArtifactCleanupFailureSink
} from "@cortex-eval/work-package/src/work-package-report-artifact-writer.ts";
import {
  prepareWorkPackageReport,
  type PreparedWorkPackageReport
} from "@cortex-eval/work-package/src/work-package-report-reader.ts";
import type { WorkPackageRestSemanticHashing } from "@cortex-eval/work-package/src/work-package-rest-retry-reader.ts";

import type { CliProcessIdentity } from "./package-command-service.ts";

const ERROR_CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES);

/** Explicit dependencies for one package-local Report stage. */
export interface WorkPackageReportRunServiceDependencies {
  /** Pure Execution context hash Port. */
  readonly contextHasher: WorkPackageExecutionContextHasher;
  /** Pure Case Definition hash Port. */
  readonly caseHasher: WorkPackageCaseDefinitionHasher;
  /** Pure REST semantic hash Ports. */
  readonly restHashing: WorkPackageRestSemanticHashing;
  /** Pure Evaluation and Final Case semantic hash Ports. */
  readonly evalHashing: WorkPackageEvalSemanticHashing;
  /** Operating-system process identity adapter. */
  readonly processIdentity: CliProcessIdentity;
  /** Collision-resistant package temporary-name source. */
  readonly nonce: () => string;
  /** UTC clock used by durable transitions and Report identity. */
  readonly now: () => string;
  /** Safe observer for post-publication cleanup failures. */
  readonly cleanupFailureSink: ReportArtifactCleanupFailureSink;
}

/** Input for one independent Report stage on an evaluated Execution. */
export interface WorkPackageReportRunInput {
  /** Existing validated Work Package directory. */
  readonly packagePath: string;
  /** Existing Execution whose Evaluation stage succeeded. */
  readonly executionId: string;
  /** Command cancellation signal. */
  readonly signal: AbortSignal;
}

/** Non-sensitive facts returned after both Report Artifacts are registered. */
export interface WorkPackageReportRunResult {
  /** Immutable Work Package identity. */
  readonly packageId: string;
  /** Immutable offline Execution version identity. */
  readonly executionId: string;
  /** Complete Evaluation result-set version consumed by Reporting. */
  readonly evaluationResultSetHash: string;
  /** Complete owner-bound Report result-set version. */
  readonly reportResultSetHash: string;
  /** Complete stable report summary. */
  readonly summary: PreparedWorkPackageReport["aggregation"]["summary"];
  /** Fixed Report JSON Artifact path. */
  readonly reportJsonPath: string;
  /** Fixed Report Markdown Artifact path. */
  readonly reportMarkdownPath: string;
}

// Preserve stable public errors and collapse implementation details into Report reconciliation.
function stableReportError(error: unknown): { readonly code: ErrorCode; readonly error: Error } {
  if (error instanceof Error && ERROR_CODE_SET.has(error.message)) {
    return { code: error.message as ErrorCode, error };
  }
  return {
    code: "REPORT_RECONCILIATION_FAILED",
    error: new Error("REPORT_RECONCILIATION_FAILED", { cause: error })
  };
}

// Keep pre-claim cancellation non-mutating and settle post-claim cancellation durably.
function requireActive(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("REQUEST_ABORTED");
}

/** Locked offline Report orchestration with two-pass bounded-memory reconciliation. */
export class WorkPackageReportRunService {
  /** Complete explicit service dependencies. */
  readonly #dependencies: WorkPackageReportRunServiceDependencies;

  /** Bind secure file, semantic hashing, process and time boundaries. */
  public constructor(dependencies: WorkPackageReportRunServiceDependencies) {
    this.#dependencies = dependencies;
  }

  /** Reconcile three immutable streams and atomically register JSON plus Markdown. */
  public async run(input: WorkPackageReportRunInput): Promise<WorkPackageReportRunResult> {
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
    let writer: WorkPackageReportArtifactWriter | undefined;
    try {
      requireActive(input.signal);
      const execution = session.readExecution(input.executionId);
      if (execution === null) throw new Error("WORK_PACKAGE_INVALID");
      const [rest, evaluation, context] = await Promise.all([
        session.prepareRestResults(input.executionId, this.#dependencies.restHashing, input.signal),
        session.prepareEvaluationResultsForReport(
          input.executionId,
          this.#dependencies.restHashing,
          this.#dependencies.evalHashing,
          input.signal
        ),
        session.inputs.readReportContext(
          execution.executionContextHash,
          execution.runExecutionLimits,
          session.inputs.streamCases(this.#dependencies.caseHasher, input.signal)
        )
      ]);
      const prepared = await prepareWorkPackageReport({
        owner: { kind: "EXECUTION", id: input.executionId },
        runContextHash: execution.executionContextHash,
        evaluationContextHash: evaluation.evaluationContextHash,
        evaluationResultSetHash: evaluation.resultSetHash,
        expectedCaseKey: (ordinal): string | null => session.inputs.expectedCaseKey(ordinal),
        openCases: () => session.inputs.streamCases(this.#dependencies.caseHasher, input.signal),
        openRestResults: (): typeof rest.results => rest.results,
        openEvaluationResults: (): typeof evaluation.results => evaluation.results
      });
      requireActive(input.signal);
      await session.startStage(input.executionId, "REPORT", this.#dependencies.now());
      stageStarted = true;
      const completedAt = this.#dependencies.now();
      writer = await WorkPackageReportArtifactWriter.create({
        session,
        executionId: input.executionId,
        context,
        evaluationContextHash: evaluation.evaluationContextHash,
        evaluationResultSetHash: evaluation.resultSetHash,
        aggregation: prepared.aggregation,
        completedAt,
        cleanupFailureSink: this.#dependencies.cleanupFailureSink
      });
      for await (const item of prepared.openCases()) {
        requireActive(input.signal);
        await writer.append(item);
      }
      requireActive(input.signal);
      const artifacts = await writer.commitStage();
      const reportJson = artifacts.find((artifact) => artifact.kind === "REPORT_JSON");
      const reportMarkdown = artifacts.find((artifact) => artifact.kind === "REPORT_MARKDOWN");
      if (reportJson === undefined || reportMarkdown === undefined)
        throw new Error("INTERNAL_ERROR");
      return {
        packageId: session.packageSummary.packageId,
        executionId: input.executionId,
        evaluationResultSetHash: evaluation.resultSetHash,
        reportResultSetHash: prepared.aggregation.reportResultSetHash,
        summary: prepared.aggregation.summary,
        reportJsonPath: reportJson.path,
        reportMarkdownPath: reportMarkdown.path
      };
    } catch (error) {
      await writer?.abort().catch(() => undefined);
      const stable = stableReportError(
        input.signal.aborted ? new Error("REQUEST_ABORTED", { cause: error }) : error
      );
      if (stageStarted) {
        await session.failStage(input.executionId, "REPORT", this.#dependencies.now(), stable.code);
      }
      throw stable.error;
    } finally {
      await session.close();
    }
  }
}
