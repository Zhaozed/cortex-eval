import { OfflineRestExecutionService } from "@cortex-eval/application/src/features/runs/offline-rest-execution-service.ts";
import type { RestExecutionMessageCode } from "@cortex-eval/application/src/features/runs/run-rest-models.ts";
import { FetchRestExecutor } from "@cortex-eval/evaluation-adapters/src/fetch-rest-executor.ts";
import type {
  WorkPackageExecutionContextHasher,
  WorkPackageAnalysisLimitOverrides,
  WorkPackageRunLimitOverrides
} from "@cortex-eval/work-package/src/work-package-execution-session.ts";
import { openWorkPackageExecutionSession } from "@cortex-eval/work-package/src/work-package-execution-session.ts";
import type { WorkPackageCaseDefinitionHasher } from "@cortex-eval/work-package/src/work-package-input-reader.ts";
import type { WorkPackageRestSemanticHashing } from "@cortex-eval/work-package/src/work-package-rest-retry-reader.ts";

import { CliSecretEnvironment } from "./cli-secret-environment.ts";
import type { RestCommandService, RestRunCommandInput } from "./cli-program.ts";
import type { CliProcessIdentity } from "./package-command-service.ts";
import {
  SessionWorkPackageRestRetryResults,
  WorkPackageRestRunService,
  type WorkPackageRestRunResult
} from "./work-package-rest-run-service.ts";

/** Explicit composition dependencies for the concrete REST command. */
export interface LocalRestCommandServiceDependencies {
  /** Pure Execution context hash Port. */
  readonly contextHasher: WorkPackageExecutionContextHasher;
  /** Pure Case Definition hash Port. */
  readonly caseHasher: WorkPackageCaseDefinitionHasher;
  /** Pure REST result and Result Set hash Ports. */
  readonly restHashing: WorkPackageRestSemanticHashing;
  /** UUIDv7 source. */
  readonly nextId: () => string;
  /** Collision-resistant staging nonce source. */
  readonly nonce: () => string;
  /** UTC clock. */
  readonly now: () => string;
  /** Stable localized REST error message resolver. */
  readonly message: (code: RestExecutionMessageCode) => string;
  /** Operating-system process identity adapter. */
  readonly processIdentity: CliProcessIdentity;
  /** Inherited process environment snapshot source. */
  readonly inheritedEnvironment: () => Readonly<Record<string, string | undefined>>;
  /** Optional Fetch edge for tests. */
  readonly fetch?: typeof fetch | undefined;
  /** Resilient observer for unpublished REST Artifact cleanup failures. */
  readonly cleanupFailureSink: {
    readonly record: (failure: { readonly executionId: string }) => Promise<void>;
  };
}

/** Real command adapter that builds one Secret-scoped REST execution graph per invocation. */
export class LocalRestCommandService implements RestCommandService {
  /** Complete explicit runtime dependencies. */
  readonly #dependencies: LocalRestCommandServiceDependencies;

  /** Bind immutable composition dependencies. */
  public constructor(dependencies: LocalRestCommandServiceDependencies) {
    this.#dependencies = dependencies;
  }

  /** Load command-scoped Secrets and execute one Work Package REST stage. */
  public async run(input: RestRunCommandInput): Promise<WorkPackageRestRunResult> {
    const environment = await CliSecretEnvironment.load({
      ...(input.envFile === undefined ? {} : { envFile: input.envFile }),
      inherited: this.#dependencies.inheritedEnvironment()
    });
    return await this.runWithEnvironment(input, environment);
  }

  /** Execute REST with one already frozen command-scoped Secret snapshot. */
  public async runWithEnvironment(
    input: RestRunCommandInput,
    environment: CliSecretEnvironment
  ): Promise<WorkPackageRestRunResult> {
    const executor = new FetchRestExecutor({
      readSecret: (key): string | undefined => environment.readSecret(key),
      ...(this.#dependencies.fetch === undefined ? {} : { fetch: this.#dependencies.fetch })
    });
    const execution = new OfflineRestExecutionService({
      restExecutor: executor,
      clock: { now: this.#dependencies.now },
      messageResolver: { message: this.#dependencies.message }
    });
    const service = new WorkPackageRestRunService({
      contextHasher: this.#dependencies.contextHasher,
      caseHasher: this.#dependencies.caseHasher,
      restExecution: execution,
      nextId: this.#dependencies.nextId,
      nonce: this.#dependencies.nonce,
      now: this.#dependencies.now,
      processIdentity: this.#dependencies.processIdentity,
      retryResults: new SessionWorkPackageRestRetryResults(this.#dependencies.restHashing),
      environment,
      openSession: openWorkPackageExecutionSession,
      cleanupFailureSink: this.#dependencies.cleanupFailureSink
    });
    return await service.run({
      packagePath: input.packagePath,
      rerun: input.rerun,
      runExecutionLimits: runOverrides(input.runLimitOverrides),
      analysisExecutionLimits: analysisOverrides(input.analysisLimitOverrides),
      signal: input.signal
    });
  }
}

// Copy only explicitly supplied Run overrides into the package boundary.
function runOverrides(
  input: RestRunCommandInput["runLimitOverrides"]
): WorkPackageRunLimitOverrides {
  return {
    ...(input.restConcurrency === undefined ? {} : { restConcurrency: input.restConcurrency }),
    ...(input.evalConcurrency === undefined ? {} : { evalConcurrency: input.evalConcurrency })
  };
}

// Copy only the explicitly supplied Analysis override.
function analysisOverrides(
  input: RestRunCommandInput["analysisLimitOverrides"]
): WorkPackageAnalysisLimitOverrides {
  return input.analysisConcurrency === undefined
    ? {}
    : { analysisConcurrency: input.analysisConcurrency };
}
