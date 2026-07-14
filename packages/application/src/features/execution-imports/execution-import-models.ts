import type { DomainJsonObject } from "@cortex-eval/domain/src/domain-canonical-hash.ts";

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
