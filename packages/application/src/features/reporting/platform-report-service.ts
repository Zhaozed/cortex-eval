import type { Clock } from "../../application-ports.ts";
import type { ImportedReportRun } from "../execution-imports/execution-import-models.ts";
import type {
  PlatformEvalCaseResult,
  PlatformEvalResultPage
} from "../evaluation/platform-eval-models.ts";
import type { PlatformEvalTransactionManager } from "../evaluation/platform-eval-ports.ts";
import type {
  PlatformRunActionResult,
  PlatformRunMessageResolver,
  PlatformRunRevisionInput
} from "../runs/platform-run-service.ts";
import type { FrozenRunCase } from "../runs/run-rest-models.ts";
import type {
  PlatformRun,
  PlatformReportSummary,
  RestResultPage,
  RunArtifactDescriptor,
  StoredRestCaseResult
} from "../runs/platform-run-models.ts";
import type { PlatformRunTransactionManager } from "../runs/platform-run-ports.ts";
import type {
  PlatformReportArtifactCaseInput,
  PublishedRunArtifact,
  RunArtifactStore
} from "../runs/run-artifact-port.ts";
import {
  createReportAccumulator,
  type ReportAggregationResult
} from "@cortex-eval/reporting/src/report-aggregation.ts";

/** Safe platform Report lifecycle event name. */
export type PlatformReportBusinessEventName =
  "RUN_REPORT_STARTED" | "RUN_REPORT_COMPLETED" | "RUN_CANCEL_REQUESTED" | "RUN_CANCELLED";

/** Safe Report lifecycle event without Case or configuration content. */
export interface PlatformReportBusinessEvent {
  /** Stable event discriminator. */
  readonly event: PlatformReportBusinessEventName;
  /** Owning Run identity. */
  readonly runId: string;
  /** Durable event timestamp. */
  readonly timestamp: string;
}

/** Entrypoint-owned Report lifecycle event sink. */
export interface PlatformReportEventSink {
  /** Record one sanitized lifecycle event. */
  readonly record: (event: PlatformReportBusinessEvent) => Promise<void>;
}

/** Explicit dependencies for platform Reporting. */
export interface PlatformReportServiceDependencies {
  /** Short Run query, claim and terminal-commit boundary. */
  readonly runTransactionManager: PlatformRunTransactionManager;
  /** Short normalized Evaluation query boundary. */
  readonly evalTransactionManager: PlatformEvalTransactionManager;
  /** Immutable paired Report Artifact store. */
  readonly artifactStore: RunArtifactStore;
  /** Application time source. */
  readonly clock: Clock;
  /** Externalized safe failure message resolver. */
  readonly messageResolver: PlatformRunMessageResolver;
  /** Resilient safe lifecycle event sink. */
  readonly eventSink: PlatformReportEventSink;
}

interface PreparedPlatformReport {
  readonly run: PlatformRun;
  readonly aggregation: ReportAggregationResult;
}

/** Complete committed Report overview without Case arrays. */
export interface PlatformReportOverview {
  /** Full frozen Run context used only by the report protocol mapper. */
  readonly run: PlatformRun | ImportedReportRun;
  /** Persisted bounded report statistics. */
  readonly report: PlatformReportSummary;
  /** Current availability of every committed Run Artifact. */
  readonly artifactAvailability: Awaited<ReturnType<RunArtifactStore["inspect"]>>;
}

/** Stable platform Report Case filters. */
export interface PlatformReportCaseQuery {
  /** Owning Run identity. */
  readonly runId: string;
  /** Maximum visible Case count. */
  readonly limit: number;
  /** Last seen frozen Ordinal. */
  readonly afterOrdinal?: number | undefined;
  /** Exact REST status alternatives. */
  readonly restStatuses?: readonly StoredRestCaseResult["status"][] | undefined;
  /** Exact Evaluation status alternatives. */
  readonly evalStatuses?: readonly PlatformEvalCaseResult["status"][] | undefined;
  /** Exact normalized Metric alternatives. */
  readonly metrics?: readonly string[] | undefined;
  /** Exact business-module alternatives. */
  readonly businessModules?: readonly string[] | undefined;
  /** Exact scenario-tag alternatives. */
  readonly scenarioTags?: readonly string[] | undefined;
}

