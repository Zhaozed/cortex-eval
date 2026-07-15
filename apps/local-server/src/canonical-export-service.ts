import {
  CanonicalExportProjectionService,
  type CanonicalArtifactSnapshotReader,
  type CanonicalSnapshotReader
} from "@cortex-eval/application/src/features/canonical-export/canonical-export-projection-service.ts";
import {
  CanonicalExportManifestV1Schema,
  CanonicalExportReconciliationV1Schema,
  type CanonicalExportRequestV1
} from "@cortex-eval/contracts/src/canonical-export-contracts.ts";
import type { DomainJsonObject } from "@cortex-eval/domain/src/domain-canonical-hash.ts";
import type { CaseImportWorkspaceManager } from "@cortex-eval/storage-sqlite/src/case-import-workspace.ts";
import { SecureWorkPackageDirectory } from "@cortex-eval/work-package/src/secure-work-package-directory.ts";
import { Readable } from "node:stream";

import { collectCanonicalArtifacts } from "./canonical-export-artifacts.ts";
import { encodeCanonicalExport, type PreparedCanonicalExport } from "./canonical-export-encoder.ts";
import { CanonicalExportWorkspace } from "./canonical-export-workspace.ts";

const CONTRACT_VERSIONS: Readonly<Record<string, string>> = {
  analysisOutput: "cortex.analysis-output.v1",
  artifactManifest: "cortex.artifact-manifest.v1",
  canonicalEntityRecord: "cortex.canonical-entity-record.v1",
  canonicalExport: "cortex.canonical-export-manifest.v1",
  canonicalExportReconciliation: "cortex.canonical-export-reconciliation.v1",
  caseDefinition: "cortex.case-definition.v1",
  endpointConfig: "cortex.endpoint-config.v1",
  execution: "cortex.execution.v1",
  llmConfig: "cortex.llm-config.v1",
  normalizedEvaluation: "cortex.normalized-eval.v1",
  platformNormalizedEvaluation: "cortex.platform-normalized-eval.v1",
  prompt: "cortex.prompt.v1"
};

/** One immutable snapshot kept only through projection and Artifact descriptor collection. */
export interface CanonicalExportSnapshotSession
  extends CanonicalSnapshotReader, CanonicalArtifactSnapshotReader {
  /** Close the read-only database and remove its independent workspace. */
  readonly close: () => Promise<void>;
}

/** Short-lived snapshot factory isolated from HTTP transport lifetime. */
export interface CanonicalExportSnapshotFactory {
  /** Create one revision-consistent database backup. */
  readonly create: (signal?: AbortSignal) => Promise<CanonicalExportSnapshotSession>;
}

/** Canonical Export orchestration dependencies. */
export interface CanonicalExportServiceDependencies {
  /** Immutable database snapshot factory. */
  readonly snapshots: CanonicalExportSnapshotFactory;
  /** Owner-aware export workspace manager. */
  readonly workspaces: CaseImportWorkspaceManager;
  /** Verified project Artifact root. */
  readonly artifactRoot: string;
  /** New UUIDv7 Export identity. */
  readonly nextId: () => string;
  /** Current UTC time. */
  readonly now: () => string;
}

// Fail before opening a success response after any cancellation boundary.
function requireActive(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("REQUEST_ABORTED");
}

// Require every mandatory read-back class to pass before transport starts.
function requireReconciled(
  checks: ReturnType<typeof CanonicalExportReconciliationV1Schema.parse>["checks"]
): void {
  if (Object.values(checks).some((check) => check.status !== "PASS")) {
    throw new Error("CANONICAL_EXPORT_RECONCILIATION_FAILED");
  }
}

// Convert a typed control document into the pure JSON writer boundary.
function controlJson(value: object): DomainJsonObject {
  return value as DomainJsonObject;
}

/** Prepare a fully read-back-reconciled export before exposing a streaming response. */
export class CanonicalExportService {
  readonly #dependencies: CanonicalExportServiceDependencies;
  readonly #projection = new CanonicalExportProjectionService();

  /** Bind snapshot, Artifact and owner-cleaned response boundaries. */
  public constructor(dependencies: CanonicalExportServiceDependencies) {
    this.#dependencies = dependencies;
  }

  /** Build all immutable files, reconcile them from disk, then return an owned NDJSON stream. */
  public async prepare(request: CanonicalExportRequestV1, signal: AbortSignal): Promise<Readable> {
    requireActive(signal);
    const workspace = await CanonicalExportWorkspace.create(this.#dependencies.workspaces);
    let snapshot: CanonicalExportSnapshotSession | undefined;
    let directory: SecureWorkPackageDirectory | undefined;
    let responseOwnsWorkspace = false;
    try {
      snapshot = await this.#dependencies.snapshots.create(signal);
      const projection = await this.#projection.project(snapshot, workspace);
      requireActive(signal);
      const expectedArtifacts = [];
      for await (const artifact of snapshot.streamArtifacts()) {
        requireActive(signal);
        expectedArtifacts.push(artifact);
      }
      await snapshot.close();
      snapshot = undefined;

      const artifacts = await collectCanonicalArtifacts(
        this.#dependencies.artifactRoot,
        workspace,
        expectedArtifacts,
        request.rawEvidenceIncluded
      );
      requireActive(signal);
      const manifest = CanonicalExportManifestV1Schema.parse({
        contractVersion: "cortex.canonical-export-manifest.v1",
        exportId: this.#dependencies.nextId(),
        createdAt: this.#dependencies.now(),
        rawEvidenceIncluded: request.rawEvidenceIncluded,
        contractVersions: CONTRACT_VERSIONS,
        entityFiles: projection.entityFiles,
        artifacts
      });
      const manifestFacts = await workspace.writeJson("manifest.json", controlJson(manifest));
      const reconciliation = CanonicalExportReconciliationV1Schema.parse(
        await workspace.reconcile(manifest)
      );
      requireReconciled(reconciliation.checks);
      const reconciliationFacts = await workspace.writeJson(
        "reconciliation.json",
        controlJson(reconciliation)
      );
      requireActive(signal);
      directory = await SecureWorkPackageDirectory.open(workspace.path);
      const prepared: PreparedCanonicalExport = {
        manifest,
        manifestFile: { path: "manifest.json", ...manifestFacts },
        reconciliationFile: { path: "reconciliation.json", ...reconciliationFacts }
      };
      const ownedDirectory = directory;
      directory = undefined;
      responseOwnsWorkspace = true;
      return Readable.from(this.#ownedEncoding(ownedDirectory, workspace, prepared, signal), {
        objectMode: false
      });
    } catch (error) {
      await snapshot?.close().catch(() => undefined);
      directory?.close();
      if (!responseOwnsWorkspace) await workspace.close().catch(() => undefined);
      throw error;
    }
  }

  // Keep the immutable workspace alive only while the consumer owns the response body.
  async *#ownedEncoding(
    directory: SecureWorkPackageDirectory,
    workspace: CanonicalExportWorkspace,
    prepared: PreparedCanonicalExport,
    signal: AbortSignal
  ): AsyncGenerator<Buffer> {
    try {
      yield* encodeCanonicalExport(directory, prepared, signal);
    } finally {
      directory.close();
      await workspace.close().catch(() => undefined);
    }
  }
}
