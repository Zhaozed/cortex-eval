import type { DomainJsonObject } from "@cortex-eval/domain/src/domain-canonical-hash.ts";

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
  readonly artifactManifest: readonly DomainJsonObject[];
  /** Registration time. */
  readonly createdAt: string;
}

/** Existing Execution identity fact used for idempotence. */
export interface ExistingImportedExecution {
  /** Platform Run identity. */
  readonly runId: string;
  /** Stored result set hash. */
  readonly resultSetHash: string;
}