/** Complete normalized Report Case plus current raw-evidence availability. */
export interface PlatformReportCase {
  /** Frozen Case identity and definition. */
  readonly testCase: FrozenRunCase;
  /** Complete normalized REST result. */
  readonly rest: StoredRestCaseResult;
  /** Complete normalized Evaluation result. */
  readonly evaluation: PlatformEvalCaseResult;
  /** Current raw evidence state without reading Raw content. */
  readonly rawEvidenceStatus: "ABSENT" | "PRESENT" | "MISSING" | "CORRUPTED";
}

/** Cursor-ready filtered Report Case page. */
export interface PlatformReportCasePage {
  /** Complete visible report Cases. */
  readonly items: readonly PlatformReportCase[];
  /** Last visible Ordinal when another matching Case exists. */
  readonly nextCursor: number | null;
}

/** Exact Report start outcome including pre-claim reconciliation failure. */
export type PlatformReportStartResult =
  | { readonly ok: true; readonly run: PlatformRun }
  | {
      readonly ok: false;
      readonly error:
        | { readonly code: "RUN_NOT_FOUND" }
        | { readonly code: "REPORT_RECONCILIATION_FAILED" }
        | {
            readonly code: "RUN_STATE_CONFLICT";
            readonly reason: "STATE_OR_REVISION" | "GLOBAL_RUNNING" | "STAGE_UNAVAILABLE";
          };
    };

// Reject non-advancing or malformed repository cursors before a stream can loop.
function nextCursor(
  current: number | undefined,
  page: RestResultPage | PlatformEvalResultPage
): number | null {
  const next = page.nextCursor;
  if (next !== null && (next <= (current ?? -1) || page.items.at(-1)?.ordinal !== next)) {
    throw new Error("REPORT_RECONCILIATION_FAILED");
  }
  return next;
}

// Stream REST results through bounded short read transactions.
async function* restResults(
  transactions: PlatformRunTransactionManager,
  runId: string
): AsyncGenerator<StoredRestCaseResult> {
  let afterOrdinal: number | undefined;
  for (;;) {
    const page = await transactions.execute(async (transaction) =>
      transaction.runs.queryRestResults({ runId, limit: 100, afterOrdinal })
    );
    for (const item of page.items) yield item;
    const next = nextCursor(afterOrdinal, page);
    if (next === null) return;
    afterOrdinal = next;
  }
}

// Stream normalized Evaluation results through bounded short read transactions.
async function* evaluationResults(
  transactions: PlatformEvalTransactionManager,
  runId: string
): AsyncGenerator<PlatformEvalCaseResult> {
  let afterOrdinal: number | undefined;
  for (;;) {
    const page = await transactions.execute(async (transaction) =>
      transaction.evaluations.queryResults({ runId, limit: 200, afterOrdinal })
    );
    for (const item of page.items) yield item;
    const next = nextCursor(afterOrdinal, page);
    if (next === null) return;
    afterOrdinal = next;
  }
}

// Join frozen Case, REST and Evaluation facts without retaining result collections.
async function* alignedCases(
  run: PlatformRun,
  runTransactions: PlatformRunTransactionManager,
  evalTransactions: PlatformEvalTransactionManager
): AsyncGenerator<PlatformReportArtifactCaseInput> {
  const rest = restResults(runTransactions, run.id)[Symbol.asyncIterator]();
  const evaluation = evaluationResults(evalTransactions, run.id)[Symbol.asyncIterator]();
  try {
    for (const testCase of run.suite.cases) {
      const [restStep, evalStep] = await Promise.all([rest.next(), evaluation.next()]);
      if (
        restStep.done ||
        evalStep.done ||
        restStep.value.runId !== run.id ||
        evalStep.value.runId !== run.id ||
        restStep.value.caseKey !== testCase.caseKey ||
        evalStep.value.caseKey !== testCase.caseKey ||
        restStep.value.ordinal !== testCase.ordinal ||
        evalStep.value.ordinal !== testCase.ordinal ||
        restStep.value.caseDefinitionHash !== testCase.definitionHash
      ) {
        throw new Error("REPORT_RECONCILIATION_FAILED");
      }
      yield { testCase, rest: restStep.value, evaluation: evalStep.value };
    }
    const [restTail, evalTail] = await Promise.all([rest.next(), evaluation.next()]);
    if (!restTail.done || !evalTail.done) throw new Error("REPORT_RECONCILIATION_FAILED");
  } finally {
    await Promise.allSettled([rest.return(undefined), evaluation.return(undefined)]);
  }
}

