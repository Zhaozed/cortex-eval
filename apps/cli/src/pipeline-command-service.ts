import type { WorkPackageExecutionContextHasher } from "@cortex-eval/work-package/src/work-package-execution-session.ts";
import { openWorkPackageExecutionSession } from "@cortex-eval/work-package/src/work-package-execution-session.ts";

import { CliSecretEnvironment } from "./cli-secret-environment.ts";
import type {
  AnalysisRunCommandInput,
  EvaluationRunCommandInput,
  PipelineRunCommandInput,
  RestRunCommandInput
} from "./cli-program.ts";
import type { CliProcessIdentity } from "./package-command-service.ts";
import type { WorkPackageEvaluationRunResult } from "./work-package-evaluation-run-service.ts";
import type {
  WorkPackageReportRunInput,
  WorkPackageReportRunResult
} from "./work-package-report-run-service.ts";
import type { WorkPackageRestRunResult } from "./work-package-rest-run-service.ts";
import type { WorkPackageAnalysisRunResult } from "./work-package-analysis-run-service.ts";

/** REST stage port that consumes the Pipeline's frozen Secret snapshot. */
export interface PreparedRestStageCommand {
  /** Create the Execution and complete its REST stage. */
  readonly runWithEnvironment: (
    input: RestRunCommandInput,
    environment: CliSecretEnvironment
  ) => Promise<WorkPackageRestRunResult>;
}

/** Evaluation stage port that consumes the same frozen Secret snapshot. */
export interface PreparedEvaluationStageCommand {
  /** Validate every predictable Evaluation dependency before REST mutation. */
  readonly preflightWithEnvironment: (
    input: { readonly packagePath: string; readonly signal: AbortSignal },
    environment: CliSecretEnvironment
  ) => Promise<void>;
  /** Complete Evaluation on the REST stage's exact Execution. */
  readonly runWithEnvironment: (
    input: EvaluationRunCommandInput,
    environment: CliSecretEnvironment
  ) => Promise<WorkPackageEvaluationRunResult>;
}

/** Report stage port that consumes the completed Evaluation version. */
export interface PreparedReportStageCommand {
  /** Complete Report JSON and Markdown on the Evaluation stage's exact Execution. */
  readonly run: (input: WorkPackageReportRunInput) => Promise<WorkPackageReportRunResult>;
}

/** Optional Analysis stage port that consumes the Pipeline's frozen Secret snapshot. */
export interface PreparedAnalysisStageCommand {
  /** Validate immutable Analyzer inputs and Secrets before REST mutation. */
  readonly preflightWithEnvironment: (
    input: { readonly packagePath: string; readonly signal: AbortSignal },
    environment: CliSecretEnvironment
  ) => Promise<void>;
  /** Complete Analysis after Report on the same Execution version. */
  readonly runWithEnvironment: (
    input: AnalysisRunCommandInput,
    environment: CliSecretEnvironment
  ) => Promise<WorkPackageAnalysisRunResult>;
}

/** Explicit dependencies for the closed REST to Evaluation to Report Pipeline. */
export interface LocalPipelineCommandServiceDependencies {
  /** Pure Execution context hash Port. */
  readonly contextHasher: WorkPackageExecutionContextHasher;
  /** Collision-resistant staging nonce source. */
  readonly nonce: () => string;
  /** UTC clock. */
  readonly now: () => string;
  /** Operating-system process identity adapter. */
  readonly processIdentity: CliProcessIdentity;
  /** Inherited process environment snapshot source. */
  readonly inheritedEnvironment: () => Readonly<Record<string, string | undefined>>;
  /** Prepared REST stage command. */
  readonly restCommands: PreparedRestStageCommand;
  /** Prepared Evaluation stage command. */
  readonly evaluationCommands: PreparedEvaluationStageCommand;
  /** Prepared Report stage command. */
  readonly reportCommands: PreparedReportStageCommand;
  /** Prepared optional Analysis stage command. */
  readonly analysisCommands: PreparedAnalysisStageCommand;
}

/** Complete P8 default Pipeline completion projection. */
export interface WorkPackagePipelineRunResult {
  /** Immutable Work Package identity. */
  readonly packageId: string;
  /** Newly created immutable Execution identity. */
  readonly executionId: string;
  /** Number of ordinary per-Case REST errors. */
  readonly restErrorCount: number;
  /** Complete REST Result Set identity. */
  readonly restResultSetHash: string;
  /** Fixed REST Artifact path. */
  readonly restArtifactPath: string;
  /** Native Promptfoo success or Assertion-fail code. */
  readonly promptfooExitCode: 0 | 100;
  /** Number of normalized FAIL Cases. */
  readonly evalFailCount: number;
  /** Number of normalized Evaluation errors. */
  readonly evalErrorCount: number;
  /** Complete Evaluation Result Set identity. */
  readonly evaluationResultSetHash: string;
  /** Fixed Raw Promptfoo Artifact path. */
  readonly rawArtifactPath: string;
  /** Fixed Normalized Eval Artifact path. */
  readonly normalizedArtifactPath: string;
  /** Complete Report Result Set identity. */
  readonly reportResultSetHash: string;
  /** Complete stable Report summary. */
  readonly reportSummary: WorkPackageReportRunResult["summary"];
  /** Fixed Report JSON Artifact path. */
  readonly reportJsonPath: string;
  /** Fixed Report Markdown Artifact path. */
  readonly reportMarkdownPath: string;
  /** Optional explicit Analysis completion projection. */
  readonly analysis?: WorkPackageAnalysisRunResult | undefined;
}

