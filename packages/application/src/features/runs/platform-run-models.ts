import type { CaseDefinition, ProviderOutput } from "@cortex-eval/domain/src/domain-evaluation.ts";
import type {
  EndpointConfigDefinition,
  LlmConfigDefinition,
  PromptDefinition
} from "@cortex-eval/domain/src/domain-resource-models.ts";
import { validateLlmConfig } from "@cortex-eval/domain/src/domain-resource-models.ts";
import type {
  ReportMetricSummary,
  ReportSummary
} from "@cortex-eval/reporting/src/report-aggregation.ts";

import type { FrozenRunCase, RestExecutionErrorType } from "./run-rest-models.ts";

/** Frozen REST and Evaluation concurrency facts owned by a Run. */
export interface PlatformRunExecutionLimits {
  /** Execution-limits contract identity. */
  readonly contractVersion: "cortex.run-execution-limits.v1";
  /** REST maximum in-flight count. */
  readonly restConcurrency: number;
  /** Evaluation maximum in-flight count. */
  readonly evalConcurrency: number;
}

/** Artifact kind available to the closed Run pipeline. */
export type RunArtifactKind =
  | "REST_RESULTS"
  | "RAW_PROMPTFOO_EVIDENCE"
  | "NORMALIZED_EVAL_RESULTS"
  | "REPORT_JSON"
  | "REPORT_MARKDOWN"
  | "ANALYSIS_RESULTS";

/** One immutable expected Run Artifact descriptor. */
export interface RunArtifactDescriptor {
  /** Stable Artifact family. */
  readonly kind: RunArtifactKind;
  /** Controlled project-relative POSIX path. */
  readonly path: string;
  /** Expected lowercase SHA-256. */
  readonly expectedSha256: string;
  /** Expected exact file byte size. */
  readonly expectedSizeBytes: number;
  /** Artifact payload contract version. */
  readonly contractVersion: string;
}

/** Complete immutable Run Artifact manifest. */
export interface RunArtifactManifest {
  /** Manifest contract version. */
  readonly contractVersion: "cortex.artifact-manifest.v1";
  /** Owning platform Run. */
  readonly owner: { readonly kind: "RUN"; readonly id: string };
  /** Unique descriptors in stage commit order. */
  readonly artifacts: readonly RunArtifactDescriptor[];
}

/** Frozen Suite input captured by one platform Run. */
export interface FrozenRunSuite {
  /** Current Suite identity at freeze time. */
  readonly id: string;
  /** Frozen display name. */
  readonly name: string;
  /** Frozen semantic Suite hash. */
  readonly suiteHash: string;
  /** Complete frozen Cases in exact Ordinal order. */
  readonly cases: readonly FrozenRunCase[];
}

/** Frozen Endpoint input captured by one platform Run. */
export interface FrozenRunEndpoint {
  /** Current Endpoint identity at freeze time, absent only for imported history. */
  readonly sourceId: string | null;
  /** Frozen display name. */
  readonly name: string;
  /** Frozen semantic Endpoint hash. */
  readonly configHash: string;
  /** Complete validated Endpoint definition. */
  readonly definition: EndpointConfigDefinition;
}

/** Frozen Evaluator input captured by one platform Run. */
export interface FrozenRunEvaluator {
  /** Current LLM identity at freeze time, absent only for imported history. */
  readonly sourceId: string | null;
  /** Frozen display name. */
  readonly name: string;
  /** Frozen semantic LLM hash. */
  readonly configHash: string;
  /** Complete validated LLM definition. */
  readonly definition: LlmConfigDefinition;
}

/** Revalidate one typed Evaluator at the Application-to-Adapter boundary. */
export function isValidFrozenRunEvaluatorDefinition(
  value: FrozenRunEvaluator["definition"]
): boolean {
  return validateLlmConfig(value).ok;
}