// Join imported REST and Evaluation facts; frozen Case definitions live in REST rows.
async function* alignedImportedCases(
  run: ImportedReportRun,
  runTransactions: PlatformRunTransactionManager,
  evalTransactions: PlatformEvalTransactionManager
): AsyncGenerator<PlatformReportArtifactCaseInput> {
  const rest = restResults(runTransactions, run.id)[Symbol.asyncIterator]();
  const evaluation = evaluationResults(evalTransactions, run.id)[Symbol.asyncIterator]();
  let ordinal = 0;
  try {
    for (;;) {
      const [restStep, evalStep] = await Promise.all([rest.next(), evaluation.next()]);
      if (restStep.done || evalStep.done) {
        if (!restStep.done || !evalStep.done || ordinal !== run.suite.caseCount) {
          throw new Error("REPORT_RECONCILIATION_FAILED");
        }
        return;
      }
      if (
        restStep.value.runId !== run.id ||
        evalStep.value.runId !== run.id ||
        restStep.value.caseKey !== evalStep.value.caseKey ||
        restStep.value.ordinal !== ordinal ||
        evalStep.value.ordinal !== ordinal
      ) {
        throw new Error("REPORT_RECONCILIATION_FAILED");
      }
      yield {
        testCase: {
          caseKey: restStep.value.caseKey,
          ordinal,
          definitionHash: restStep.value.caseDefinitionHash,
          definition: restStep.value.definition
        },
        rest: restStep.value,
        evaluation: evalStep.value
      };
      ordinal += 1;
    }
  } finally {
    await Promise.allSettled([rest.return(undefined), evaluation.return(undefined)]);
  }
}

// Select the exact alignment strategy without making imported history executable.
function reportCases(
  run: PlatformRun | ImportedReportRun,
  runTransactions: PlatformRunTransactionManager,
  evalTransactions: PlatformEvalTransactionManager
): AsyncGenerator<PlatformReportArtifactCaseInput> {
  return run.sourceType === "PLATFORM"
    ? alignedCases(run, runTransactions, evalTransactions)
    : alignedImportedCases(run, runTransactions, evalTransactions);
}

// Apply AND across fields and OR within each exact Report Case filter.
function matchesQuery(
  item: PlatformReportArtifactCaseInput,
  query: PlatformReportCaseQuery
): boolean {
  if (query.restStatuses !== undefined && !query.restStatuses.includes(item.rest.status)) {
    return false;
  }
  if (query.evalStatuses !== undefined && !query.evalStatuses.includes(item.evaluation.status)) {
    return false;
  }
  if (
    query.metrics !== undefined &&
    !item.evaluation.metrics.some((metric) => query.metrics?.includes(metric.metric) === true)
  ) {
    return false;
  }
  if (
    query.businessModules !== undefined &&
    !query.businessModules.includes(item.testCase.definition.metadata.businessModule)
  ) {
    return false;
  }
  if (
    query.scenarioTags !== undefined &&
    !query.scenarioTags.includes(item.testCase.definition.metadata.scenarioTag)
  ) {
    return false;
  }
  return true;
}

/** Platform Report orchestration with preflight before claim and paired publication. */
export class PlatformReportService {
  readonly #runTransactions: PlatformRunTransactionManager;
  readonly #evalTransactions: PlatformEvalTransactionManager;
  readonly #artifacts: RunArtifactStore;
  readonly #clock: Clock;
  readonly #messages: PlatformRunMessageResolver;
  readonly #events: PlatformReportEventSink;
  readonly #tasks = new Map<string, Promise<void>>();
  readonly #controllers = new Map<string, AbortController>();
  readonly #interrupting = new Set<string>();