/** Sequential REST to Evaluation to Report command with all-stage Secret preflight. */
export class LocalPipelineCommandService {
  /** Complete explicit runtime dependencies. */
  readonly #dependencies: LocalPipelineCommandServiceDependencies;

  /** Bind package validation, stage commands and environment sources. */
  public constructor(dependencies: LocalPipelineCommandServiceDependencies) {
    this.#dependencies = dependencies;
  }

  /** Preflight selected dependencies, then execute all default stages on one Execution. */
  public async run(input: PipelineRunCommandInput): Promise<WorkPackagePipelineRunResult> {
    if (input.signal.aborted) throw new Error("REQUEST_ABORTED");
    const environment = await CliSecretEnvironment.load({
      ...(input.envFile === undefined ? {} : { envFile: input.envFile }),
      inherited: this.#dependencies.inheritedEnvironment()
    });
    await this.#preflight(
      input.packagePath,
      environment,
      input.signal,
      input.analysisSelector !== undefined
    );
    await this.#dependencies.evaluationCommands.preflightWithEnvironment(
      { packagePath: input.packagePath, signal: input.signal },
      environment
    );
    if (input.analysisSelector !== undefined) {
      await this.#dependencies.analysisCommands.preflightWithEnvironment(
        { packagePath: input.packagePath, signal: input.signal },
        environment
      );
    }
    const rest = await this.#dependencies.restCommands.runWithEnvironment(input, environment);
    const evaluation = await this.#dependencies.evaluationCommands.runWithEnvironment(
      {
        packagePath: input.packagePath,
        executionId: rest.executionId,
        ...(input.envFile === undefined ? {} : { envFile: input.envFile }),
        signal: input.signal
      },
      environment
    );
    const report = await this.#dependencies.reportCommands.run({
      packagePath: input.packagePath,
      executionId: evaluation.executionId,
      signal: input.signal
    });
    const analysis =
      input.analysisSelector === undefined
        ? undefined
        : await this.#dependencies.analysisCommands.runWithEnvironment(
            {
              packagePath: input.packagePath,
              executionId: report.executionId,
              selector: input.analysisSelector,
              ...(input.envFile === undefined ? {} : { envFile: input.envFile }),
              signal: input.signal
            },
            environment
          );
    if (
      rest.packageId !== evaluation.packageId ||
      rest.executionId !== evaluation.executionId ||
      evaluation.packageId !== report.packageId ||
      evaluation.executionId !== report.executionId ||
      evaluation.resultSetHash !== report.evaluationResultSetHash
    ) {
      throw new Error("INTERNAL_ERROR");
    }
    if (
      analysis !== undefined &&
      (analysis.packageId !== report.packageId || analysis.executionId !== report.executionId)
    ) {
      throw new Error("INTERNAL_ERROR");
    }
    return {
      packageId: rest.packageId,
      executionId: rest.executionId,
      restErrorCount: rest.restErrorCount,
      restResultSetHash: rest.resultSetHash,
      restArtifactPath: rest.artifactPath,
      promptfooExitCode: evaluation.promptfooExitCode,
      evalFailCount: evaluation.evalFailCount,
      evalErrorCount: evaluation.evalErrorCount,
      evaluationResultSetHash: evaluation.resultSetHash,
      rawArtifactPath: evaluation.rawArtifactPath,
      normalizedArtifactPath: evaluation.normalizedArtifactPath,
      reportResultSetHash: report.reportResultSetHash,
      reportSummary: report.summary,
      reportJsonPath: report.reportJsonPath,
      reportMarkdownPath: report.reportMarkdownPath,
      ...(analysis === undefined ? {} : { analysis })
    };
  }

  // Validate immutable package facts and every selected stage Secret before REST mutation.
  async #preflight(
    packagePath: string,
    environment: CliSecretEnvironment,
    signal: AbortSignal,
    includeAnalysis: boolean
  ): Promise<void> {
    const processStartedAt = await this.#dependencies.processIdentity.processStartedAt(process.pid);
    if (processStartedAt === null) throw new Error("INTERNAL_ERROR");
    const session = await openWorkPackageExecutionSession({
      rootPath: packagePath,
      owner: {
        pid: process.pid,
        processStartedAt,
        executionId: null,
        acquiredAt: this.#dependencies.now()
      },
      contextHasher: this.#dependencies.contextHasher,
      nonce: this.#dependencies.nonce
    });
    try {
      if (signal.aborted) throw new Error("REQUEST_ABORTED");
      const keys = new Set([
        ...session.inputs.requiredEnvKeys("REST"),
        ...session.inputs.requiredEnvKeys("EVALUATION"),
        ...session.inputs.requiredEnvKeys("REPORT")
      ]);
      if (includeAnalysis) {
        for (const key of session.inputs.requiredEnvKeys("ANALYSIS")) keys.add(key);
      }
      environment.require([...keys]);
    } finally {
      await session.close();
    }
  }
}
