import { canonicalJson } from "@cortex-eval/domain/src/domain-canonical-hash.ts";

import type { Clock, IdGenerator, TransactionManager } from "../../application-ports.ts";
import type {
  ExistingImportedExecutionReport,
  ImportedExecutionReportCase,
  ImportedExecutionReportRecord
} from "./execution-import-models.ts";
import { importedExecutionArtifactManifestJson } from "./execution-import-models.ts";

/** Complete cleaned Report import command produced by the Work Package boundary. */
export interface ImportExecutionReportCommand extends Omit<
  ImportedExecutionReportRecord,
  "runId" | "importedAt"
> {
  /** Re-open the fully reconciled Case stream only for a first import. */
  readonly openCases: () => AsyncIterable<ImportedExecutionReportCase>;
}

/** Stable first-import, idempotent or identity-conflict outcome. */
export type ImportExecutionReportResult =
  | { readonly ok: true; readonly runId: string; readonly idempotent: boolean }
  | {
      readonly ok: false;
      readonly error: { readonly code: "EXECUTION_RESULT_CONFLICT"; readonly executionId: string };
    };

// Reject owner/path ambiguity before any transaction or file stream is consumed.
function hasValidArtifactIdentity(command: ImportExecutionReportCommand): boolean {
  if (command.artifactManifest.owner.id !== command.executionId) return false;
  const prefix = `executions/${command.executionId}/`;
  const kinds = new Set<string>();
  const paths = new Set<string>();
  for (const artifact of command.artifactManifest.artifacts) {
    if (kinds.has(artifact.kind) || paths.has(artifact.path) || !artifact.path.startsWith(prefix)) {
      return false;
    }
    kinds.add(artifact.kind);
    paths.add(artifact.path);
  }
  return true;
}

// Compare every immutable version and Artifact identity used by idempotence.
function isSameImport(
  existing: ExistingImportedExecutionReport,
  command: ImportExecutionReportCommand
): boolean {
  return (
    existing.packageId === command.packageId &&
    existing.restResultSetHash === command.restResultSetHash &&
    existing.evaluationContextHash === command.evaluationContextHash &&
    existing.evaluationResultSetHash === command.evaluationResultSetHash &&
    existing.reportResultSetHash === command.reportResultSetHash &&
    canonicalJson(importedExecutionArtifactManifestJson(existing.artifactManifest)) ===
      canonicalJson(importedExecutionArtifactManifestJson(command.artifactManifest))
  );
}

/** Atomic complete Report import use case over already-cleaned replayable sources. */
export class ImportExecutionReport {
  readonly #transactionManager: TransactionManager;
  readonly #idGenerator: IdGenerator;
  readonly #clock: Clock;

  /** Bind explicit transaction, identity and time dependencies. */
  public constructor(dependencies: {
    readonly transactionManager: TransactionManager;
    readonly idGenerator: IdGenerator;
    readonly clock: Clock;
  }) {
    this.#transactionManager = dependencies.transactionManager;
    this.#idGenerator = dependencies.idGenerator;
    this.#clock = dependencies.clock;
  }

  /** Import one complete offline Report version without trusting external summaries. */
  public execute(command: ImportExecutionReportCommand): Promise<ImportExecutionReportResult> {
    if (!hasValidArtifactIdentity(command)) {
      return Promise.resolve({
        ok: false,
        error: { code: "EXECUTION_RESULT_CONFLICT", executionId: command.executionId }
      });
    }
    return this.#transactionManager.execute(async (transaction) => {
      const existing = await transaction.runs.getImportedExecutionReport(command.executionId);
      if (existing !== null) {
        return isSameImport(existing, command)
          ? { ok: true, runId: existing.runId, idempotent: true }
          : {
              ok: false,
              error: {
                code: "EXECUTION_RESULT_CONFLICT" as const,
                executionId: command.executionId
              }
            };
      }
      const { openCases, ...facts } = command;
      const value: ImportedExecutionReportRecord = {
        ...facts,
        runId: this.#idGenerator.nextId(),
        importedAt: this.#clock.now()
      };
      await transaction.runs.insertImportedExecutionReport(value, openCases());
      return { ok: true, runId: value.runId, idempotent: false };
    });
  }
}
