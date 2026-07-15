import { CaseDefinitionWriter } from "@cortex-eval/application/src/features/test-suites/case-definition-writer.ts";
import { WorkPackageExportSnapshotService } from "@cortex-eval/application/src/features/work-packages/work-package-export-snapshot-service.ts";
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
import { PlatformRerunService } from "@cortex-eval/application/src/features/runs/platform-rerun-service.ts";
import {
  PlatformEvaluationService,
  type PlatformEvaluationBusinessEvent
} from "@cortex-eval/application/src/features/evaluation/platform-evaluation-service.ts";
import {
  PlatformReportService,
  type PlatformReportBusinessEvent
} from "@cortex-eval/application/src/features/reporting/platform-report-service.ts";
import { PlatformCaseAnalysisService } from "@cortex-eval/application/src/features/case-analysis/platform-case-analysis-service.ts";
import type { AnalysisModelClient } from "@cortex-eval/application/src/features/case-analysis/case-analysis-model-client.ts";
import { CaseAnalysisDecisionService } from "@cortex-eval/application/src/features/case-analysis/case-analysis-decision-service.ts";
import zhCnMessages from "@cortex-eval/contracts/messages/zh-CN.json" with { type: "json" };
import analysisCaseMessages from "@cortex-eval/contracts/messages/analysis-case.zh-CN.json" with { type: "json" };
import { FetchRestExecutor } from "@cortex-eval/evaluation-adapters/src/fetch-rest-executor.ts";
import { PlatformPromptfooEvaluationEngine } from "@cortex-eval/evaluation-adapters/src/platform-promptfoo-evaluation-engine.ts";
import { PromptfooRuntimePreflight } from "@cortex-eval/evaluation-adapters/src/promptfoo-runtime-preflight.ts";
import { createFrozenAnalyzerModelClient } from "@cortex-eval/evaluation-adapters/src/frozen-analyzer-model-client.ts";
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
import { WorkPackageExportService } from "./work-package-export-service.ts";
import { createWorkPackageExportHandler } from "./work-package-export-handler.ts";
import { ExecutionReportImportService } from "./execution-report-import-service.ts";
import { ExecutionAnalysisImportService } from "./execution-analysis-import-service.ts";
import { CanonicalExportService } from "./canonical-export-service.ts";
import { createCanonicalExportHandler } from "./canonical-export-handler.ts";

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
  /** Optional test-owned Analyzer boundary; production defaults to the official SDK adapter. */
  readonly analysisModelClient?: AnalysisModelClient | undefined;
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
  readonly #reports: PlatformReportService;
  #closed = false;

  /** Bind one Fastify instance and its owned storage. */
  public constructor(
    server: FastifyInstance,
    storage: SqliteStorage,
    businessLogger: ResilientBusinessLogger,
    runs: PlatformRunService,
    evaluations: PlatformEvaluationService,
    reports: PlatformReportService
  ) {
    this.server = server;
    this.databasePath = storage.databasePath;
    this.#storage = storage;
    this.#businessLogger = businessLogger;
    this.#runs = runs;
    this.#evaluations = evaluations;
    this.#reports = reports;
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
    await this.#reports.shutdown();
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

/** Resolve both Analyzer Case errors and registered platform Analysis errors. */
export function resolveAnalysisMessage(code: string): string {
  const messages: Readonly<Record<string, unknown>> = analysisCaseMessages;
  const value = messages[code];
  return typeof value === "string" ? value : runMessage(code);
}

/** Initialize storage, clean staging and assemble all P3 resource capabilities. */
export async function createLocalServerRuntime(
  options: LocalServerRuntimeOptions
): Promise<LocalServerRuntime> {
  const businessLogger = options.businessLogger ?? createDefaultBusinessLogger(options.projectRoot);
  const storage = await initializeSqliteStorage({ projectRoot: options.projectRoot });
  try {
    const transactionManager = storage.createTransactionManager();
    const processLiveness = new PsProcessLiveness();
    const stagingFactory = storage.createCaseImportStagingFactory((event) =>
      businessLogger.record({ event, timestamp: new Date().toISOString() })
    );
    const analysisImportStagingFactory = storage.createAnalysisImportStagingFactory((event) =>
      businessLogger.record({ event, timestamp: new Date().toISOString() })
    );
    const caseExportBodies = new FileCaseExportBodyPreparer(
      new CaseImportWorkspaceManager({
        containmentRoot: options.projectRoot,
        temporaryRoot: join(options.projectRoot, ".cortex-eval", "tmp"),
        processLiveness,
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
    await analysisImportStagingFactory.cleanupStale();
    await caseExportBodies.cleanupStale();
    const workPackageExportWorkspaces = new CaseImportWorkspaceManager({
      containmentRoot: options.projectRoot,
      temporaryRoot: join(options.projectRoot, ".cortex-eval", "tmp"),
      processLiveness,
      now: Date.now,
      nonce: randomUUID,
      pid: process.pid,
      ttlMs: 24 * 60 * 60 * 1000,
      workspacePrefix: "work-package-export-",
      onSecurityEvent: (event): Promise<void> =>
        businessLogger.record({ event, timestamp: new Date().toISOString() })
    });
    await workPackageExportWorkspaces.cleanupStale();
    const canonicalExportWorkspaces = new CaseImportWorkspaceManager({
      containmentRoot: options.projectRoot,
      temporaryRoot: join(options.projectRoot, ".cortex-eval", "tmp"),
      processLiveness,
      now: Date.now,
      nonce: randomUUID,
      pid: process.pid,
      ttlMs: 24 * 60 * 60 * 1000,
      workspacePrefix: "canonical-export-",
      onSecurityEvent: (event): Promise<void> =>
        businessLogger.record({ event, timestamp: new Date().toISOString() })
    });
    await canonicalExportWorkspaces.cleanupStale();
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
    const artifactStore = await LocalRunArtifactStore.create({
      projectRoot: options.projectRoot,
      onCleanupFailure: (event): Promise<void> =>
        businessLogger.record({ event, timestamp: new Date().toISOString() })
    });
    const runTransactionManager = storage.createRunTransactionManager();
    const lifecycleEventSink = {
      record: (
        event:
          PlatformRunBusinessEvent | PlatformEvaluationBusinessEvent | PlatformReportBusinessEvent
      ): Promise<void> =>
        businessLogger.record({
          event: event.event,
          timestamp: event.timestamp,
          resourceId: event.runId
        })
    };
    const promptfooBinary = join(process.cwd(), "node_modules", ".bin", "promptfoo");
    const promptfooTemporaryParent = join(options.projectRoot, ".cortex-eval", "tmp", "promptfoo");
    const runtimePreflight = new PromptfooRuntimePreflight({
      promptfooBinary,
      temporaryContainmentRoot: options.projectRoot,
      temporaryParent: promptfooTemporaryParent,
      timeoutMs: 30_000
    });
    // Warm only the fixed Promptfoo version attestation. Each Run still rechecks the exact binary
    // identity before trusting it, while an unavailable runtime remains a Run preflight failure.
    await runtimePreflight.check([], new AbortController().signal);
    const reports = new PlatformReportService({
      runTransactionManager,
      evalTransactionManager: storage.createEvalTransactionManager(),
      artifactStore,
      clock,
      messageResolver: { message: runMessage },
      eventSink: lifecycleEventSink
    });
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
      runtimePreflight,
      artifactStore,
      clock,
      messageResolver: { message: runMessage },
      eventSink: lifecycleEventSink,
      pipelineReportStarter: reports
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
    const reruns = new PlatformRerunService({
      runTransactionManager,
      evalTransactionManager: storage.createEvalTransactionManager(),
      artifactStore,
      idGenerator,
      clock
    });
    const reportImports = new ExecutionReportImportService({
      transactionManager,
      idGenerator,
      clock,
      processIdentity: processLiveness,
      nonce: randomUUID
    });
    const analysisTransactionManager = storage.createAnalysisTransactionManager();
    const analysisImports = new ExecutionAnalysisImportService({
      stagingFactory: analysisImportStagingFactory,
      idGenerator,
      clock,
      processIdentity: processLiveness,
      nonce: randomUUID,
      errorMessage: resolveAnalysisMessage
    });
    const analyses = new PlatformCaseAnalysisService({
      transactionManager: analysisTransactionManager,
      reports,
      modelClient:
        options.analysisModelClient ??
        createFrozenAnalyzerModelClient({
          readSecret: (key): string | undefined => process.env[key]
        }),
      idGenerator,
      clock,
      errorMessage: resolveAnalysisMessage
    });
    const analysisDecisions = new CaseAnalysisDecisionService({
      transactionManager: analysisTransactionManager,
      caseWriter: cases,
      clock
    });
    await analysisTransactionManager.execute((transaction) =>
      transaction.analyses.recoverUnfinished(
        clock.now(),
        "ANALYSIS_INTERRUPTED",
        resolveAnalysisMessage("ANALYSIS_INTERRUPTED")
      )
    );
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
      queryEvalResults: evaluations.queryResults.bind(evaluations),
      startReport: reports.start.bind(reports),
      cancelReport: reports.cancel.bind(reports),
      getReport: reports.get.bind(reports),
      hasReportRun: reports.exists.bind(reports),
      queryReportCases: reports.queryCases.bind(reports),
      getReportCase: reports.getCase.bind(reports),
      streamReportCases: reports.streamCases.bind(reports),
      openReportExport: artifactStore.openReportJson.bind(artifactStore),
      createRerun: reruns.create.bind(reruns),
      importExecutionReport: reportImports.importReport.bind(reportImports),
      importExecutionAnalysis: analysisImports.importAnalysis.bind(analysisImports),
      startCaseAnalysis: analyses.start.bind(analyses),
      getCurrentCaseAnalysis: analyses.getCurrent.bind(analyses),
      rejectAnalysisProposal: analysisDecisions.rejectProposal.bind(analysisDecisions),
      acceptAnalysisProposal: analysisDecisions.acceptProposal.bind(analysisDecisions)
    };
    const server = buildLocalServer({
      requestIdGenerator: idGenerator,
      resourceHandlers,
      runHandlers: createApplicationRunHandlers(runApplication),
      workPackageExportHandler: createWorkPackageExportHandler(
        new WorkPackageExportService({
          snapshots: new WorkPackageExportSnapshotService({ transactionManager }),
          workspaces: workPackageExportWorkspaces,
          nextId: idGenerator.nextId,
          now: clock.now
        })
      ),
      canonicalExportHandler: createCanonicalExportHandler(
        new CanonicalExportService({
          snapshots: storage.createCanonicalExportSnapshotFactory(canonicalExportWorkspaces),
          workspaces: canonicalExportWorkspaces,
          artifactRoot: join(options.projectRoot, ".cortex-eval", "artifacts"),
          nextId: idGenerator.nextId,
          now: clock.now
        })
      ),
      businessLogger,
      ...(options.staticRoot === undefined ? {} : { staticRoot: options.staticRoot })
    });
    return new LocalServerRuntime(server, storage, businessLogger, runs, evaluations, reports);
  } catch (error) {
    await storage.close();
    throw error;
  }
}
