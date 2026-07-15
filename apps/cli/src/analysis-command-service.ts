import { createFrozenAnalyzerModelClient } from "@cortex-eval/evaluation-adapters/src/frozen-analyzer-model-client.ts";
import type { WorkPackageExecutionContextHasher } from "@cortex-eval/work-package/src/work-package-execution-session.ts";
import { openWorkPackageExecutionSession } from "@cortex-eval/work-package/src/work-package-execution-session.ts";
import type { WorkPackageCaseDefinitionHasher } from "@cortex-eval/work-package/src/work-package-input-reader.ts";
import type { WorkPackageEvalSemanticHashing } from "@cortex-eval/work-package/src/work-package-evaluation-retry-reader.ts";
import type { WorkPackageRestSemanticHashing } from "@cortex-eval/work-package/src/work-package-rest-retry-reader.ts";

import { CliSecretEnvironment } from "./cli-secret-environment.ts";
import type { AnalysisCommandService, AnalysisRunCommandInput } from "./cli-program.ts";
import type { CliProcessIdentity } from "./package-command-service.ts";
import {
  WorkPackageAnalysisRunService,
  type WorkPackageAnalysisRunResult
} from "./work-package-analysis-run-service.ts";

/** Explicit composition dependencies for the concrete Analysis command. */
export interface LocalAnalysisCommandServiceDependencies {
  /** Pure Execution context hash Port. */
  readonly contextHasher: WorkPackageExecutionContextHasher;
  /** Pure Case Definition hash Port. */
  readonly caseHasher: WorkPackageCaseDefinitionHasher;
  /** Pure REST semantic hash Ports. */
  readonly restHashing: WorkPackageRestSemanticHashing;
  /** Pure Evaluation and Final Case semantic hash Ports. */
  readonly evalHashing: WorkPackageEvalSemanticHashing;
  /** Collision-resistant staging nonce source. */
  readonly nonce: () => string;
  /** UTC clock. */
  readonly now: () => string;
  /** Operating-system process identity adapter. */
  readonly processIdentity: CliProcessIdentity;
  /** Inherited process environment snapshot source. */
  readonly inheritedEnvironment: () => Readonly<Record<string, string | undefined>>;
  /** Externalized safe Analyzer error message resolver. */
  readonly errorMessage: (code: string) => string;
}

/** Real command adapter that builds one Secret-scoped Analyzer graph per invocation. */
export class LocalAnalysisCommandService implements AnalysisCommandService {
  /** Complete explicit runtime dependencies. */
  readonly #dependencies: LocalAnalysisCommandServiceDependencies;

  /** Bind immutable composition dependencies. */
  public constructor(dependencies: LocalAnalysisCommandServiceDependencies) {
    this.#dependencies = dependencies;
  }

  /** Load command-scoped Secrets and execute one existing Work Package Analysis stage. */
  public async run(input: AnalysisRunCommandInput): Promise<WorkPackageAnalysisRunResult> {
    const environment = await CliSecretEnvironment.load({
      ...(input.envFile === undefined ? {} : { envFile: input.envFile }),
      inherited: this.#dependencies.inheritedEnvironment()
    });
    return await this.runWithEnvironment(input, environment);
  }

  /** Execute Analysis with one already frozen command-scoped Secret snapshot. */
  public async runWithEnvironment(
    input: AnalysisRunCommandInput,
    environment: CliSecretEnvironment
  ): Promise<WorkPackageAnalysisRunResult> {
    await this.preflightWithEnvironment(
      { packagePath: input.packagePath, signal: input.signal },
      environment
    );
    const modelClient = createFrozenAnalyzerModelClient({
      readSecret: (key): string | undefined => environment.readSecret(key)
    });
    return await new WorkPackageAnalysisRunService({
      contextHasher: this.#dependencies.contextHasher,
      caseHasher: this.#dependencies.caseHasher,
      restHashing: this.#dependencies.restHashing,
      evalHashing: this.#dependencies.evalHashing,
      modelClient,
      processIdentity: this.#dependencies.processIdentity,
      nonce: this.#dependencies.nonce,
      now: this.#dependencies.now,
      errorMessage: this.#dependencies.errorMessage
    }).run({
      packagePath: input.packagePath,
      executionId: input.executionId,
      selector: input.selector,
      signal: input.signal
    });
  }

  /** Validate immutable Analyzer, Prompt and Secret names without mutating an Execution. */
  public async preflightWithEnvironment(
    input: { readonly packagePath: string; readonly signal: AbortSignal },
    environment: CliSecretEnvironment
  ): Promise<void> {
    const processStartedAt = await this.#dependencies.processIdentity.processStartedAt(process.pid);
    if (processStartedAt === null) throw new Error("WORK_PACKAGE_LOCKED");
    const session = await openWorkPackageExecutionSession({
      rootPath: input.packagePath,
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
      if (input.signal.aborted) throw new Error("REQUEST_ABORTED");
      environment.require(session.inputs.requiredEnvKeys("ANALYSIS"));
      await session.inputs.readAnalysisInputs();
    } finally {
      await session.close();
    }
  }
}
