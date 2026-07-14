import {
  canonicalJson,
  type DomainJsonObject
} from "@cortex-eval/domain/src/domain-canonical-hash.ts";

import type { Clock, IdGenerator, TransactionManager } from "../../application-ports.ts";
import type {
  ImportedExecutionArtifactManifest,
  ImportedExecutionRecord
} from "./execution-import-models.ts";
import { importedExecutionArtifactManifestJson } from "./execution-import-models.ts";

/** Minimal P2 Execution import registration command. */
export interface ImportExecutionIdentityCommand {
  /** Immutable Work Package identity. */
  readonly packageId: string;
  /** Immutable offline Execution identity. */
  readonly executionId: string;
  /** Recomputed result set hash. */
  readonly resultSetHash: string;
  /** Whether normalized results contain errors. */
  readonly hasErrors: boolean;
  /** Frozen Suite snapshot. */
  readonly suiteSnapshot: DomainJsonObject;
  /** Frozen Endpoint snapshot. */
  readonly endpointSnapshot: DomainJsonObject;
  /** Frozen Evaluator snapshot. */
  readonly evaluatorSnapshot: DomainJsonObject;
  /** Frozen Rubric Prompt snapshots. */
  readonly rubricPromptsSnapshot: readonly DomainJsonObject[];
  /** Frozen Run context hash. */
  readonly runContextHash: string;
  /** Frozen contract versions. */
  readonly contractVersions: DomainJsonObject;
  /** Frozen Run execution limits. */
  readonly runExecutionLimits: DomainJsonObject;
  /** Versioned expected Artifact facts. */
  readonly artifactManifest: ImportedExecutionArtifactManifest;
}

/** Exact minimal Execution identity registration result. */
export type ImportExecutionIdentityResult =
  | { readonly ok: true; readonly runId: string; readonly idempotent: boolean }
  | {
      readonly ok: false;
      readonly error: { readonly code: "EXECUTION_RESULT_CONFLICT"; readonly executionId: string };
    };

/** Minimal Execution ID idempotence use case; complete import remains P7. */
export class ImportExecutionIdentity {
  readonly #transactionManager: TransactionManager;
  readonly #idGenerator: IdGenerator;
  readonly #clock: Clock;

  /** Create the use case with explicit identity, time and transaction boundaries. */
  public constructor(dependencies: {
    readonly transactionManager: TransactionManager;
    readonly idGenerator: IdGenerator;
    readonly clock: Clock;
  }) {
    this.#transactionManager = dependencies.transactionManager;
    this.#idGenerator = dependencies.idGenerator;
    this.#clock = dependencies.clock;
  }

  /** Register or idempotently resolve one validated Execution identity. */
  public execute(command: ImportExecutionIdentityCommand): Promise<ImportExecutionIdentityResult> {
    const artifactKinds = new Set<string>();
    const artifactPaths = new Set<string>();
    const artifactPrefix = `executions/${command.executionId}/`;
    const artifactIdentityInvalid = command.artifactManifest.artifacts.some((artifact) => {
      const duplicate = artifactKinds.has(artifact.kind) || artifactPaths.has(artifact.path);
      artifactKinds.add(artifact.kind);
      artifactPaths.add(artifact.path);
      return duplicate || !artifact.path.startsWith(artifactPrefix);
    });
    if (command.artifactManifest.owner.id !== command.executionId || artifactIdentityInvalid) {
      return Promise.resolve({
        ok: false,
        error: { code: "EXECUTION_RESULT_CONFLICT", executionId: command.executionId }
      });
    }
    const value: ImportedExecutionRecord = {
      ...command,
      runId: this.#idGenerator.nextId(),
      createdAt: this.#clock.now()
    };
    return this.#transactionManager.execute(async (transaction) => {
      const existing = await transaction.runs.getImportedExecution(command.executionId);
      if (existing !== null) {
        return existing.packageId === command.packageId &&
          existing.resultSetHash === command.resultSetHash &&
          canonicalJson(importedExecutionArtifactManifestJson(existing.artifactManifest)) ===
            canonicalJson(importedExecutionArtifactManifestJson(command.artifactManifest))
          ? { ok: true, runId: existing.runId, idempotent: true }
          : {
              ok: false,
              error: { code: "EXECUTION_RESULT_CONFLICT", executionId: command.executionId }
            };
      }
      await transaction.runs.insertImportedExecution(value);
      return { ok: true, runId: value.runId, idempotent: false };
    });
  }
}
