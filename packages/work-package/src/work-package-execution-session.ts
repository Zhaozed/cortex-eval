import { randomUUID } from "node:crypto";

import {
  UtcDateTimeSchema,
  UuidV7Schema
} from "@cortex-eval/contracts/src/contracts-primitives.ts";
import type { EvalCaseV1 } from "@cortex-eval/contracts/src/artifact-contracts.ts";
import type { ErrorCode } from "@cortex-eval/contracts/src/error-contracts.ts";
import {
  AnalysisExecutionLimitsV1Schema,
  RunExecutionLimitsV1Schema,
  type AnalysisExecutionLimitsV1,
  type RunExecutionLimitsV1
} from "@cortex-eval/contracts/src/execution-limit-contracts.ts";
import {
  ExecutionV1Schema,
  type ExecutionV1
} from "@cortex-eval/contracts/src/work-package-contracts.ts";
import { WORK_PACKAGE_RUNTIME_LIMITS } from "@cortex-eval/contracts/src/work-package-runtime-contracts.ts";

import {
  SecureWorkPackageDirectory,
  type ImmutableFileExpectation,
  type ImmutableFilePublicationIdentity,
  type ImmutableFileWriter,
  type PublishedImmutableFile,
  type WorkPackageLock,
  type WorkPackageLockOwner
} from "./secure-work-package-directory.ts";
import {
  validateLockedWorkPackageDirectory,
  type ValidatedWorkPackage,
  type WorkPackageValidationOptions
} from "./work-package-validator.ts";
import {
  WorkPackageInputReader,
  type WorkPackageCaseDefinitionHasher
} from "./work-package-input-reader.ts";
import { recoverInterruptedWorkPackageExecutions } from "./work-package-execution-recovery.ts";
import {
  prepareWorkPackageEvaluationRetryResults,
  type WorkPackageEvalSemanticHashing
} from "./work-package-evaluation-retry-reader.ts";
import {
  prepareWorkPackageEvaluationResults,
  prepareWorkPackageEvaluationResultsForReport,
  type PreparedWorkPackageEvaluationResults
} from "./work-package-evaluation-result-reader.ts";
import {
  prepareWorkPackageRestResults,
  prepareWorkPackageRestRetryResults,
  type PreparedWorkPackageRestResults,
  type WorkPackageRestSemanticHashing
} from "./work-package-rest-retry-reader.ts";
import {
  prepareWorkPackageReportImport,
  type PreparedWorkPackageReportImport
} from "./work-package-report-import-reader.ts";
import {
  prepareWorkPackageAnalysisImport,
  type PreparedWorkPackageAnalysisImport
} from "./work-package-analysis-import-reader.ts";
import type { OfflineRestCaseResult } from "@cortex-eval/application/src/features/runs/offline-rest-execution-service.ts";

type WorkPackageStage = "REST" | "EVALUATION" | "REPORT" | "ANALYSIS";
export type WorkPackageArtifactKind =
  | "REST_RESULTS"
  | "RAW_PROMPTFOO_EVIDENCE"
  | "NORMALIZED_EVAL_RESULTS"
  | "REPORT_JSON"
  | "REPORT_MARKDOWN"
  | "ANALYSIS_RESULTS";

/** Exact pure hash input that binds one offline Execution version. */
export interface WorkPackageExecutionContextHashInput {
  /** Hash contract version. */
  readonly contractVersion: "cortex.execution-context.v1";
  /** Immutable Work Package identity. */
  readonly packageId: string;
  /** Hash of the exact immutable Manifest bytes. */
  readonly manifestHash: string;
  /** Frozen REST and Evaluation limits. */
  readonly runExecutionLimits: RunExecutionLimitsV1;
  /** Frozen Analysis limit. */
  readonly analysisExecutionLimits: AnalysisExecutionLimitsV1;
}