/** Frozen Rubric Prompt captured by one platform Run. */
export interface FrozenRunRubricPrompt {
  /** Current Prompt identity at freeze time, absent only for imported history. */
  readonly sourceId: string | null;
  /** Frozen display name. */
  readonly name: string;
  /** Frozen semantic Prompt hash. */
  readonly promptHash: string;
  /** Complete validated Prompt definition. */
  readonly definition: PromptDefinition;
}

/** Platform Run contract identities frozen with all input facts. */
export interface PlatformRunContractVersions {
  /** Frozen snapshot contract. */
  readonly runSnapshot: "cortex.run-snapshot.v1";
  /** Case definition contract. */
  readonly caseDefinition: "cortex.case-definition.v1";
  /** Platform REST Artifact contract. */
  readonly platformRestResults: "cortex.platform-rest-results.v1";
}

/** Persisted bounded Report statistics for one immutable Run version. */
export interface PlatformReportSummary {
  /** Complete overall Report statistics. */
  readonly summary: ReportSummary;
  /** Stable Metric summaries sorted by Metric name. */
  readonly byMetric: readonly ReportMetricSummary[];
}

/** Current platform Run aggregate. */
export interface PlatformRun {
  /** Internal Run identity. */
  readonly id: string;
  /** Strict source discriminator. */
  readonly sourceType: "PLATFORM";
  /** Source Run for future closed rerun flows. */
  readonly sourceRunId: string | null;
  /** Current rerun mode; P5 creates only NONE. */
  readonly rerunMode: "NONE" | "RETRY_FAILED" | "FORCE";
  /** Complete frozen Suite. */
  readonly suite: FrozenRunSuite;
  /** Complete frozen Endpoint. */
  readonly endpoint: FrozenRunEndpoint;
  /** Complete frozen Evaluator. */
  readonly evaluator: FrozenRunEvaluator;
  /** Complete referenced Rubric Prompt set. */
  readonly rubricPrompts: readonly FrozenRunRubricPrompt[];
  /** Semantic frozen Run context hash. */
  readonly runContextHash: string;
  /** Exact Promptfoo version for later Evaluation. */
  readonly promptfooVersion: "0.121.18";
  /** Frozen protocol versions. */
  readonly contractVersions: PlatformRunContractVersions;
  /** Frozen REST and Evaluation limits. */
  readonly runExecutionLimits: PlatformRunExecutionLimits;
  /** Manual staged or automatic pipeline mode. */
  readonly runMode: "STAGED" | "PIPELINE";
  /** Current lifecycle status. */
  readonly status:
    | "READY"
    | "RUNNING"
    | "COMPLETED"
    | "COMPLETED_WITH_ERRORS"
    | "FAILED"
    | "CANCELLED"
    | "INTERRUPTED";
  /** Current or terminal pipeline stage. */
  readonly stage: "REST" | "EVALUATION" | "REPORT" | "DONE";
  /** Optimistic state and progress token. */
  readonly lockRevision: number;
  /** Explicit cancellation request time. */
  readonly cancelRequestedAt: string | null;
  /** Number of durable real REST Case results. */
  readonly restCompletedCount: number;
  /** Number of durable REST Error results. */
  readonly restErrorCount: number;
  /** Number of atomically committed Evaluation results. */
  readonly evalCompletedCount: number;
  /** Number of committed Evaluation PASS results. */
  readonly evalPassCount: number;
  /** Number of committed Evaluation FAIL results. */
  readonly evalFailCount: number;
  /** Number of committed Evaluation system errors. */
  readonly evalErrorCount: number;
  /** Number of committed Not Evaluated results. */
  readonly evalNotEvaluatedCount: number;
  /** Complete REST result-set hash after stage commit. */
  readonly resultSetHash: string | null;
  /** Frozen Evaluation invocation identity after Evaluation commit. */
  readonly evaluationContextHash: string | null;
  /** Complete Evaluation result-set identity after Evaluation commit. */
  readonly evaluationResultSetHash: string | null;
  /** Complete Report result-set identity after Report commit. */
  readonly reportResultSetHash: string | null;
  /** Bounded committed Report summary, absent before Report commit. */
  readonly reportSummary: PlatformReportSummary | null;
  /** Complete immutable Artifact expectation facts. */
  readonly artifactManifest: RunArtifactManifest;
  /** Stable terminal system error code. */
  readonly errorCode: string | null;
  /** Externalized safe terminal error message. */
  readonly errorMessage: string | null;
  /** First stage start time. */
  readonly startedAt: string | null;
  /** Terminal completion time. */
  readonly completedAt: string | null;
  /** Creation time. */
  readonly createdAt: string;
  /** Last durable fact update time. */
  readonly updatedAt: string;
}

