import type { DomainJsonObject } from "@cortex-eval/domain/src/domain-canonical-hash.ts";
import type { PlatformEvalCaseResult } from "../evaluation/platform-eval-models.ts";
import type {
  FrozenRunEndpoint,
  FrozenRunEvaluator,
  FrozenRunRubricPrompt,
  PlatformReportSummary,
  PlatformRunExecutionLimits
} from "../runs/platform-run-models.ts";
import type { OfflineRestCaseResult } from "../runs/offline-rest-execution-service.ts";
import type { FrozenRunCase } from "../runs/run-rest-models.ts";

/** Artifact kind accepted by one normalized offline Execution manifest. */
export type ImportedExecutionArtifactKind =
  | "REST_RESULTS"
  | "RAW_PROMPTFOO_EVIDENCE"
  | "NORMALIZED_EVAL_RESULTS"
  | "REPORT_JSON"
  | "REPORT_MARKDOWN"
  | "ANALYSIS_RESULTS";

/** One immutable expected offline Execution Artifact descriptor. */
export interface ImportedExecutionArtifactDescriptor {
  /** Stable Artifact family. */
  readonly kind: ImportedExecutionArtifactKind;
  /** Controlled project-relative POSIX path. */
  readonly path: string;
  /** Expected lowercase SHA-256. */
  readonly expectedSha256: string;
  /** Expected exact file byte size. */
  readonly expectedSizeBytes: number;
  /** Artifact payload contract version. */
  readonly contractVersion: string;
}

/** Complete immutable Artifact manifest owned by an offline Execution. */
export interface ImportedExecutionArtifactManifest {
  /** Manifest contract version. */
  readonly contractVersion: "cortex.artifact-manifest.v1";
  /** Owning offline Execution. */
  readonly owner: { readonly kind: "EXECUTION"; readonly id: string };
  /** Unique expected descriptors. */
  readonly artifacts: readonly ImportedExecutionArtifactDescriptor[];
}

/** Project one cleaned import Manifest into canonical JSON facts. */
export function importedExecutionArtifactManifestJson(
  value: ImportedExecutionArtifactManifest
): DomainJsonObject {
  return {
    contractVersion: value.contractVersion,
    owner: { kind: value.owner.kind, id: value.owner.id },
    artifacts: value.artifacts.map((artifact) => ({
      kind: artifact.kind,
      path: artifact.path,
      expectedSha256: artifact.expectedSha256,
      expectedSizeBytes: artifact.expectedSizeBytes,
      contractVersion: artifact.contractVersion
    }))
  };
}

/** Minimal normalized imported Run fact registered in P2. */
export interface ImportedExecutionRecord {
  /** New platform Run identity. */
  readonly runId: string;
  /** Immutable Work Package identity. */
  readonly packageId: string;
  /** Immutable offline Execution identity. */
  readonly executionId: string;
  /** Recomputed normalized result set hash. */
  readonly resultSetHash: string;
  /** Whether the complete normalized result contains errors. */
  readonly hasErrors: boolean;
  /** Frozen Suite snapshot. */
  readonly suiteSnapshot: DomainJsonObject;
  /** Frozen Endpoint snapshot. */
  readonly endpointSnapshot: DomainJsonObject;
  /** Frozen Evaluator snapshot. */
  readonly evaluatorSnapshot: DomainJsonObject;
  /** Frozen referenced Rubric Prompt snapshots. */
  readonly rubricPromptsSnapshot: readonly DomainJsonObject[];
  /** Frozen Run context hash. */
  readonly runContextHash: string;
  /** Frozen protocol versions. */
  readonly contractVersions: DomainJsonObject;
  /** Frozen REST and Eval limits. */
  readonly runExecutionLimits: DomainJsonObject;
  /** Versioned Run artifact expectation facts. */
  readonly artifactManifest: ImportedExecutionArtifactManifest;
  /** Registration time. */
  readonly createdAt: string;
}

/** Existing Execution identity fact used for idempotence. */
export interface ExistingImportedExecution {
  /** Platform Run identity. */
  readonly runId: string;
  /** Strict persisted source discriminator. */
  readonly sourceType: "OFFLINE_IMPORT";
  /** Immutable Work Package identity. */
  readonly packageId: string;
  /** Stored result set hash. */
  readonly resultSetHash: string;
  /** Exact cleaned Artifact identity stored with the imported Run. */
  readonly artifactManifest: ImportedExecutionArtifactManifest;
}

/** Evaluation fields imported before a new platform Run identity is allocated. */
export type ImportedExecutionEvaluationResult = Omit<
  PlatformEvalCaseResult,
  "runId" | "createdAt" | "updatedAt"
>;

/** One fully reconciled frozen Case, REST result and Evaluation result. */
export interface ImportedExecutionReportCase {
  /** Frozen Case input identity and definition. */
  readonly testCase: FrozenRunCase;
  /** Normalized offline REST fact aligned to the Case. */
  readonly rest: OfflineRestCaseResult;
  /** Normalized Evaluation fact aligned to the same Case and REST result. */
  readonly evaluation: ImportedExecutionEvaluationResult;
}

/** Compact frozen Suite identity for an imported history Run. */
export interface ImportedRunSuiteSnapshot {
  /** Source Suite identity retained by the Work Package. */
  readonly id: string;
  /** Frozen safe display name. */
  readonly name: string;
  /** Frozen Suite semantic identity. */
  readonly suiteHash: string;
  /** Exact imported Case count without embedding definitions. */
  readonly caseCount: number;
}