/** Pure hash Port implemented by the Domain composition root. */
export interface WorkPackageExecutionContextHasher {
  /** Hash one fully cleaned Execution context. */
  readonly hash: (input: WorkPackageExecutionContextHashInput) => string;
}

/** Source identity mode for a new immutable Execution version. */
export type WorkPackageExecutionRerun =
  | { readonly mode: "NEW" }
  | { readonly mode: "RETRY_FAILED"; readonly sourceExecutionId: string }
  | { readonly mode: "FORCE"; readonly sourceExecutionId: string };

/** Inputs frozen before the first offline stage starts. */
export interface WorkPackageRunLimitOverrides {
  /** Optional REST maximum in-flight override. */
  readonly restConcurrency?: number | undefined;
  /** Optional Evaluation maximum in-flight override. */
  readonly evalConcurrency?: number | undefined;
}

/** Optional Analysis limit merged with the Manifest default. */
export interface WorkPackageAnalysisLimitOverrides {
  /** Optional Analysis maximum in-flight override. */
  readonly analysisConcurrency?: number | undefined;
}

/** Inputs frozen before the first offline stage starts. */
export interface CreateWorkPackageExecutionInput {
  /** New UUIDv7 Execution identity. */
  readonly executionId: string;
  /** Creation time in UTC. */
  readonly createdAt: string;
  /** New, retry-failed or force provenance. */
  readonly rerun: WorkPackageExecutionRerun;
  /** Optional explicit REST and Evaluation limits. */
  readonly runExecutionLimits?: WorkPackageRunLimitOverrides | RunExecutionLimitsV1 | undefined;
  /** Optional explicit Analysis limit. */
  readonly analysisExecutionLimits?:
    WorkPackageAnalysisLimitOverrides | AnalysisExecutionLimitsV1 | undefined;
}

/** One durably published Artifact registered by a stage state transition. */
export interface CommittedStageArtifact extends ImmutableFileExpectation {
  /** Frozen Artifact slot kind. */
  readonly kind: WorkPackageArtifactKind;
  /** Frozen Artifact contract version. */
  readonly contractVersion: string;
}

/** Newly published stage Artifact carrying a non-persisted compensation identity. */
export interface PublishedStageArtifact extends CommittedStageArtifact {
  /** Exact publication identity used only before durable stage registration. */
  readonly publicationIdentity: ImmutableFilePublicationIdentity;
}

// Strip process-local compensation identity before strict contract persistence.
function committedArtifact(published: PublishedStageArtifact): CommittedStageArtifact {
  return {
    path: published.path,
    sha256: published.sha256,
    sizeBytes: published.sizeBytes,
    kind: published.kind,
    contractVersion: published.contractVersion
  };
}

/** Attach one stage slot to an exact low-level publication handle. */
export function publishedStageArtifact(
  published: PublishedImmutableFile,
  kind: WorkPackageArtifactKind,
  contractVersion: string
): PublishedStageArtifact {
  return {
    ...published.integrity,
    kind,
    contractVersion,
    publicationIdentity: published.publicationIdentity
  };
}

/** Dependencies required to hold one complete package mutation session. */
export interface OpenWorkPackageExecutionSessionInput {
  /** Work Package root path. */
  readonly rootPath: string;
  /** Stable lock diagnostics. */
  readonly owner: WorkPackageLockOwner;
  /** Domain context hash boundary. */
  readonly contextHasher: WorkPackageExecutionContextHasher;
  /** Collision-resistant temporary name source. */
  readonly nonce?: (() => string) | undefined;
  /** Explicit operation-scoped Artifact integrity policy. */
  readonly validationOptions?: WorkPackageValidationOptions | undefined;
}

/** Safe package identity summary returned by validation commands. */
export interface WorkPackageValidationSummary {
  /** Immutable Package identity. */
  readonly packageId: string;
  /** Exact immutable Manifest file hash. */
  readonly manifestSha256: string;
  /** Number of validated Execution versions. */
  readonly executionCount: number;
}

