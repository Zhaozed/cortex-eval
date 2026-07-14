import type {
  RunArtifactDescriptor,
  RunArtifactManifest,
  StoredRestCaseResult
} from "./platform-run-models.ts";
import type { PlatformEvalCaseResult } from "../evaluation/platform-eval-models.ts";
import type { DomainJsonObject } from "@cortex-eval/domain/src/domain-canonical-hash.ts";

/** Complete immutable platform REST Artifact input. */
export interface PlatformRestArtifactInput {
  /** Owning Run identity. */
  readonly runId: string;
  /** Frozen Run context hash. */
  readonly runContextHash: string;
  /** Complete REST stage time. */
  readonly completedAt: string;
  /** Expected exact number of ordered REST Case results. */
  readonly expectedTotal: number;
  /** Single-use ordered REST Case result stream. */
  readonly cases: AsyncIterable<StoredRestCaseResult>;
}

/** Immutable Artifact write facts produced in one streaming pass. */
export interface PlatformRestArtifactWriteResult {
  /** Immutable file descriptor. */
  readonly descriptor: RunArtifactDescriptor;
  /** Complete semantic result-set hash. */
  readonly resultSetHash: string;
}

/** Immutable raw Promptfoo evidence input for one platform Evaluation. */
export interface PlatformRawPromptfooArtifactInput {
  /** Owning Run identity. */
  readonly runId: string;
  /** Frozen Run context hash. */
  readonly runContextHash: string;
  /** Frozen Evaluation generation, matrix and Evaluator context. */
  readonly evaluationContextHash: string;
  /** Exact fixed Promptfoo version. */
  readonly promptfooVersion: "0.121.18";
  /** Native process exit code, including Assertion Fail code 100. */
  readonly exitCode: 0 | 100;
  /** Whole Promptfoo process duration. */
  readonly durationMs: number;
  /** Validated JSON raw output. */
  readonly raw: DomainJsonObject;
}

/** Immutable normalized Evaluation Artifact input. */
export interface PlatformNormalizedEvalArtifactInput {
  /** Owning Run identity. */
  readonly runId: string;
  /** Frozen Run context hash. */
  readonly runContextHash: string;
  /** Frozen Evaluation generation, matrix and Evaluator context. */
  readonly evaluationContextHash: string;
  /** Complete Evaluation timestamp. */
  readonly completedAt: string;
  /** Expected exact number of ordered Eval results. */
  readonly expectedTotal: number;
  /** Complete semantic Eval result-set hash. */
  readonly resultSetHash: string;
  /** Single-use ordered normalized Eval result stream. */
  readonly cases: AsyncIterable<PlatformEvalCaseResult>;
}

/** Current immutable Artifact file availability. */
export interface RunArtifactAvailability {
  /** Expected Artifact descriptor. */
  readonly artifact: RunArtifactDescriptor;
  /** Current exact availability. */
  readonly status: "PRESENT" | "MISSING" | "CORRUPTED";
}

/** Application Port for Run-owned immutable Artifact files. */
export interface RunArtifactStore {
  /** Atomically write one new REST Artifact without replacing an existing file. */
  writeRestResults(input: PlatformRestArtifactInput): Promise<PlatformRestArtifactWriteResult>;
  /** Atomically write raw Promptfoo evidence without replacing an existing file. */
  writeRawPromptfooEvidence(
    input: PlatformRawPromptfooArtifactInput
  ): Promise<RunArtifactDescriptor>;
  /** Atomically write normalized Evaluation results without replacing an existing file. */
  writeNormalizedEvalResults(
    input: PlatformNormalizedEvalArtifactInput
  ): Promise<RunArtifactDescriptor>;
  /** Remove only one uncommitted owner artifact after a failed database CAS. */
  removeUncommitted(artifact: RunArtifactDescriptor): Promise<void>;
  /** Inspect expected immutable files without changing database facts. */
  inspect(manifest: RunArtifactManifest): Promise<readonly RunArtifactAvailability[]>;
  /** Remove only owner artifacts that are absent from all durable manifests. */
  cleanupOrphans(manifests: readonly RunArtifactManifest[]): Promise<void>;
}