/** Small durable Run state used by polling, CAS settlement and Artifact inspection. */
export interface PlatformRunProgress {
  /** Internal Run identity. */
  readonly id: string;
  /** Strict source discriminator. */
  readonly sourceType: "PLATFORM";
  /** Current lifecycle status. */
  readonly status: PlatformRun["status"];
  /** Current or terminal pipeline stage. */
  readonly stage: PlatformRun["stage"];
  /** Latest optimistic state token. */
  readonly lockRevision: number;
  /** Explicit cancellation request time. */
  readonly cancelRequestedAt: string | null;
  /** Frozen total Case count without loading the Case array. */
  readonly restTotalCount: number;
  /** Durable REST completion count. */
  readonly restCompletedCount: number;
  /** Durable REST Error count. */
  readonly restErrorCount: number;
  /** Atomically committed Evaluation completion count. */
  readonly evalCompletedCount: number;
  /** Atomically committed Evaluation PASS count. */
  readonly evalPassCount: number;
  /** Atomically committed Evaluation FAIL count. */
  readonly evalFailCount: number;
  /** Atomically committed Evaluation system-error count. */
  readonly evalErrorCount: number;
  /** Atomically committed Not Evaluated count. */
  readonly evalNotEvaluatedCount: number;
  /** Complete REST result-set hash after stage commit. */
  readonly resultSetHash: string | null;
  /** Frozen Evaluation invocation identity after Evaluation commit. */
  readonly evaluationContextHash: string | null;
  /** Complete Evaluation result-set identity after Evaluation commit. */
  readonly evaluationResultSetHash: string | null;
  /** Complete Report result-set identity after Report commit. */
  readonly reportResultSetHash: string | null;
  /** Complete immutable Artifact expectation facts. */
  readonly artifactManifest: RunArtifactManifest;
  /** Stable terminal system error code. */
  readonly errorCode: string | null;
  /** Safe externalized terminal error message. */
  readonly errorMessage: string | null;
  /** First stage start time. */
  readonly startedAt: string | null;
  /** Terminal completion time. */
  readonly completedAt: string | null;
  /** Creation time. */
  readonly createdAt: string;
  /** Last durable fact update time. */
  readonly updatedAt: string;
}

/** One frozen Rubric Prompt identity without its messages. */
export interface FrozenRunRubricPromptSummary {
  /** Current Prompt identity at freeze time. */
  readonly sourceId: string | null;
  /** Frozen display name. */
  readonly name: string;
  /** Frozen semantic Prompt hash. */
  readonly promptHash: string;
  /** Frozen business Prompt key. */
  readonly promptKey: string;
}