const ARTIFACT_SLOTS: Readonly<
  Record<
    WorkPackageArtifactKind,
    {
      readonly stage: WorkPackageStage;
      readonly fileName: string;
      readonly contractVersion: string;
    }
  >
> = {
  REST_RESULTS: {
    stage: "REST",
    fileName: "rest-results.json",
    contractVersion: "cortex.rest-results.v1"
  },
  RAW_PROMPTFOO_EVIDENCE: {
    stage: "EVALUATION",
    fileName: "promptfoo-raw.json",
    contractVersion: "promptfoo.0.121.18"
  },
  NORMALIZED_EVAL_RESULTS: {
    stage: "EVALUATION",
    fileName: "normalized-eval.json",
    contractVersion: "cortex.normalized-eval.v1"
  },
  REPORT_JSON: {
    stage: "REPORT",
    fileName: "report.json",
    contractVersion: "cortex.report.v1"
  },
  REPORT_MARKDOWN: {
    stage: "REPORT",
    fileName: "report.md",
    contractVersion: "cortex.report-markdown.v1"
  },
  ANALYSIS_RESULTS: {
    stage: "ANALYSIS",
    fileName: "analysis-results.json",
    contractVersion: "cortex.analysis-results.v1"
  }
};

const STAGE_DEPENDENCIES: Readonly<Record<WorkPackageStage, readonly WorkPackageStage[]>> = {
  REST: [],
  EVALUATION: ["REST"],
  REPORT: ["REST", "EVALUATION"],
  ANALYSIS: ["REPORT"]
};

const PENDING_STAGE = {
  status: "PENDING" as const,
  startedAt: null,
  completedAt: null,
  errorCode: null,
  artifacts: []
};

// Serialize one validated mutable state within the fixed Execution byte limit.
function executionBytes(execution: ExecutionV1): Buffer {
  const parsed = ExecutionV1Schema.parse(execution);
  const bytes = Buffer.from(`${JSON.stringify(parsed)}\n`, "utf8");
  if (bytes.byteLength > WORK_PACKAGE_RUNTIME_LIMITS.executionBytes) {
    throw new Error("WORK_PACKAGE_INVALID");
  }
  return bytes;
}

// Return the outer completion time only after every stage has reached a terminal state.
function executionCompletedAt(stages: ExecutionV1["stages"], completedAt: string): string | null {
  const incomplete = Object.values(stages).some(
    (stage) => stage.status === "PENDING" || stage.status === "RUNNING"
  );
  return incomplete ? null : completedAt;
}

/** Locked state boundary for one Work Package and all of its Execution versions. */
export class WorkPackageExecutionSession {
  /** Stable package directory descriptor. */
  readonly #directory: SecureWorkPackageDirectory;
  /** Held exclusive package lock. */
  readonly #lock: WorkPackageLock;
  /** Validated immutable package facts. */
  readonly #validated: ValidatedWorkPackage;
  /** Pure Execution context hasher. */
  readonly #contextHasher: WorkPackageExecutionContextHasher;
  /** Temporary name source. */
  readonly #nonce: () => string;
  /** Current validated Execution states. */
  readonly #executions = new Map<string, ExecutionV1>();
  /** Narrow immutable input reader. */
  readonly #inputs: WorkPackageInputReader;
  #closed = false;

  /** Construct only after locking and validating the complete package. */
  public constructor(input: {
    readonly directory: SecureWorkPackageDirectory;
    readonly lock: WorkPackageLock;
    readonly validated: ValidatedWorkPackage;
    readonly contextHasher: WorkPackageExecutionContextHasher;
    readonly nonce: () => string;
  }) {
    this.#directory = input.directory;
    this.#lock = input.lock;
    this.#validated = input.validated;
    this.#contextHasher = input.contextHasher;
    this.#nonce = input.nonce;
    this.#inputs = new WorkPackageInputReader(input.directory, input.validated.manifest);
    for (const item of input.validated.executions) {
      this.#validateExecutionContext(item.execution);
      this.#executions.set(item.executionId, item.execution);
    }
  }