/** Work Package protocol identities retained by an imported history Run. */
export interface ImportedRunContractVersions {
  /** Case definition contract. */
  readonly caseDefinition: "cortex.case-definition.v1";
  /** Offline REST result contract. */
  readonly restResults: "cortex.rest-results-jsonl.v1";
  /** Normalized Evaluation contract. */
  readonly normalizedEval: "cortex.normalized-eval-jsonl.v1";
  /** Report contract. */
  readonly report: "cortex.report.v1";
  /** Analysis input contract. */
  readonly analysisInput: "cortex.analysis-input.v1";
  /** Analysis output contract. */
  readonly analysisOutput: "cortex.analysis-output.v1";
}

/** Complete imported Report Run fact written atomically with every Case result. */
export interface ImportedExecutionReportRecord {
  /** New platform Run identity. */
  readonly runId: string;
  /** Immutable Work Package identity. */
  readonly packageId: string;
  /** Immutable offline Execution version identity. */
  readonly executionId: string;
  /** Complete REST result-set identity. */
  readonly restResultSetHash: string;
  /** Frozen Evaluation invocation identity. */
  readonly evaluationContextHash: string;
  /** Complete Evaluation result-set identity. */
  readonly evaluationResultSetHash: string;
  /** Complete Report result-set identity. */
  readonly reportResultSetHash: string;
  /** Recomputed report counters and Metric summaries. */
  readonly reportSummary: PlatformReportSummary;
  /** Frozen Suite snapshot already cleaned at the Work Package boundary. */
  readonly suiteSnapshot: ImportedRunSuiteSnapshot;
  /** Frozen Endpoint snapshot already cleaned at the Work Package boundary. */
  readonly endpointSnapshot: FrozenRunEndpoint;
  /** Frozen Evaluator snapshot already cleaned at the Work Package boundary. */
  readonly evaluatorSnapshot: FrozenRunEvaluator;
  /** Frozen referenced Rubric Prompt snapshots. */
  readonly rubricPromptsSnapshot: readonly FrozenRunRubricPrompt[];
  /** Frozen Execution context identity. */
  readonly runContextHash: string;
  /** Frozen protocol versions. */
  readonly contractVersions: ImportedRunContractVersions;
  /** Frozen REST and Evaluation limits. */
  readonly runExecutionLimits: PlatformRunExecutionLimits;
  /** Exact expected offline Artifact identities. */
  readonly artifactManifest: ImportedExecutionArtifactManifest;
  /** Offline Execution creation time. */
  readonly executionCreatedAt: string;
  /** Offline Execution first-stage start time. */
  readonly executionStartedAt: string | null;
  /** Offline Report completion time. */
  readonly completedAt: string;
  /** Local platform registration time. */
  readonly importedAt: string;
}

/** Complete bounded imported Report Run used by history and Report queries. */
export interface ImportedReportRun {
  /** Platform Run identity allocated during import. */
  readonly id: string;
  /** Strict imported-history discriminator. */
  readonly sourceType: "OFFLINE_IMPORT";
  /** Immutable Work Package identity. */
  readonly packageId: string;
  /** Immutable offline Execution identity. */
  readonly executionId: string;
  /** Imported Runs never reference a platform rerun source. */
  readonly sourceRunId: null;
  /** Imported Runs are not platform rerun attempts. */
  readonly rerunMode: "NONE";
  /** Compact frozen Suite context. */
  readonly suite: ImportedRunSuiteSnapshot;
  /** Complete frozen Endpoint context. */
  readonly endpoint: FrozenRunEndpoint;
  /** Complete frozen Evaluator context. */
  readonly evaluator: FrozenRunEvaluator;
  /** Complete frozen Rubric Prompt context. */
  readonly rubricPrompts: readonly FrozenRunRubricPrompt[];
  /** Frozen Execution context identity. */
  readonly runContextHash: string;
  /** Exact Promptfoo version. */
  readonly promptfooVersion: "0.121.18";
  /** Offline protocol identities. */
  readonly contractVersions: ImportedRunContractVersions;
  /** Frozen REST and Evaluation limits. */
  readonly runExecutionLimits: PlatformRunExecutionLimits;
  /** Terminal imported lifecycle status. */
  readonly status: "COMPLETED" | "COMPLETED_WITH_ERRORS";
  /** Imported complete Report stage. */
  readonly stage: "DONE";
  /** Complete REST result-set identity. */
  readonly restResultSetHash: string;
  /** Frozen Evaluation invocation identity. */
  readonly evaluationContextHash: string;
  /** Complete Evaluation result-set identity. */
  readonly evaluationResultSetHash: string;
  /** Complete Report result-set identity. */
  readonly reportResultSetHash: string;
  /** Recomputed bounded Report summary. */
  readonly reportSummary: PlatformReportSummary;
  /** Immutable offline Artifact identities. */
  readonly artifactManifest: ImportedExecutionArtifactManifest;
  /** Offline Report completion time. */
  readonly completedAt: string;
  /** Offline Execution creation time. */
  readonly createdAt: string;
  /** Local import registration time. */
  readonly updatedAt: string;
}

/** Existing complete Report import identity used for idempotence classification. */
export interface ExistingImportedExecutionReport {
  /** Platform Run identity. */
  readonly runId: string;
  /** Strict persisted source discriminator. */
  readonly sourceType: "OFFLINE_IMPORT";
  /** Immutable Work Package identity. */
  readonly packageId: string;
  /** Complete REST result-set identity. */
  readonly restResultSetHash: string;
  /** Frozen Evaluation invocation identity. */
  readonly evaluationContextHash: string;
  /** Complete Evaluation result-set identity. */
  readonly evaluationResultSetHash: string;
  /** Complete Report result-set identity. */
  readonly reportResultSetHash: string;
  /** Exact cleaned Artifact identity stored with the imported Run. */
  readonly artifactManifest: ImportedExecutionArtifactManifest;
}
