import type { WorkPackageExecutionContextHasher } from "@cortex-eval/work-package/src/work-package-execution-session.ts";
import { openWorkPackageExecutionSession } from "@cortex-eval/work-package/src/work-package-execution-session.ts";

import { CliSecretEnvironment } from "./cli-secret-environment.ts";
import type { EvaluationRunCommandInput, RestRunCommandInput } from "./cli-program.ts";
import type { CliProcessIdentity } from "./package-command-service.ts";
import type { WorkPackageEvaluationRunResult } from "./work-package-evaluation-run-service.ts";
import type { WorkPackageRestRunResult } from "./work-package-rest-run-service.ts";

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

/** Explicit dependencies for the currently closed REST to Evaluation Pipeline. */
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
}

/** Current P7 Pipeline completion projection without future Report fields. */
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
}

/** Sequential REST to Evaluation command with all-stage Secret preflight. */
export class LocalPipelineCommandService {
  /** Complete explicit runtime dependencies. */
  readonly #dependencies: LocalPipelineCommandServiceDependencies;

  /** Bind package validation, stage commands and environment sources. */
  public constructor(dependencies: LocalPipelineCommandServiceDependencies) {
    this.#dependencies = dependencies;
  }

  /** Preflight both stages, then execute them against one new Execution identity. */
  public async run(input: RestRunCommandInput): Promise<WorkPackagePipelineRunResult> {
    if (input.signal.aborted) throw new Error("REQUEST_ABORTED");
    const environment = await CliSecretEnvironment.load({
      ...(input.envFile === undefined ? {} : { envFile: input.envFile }),
      inherited: this.#dependencies.inheritedEnvironment()
    });
    await this.#preflight(input.packagePath, environment, input.signal);
    await this.#dependencies.evaluationCommands.preflightWithEnvironment(
      { packagePath: input.packagePath, signal: input.signal },
      environment
    );
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
    if (rest.packageId !== evaluation.packageId || rest.executionId !== evaluation.executionId) {
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
      normalizedArtifactPath: evaluation.normalizedArtifactPath
    };
  }

  // Validate immutable package facts and every selected stage Secret before REST mutation.
  async #preflight(
    packagePath: string,
    environment: CliSecretEnvironment,
    signal: AbortSignal
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
        ...session.inputs.requiredEnvKeys("EVALUATION")
      ]);
      environment.require([...keys]);
    } finally {
      await session.close();
    }
  }
}