  /** Return only non-sensitive package identity and validated Execution count. */
  public get packageSummary(): WorkPackageValidationSummary {
    this.#requireOpen();
    return {
      packageId: this.#validated.manifest.packageId,
      manifestSha256: this.#validated.manifestSha256,
      executionCount: this.#executions.size
    };
  }

  /** Return the narrow immutable input reader owned by this locked session. */
  public get inputs(): WorkPackageInputReader {
    this.#requireOpen();
    return this.#inputs;
  }

  /** Return one cleaned Execution state without reading a caller-controlled path. */
  public readExecution(executionId: string): ExecutionV1 | null {
    this.#requireOpen();
    return this.#executions.get(executionId) ?? null;
  }

  /** Preflight a source REST Artifact and return only reusable success facts. */
  public prepareRestRetryResults(
    sourceExecutionId: string,
    hashing: WorkPackageRestSemanticHashing,
    signal: AbortSignal
  ): Promise<AsyncIterable<OfflineRestCaseResult>> {
    this.#requireOpen();
    return prepareWorkPackageRestRetryResults({
      directory: this.#directory,
      manifest: this.#validated.manifest,
      sourceExecution: this.#requireExecution(sourceExecutionId),
      hashing,
      signal
    });
  }

  /** Preflight one Execution's complete REST version for its Evaluation stage. */
  public prepareRestResults(
    executionId: string,
    hashing: WorkPackageRestSemanticHashing,
    signal: AbortSignal
  ): Promise<PreparedWorkPackageRestResults> {
    this.#requireOpen();
    return prepareWorkPackageRestResults({
      directory: this.#directory,
      manifest: this.#validated.manifest,
      sourceExecution: this.#requireExecution(executionId),
      hashing,
      signal
    });
  }

  /** Select source Evaluation facts that remain REST-aligned and Raw-backed. */
  public prepareEvaluationRetryResults(
    targetExecutionId: string,
    restHashing: WorkPackageRestSemanticHashing,
    evalHashing: WorkPackageEvalSemanticHashing,
    signal: AbortSignal
  ): Promise<AsyncIterable<EvalCaseV1>> {
    this.#requireOpen();
    return prepareWorkPackageEvaluationRetryResults({
      directory: this.#directory,
      manifest: this.#validated.manifest,
      targetExecution: this.#requireExecution(targetExecutionId),
      readExecution: (executionId): ExecutionV1 | null => this.#executions.get(executionId) ?? null,
      restHashing,
      evalHashing,
      signal
    });
  }

  /** Preflight and stream one complete ordinary Evaluation version for platform import. */
  public prepareEvaluationResults(
    executionId: string,
    restHashing: WorkPackageRestSemanticHashing,
    evalHashing: WorkPackageEvalSemanticHashing,
    signal: AbortSignal
  ): Promise<PreparedWorkPackageEvaluationResults> {
    this.#requireOpen();
    return prepareWorkPackageEvaluationResults({
      directory: this.#directory,
      manifest: this.#validated.manifest,
      sourceExecution: this.#requireExecution(executionId),
      readExecution: (sourceExecutionId): ExecutionV1 | null =>
        this.#executions.get(sourceExecutionId) ?? null,
      restHashing,
      evalHashing,
      signal
    });
  }

  /** Stream complete normalized Evaluation facts for Reporting without requiring Raw bytes. */
  public prepareEvaluationResultsForReport(
    executionId: string,
    restHashing: WorkPackageRestSemanticHashing,
    evalHashing: WorkPackageEvalSemanticHashing,
    signal: AbortSignal
  ): Promise<PreparedWorkPackageEvaluationResults> {
    this.#requireOpen();
    return prepareWorkPackageEvaluationResultsForReport({
      directory: this.#directory,
      manifest: this.#validated.manifest,
      sourceExecution: this.#requireExecution(executionId),
      readExecution: (sourceExecutionId): ExecutionV1 | null =>
        this.#executions.get(sourceExecutionId) ?? null,
      restHashing,
      evalHashing,
      signal
    });
  }

