import type {
  PlatformRun,
  PlatformRunDetail,
  PlatformRunPage,
  PlatformRunProgress,
  PlatformRunQuery,
  RestResultPage,
  RestResultQuery,
  RunArtifactManifest,
  StoredRestCaseResult
} from "./platform-run-models.ts";
import type { ImportedReportRun } from "../execution-imports/execution-import-models.ts";
import type { ReportAggregationResult } from "@cortex-eval/reporting/src/report-aggregation.ts";
import type { StoredTestCase, TestSuite } from "../test-suites/test-suite-models.ts";
import type {
  ConfigurationResource,
  ConfigurationResourceKind
} from "../configurations/configuration-models.ts";

/** Exact stage claim outcome. */
export type ClaimRunStageResult =
  | { readonly ok: true; readonly run: PlatformRun }
  | { readonly ok: false; readonly reason: "NOT_FOUND" | "STATE_OR_REVISION" | "GLOBAL_RUNNING" };

/** Exact cancellation request outcome. */
export type RequestRunCancellationResult =
  | { readonly ok: true; readonly run: PlatformRunProgress }
  | { readonly ok: false; readonly reason: "NOT_FOUND" | "STATE_OR_REVISION" };

/** REST stage commit facts guarded by one latest Revision. */
export interface CompleteRestStageInput {
  /** Target Run. */
  readonly runId: string;
  /** Latest progress Revision. */
  readonly expectedRevision: number;
  /** Complete frozen Case count. */
  readonly expectedTotal: number;
  /** Complete semantic REST result-set hash. */
  readonly resultSetHash: string;
  /** Manifest containing the immutable REST Artifact descriptor. */
  readonly artifactManifest: RunArtifactManifest;
  /** Commit timestamp. */
  readonly updatedAt: string;
}

/** REPORT stage terminal commit guarded by the latest Revision. */
export interface CompleteReportStageInput {
  /** Target platform Run. */
  readonly runId: string;
  /** Latest claimed REPORT Revision. */
  readonly expectedRevision: number;
  /** Complete preflighted Report aggregation and version. */
  readonly aggregation: ReportAggregationResult;
  /** Manifest containing exactly the new JSON and Markdown descriptors. */
  readonly artifactManifest: RunArtifactManifest;
  /** Shared Report completion timestamp. */
  readonly completedAt: string;
}

/** Stable terminal Run failure facts guarded by the latest Revision. */
export interface FailPlatformRunInput {
  /** Target Run. */
  readonly runId: string;
  /** Latest durable Revision. */
  readonly expectedRevision: number;
  /** Stable failure code. */
  readonly errorCode: string;
  /** Externalized safe failure message. */
  readonly errorMessage: string;
  /** Terminal timestamp. */
  readonly completedAt: string;
}

/** Transaction-bound platform Run persistence operations. */
export interface PlatformRunRepository {
  /** Insert one fully frozen READY/REST Run. */
  insertPlatformRun(value: PlatformRun): Promise<void>;
  /** Insert one frozen rerun and its already-validated reusable REST successes atomically. */
  insertPlatformRerun(
    value: PlatformRun,
    reusedRestResults: readonly StoredRestCaseResult[]
  ): Promise<void>;
  /** Read one strict platform Run without mapping imported history. */
  getPlatformRun(runId: string): Promise<PlatformRun | null>;
  /** Read one complete bounded imported Report history Run. */
  getImportedReportRun(runId: string): Promise<ImportedReportRun | null>;
  /** Read one bounded platform Run detail without Case arrays or Prompt bodies. */
  getPlatformRunDetail(runId: string): Promise<PlatformRunDetail | null>;
  /** Read one small durable state projection for polling and CAS settlement. */
  getPlatformRunProgress(runId: string): Promise<PlatformRunProgress | null>;
  /** Query recent platform Runs without loading frozen Case definitions. */
  queryPlatformRuns(query: PlatformRunQuery): Promise<PlatformRunPage>;
  /** Claim one READY stage while enforcing the global RUNNING invariant. */
  claimStage(
    runId: string,
    expectedRevision: number,
    updatedAt: string
  ): Promise<ClaimRunStageResult>;
  /** Record an explicit cancellation request through one CAS write. */
  requestCancel(
    runId: string,
    expectedRevision: number,
    updatedAt: string
  ): Promise<RequestRunCancellationResult>;
  /** Idempotently persist one real dispatched REST result and its counters. */
  recordRestResult(
    value: StoredRestCaseResult,
    updatedAt: string
  ): Promise<PlatformRunProgress | null>;
  /** Commit a complete REST stage only while cancellation remains absent. */
  completeRestStage(input: CompleteRestStageInput): Promise<PlatformRunProgress | null>;
  /** Atomically append both Report descriptors and finish the Run. */
  completeReportStage(input: CompleteReportStageInput): Promise<PlatformRunProgress | null>;
  /** Commit cancellation after all already-dispatched work settles. */
  commitCancellation(
    runId: string,
    expectedRevision: number,
    completedAt: string
  ): Promise<PlatformRunProgress | null>;
  /** Commit one active or automatic-handoff stage failure only before cancellation wins. */
  failRun(input: FailPlatformRunInput): Promise<PlatformRunProgress | null>;
  /** Commit runtime interruption for the still-owned active stage, including a raced stage commit. */
  interruptRun(
    runId: string,
    expectedRevision: number,
    completedAt: string
  ): Promise<PlatformRunProgress | null>;
  /** Convert all abandoned RUNNING Runs into explicit interruption facts. */
  recoverRunning(completedAt: string): Promise<readonly PlatformRunProgress[]>;
  /** Query real REST results in frozen order. */
  queryRestResults(query: RestResultQuery): Promise<RestResultPage>;
  /** Read one real REST result by Run and Case key. */
  getRestResult(runId: string, caseKey: string): Promise<StoredRestCaseResult | null>;
  /** List all durable platform Run manifests for startup orphan cleanup. */
  listPlatformRunManifests(): Promise<readonly RunArtifactManifest[]>;
}

/** Narrow current-resource reader used only while freezing a new Run. */
export interface PlatformRunResourceReader {
  /** Read one current Suite aggregate. */
  getSuite(suiteId: string): Promise<TestSuite | null>;
  /** Read all current Cases in exact Ordinal order. */
  listCases(suiteId: string): Promise<readonly StoredTestCase[]>;
  /** Read one exact current Configuration. */
  getConfiguration(
    kind: ConfigurationResourceKind,
    id: string
  ): Promise<ConfigurationResource | null>;
  /** List all current Rubric Prompts for referenced-key selection. */
  listRubricPrompts(): Promise<readonly ConfigurationResource[]>;
}

/** Repositories exposed inside one short platform Run transaction. */
export interface PlatformRunTransaction {
  /** Current Suite resources used only while freezing a new Run. */
  readonly resources: PlatformRunResourceReader;
  /** Platform Run aggregate persistence. */
  readonly runs: PlatformRunRepository;
}

/** Dedicated managed transaction boundary for Run orchestration. */
export interface PlatformRunTransactionManager {
  /** Execute database-only Run work atomically. */
  execute<T>(work: (transaction: PlatformRunTransaction) => Promise<T>): Promise<T>;
}
