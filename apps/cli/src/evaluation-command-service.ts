import { FrozenPromptfooEvaluationEngine } from "@cortex-eval/evaluation-adapters/src/platform-promptfoo-evaluation-engine.ts";
import {
  PROMPTFOO_CAPABILITY_MATRIX_HASH,
  promptfooAssertionRequiresEvaluator
} from "@cortex-eval/evaluation-adapters/src/promptfoo-capability-projection.ts";
import { PromptfooRuntimePreflight } from "@cortex-eval/evaluation-adapters/src/promptfoo-runtime-preflight.ts";
import type { WorkPackageEvalSemanticHashing } from "@cortex-eval/work-package/src/work-package-evaluation-retry-reader.ts";
import type { WorkPackageExecutionContextHasher } from "@cortex-eval/work-package/src/work-package-execution-session.ts";
import type { WorkPackageCaseDefinitionHasher } from "@cortex-eval/work-package/src/work-package-input-reader.ts";
import type { WorkPackageRestSemanticHashing } from "@cortex-eval/work-package/src/work-package-rest-retry-reader.ts";

import { CliSecretEnvironment } from "./cli-secret-environment.ts";
import type { EvaluationCommandService, EvaluationRunCommandInput } from "./cli-program.ts";
import type { CliProcessIdentity } from "./package-command-service.ts";
import { WorkPackageEvaluationStagingStore } from "./work-package-evaluation-staging-store.ts";
import {
  WorkPackageEvaluationRunService,
  type WorkPackageEvaluationCleanupFailureSink,
  type WorkPackageEvaluationRunResult
} from "./work-package-evaluation-run-service.ts";

/** Explicit composition dependencies for the concrete Evaluation command. */
export interface LocalEvaluationCommandServiceDependencies {
  /** Pure Execution context hash Port. */
  readonly contextHasher: WorkPackageExecutionContextHasher;
  /** Pure Case Definition hash Port. */
  readonly caseHasher: WorkPackageCaseDefinitionHasher;
  /** Pure REST result and Result Set hash Ports. */
  readonly restHashing: WorkPackageRestSemanticHashing;
  /** Pure Eval result, Final result and Result Set hash Ports. */
  readonly evalHashing: WorkPackageEvalSemanticHashing;
  /** Absolute fixed Promptfoo executable path. */
  readonly promptfooBinary: string;
  /** Explicit containment root for disposable Promptfoo files. */
  readonly temporaryContainmentRoot: string;
  /** Controlled child directory for disposable Promptfoo files. */
  readonly temporaryParent: string;
  /** Whole fixed-version Evaluation timeout. */
  readonly promptfooTimeoutMs: number;
  /** Interpreter preflight timeout. */
  readonly runtimePreflightTimeoutMs: number;
  /** UUIDv7 Bridge call identity source. */
  readonly nextId: () => string;
  /** Collision-resistant staging nonce source. */
  readonly nonce: () => string;
  /** UTC clock. */
  readonly now: () => string;
  /** Operating-system process identity adapter. */
  readonly processIdentity: CliProcessIdentity;
  /** Inherited process environment snapshot source. */
  readonly inheritedEnvironment: () => Readonly<Record<string, string | undefined>>;
  /** Resilient safe observer for private Promptfoo cleanup failures. */
  readonly cleanupFailureSink: WorkPackageEvaluationCleanupFailureSink;
}

/** Real command adapter that builds one Secret-scoped Evaluation graph per invocation. */
export class LocalEvaluationCommandService implements EvaluationCommandService {
  /** Complete explicit runtime dependencies. */
  readonly #dependencies: LocalEvaluationCommandServiceDependencies;

  /** Bind immutable composition dependencies. */
  public constructor(dependencies: LocalEvaluationCommandServiceDependencies) {
    this.#dependencies = dependencies;
  }

  /** Load command-scoped Secrets and execute one existing Work Package Evaluation stage. */
  public async run(input: EvaluationRunCommandInput): Promise<WorkPackageEvaluationRunResult> {
    const environment = await CliSecretEnvironment.load({
      ...(input.envFile === undefined ? {} : { envFile: input.envFile }),
      inherited: this.#dependencies.inheritedEnvironment()
    });
    return await this.runWithEnvironment(input, environment);
  }

  /** Execute Evaluation with one already frozen command-scoped Secret snapshot. */
  public async runWithEnvironment(
    input: EvaluationRunCommandInput,
    environment: CliSecretEnvironment
  ): Promise<WorkPackageEvaluationRunResult> {
    return await this.#service(environment).run({
      packagePath: input.packagePath,
      executionId: input.executionId,
      signal: input.signal
    });
  }

  /** Validate package-local Evaluation dependencies without creating an Execution. */
  public async preflightWithEnvironment(
    input: { readonly packagePath: string; readonly signal: AbortSignal },
    environment: CliSecretEnvironment
  ): Promise<void> {
    await this.#service(environment).preflight(input);
  }

  // Compose one command-scoped graph around the frozen Secret snapshot.
  #service(environment: CliSecretEnvironment): WorkPackageEvaluationRunService {
    const engine = new FrozenPromptfooEvaluationEngine({
      promptfooBinary: this.#dependencies.promptfooBinary,
      temporaryContainmentRoot: this.#dependencies.temporaryContainmentRoot,
      temporaryParent: this.#dependencies.temporaryParent,
      promptfooTimeoutMs: this.#dependencies.promptfooTimeoutMs,
      capabilityMatrixHash: PROMPTFOO_CAPABILITY_MATRIX_HASH,
      requiresEvaluator: promptfooAssertionRequiresEvaluator,
      readSecret: (key): string | undefined => environment.readSecret(key),
      createCallId: this.#dependencies.nextId
    });
    const runtimePreflight = new PromptfooRuntimePreflight({
      promptfooBinary: this.#dependencies.promptfooBinary,
      temporaryContainmentRoot: this.#dependencies.temporaryContainmentRoot,
      temporaryParent: this.#dependencies.temporaryParent,
      timeoutMs: this.#dependencies.runtimePreflightTimeoutMs
    });
    const service = new WorkPackageEvaluationRunService({
      contextHasher: this.#dependencies.contextHasher,
      caseHasher: this.#dependencies.caseHasher,
      restHashing: this.#dependencies.restHashing,
      evalHashing: this.#dependencies.evalHashing,
      engine,
      runtimePreflight,
      environment,
      processIdentity: this.#dependencies.processIdentity,
      nonce: this.#dependencies.nonce,
      now: this.#dependencies.now,
      cleanupFailureSink: this.#dependencies.cleanupFailureSink,
      stagingFactory: {
        create: (): Promise<WorkPackageEvaluationStagingStore> =>
          WorkPackageEvaluationStagingStore.create(
            this.#dependencies.temporaryContainmentRoot,
            this.#dependencies.temporaryParent
          )
      }
    });
    return service;
  }
}