  /** Preflight a completed Report and expose a second strict import pass. */
  public prepareReportImport(
    executionId: string,
    caseHasher: WorkPackageCaseDefinitionHasher,
    restHashing: WorkPackageRestSemanticHashing,
    evalHashing: WorkPackageEvalSemanticHashing,
    signal: AbortSignal
  ): Promise<PreparedWorkPackageReportImport> {
    this.#requireOpen();
    return prepareWorkPackageReportImport({
      directory: this.#directory,
      manifest: this.#validated.manifest,
      execution: this.#requireExecution(executionId),
      inputs: this.#inputs,
      caseHasher,
      restHashing,
      evalHashing,
      signal
    });
  }

  /** Preflight a completed Analysis and expose a second strict import pass. */
  public prepareAnalysisImport(
    executionId: string,
    caseHasher: WorkPackageCaseDefinitionHasher,
    restHashing: WorkPackageRestSemanticHashing,
    evalHashing: WorkPackageEvalSemanticHashing,
    signal: AbortSignal
  ): Promise<PreparedWorkPackageAnalysisImport> {
    this.#requireOpen();
    return prepareWorkPackageAnalysisImport({
      directory: this.#directory,
      manifest: this.#validated.manifest,
      execution: this.#requireExecution(executionId),
      inputs: this.#inputs,
      caseHasher,
      restHashing,
      evalHashing,
      signal
    });
  }

