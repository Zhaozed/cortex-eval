import { CaseDefinitionWriter } from "@cortex-eval/application/src/features/test-suites/case-definition-writer.ts";
import { CaseExportService } from "@cortex-eval/application/src/features/test-suites/case-export-service.ts";
import { StreamingCaseImportService } from "@cortex-eval/application/src/features/test-suites/streaming-case-import-service.ts";
import { TestSuiteService } from "@cortex-eval/application/src/features/test-suites/test-suite-service.ts";
import {
  ConfigurationService,
  type EndpointValidator,
  type LlmValidator
} from "@cortex-eval/application/src/features/configurations/configuration-service.ts";
import {
  PlatformRunService,
  type PlatformRunBusinessEvent
} from "@cortex-eval/application/src/features/runs/platform-run-service.ts";
import {
  PlatformEvaluationService,
  type PlatformEvaluationBusinessEvent
} from "@cortex-eval/application/src/features/evaluation/platform-evaluation-service.ts";
import zhCnMessages from "@cortex-eval/contracts/messages/zh-CN.json" with { type: "json" };
import { FetchRestExecutor } from "@cortex-eval/evaluation-adapters/src/fetch-rest-executor.ts";
import { PlatformPromptfooEvaluationEngine } from "@cortex-eval/evaluation-adapters/src/platform-promptfoo-evaluation-engine.ts";
import { PromptfooRuntimePreflight } from "@cortex-eval/evaluation-adapters/src/promptfoo-runtime-preflight.ts";
import {
  PROMPTFOO_CAPABILITY_MATRIX_HASH,
  promptfooAssertionRequiresEvaluator
} from "@cortex-eval/evaluation-adapters/src/promptfoo-capability-projection.ts";
import {
  initializeSqliteStorage,
  type SqliteStorage
} from "@cortex-eval/storage-sqlite/src/sqlite-database.ts";
import {
  CaseImportWorkspaceManager,
  PsProcessLiveness
} from "@cortex-eval/storage-sqlite/src/case-import-workspace.ts";
import { v7 as uuidV7 } from "uuid";
import type { FastifyInstance } from "fastify";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { createApplicationResourceHandlers } from "./application-resource-handlers.ts";
import { createApplicationRunHandlers } from "./application-run-handlers.ts";
import { buildLocalServer } from "./local-server.ts";
import { ResilientBusinessLogger, RotatingTextLogSink } from "./local-logger.ts";
import {
  EndpointConnectivityValidator,
  LlmAvailabilityValidator
} from "./configuration-probe-adapters.ts";
import { applyDevelopmentSeed } from "./development-seed.ts";
import { FileCaseExportBodyPreparer } from "./case-export-staging.ts";
import { LocalRunArtifactStore } from "./run-artifact-store.ts";

/** Local Server composition options. */
export interface LocalServerRuntimeOptions {
  /** Absolute project root owning `.cortex-eval`. */
  readonly projectRoot: string;
  /** Real Endpoint probe adapter. */
  readonly endpointValidator?: EndpointValidator | undefined;
  /** Real LLM probe adapter. */
  readonly llmValidator?: LlmValidator | undefined;
  /** Optional resilient safe business logger. */
  readonly businessLogger?: ResilientBusinessLogger | undefined;
  /** Apply the strict bundled development Seed when explicitly enabled. */
  readonly developmentSeed?: boolean | undefined;
  /** Optional built Web root used by the production runtime and E2E. */
  readonly staticRoot?: string | undefined;
}

/** Fully composed Local Server lifecycle. */
export class LocalServerRuntime {
  /** Non-listening or listening Fastify instance. */
  public readonly server: FastifyInstance;
  /** Absolute platform SQLite file path. */
  public readonly databasePath: string;
  readonly #storage: SqliteStorage;
  readonly #businessLogger: ResilientBusinessLogger;
  readonly #runs: PlatformRunService;
  readonly #evaluations: PlatformEvaluationService;
  #closed = false;

  /** Bind one Fastify instance and its owned storage. */
  public constructor(
    server: FastifyInstance,
    storage: SqliteStorage,
    businessLogger: ResilientBusinessLogger,
    runs: PlatformRunService,
    evaluations: PlatformEvaluationService
  ) {
    this.server = server;
    this.databasePath = storage.databasePath;
    this.#storage = storage;
    this.#businessLogger = businessLogger;
    this.#runs = runs;
    this.#evaluations = evaluations;
  }

  /** Listen on the fixed current loopback address and default port. */
  public listen(): Promise<string> {
    return this.server.listen({ host: "127.0.0.1", port: 4310 });
  }

  /** Stop HTTP work before closing SQLite, exactly once. */
  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.server.close();
    await this.#runs.shutdown();
    await this.#evaluations.shutdown();
    await this.#businessLogger.flush();
    await this.#storage.close();
  }
}

// Create the owner-only production logger used when no explicit test sink is supplied.
function createDefaultBusinessLogger(projectRoot: string): ResilientBusinessLogger {
  return new ResilientBusinessLogger({
    sink: new RotatingTextLogSink({
      path: join(projectRoot, ".cortex-eval", "logs", "local-server.log")
    }),
    stderr: {
      write: (line): void => {
        process.stderr.write(line);
      }
    }
  });
}

// Resolve one stable Run message without accepting arbitrary core copy.
function runMessage(code: string): string {
  const messages: Readonly<Record<string, unknown>> = zhCnMessages;
  const value = messages[code];
  return typeof value === "string" ? value : zhCnMessages.INTERNAL_ERROR;
}

