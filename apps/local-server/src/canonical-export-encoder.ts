import type {
  CanonicalExportEventV1,
  CanonicalExportManifestV1
} from "@cortex-eval/contracts/src/canonical-export-contracts.ts";
import type { SecureWorkPackageDirectory } from "@cortex-eval/work-package/src/secure-work-package-directory.ts";

interface CanonicalExportFileDescriptor {
  /** Export-relative immutable file path. */
  readonly path: string;
  /** SHA-256 over exact file bytes. */
  readonly sha256: string;
  /** Exact immutable file size. */
  readonly sizeBytes: number;
}

/** Fully reconciled files required by the transport encoder. */
export interface PreparedCanonicalExport {
  /** Parsed Manifest that defines entity and included Artifact files. */
  readonly manifest: CanonicalExportManifestV1;
  /** Exact Manifest control-file descriptor. */
  readonly manifestFile: CanonicalExportFileDescriptor & { readonly path: "manifest.json" };
  /** Exact Reconciliation control-file descriptor. */
  readonly reconciliationFile: CanonicalExportFileDescriptor & {
    readonly path: "reconciliation.json";
  };
}

// Stop between bounded chunks when the HTTP request has been cancelled.
function requireActive(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new Error("REQUEST_ABORTED");
}

// Stream one immutable file with a contiguous per-file sequence.
async function* fileEvents(
  directory: SecureWorkPackageDirectory,
  file: CanonicalExportFileDescriptor,
  includeStart: boolean,
  signal?: AbortSignal
): AsyncGenerator<CanonicalExportEventV1> {
  if (includeStart) yield { type: "FILE_START", file };
  let sequence = 0;
  for await (const chunk of directory.streamFile(file.path, file.sizeBytes)) {
    requireActive(signal);
    yield {
      type: "FILE_CHUNK",
      path: file.path,
      sequence,
      dataBase64: chunk.toString("base64")
    };
    sequence += 1;
  }
  requireActive(signal);
  yield { type: "FILE_END", path: file.path };
}

// Return the fixed entity order followed by the already identity-sorted included Artifacts.
function dataFiles(manifest: CanonicalExportManifestV1): readonly CanonicalExportFileDescriptor[] {
  const entities = manifest.entityFiles.map((file) => ({
    path: file.path,
    sha256: file.sha256,
    sizeBytes: file.sizeBytes
  }));
  const artifacts = manifest.artifacts.flatMap((artifact) =>
    artifact.exportPath === null ||
    artifact.actualSha256 === null ||
    artifact.actualSizeBytes === null
      ? []
      : [
          {
            path: artifact.exportPath,
            sha256: artifact.actualSha256,
            sizeBytes: artifact.actualSizeBytes
          }
        ]
  );
  return [...entities, ...artifacts];
}

/** Emit one independent Manifest-first Canonical Export event stream. */
export async function* streamCanonicalExportEvents(
  directory: SecureWorkPackageDirectory,
  prepared: PreparedCanonicalExport,
  signal?: AbortSignal
): AsyncGenerator<CanonicalExportEventV1> {
  requireActive(signal);
  yield {
    type: "EXPORT_START",
    exportId: prepared.manifest.exportId,
    manifest: prepared.manifestFile
  };
  yield* fileEvents(directory, prepared.manifestFile, false, signal);
  for (const file of dataFiles(prepared.manifest)) {
    yield* fileEvents(directory, file, true, signal);
  }
  yield* fileEvents(directory, prepared.reconciliationFile, true, signal);
  requireActive(signal);
  yield {
    type: "EXPORT_END",
    exportId: prepared.manifest.exportId,
    reconciliation: prepared.reconciliationFile
  };
}

/** Encode exact LF-delimited JSON transport events with backpressure. */
export async function* encodeCanonicalExport(
  directory: SecureWorkPackageDirectory,
  prepared: PreparedCanonicalExport,
  signal?: AbortSignal
): AsyncGenerator<Buffer> {
  for await (const event of streamCanonicalExportEvents(directory, prepared, signal)) {
    yield Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
  }
}