  /** Create one new Execution identity before any stage starts. */
  public async createExecution(input: CreateWorkPackageExecutionInput): Promise<ExecutionV1> {
    this.#requireOpen();
    const executionId = UuidV7Schema.parse(input.executionId);
    const createdAt = UtcDateTimeSchema.parse(input.createdAt);
    if (this.#executions.has(executionId)) throw new Error("EXECUTION_RESULT_CONFLICT");
    if (input.rerun.mode !== "NEW") {
      UuidV7Schema.parse(input.rerun.sourceExecutionId);
      if (!this.#executions.has(input.rerun.sourceExecutionId)) {
        throw new Error("WORK_PACKAGE_INVALID");
      }
    }
    const runExecutionLimits = RunExecutionLimitsV1Schema.parse({
      ...this.#validated.manifest.executionLimitPolicy.run.defaults,
      ...input.runExecutionLimits
    });
    const analysisExecutionLimits = AnalysisExecutionLimitsV1Schema.parse({
      ...this.#validated.manifest.executionLimitPolicy.analysis.defaults,
      ...input.analysisExecutionLimits
    });
    const executionContextHash = this.#contextHasher.hash({
      contractVersion: "cortex.execution-context.v1",
      packageId: this.#validated.manifest.packageId,
      manifestHash: this.#validated.manifestSha256,
      runExecutionLimits,
      analysisExecutionLimits
    });
    const execution = ExecutionV1Schema.parse({
      contractVersion: "cortex.execution.v1",
      packageId: this.#validated.manifest.packageId,
      executionId,
      createdAt,
      startedAt: null,
      completedAt: null,
      rerun: input.rerun,
      runExecutionLimits,
      analysisExecutionLimits,
      executionContextHash,
      stages: {
        REST: { ...PENDING_STAGE },
        EVALUATION: { ...PENDING_STAGE },
        REPORT: { ...PENDING_STAGE },
        ANALYSIS: { ...PENDING_STAGE }
      }
    });
    await this.#directory.writeImmutableFile(
      `executions/${executionId}/execution.json`,
      executionBytes(execution),
      this.#nonce()
    );
    this.#executions.set(executionId, execution);
    return execution;
  }

  /** Move one pending stage to running only after all fixed dependencies succeeded. */
  public async startStage(
    executionId: string,
    stageName: WorkPackageStage,
    startedAt: string
  ): Promise<ExecutionV1> {
    this.#requireOpen();
    const execution = this.#requireExecution(executionId);
    const stage = execution.stages[stageName];
    if (stage.status === "SUCCEEDED") throw new Error("ARTIFACT_ALREADY_COMMITTED");
    if (stage.status !== "PENDING") throw new Error("RUN_STATE_CONFLICT");
    if (
      STAGE_DEPENDENCIES[stageName].some(
        (dependency) => execution.stages[dependency].status !== "SUCCEEDED"
      )
    ) {
      throw new Error("RUN_STATE_CONFLICT");
    }
    const timestamp = UtcDateTimeSchema.parse(startedAt);
    const next = ExecutionV1Schema.parse({
      ...execution,
      startedAt: execution.startedAt ?? timestamp,
      stages: {
        ...execution.stages,
        [stageName]: {
          status: "RUNNING",
          startedAt: timestamp,
          completedAt: null,
          errorCode: null,
          artifacts: []
        }
      }
    });
    return await this.#replaceExecution(next);
  }

  /** Create one immutable writer for the fixed Artifact slot of a running stage. */
  public createStageArtifactWriter(
    executionId: string,
    kind: WorkPackageArtifactKind,
    maximumBytes: number
  ): Promise<ImmutableFileWriter> {
    this.#requireOpen();
    const execution = this.#requireExecution(executionId);
    const slot = ARTIFACT_SLOTS[kind];
    if (execution.stages[slot.stage].status !== "RUNNING") {
      throw new Error("RUN_STATE_CONFLICT");
    }
    return this.#directory.createComputedFileWriter(
      `executions/${executionId}/${slot.fileName}`,
      maximumBytes,
      this.#nonce()
    );
  }

  /** Register the complete fixed Artifact set and make one running stage immutable. */
  public async completeStage(
    executionId: string,
    stageName: WorkPackageStage,
    completedAt: string,
    artifacts: readonly PublishedStageArtifact[]
  ): Promise<ExecutionV1> {
    this.#requireOpen();
    const execution = this.#requireExecution(executionId);
    const stage = execution.stages[stageName];
    if (stage.status !== "RUNNING" || stage.startedAt === null) {
      throw new Error("RUN_STATE_CONFLICT");
    }
    const durableArtifacts = artifacts.map(committedArtifact);
    for (const artifact of durableArtifacts) {
      const slot = ARTIFACT_SLOTS[artifact.kind];
      if (slot.stage !== stageName || slot.contractVersion !== artifact.contractVersion) {
        throw new Error("WORK_PACKAGE_INVALID");
      }
    }
    const timestamp = UtcDateTimeSchema.parse(completedAt);
    const stages = {
      ...execution.stages,
      [stageName]: {
        status: "SUCCEEDED" as const,
        startedAt: stage.startedAt,
        completedAt: timestamp,
        errorCode: null,
        artifacts: durableArtifacts
      }
    };
    const next = ExecutionV1Schema.parse({
      ...execution,
      completedAt: executionCompletedAt(stages, timestamp),
      stages
    });
    return await this.#replaceExecution(next);
  }

  /** Remove one fixed-slot Artifact that was published but never registered by its stage. */
  public async discardUnregisteredStageArtifact(
    executionId: string,
    stageName: WorkPackageStage,
    artifact: PublishedStageArtifact
  ): Promise<void> {
    this.#requireOpen();
    const execution = this.#requireExecution(executionId);
    const slot = ARTIFACT_SLOTS[artifact.kind];
    const expectedPath = `executions/${executionId}/${slot.fileName}`;
    if (
      slot.stage !== stageName ||
      slot.contractVersion !== artifact.contractVersion ||
      artifact.path !== expectedPath
    ) {
      throw new Error("WORK_PACKAGE_INVALID");
    }
    const registered = execution.stages[stageName].artifacts.some(
      (current) => current.path === artifact.path
    );
    if (registered) throw new Error("ARTIFACT_ALREADY_COMMITTED");
    const removed = await this.#directory.removeFileIfMatches({
      integrity: artifact,
      publicationIdentity: artifact.publicationIdentity
    });
    if (!removed) throw new Error("TEMP_CLEANUP_FAILED");
  }

  /** Record one running stage system error without publishing unregistered output. */
  public async failStage(
    executionId: string,
    stageName: WorkPackageStage,
    completedAt: string,
    errorCode: ErrorCode
  ): Promise<ExecutionV1> {
    this.#requireOpen();
    const execution = this.#requireExecution(executionId);
    const stage = execution.stages[stageName];
    if (stage.status !== "RUNNING" || stage.startedAt === null) {
      throw new Error("RUN_STATE_CONFLICT");
    }
    const timestamp = UtcDateTimeSchema.parse(completedAt);
    const stages = {
      ...execution.stages,
      [stageName]: {
        status: "ERROR" as const,
        startedAt: stage.startedAt,
        completedAt: timestamp,
        errorCode,
        artifacts: []
      }
    };
    const next = ExecutionV1Schema.parse({
      ...execution,
      completedAt: executionCompletedAt(stages, timestamp),
      stages
    });
    return await this.#replaceExecution(next);
  }

  /** Release the stable lock before closing the retained directory descriptor. */
  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#lock.release();
    } finally {
      this.#directory.close();
    }
  }

  // Persist one complete mutable state replacement and update the in-session projection.
  async #replaceExecution(execution: ExecutionV1): Promise<ExecutionV1> {
    await this.#directory.replaceMutableFile(
      `executions/${execution.executionId}/execution.json`,
      executionBytes(execution),
      this.#nonce()
    );
    this.#executions.set(execution.executionId, execution);
    return execution;
  }

  // Require one validated Execution without leaking map mutation to callers.
  #requireExecution(executionId: string): ExecutionV1 {
    const parsedId = UuidV7Schema.parse(executionId);
    const execution = this.#executions.get(parsedId);
    if (execution === undefined) throw new Error("WORK_PACKAGE_INVALID");
    return execution;
  }

  // Recompute every loaded Execution hash before any mutation is allowed.
  #validateExecutionContext(execution: ExecutionV1): void {
    const expected = this.#contextHasher.hash({
      contractVersion: "cortex.execution-context.v1",
      packageId: execution.packageId,
      manifestHash: this.#validated.manifestSha256,
      runExecutionLimits: execution.runExecutionLimits,
      analysisExecutionLimits: execution.analysisExecutionLimits
    });
    if (execution.executionContextHash !== expected) {
      throw new Error("WORK_PACKAGE_HASH_MISMATCH");
    }
  }

  #requireOpen(): void {
    if (this.#closed) throw new Error("WORK_PACKAGE_DIRECTORY_CLOSED");
  }
}

/** Open, exclusively lock and fully validate one Work Package mutation session. */
export async function openWorkPackageExecutionSession(
  input: OpenWorkPackageExecutionSessionInput
): Promise<WorkPackageExecutionSession> {
  const directory = await SecureWorkPackageDirectory.open(input.rootPath);
  let lock: WorkPackageLock | undefined;
  const nonce = input.nonce ?? randomUUID;
  try {
    lock = await directory.acquireLock(input.owner);
    await recoverInterruptedWorkPackageExecutions(directory, input.owner.acquiredAt, nonce);
    const validated = await validateLockedWorkPackageDirectory(directory, input.validationOptions);
    return new WorkPackageExecutionSession({
      directory,
      lock,
      validated,
      contextHasher: input.contextHasher,
      nonce
    });
  } catch (error) {
    await lock?.release();
    directory.close();
    throw error;
  }
}
