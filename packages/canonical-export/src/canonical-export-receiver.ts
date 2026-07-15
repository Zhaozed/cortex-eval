import {
  CanonicalExportManifestV1Schema,
  CanonicalExportReconciliationV1Schema,
  type CanonicalExportEventV1,
  type CanonicalExportManifestV1,
  type CanonicalExportReconciliationV1
} from "@cortex-eval/contracts/src/canonical-export-contracts.ts";
import { canonicalJson } from "@cortex-eval/domain/src/domain-canonical-hash.ts";
import {
  WorkPackageDirectoryPublisher,
  type WorkPackageCleanupFailureSink
} from "@cortex-eval/work-package/src/work-package-directory-publisher.ts";
import type {
  ImmutableFileExpectation,
  ImmutableFileWriter,
  WorkPackageLockOwner
} from "@cortex-eval/work-package/src/secure-work-package-directory.ts";
import { createHash } from "node:crypto";

import { readCanonicalExportEvents } from "./canonical-export-line-reader.ts";
import { reconcileCanonicalExportDirectory } from "./canonical-export-validator.ts";

/** Receiver ownership, cancellation and cleanup dependencies. */
export interface CanonicalExportReceiverOptions {
  /** Unpredictable staging and writer nonce. */
  readonly nonce: string;
  /** Stable current-process ownership. */
  readonly owner: WorkPackageLockOwner;
  /** Raw Evidence authorization from the initiating request. */
  readonly rawEvidenceIncluded: boolean;
  /** Optional command cancellation. */
  readonly signal?: AbortSignal | undefined;
  /** Resilient observer for unpublished cleanup failure. */
  readonly cleanupFailureSink?: WorkPackageCleanupFailureSink | undefined;
}

/** Atomically published Canonical Export identity. */
export interface ReceivedCanonicalExport {
  /** Versioned Export UUID. */
  readonly exportId: string;
  /** Exact Manifest SHA-256. */
  readonly manifestSha256: string;
  /** Absolute published directory path. */
  readonly targetPath: string;
}

type FileDescriptor = ImmutableFileExpectation;

// Derive a bounded native temporary name from the receiver nonce and file order.
function writerNonce(nonce: string, index: number): string {
  return createHash("sha256").update(`${nonce}:${index}`).digest("hex");
}

// Compare an external descriptor without coercion.
function sameFile(left: FileDescriptor, right: FileDescriptor): boolean {
  return (
    left.path === right.path && left.sha256 === right.sha256 && left.sizeBytes === right.sizeBytes
  );
}