/** Initialize storage, clean staging and assemble all P3 resource capabilities. */
export async function createLocalServerRuntime(
  options: LocalServerRuntimeOptions
): Promise<LocalServerRuntime> {
  const businessLogger = options.businessLogger ?? createDefaultBusinessLogger(options.projectRoot);
  const storage = await initializeSqliteStorage({ projectRoot: options.projectRoot });
  try {
    const transactionManager = storage.createTransactionManager();
    const stagingFactory = storage.createCaseImportStagingFactory((event) =>
      businessLogger.record({ event, timestamp: new Date().toISOString() })
    );
    const caseExportBodies = new FileCaseExportBodyPreparer(
      new CaseImportWorkspaceManager({
        containmentRoot: options.projectRoot,
        temporaryRoot: join(options.projectRoot, ".cortex-eval", "tmp"),
        processLiveness: new PsProcessLiveness(),
        now: Date.now,
        nonce: randomUUID,
        pid: process.pid,
        ttlMs: 24 * 60 * 60 * 1000,
        workspacePrefix: "case-export-",
        onSecurityEvent: (event): Promise<void> =>
          businessLogger.record({ event, timestamp: new Date().toISOString() })
      })
    );
    await stagingFactory.cleanupStale();
    await caseExportBodies.cleanupStale();
    const clock = { now: (): string => new Date().toISOString() };
    const idGenerator = { nextId: (): string => uuidV7() };
    const common = { transactionManager, clock, idGenerator };
    const testSuites = new TestSuiteService(common);
    const cases = new CaseDefinitionWriter(common);
    const configurations = new ConfigurationService({
      ...common,
      endpointValidator: options.endpointValidator ?? new EndpointConnectivityValidator(),
      llmValidator: options.llmValidator ?? new LlmAvailabilityValidator()
    });
    if (options.developmentSeed === true) {
      await applyDevelopmentSeed({ testSuites, cases, configurations });
    }
    const artifactStore = await LocalRunArtifactStore.create({ projectRoot: options.projectRoot });
    const runTransactionManager = storage.createRunTransactionManager();
    const lifecycleEventSink = {
      record: (event: PlatformRunBusinessEvent | PlatformEvaluationBusinessEvent): Promise<void> =>
        businessLogger.record({
          event: event.event,
          timestamp: event.timestamp,
          resourceId: event.runId
        })
    };
    const promptfooBinary = join(process.cwd(), "node_modules", ".bin", "promptfoo");
    const promptfooTemporaryParent = join(options.projectRoot, ".cortex-eval", "tmp", "promptfoo");
    const evaluations = new PlatformEvaluationService({
      runTransactionManager,
      evalTransactionManager: storage.createEvalTransactionManager(),
      engine: new PlatformPromptfooEvaluationEngine({
        promptfooBinary,
        temporaryContainmentRoot: options.projectRoot,
        temporaryParent: promptfooTemporaryParent,
        promptfooTimeoutMs: 10 * 60 * 1_000,
        capabilityMatrixHash: PROMPTFOO_CAPABILITY_MATRIX_HASH,
        requiresEvaluator: promptfooAssertionRequiresEvaluator,
        readSecret: (key): string | undefined => process.env[key],
        createCallId: (): string => uuidV7()
      }),
      runtimePreflight: new PromptfooRuntimePreflight({
        promptfooBinary,
        temporaryContainmentRoot: options.projectRoot,
        temporaryParent: promptfooTemporaryParent,
        timeoutMs: 30_000
      }),
      artifactStore,
      clock,
      messageResolver: { message: runMessage },
      eventSink: lifecycleEventSink
    });
    const runs = new PlatformRunService({
      transactionManager: runTransactionManager,
      restExecutor: new FetchRestExecutor({
        readSecret: (key): string | undefined => process.env[key]
      }),
      artifactStore,
      clock,
      idGenerator,
      messageResolver: { message: runMessage },
      eventSink: lifecycleEventSink,
      pipelineEvaluationStarter: evaluations
    });
    await runs.initialize();
    const resourceHandlers = createApplicationResourceHandlers({
      testSuites,
      configurations,
      cases,
      caseExports: new CaseExportService({ transactionManager }),
      caseExportBodies,
      caseImports: new StreamingCaseImportService({ ...common, stagingFactory })
    });
    const runApplication = {
      preflight: runs.preflight.bind(runs),
      create: runs.create.bind(runs),
      queryRuns: runs.queryRuns.bind(runs),
      get: runs.get.bind(runs),
      getProgress: runs.getProgress.bind(runs),
      inspectArtifacts: runs.inspectArtifacts.bind(runs),
      queryRestResults: runs.queryRestResults.bind(runs),
      getRestResult: runs.getRestResult.bind(runs),
      start: runs.start.bind(runs),
      cancel: runs.cancel.bind(runs),
      startEvaluation: evaluations.start.bind(evaluations),
      cancelEvaluation: evaluations.cancel.bind(evaluations),
      queryEvalResults: evaluations.queryResults.bind(evaluations)
    };
    const server = buildLocalServer({
      requestIdGenerator: idGenerator,
      resourceHandlers,
      runHandlers: createApplicationRunHandlers(runApplication),
      businessLogger,
      ...(options.staticRoot === undefined ? {} : { staticRoot: options.staticRoot })
    });
    return new LocalServerRuntime(server, storage, businessLogger, runs, evaluations);
  } catch (error) {
    await storage.close();
    throw error;
  }
}