/** Bounded Run detail projection that excludes Case arrays and Prompt bodies. */
export interface PlatformRunDetail extends PlatformRunProgress {
  /** Source Run for later closed rerun flows. */
  readonly sourceRunId: string | null;
  /** Current rerun mode. */
  readonly rerunMode: PlatformRun["rerunMode"];
  /** Frozen Suite identity and count without Case definitions. */
  readonly suite: {
    readonly id: string;
    readonly name: string;
    readonly suiteHash: string;
    readonly caseCount: number;
  };
  /** Complete bounded frozen Endpoint. */
  readonly endpoint: FrozenRunEndpoint;
  /** Complete bounded frozen Evaluator. */
  readonly evaluator: FrozenRunEvaluator;
  /** Frozen Prompt identities without messages. */
  readonly rubricPrompts: readonly FrozenRunRubricPromptSummary[];
  /** Semantic frozen Run context hash. */
  readonly runContextHash: string;
  /** Exact Promptfoo version. */
  readonly promptfooVersion: PlatformRun["promptfooVersion"];
  /** Frozen protocol versions. */
  readonly contractVersions: PlatformRunContractVersions;
  /** Frozen REST and Evaluation limits. */
  readonly runExecutionLimits: PlatformRunExecutionLimits;
  /** Manual staged or automatic pipeline mode. */
  readonly runMode: PlatformRun["runMode"];
}

/** Project one already-validated full Run into its small durable state shape. */
export function platformRunProgress(value: PlatformRun): PlatformRunProgress {
  return {
    id: value.id,
    sourceType: value.sourceType,
    status: value.status,
    stage: value.stage,
    lockRevision: value.lockRevision,
    cancelRequestedAt: value.cancelRequestedAt,
    restTotalCount: value.suite.cases.length,
    restCompletedCount: value.restCompletedCount,
    restErrorCount: value.restErrorCount,
    evalCompletedCount: value.evalCompletedCount,
    evalPassCount: value.evalPassCount,
    evalFailCount: value.evalFailCount,
    evalErrorCount: value.evalErrorCount,
    evalNotEvaluatedCount: value.evalNotEvaluatedCount,
    resultSetHash: value.resultSetHash,
    evaluationContextHash: value.evaluationContextHash,
    evaluationResultSetHash: value.evaluationResultSetHash,
    reportResultSetHash: value.reportResultSetHash,
    artifactManifest: value.artifactManifest,
    errorCode: value.errorCode,
    errorMessage: value.errorMessage,
    startedAt: value.startedAt,
    completedAt: value.completedAt,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  };
}

/** Project one already-validated full Run into its bounded detail shape. */
export function platformRunDetail(value: PlatformRun): PlatformRunDetail {
  return {
    ...platformRunProgress(value),
    sourceRunId: value.sourceRunId,
    rerunMode: value.rerunMode,
    suite: {
      id: value.suite.id,
      name: value.suite.name,
      suiteHash: value.suite.suiteHash,
      caseCount: value.suite.cases.length
    },
    endpoint: value.endpoint,
    evaluator: value.evaluator,
    rubricPrompts: value.rubricPrompts.map((item) => ({
      sourceId: item.sourceId,
      name: item.name,
      promptHash: item.promptHash,
      promptKey: item.definition.promptKey
    })),
    runContextHash: value.runContextHash,
    promptfooVersion: value.promptfooVersion,
    contractVersions: value.contractVersions,
    runExecutionLimits: value.runExecutionLimits,
    runMode: value.runMode
  };
}

/** Shared persisted REST result fields. */
interface StoredRestCaseResultBase {
  /** Owning Run identity. */
  readonly runId: string;
  /** Frozen Case key. */
  readonly caseKey: string;
  /** Frozen Case order. */
  readonly ordinal: number;
  /** Complete frozen Case definition. */
  readonly definition: CaseDefinition;
  /** Frozen Case definition hash. */
  readonly caseDefinitionHash: string;
  /** Rounded nonnegative request duration. */
  readonly durationMs: number;
  /** Durable completion time. */
  readonly completedAt: string;
  /** Semantic REST result hash. */
  readonly resultHash: string;
  /** Reuse identity for a copied REST result. */
  readonly provenance: {
    readonly sourceKind: "RUN" | "EXECUTION";
    readonly sourceId: string;
    readonly sourceResultHash: string;
  } | null;
}