// Return the exact manifest-defined file sequence after the Manifest itself.
function dataFiles(manifest: CanonicalExportManifestV1): readonly FileDescriptor[] {
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

// Read and validate one bounded control document after its expected writer committed.
async function readControl<T>(
  publisher: WorkPackageDirectoryPublisher,
  file: FileDescriptor,
  parse: (dirty: unknown) => T
): Promise<T> {
  const bytes = await publisher.directory.readFileBounded(file.path, file.sizeBytes);
  let dirty: unknown;
  try {
    dirty = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    throw new Error("CANONICAL_EXPORT_EVENT_INVALID", { cause: error });
  }
  try {
    return parse(dirty);
  } catch (error) {
    throw new Error("CANONICAL_EXPORT_EVENT_INVALID", { cause: error });
  }
}

// Commit only the exact open file event sequence.
async function consumeOpenFile(
  event: CanonicalExportEventV1,
  writer: ImmutableFileWriter,
  path: string,
  sequence: number
): Promise<"OPEN" | "COMMITTED"> {
  if (event.type === "FILE_CHUNK") {
    if (event.path !== path || event.sequence !== sequence) {
      throw new Error("CANONICAL_EXPORT_EVENT_INVALID");
    }
    await writer.append(Buffer.from(event.dataBase64, "base64"));
    return "OPEN";
  }
  if (event.type !== "FILE_END" || event.path !== path) {
    throw new Error("CANONICAL_EXPORT_EVENT_INVALID");
  }
  await writer.commit();
  return "COMMITTED";
}

// Require the received reconciliation to equal an independent disk recomputation.
function requireSameReconciliation(
  received: CanonicalExportReconciliationV1,
  actual: CanonicalExportReconciliationV1
): void {
  const allPass = Object.values(actual.checks).every((entry) => entry.status === "PASS");
  if (!allPass || canonicalJson(received) !== canonicalJson(actual)) {
    throw new Error("CANONICAL_EXPORT_RECONCILIATION_FAILED");
  }
}

/** Receive, independently reconcile and atomically publish one Canonical Export directory. */
export async function receiveCanonicalExport(
  input: AsyncIterable<Uint8Array>,
  targetPath: string,
  options: CanonicalExportReceiverOptions
): Promise<ReceivedCanonicalExport> {
  const publisher = await WorkPackageDirectoryPublisher.create(
    targetPath,
    options.nonce,
    options.owner,
    options.cleanupFailureSink
  );
  let writer: ImmutableFileWriter | undefined;
  let currentPath: string | undefined;
  let nextSequence = 0;
  let writerIndex = 0;
  let phase: "START" | "MANIFEST" | "FILES" | "RECONCILIATION" | "END" | "DONE" = "START";
  let exportId: string | undefined;
  let manifestFile: FileDescriptor | undefined;
  let manifest: CanonicalExportManifestV1 | undefined;
  let expectedFiles: readonly FileDescriptor[] = [];
  let expectedIndex = 0;
  let reconciliationFile: FileDescriptor | undefined;
  let reconciliation: CanonicalExportReconciliationV1 | undefined;
  try {
    for await (const event of readCanonicalExportEvents(input, options.signal)) {
      if (phase === "DONE") throw new Error("CANONICAL_EXPORT_EVENT_INVALID");
      if (phase === "START") {
        if (event.type !== "EXPORT_START") throw new Error("CANONICAL_EXPORT_EVENT_INVALID");
        exportId = event.exportId;
        manifestFile = event.manifest;
        writer = await publisher.directory.createImmutableFileWriter(
          manifestFile,
          writerNonce(options.nonce, writerIndex)
        );
        writerIndex += 1;
        currentPath = manifestFile.path;
        phase = "MANIFEST";
        continue;
      }
      if (writer !== undefined && currentPath !== undefined) {
        const committed = await consumeOpenFile(event, writer, currentPath, nextSequence);
        if (event.type === "FILE_CHUNK") nextSequence += 1;
        if (committed === "OPEN") continue;
        writer = undefined;
        currentPath = undefined;
        nextSequence = 0;
        if (phase === "MANIFEST" && manifestFile !== undefined) {
          manifest = await readControl(publisher, manifestFile, (dirty) =>
            CanonicalExportManifestV1Schema.parse(dirty)
          );
          if (manifest.exportId !== exportId) throw new Error("CANONICAL_EXPORT_EVENT_INVALID");
          if (manifest.rawEvidenceIncluded !== options.rawEvidenceIncluded) {
            throw new Error("CANONICAL_EXPORT_EVENT_INVALID");
          }
          expectedFiles = dataFiles(manifest);
          phase = "FILES";
        } else if (phase === "RECONCILIATION" && reconciliationFile !== undefined) {
          reconciliation = await readControl(publisher, reconciliationFile, (dirty) =>
            CanonicalExportReconciliationV1Schema.parse(dirty)
          );
          if (reconciliation.exportId !== exportId) {
            throw new Error("CANONICAL_EXPORT_EVENT_INVALID");
          }
          phase = "END";
        }
        continue;
      }
      if (phase === "FILES" && event.type === "FILE_START") {
        const expected = expectedFiles[expectedIndex];
        if (expected !== undefined) {
          if (!sameFile(expected, event.file)) throw new Error("CANONICAL_EXPORT_EVENT_INVALID");
          expectedIndex += 1;
        } else {
          if (event.file.path !== "reconciliation.json") {
            throw new Error("CANONICAL_EXPORT_EVENT_INVALID");
          }
          reconciliationFile = event.file;
          phase = "RECONCILIATION";
        }
        writer = await publisher.directory.createImmutableFileWriter(
          event.file,
          writerNonce(options.nonce, writerIndex)
        );
        writerIndex += 1;
        currentPath = event.file.path;
        continue;
      }
      if (
        phase !== "END" ||
        event.type !== "EXPORT_END" ||
        exportId === undefined ||
        event.exportId !== exportId ||
        manifest === undefined ||
        manifestFile === undefined ||
        reconciliation === undefined ||
        reconciliationFile === undefined ||
        expectedIndex !== expectedFiles.length ||
        !sameFile(reconciliationFile, event.reconciliation)
      ) {
        throw new Error("CANONICAL_EXPORT_EVENT_INVALID");
      }
      const actual = await reconcileCanonicalExportDirectory(publisher.directory, manifest);
      requireSameReconciliation(reconciliation, actual);
      phase = "DONE";
    }
    if (phase !== "DONE" || exportId === undefined || manifestFile === undefined) {
      throw new Error("CANONICAL_EXPORT_STREAM_TRUNCATED");
    }
    await publisher.prepareForValidation();
    await publisher.publish();
    return { exportId, manifestSha256: manifestFile.sha256, targetPath };
  } catch (error) {
    await writer?.abort().catch(() => undefined);
    await publisher.abort().catch(async () => {
      await options.cleanupFailureSink
        ?.record({ code: "TEMP_CLEANUP_FAILED" })
        .catch(() => undefined);
    });
    throw error;
  }
}
