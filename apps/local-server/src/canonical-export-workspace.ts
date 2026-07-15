import {
  CANONICAL_ENTITY_FILE_ORDER,
  type CanonicalEntityFileSink,
  type CanonicalEntityType,
  type CanonicalWrittenFileFacts
} from "@cortex-eval/application/src/features/canonical-export/canonical-export-projection-service.ts";
import {
  CanonicalExportManifestV1Schema,
  type CanonicalExportManifestV1,
  type CanonicalExportReconciliationV1
} from "@cortex-eval/contracts/src/canonical-export-contracts.ts";
import { WorkPackageRuntimePathSchema } from "@cortex-eval/contracts/src/work-package-runtime-contracts.ts";
import {
  canonicalJson,
  type DomainJsonValue
} from "@cortex-eval/domain/src/domain-canonical-hash.ts";
import {
  type CaseImportWorkspaceManager,
  type OwnedCaseImportWorkspace
} from "@cortex-eval/storage-sqlite/src/case-import-workspace.ts";
import { reconcileCanonicalExportDirectory } from "@cortex-eval/canonical-export/src/canonical-export-validator.ts";
import { SecureWorkPackageDirectory } from "@cortex-eval/work-package/src/secure-work-package-directory.ts";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, rm, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";

// Validate one Node stream chunk before using it as file bytes.
function byteChunk(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new Error("CANONICAL_EXPORT_STREAM_INVALID");
}

// Write every byte to one already-open immutable file.
async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset);
    if (result.bytesWritten < 1) throw new Error("CANONICAL_EXPORT_WRITE_FAILED");
    offset += result.bytesWritten;
  }
}

/** Owner-only file workspace for one fully reconciled Canonical Export. */
export class CanonicalExportWorkspace implements CanonicalEntityFileSink {
  /** Canonical active workspace path. */
  public readonly path: string;
  readonly #manager: CaseImportWorkspaceManager;
  readonly #workspace: OwnedCaseImportWorkspace;
  #closed = false;

  /** Bind a newly created owned workspace. */
  private constructor(manager: CaseImportWorkspaceManager, workspace: OwnedCaseImportWorkspace) {
    this.path = workspace.path;
    this.#manager = manager;
    this.#workspace = workspace;
  }

  /** Create one workspace and its fixed 0700 entity directory. */
  public static async create(
    manager: CaseImportWorkspaceManager
  ): Promise<CanonicalExportWorkspace> {
    const workspace = await manager.create();
    try {
      const entities = join(workspace.path, "entities");
      await mkdir(entities, { mode: 0o700 });
      await chmod(entities, 0o700);
      return new CanonicalExportWorkspace(manager, workspace);
    } catch (error) {
      await manager.cleanupOwned(workspace).catch(() => undefined);
      throw error;
    }
  }

  /** Consume one complete entity stream into its fixed immutable JSONL file. */
  public async write(
    entityType: CanonicalEntityType,
    lines: AsyncIterable<string>
  ): Promise<CanonicalWrittenFileFacts> {
    const descriptor = CANONICAL_ENTITY_FILE_ORDER.find(
      (candidate) => candidate.entityType === entityType
    );
    if (descriptor === undefined) throw new Error("CANONICAL_ENTITY_TYPE_INVALID");
    return await this.#writeImmutable(descriptor.path, lines);
  }

  /** Write one canonical JSON control file and return exact bytes. */
  public async writeJson(
    relativePath: "manifest.json" | "reconciliation.json",
    value: DomainJsonValue
  ): Promise<CanonicalWrittenFileFacts> {
    return await this.#writeImmutable(relativePath, [canonicalJson(value)]);
  }

  /** Copy one internally selected Artifact into a new immutable export path. */
  public async writeBinary(
    relativePath: string,
    parts: AsyncIterable<Uint8Array>
  ): Promise<CanonicalWrittenFileFacts> {
    WorkPackageRuntimePathSchema.parse(relativePath);
    if (!relativePath.startsWith("artifacts/")) throw new Error("CANONICAL_ARTIFACT_PATH_INVALID");
    const parent = join(this.path, dirname(relativePath));
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await chmod(parent, 0o700);
    return await this.#writeImmutable(relativePath, parts);
  }

  /** Remove only one unpublished file created inside this owned workspace. */
  public async remove(relativePath: string): Promise<void> {
    WorkPackageRuntimePathSchema.parse(relativePath);
    if (!relativePath.startsWith("artifacts/")) throw new Error("CANONICAL_ARTIFACT_PATH_INVALID");
    await rm(join(this.path, relativePath), { force: true });
  }

  /** Reopen every entity and included Artifact file for mandatory four-way reconciliation. */
  public async reconcile(
    dirtyManifest: CanonicalExportManifestV1
  ): Promise<CanonicalExportReconciliationV1> {
    const manifest = CanonicalExportManifestV1Schema.parse(dirtyManifest);
    const directory = await SecureWorkPackageDirectory.open(this.path);
    try {
      return await reconcileCanonicalExportDirectory(directory, manifest);
    } finally {
      directory.close();
    }
  }

  /** Remove the complete unpublished workspace exactly once. */
  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#manager.cleanupOwned(this.#workspace);
  }

  // Create and durably finish one new 0600 file without replacement.
  async #writeImmutable(
    relativePath: string,
    parts: AsyncIterable<string | Uint8Array> | Iterable<string | Uint8Array>
  ): Promise<CanonicalWrittenFileFacts> {
    if (this.#closed) throw new Error("CANONICAL_EXPORT_WORKSPACE_CLOSED");
    const absolutePath = join(this.path, relativePath);
    const before = await lstat(absolutePath).catch(() => null);
    if (before !== null) throw new Error("CANONICAL_EXPORT_FILE_EXISTS");
    const handle = await open(absolutePath, "wx", 0o600);
    const hash = createHash("sha256");
    let sizeBytes = 0;
    try {
      for await (const part of parts) {
        const bytes = typeof part === "string" ? Buffer.from(part, "utf8") : byteChunk(part);
        await writeAll(handle, bytes);
        hash.update(bytes);
        sizeBytes += bytes.byteLength;
      }
      await handle.sync();
      await handle.chmod(0o600);
      await handle.close();
      return { sha256: hash.digest("hex"), sizeBytes };
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(absolutePath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