  /** Bind all pure, persistence, file and observation boundaries. */
  public constructor(dependencies: PlatformReportServiceDependencies) {
    this.#runTransactions = dependencies.runTransactionManager;
    this.#evalTransactions = dependencies.evalTransactionManager;
    this.#artifacts = dependencies.artifactStore;
    this.#clock = dependencies.clock;
    this.#messages = dependencies.messageResolver;
    this.#events = dependencies.eventSink;
  }

  /** Preflight every immutable result, then claim and asynchronously publish REPORT. */
  public async start(input: PlatformRunRevisionInput): Promise<PlatformReportStartResult> {
    const candidate = await this.#runTransactions.execute(async (transaction) =>
      transaction.runs.getPlatformRun(input.runId)
    );
    if (candidate === null) return { ok: false, error: { code: "RUN_NOT_FOUND" } };
    if (candidate.stage !== "REPORT") {
      return { ok: false, error: { code: "RUN_STATE_CONFLICT", reason: "STAGE_UNAVAILABLE" } };
    }
    if (candidate.status !== "READY" || candidate.lockRevision !== input.expectedRevision) {
      return { ok: false, error: { code: "RUN_STATE_CONFLICT", reason: "STATE_OR_REVISION" } };
    }
    let prepared: PreparedPlatformReport;
    try {
      prepared = await this.#prepare(candidate);
    } catch {
      return { ok: false, error: { code: "REPORT_RECONCILIATION_FAILED" } };
    }
    const claim = await this.#runTransactions.execute(async (transaction) =>
      transaction.runs.claimStage(input.runId, input.expectedRevision, this.#clock.now())
    );
    if (!claim.ok) {
      return claim.reason === "NOT_FOUND"
        ? { ok: false, error: { code: "RUN_NOT_FOUND" } }
        : { ok: false, error: { code: "RUN_STATE_CONFLICT", reason: claim.reason } };
    }
    await this.#recordEvent("RUN_REPORT_STARTED", claim.run.id, claim.run.updatedAt);
    this.#launch({ run: claim.run, aggregation: prepared.aggregation });
    return { ok: true, run: claim.run };
  }

  /** Wait until every currently owned Report settles. */
  public async waitForIdle(): Promise<void> {
    while (this.#tasks.size > 0) await Promise.all([...this.#tasks.values()]);
  }

  /** Read one committed Report overview without recomputing statistics. */
  public async get(runId: string): Promise<PlatformReportOverview | null> {
    const run = await this.#readReportRun(runId);
    if (run === null) return null;
    if (run.reportSummary === null || run.reportResultSetHash === null) return null;
    const report = run.reportSummary;
    const artifactAvailability =
      run.sourceType === "PLATFORM"
        ? await this.#artifacts.inspect(run.artifactManifest)
        : run.artifactManifest.artifacts.map((artifact) => ({
            artifact,
            status: "MISSING" as const
          }));
    return { run, report, artifactAvailability };
  }

  /** Check Run existence across executable platform and immutable imported history. */
  public async exists(runId: string): Promise<boolean> {
    return (await this.#readReportRun(runId)) !== null;
  }

  /** Scan immutable ordered facts into one bounded filtered Report Case page. */
  public async queryCases(query: PlatformReportCaseQuery): Promise<PlatformReportCasePage | null> {
    if (
      !Number.isInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > 200 ||
      (query.afterOrdinal !== undefined &&
        (!Number.isInteger(query.afterOrdinal) || query.afterOrdinal < 0))
    ) {
      throw new Error("REPORT_QUERY_INVALID");
    }
    const run = await this.#readReportRun(query.runId);
    if (run === null) return null;
    if (run.reportSummary === null || run.reportResultSetHash === null) return null;
    const matching: PlatformReportCase[] = [];
    for await (const item of reportCases(run, this.#runTransactions, this.#evalTransactions)) {
      if (item.testCase.ordinal <= (query.afterOrdinal ?? -1) || !matchesQuery(item, query)) {
        continue;
      }
      matching.push({
        ...item,
        rawEvidenceStatus: await this.#rawEvidenceStatus(item.evaluation, run.sourceType)
      });
      if (matching.length > query.limit) break;
    }
    const hasMore = matching.length > query.limit;
    const items = hasMore ? matching.slice(0, query.limit) : matching;
    return {
      items,
      nextCursor: hasMore ? (items.at(-1)?.testCase.ordinal ?? null) : null
    };
  }

  /** Read one complete committed Report Case without scanning unrelated result bodies. */
  public async getCase(runId: string, caseKey: string): Promise<PlatformReportCase | null> {
    const run = await this.#readReportRun(runId);
    if (run === null) return null;
    if (run.reportSummary === null || run.reportResultSetHash === null) return null;
    const platformCase =
      run.sourceType === "PLATFORM"
        ? run.suite.cases.find((item) => item.caseKey === caseKey)
        : undefined;
    if (run.sourceType === "PLATFORM" && platformCase === undefined) return null;
    const rest = await this.#runTransactions.execute(async (transaction) =>
      transaction.runs.getRestResult(runId, caseKey)
    );
    const targetOrdinal = platformCase?.ordinal ?? rest?.ordinal;
    if (targetOrdinal === undefined) return null;
    const evaluationPage = await this.#evalTransactions.execute(async (transaction) =>
      transaction.evaluations.queryResults({
        runId,
        limit: 1,
        ...(targetOrdinal === 0 ? {} : { afterOrdinal: targetOrdinal - 1 })
      })
    );
    const evaluation = evaluationPage.items[0];
    const testCase =
      platformCase ??
      (rest === null
        ? undefined
        : {
            caseKey: rest.caseKey,
            ordinal: rest.ordinal,
            definitionHash: rest.caseDefinitionHash,
            definition: rest.definition
          });
    if (
      testCase === undefined ||
      rest === null ||
      evaluation === undefined ||
      rest.ordinal !== testCase.ordinal ||
      evaluation.ordinal !== testCase.ordinal ||
      rest.caseKey !== testCase.caseKey ||
      evaluation.caseKey !== testCase.caseKey ||
      rest.caseDefinitionHash !== testCase.definitionHash
    ) {
      return null;
    }
    return {
      testCase,
      rest,
      evaluation,
      rawEvidenceStatus: await this.#rawEvidenceStatus(evaluation, run.sourceType)
    };
  }

  /** Stream every aligned committed Report Case once for normalized export. */
  public async *streamCases(runId: string): AsyncGenerator<PlatformReportArtifactCaseInput> {
    const run = await this.#readReportRun(runId);
    if (run === null) throw new Error("REPORT_RECONCILIATION_FAILED");
    if (run.reportSummary === null || run.reportResultSetHash === null) {
      throw new Error("REPORT_RECONCILIATION_FAILED");
    }
    let count = 0;
    for await (const item of reportCases(run, this.#runTransactions, this.#evalTransactions)) {
      yield item;
      count += 1;
    }
    const expected = run.sourceType === "PLATFORM" ? run.suite.cases.length : run.suite.caseCount;
    if (count !== expected) throw new Error("REPORT_RECONCILIATION_FAILED");
  }

  /** Persist Report cancellation and abort the local file owner immediately. */
  public async cancel(input: PlatformRunRevisionInput): Promise<PlatformRunActionResult> {
    const result = await this.#runTransactions.execute(async (transaction) =>
      transaction.runs.requestCancel(input.runId, input.expectedRevision, this.#clock.now())
    );
    if (!result.ok) {
      return result.reason === "NOT_FOUND"
        ? { ok: false, error: { code: "RUN_NOT_FOUND" } }
        : { ok: false, error: { code: "RUN_STATE_CONFLICT", reason: "STATE_OR_REVISION" } };
    }
    await this.#recordEvent("RUN_CANCEL_REQUESTED", result.run.id, result.run.updatedAt);
    this.#controllers.get(input.runId)?.abort();
    return { ok: true, run: result.run };
  }

  /** Interrupt every locally owned Report before storage shutdown. */
  public async shutdown(): Promise<void> {
    for (const [runId, controller] of this.#controllers) {
      this.#interrupting.add(runId);
      controller.abort();
    }
    await this.waitForIdle();
  }

  // Reconcile the first pass and retain only compact aggregate facts.
  async #prepare(run: PlatformRun): Promise<PreparedPlatformReport> {
    const evaluationContextHash = run.evaluationContextHash;
    const evaluationResultSetHash = run.evaluationResultSetHash;
    if (evaluationContextHash === null || evaluationResultSetHash === null) {
      throw new Error("REPORT_RECONCILIATION_FAILED");
    }
    const accumulator = createReportAccumulator({
      owner: { kind: "RUN", id: run.id },
      runContextHash: run.runContextHash,
      evaluationContextHash,
      evaluationResultSetHash,
      expectedCaseKey: (ordinal) => run.suite.cases[ordinal]?.caseKey ?? null
    });
    for await (const item of alignedCases(run, this.#runTransactions, this.#evalTransactions)) {
      accumulator.add({
        caseKey: item.testCase.caseKey,
        ordinal: item.testCase.ordinal,
        rest: { status: item.rest.status, resultHash: item.rest.resultHash },
        evaluation: {
          status: item.evaluation.status,
          evalResultHash: item.evaluation.evalResultHash,
          finalCaseResultHash: item.evaluation.finalCaseResultHash,
          metrics: item.evaluation.metrics
        }
      });
    }
    return { run, aggregation: accumulator.finish() };
  }

  // Own one background task and keep all failures internally settled.
  #launch(prepared: PreparedPlatformReport): void {
    const controller = new AbortController();
    this.#controllers.set(prepared.run.id, controller);
    const task = this.#execute(prepared, controller.signal)
      .catch(() => undefined)
      .finally(() => {
        this.#controllers.delete(prepared.run.id);
        this.#interrupting.delete(prepared.run.id);
        this.#tasks.delete(prepared.run.id);
      });
    this.#tasks.set(prepared.run.id, task);
  }

  // Publish both files outside transactions and commit their manifest atomically.
  async #execute(prepared: PreparedPlatformReport, signal: AbortSignal): Promise<void> {
    const published: PublishedRunArtifact[] = [];
    try {
      const reportCompletedAt = this.#clock.now();
      const output = await this.#artifacts.writeReport({
        run: prepared.run,
        completedAt: reportCompletedAt,
        aggregation: prepared.aggregation,
        expectedTotal: prepared.run.suite.cases.length,
        signal,
        cases: alignedCases(prepared.run, this.#runTransactions, this.#evalTransactions)
      });
      published.push(output.json, output.markdown);
      const current = await this.#runTransactions.execute(async (transaction) =>
        transaction.runs.getPlatformRunProgress(prepared.run.id)
      );
      if (current?.status !== "RUNNING" || current.stage !== "REPORT") {
        throw new Error("RUN_REPORT_OWNER_LOST");
      }
      if (this.#interrupting.has(prepared.run.id)) {
        await this.#removeUncommitted(published);
        published.length = 0;
        const interruptedAt = this.#clock.now();
        await this.#runTransactions.execute(async (transaction) =>
          transaction.runs.interruptRun(prepared.run.id, current.lockRevision, interruptedAt)
        );
        return;
      }
      if (current.cancelRequestedAt !== null) {
        await this.#removeUncommitted(published);
        published.length = 0;
        const cancelledAt = this.#clock.now();
        const cancelled = await this.#runTransactions.execute(async (transaction) =>
          transaction.runs.commitCancellation(prepared.run.id, current.lockRevision, cancelledAt)
        );
        if (cancelled !== null) {
          await this.#recordEvent("RUN_CANCELLED", prepared.run.id, cancelledAt);
        }
        return;
      }
      const committed = await this.#runTransactions.execute(async (transaction) =>
        transaction.runs.completeReportStage({
          runId: prepared.run.id,
          expectedRevision: current.lockRevision,
          aggregation: prepared.aggregation,
          artifactManifest: {
            contractVersion: "cortex.artifact-manifest.v1",
            owner: { kind: "RUN", id: prepared.run.id },
            artifacts: [output.json.descriptor, output.markdown.descriptor]
          },
          completedAt: reportCompletedAt
        })
      );
      if (committed === null) throw new Error("RUN_REPORT_COMMIT_CONFLICT");
      published.length = 0;
      await this.#recordEvent("RUN_REPORT_COMPLETED", prepared.run.id, reportCompletedAt);
    } catch (error) {
      await this.#removeUncommitted(published);
      const current = await this.#runTransactions.execute(async (transaction) =>
        transaction.runs.getPlatformRunProgress(prepared.run.id)
      );
      if (current?.status === "RUNNING" && current.stage === "REPORT") {
        const completedAt = this.#clock.now();
        if (this.#interrupting.has(prepared.run.id)) {
          await this.#runTransactions.execute(async (transaction) =>
            transaction.runs.interruptRun(prepared.run.id, current.lockRevision, completedAt)
          );
          return;
        }
        if (current.cancelRequestedAt !== null) {
          const cancelled = await this.#runTransactions.execute(async (transaction) =>
            transaction.runs.commitCancellation(prepared.run.id, current.lockRevision, completedAt)
          );
          if (cancelled !== null) {
            await this.#recordEvent("RUN_CANCELLED", prepared.run.id, completedAt);
          }
          return;
        }
        await this.#runTransactions.execute(async (transaction) =>
          transaction.runs.failRun({
            runId: prepared.run.id,
            expectedRevision: current.lockRevision,
            errorCode: "REPORT_RECONCILIATION_FAILED",
            errorMessage: this.#messages.message("REPORT_RECONCILIATION_FAILED"),
            completedAt
          })
        );
      }
      throw error;
    }
  }

  // Remove only files published by this not-yet-committed owner.
  async #removeUncommitted(artifacts: readonly PublishedRunArtifact[]): Promise<void> {
    await Promise.allSettled(
      artifacts.map((artifact) => this.#artifacts.removeUncommitted(artifact))
    );
  }

  // Inspect only the allowlisted evidence descriptor referenced by one normalized result.
  async #rawEvidenceStatus(
    evaluation: PlatformEvalCaseResult,
    sourceType: PlatformRun["sourceType"] | ImportedReportRun["sourceType"]
  ): Promise<PlatformReportCase["rawEvidenceStatus"]> {
    const evidence = evaluation.rawEvidence;
    if (evidence === null) return "ABSENT";
    if (sourceType === "OFFLINE_IMPORT") return "MISSING";
    const match = /^runs\/([^/]+)\/promptfoo-raw\.json$/.exec(evidence.path);
    const ownerId = match?.[1];
    if (ownerId === undefined) return "CORRUPTED";
    const descriptor: RunArtifactDescriptor = {
      kind: "RAW_PROMPTFOO_EVIDENCE",
      path: evidence.path,
      expectedSha256: evidence.expectedSha256,
      expectedSizeBytes: evidence.expectedSizeBytes,
      contractVersion: "cortex.platform-raw-promptfoo-evidence.v1"
    };
    const availability = await this.#artifacts.inspect({
      contractVersion: "cortex.artifact-manifest.v1",
      owner: { kind: "RUN", id: ownerId },
      artifacts: [descriptor]
    });
    return availability[0]?.status ?? "CORRUPTED";
  }

  // Read one reportable Run from exactly one source discriminator.
  async #readReportRun(runId: string): Promise<PlatformRun | ImportedReportRun | null> {
    return await this.#runTransactions.execute(async (transaction) => {
      const platform = await transaction.runs.getPlatformRun(runId);
      return platform ?? (await transaction.runs.getImportedReportRun(runId));
    });
  }

  // Observation failures cannot change the Report outcome.
  async #recordEvent(
    event: PlatformReportBusinessEventName,
    runId: string,
    timestamp: string
  ): Promise<void> {
    await this.#events.record({ event, runId, timestamp }).catch(() => undefined);
  }
}