/** Persisted successful REST result. */
export interface StoredRestCaseSuccess extends StoredRestCaseResultBase {
  /** Stable success status. */
  readonly status: "SUCCEEDED";
  /** Successful HTTP status. */
  readonly httpStatus: number;
  /** Clean validated Provider Output. */
  readonly providerOutput: ProviderOutput;
  /** Error type is explicitly absent. */
  readonly errorType: null;
  /** Error message is explicitly absent. */
  readonly errorMessage: null;
}

/** Persisted failed REST result. */
export interface StoredRestCaseFailure extends StoredRestCaseResultBase {
  /** Stable failure status. */
  readonly status: "ERROR";
  /** HTTP status when one was received. */
  readonly httpStatus: number | null;
  /** Provider Output is explicitly absent. */
  readonly providerOutput: null;
  /** Stable REST error classification. */
  readonly errorType: RestExecutionErrorType;
  /** Externalized safe error text. */
  readonly errorMessage: string;
}

/** One real persisted REST Case result. */
export type StoredRestCaseResult = StoredRestCaseSuccess | StoredRestCaseFailure;

/** Stable REST result page query. */
export interface RestResultQuery {
  /** Owning Run identity. */
  readonly runId: string;
  /** Maximum returned items. */
  readonly limit: number;
  /** Last seen exact Ordinal. */
  readonly afterOrdinal?: number | undefined;
}

/** Stable REST result page. */
export interface RestResultPage {
  /** Ordered real result facts. */
  readonly items: readonly StoredRestCaseResult[];
  /** Next exact Ordinal when another page exists. */
  readonly nextCursor: number | null;
}

/** Small platform Run projection for Dashboard and list pages. */
export interface PlatformRunSummary {
  /** Internal Run identity. */
  readonly id: string;
  /** Strict source discriminator. */
  readonly sourceType: "PLATFORM" | "OFFLINE_IMPORT";
  /** Frozen Suite identity. */
  readonly suiteId: string;
  /** Frozen Suite display name. */
  readonly suiteName: string;
  /** Manual staged or pipeline mode. */
  readonly runMode: "STAGED" | "PIPELINE";
  /** Current lifecycle status. */
  readonly status: PlatformRun["status"];
  /** Current or terminal stage. */
  readonly stage: PlatformRun["stage"];
  /** Latest optimistic state token. */
  readonly lockRevision: number;
  /** Explicit cancellation request time. */
  readonly cancelRequestedAt: string | null;
  /** Frozen total Case count. */
  readonly restTotalCount: number;
  /** Durable REST completion count. */
  readonly restCompletedCount: number;
  /** Durable REST Error count. */
  readonly restErrorCount: number;
  /** Atomically committed Evaluation completion count. */
  readonly evalCompletedCount: number;
  /** Atomically committed Evaluation PASS count. */
  readonly evalPassCount: number;
  /** Atomically committed Evaluation FAIL count. */
  readonly evalFailCount: number;
  /** Atomically committed Evaluation system-error count. */
  readonly evalErrorCount: number;
  /** Atomically committed Not Evaluated count. */
  readonly evalNotEvaluatedCount: number;
  /** Creation time. */
  readonly createdAt: string;
  /** Last durable update time. */
  readonly updatedAt: string;
}

/** Stable descending platform Run list cursor. */
export interface PlatformRunPageCursor {
  /** Last creation time. */
  readonly createdAt: string;
  /** Last Run identity tie-breaker. */
  readonly id: string;
}

/** Bounded recent platform Run query. */
export interface PlatformRunQuery {
  /** Maximum returned summaries. */
  readonly limit: number;
  /** Return Runs strictly after this descending tuple. */
  readonly afterCursor?: PlatformRunPageCursor | undefined;
}

/** Stable recent platform Run page. */
export interface PlatformRunPage {
  /** Small descending Run summaries. */
  readonly items: readonly PlatformRunSummary[];
  /** Next cursor when another page exists. */
  readonly nextCursor: PlatformRunPageCursor | null;
}
