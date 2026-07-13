import type {
  RunArtifactDescriptor,
  RunArtifactManifest,
  StoredRestCaseResult
} from "./platform-run-models.ts";

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
  /** Remove only one uncommitted owner artifact after a failed database CAS. */
  removeUncommitted(artifact: RunArtifactDescriptor): Promise<void>;
  /** Inspect expected immutable files without changing database facts. */
  inspect(manifest: RunArtifactManifest): Promise<readonly RunArtifactAvailability[]>;
  /** Remove only owner artifacts that are absent from all durable manifests. */
  cleanupOrphans(manifests: readonly RunArtifactManifest[]): Promise<void>;
}
