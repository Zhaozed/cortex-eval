import type { WorkPackageManifestV1 } from "@cortex-eval/contracts/src/work-package-contracts.ts";
import {
  WORK_PACKAGE_RUNTIME_LIMITS,
  type WorkPackageExportEventV1
} from "@cortex-eval/contracts/src/work-package-runtime-contracts.ts";
import { createHash } from "node:crypto";

import {
  WorkPackageDirectoryPublisher,
  type WorkPackageCleanupFailureSink
} from "./work-package-directory-publisher.ts";
import { readWorkPackageExportEvents } from "./work-package-export-line-reader.ts";
import {
  type ImmutableFileExpectation,
  type ImmutableFileWriter,
  type WorkPackageLockOwner
} from "./secure-work-package-directory.ts";
import { validateWorkPackageManifestPolicy } from "./work-package-manifest-policy.ts";
import { validateWorkPackageDirectory } from "./work-package-validator.ts";

/** Receiver dependencies and stable ownership identity. */
export interface WorkPackageExportReceiverOptions {
  /** Unpredictable staging and temporary-file nonce. */
  readonly nonce: string;
  /** Process identity used by staging and the package lock. */
  readonly owner: WorkPackageLockOwner;
  /** Optional cancellation propagated from CLI transport. */
  readonly signal?: AbortSignal | undefined;
  /** Optional resilient observer for unpublished staging cleanup failures. */
  readonly cleanupFailureSink?: WorkPackageCleanupFailureSink | undefined;
}

/** Successfully published Work Package identity. */
export interface ReceivedWorkPackage {
  /** Frozen Package identity read from the validated Manifest. */
  readonly packageId: string;
  /** Exact validated Manifest file hash. */
  readonly manifestSha256: string;
  /** Absolute target path atomically published by the receiver. */
  readonly targetPath: string;
}

// Clean one bounded Manifest after its exact hash and size have already matched.
async function readManifest(
  publisher: WorkPackageDirectoryPublisher
): Promise<WorkPackageManifestV1> {
  const bytes = await publisher.directory.readFileBounded(
    "manifest.json",
    WORK_PACKAGE_RUNTIME_LIMITS.manifestBytes
  );
  let dirty: unknown;
  try {
    dirty = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    throw new Error("WORK_PACKAGE_INVALID", { cause: error });
  }
  try {
    return validateWorkPackageManifestPolicy(dirty);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("WORK_PACKAGE_")) throw error;
    throw new Error("WORK_PACKAGE_INVALID", { cause: error });
  }
}

// Derive a bounded native temporary filename from caller nonce and file order.
function writerNonce(nonce: string, index: number): string {
  return createHash("sha256").update(`${nonce}:${index}`).digest("hex");
}

// Build the exact post-Manifest file allowlist.
function inputFiles(manifest: WorkPackageManifestV1): readonly ImmutableFileExpectation[] {
  return [
    manifest.inputs.tests,
    manifest.inputs.endpoint,
    manifest.inputs.evaluator,
    manifest.inputs.analyzer,
    manifest.inputs.analysisPrompt,
    manifest.inputs.envExample,
    ...manifest.inputs.rubricPrompts
  ];
}

// Compare a FILE_START descriptor with the Manifest fact without coercion.
function sameFile(left: ImmutableFileExpectation, right: ImmutableFileExpectation): boolean {
  return (
    left.path === right.path && left.sha256 === right.sha256 && left.sizeBytes === right.sizeBytes
  );
}

// Consume one chunk or file terminator for the currently open writer.
async function consumeOpenFile(
  event: WorkPackageExportEventV1,
  writer: ImmutableFileWriter,
  path: string,
  sequence: number
): Promise<"OPEN" | "COMMITTED"> {
  if (event.type === "FILE_CHUNK") {
    if (event.path !== path || event.sequence !== sequence) {
      throw new Error("EXPORT_EVENT_INVALID");
    }
    await writer.append(Buffer.from(event.dataBase64, "base64"));
    return "OPEN";
  }
  if (event.type !== "FILE_END" || event.path !== path) {
    throw new Error("EXPORT_EVENT_INVALID");
  }
  await writer.commit();
  return "COMMITTED";
}

/** Receive, validate and atomically publish one Manifest-first export stream. */
export async function receiveWorkPackageExport(
  input: AsyncIterable<Uint8Array>,
  targetPath: string,
  options: WorkPackageExportReceiverOptions
): Promise<ReceivedWorkPackage> {
  const publisher = await WorkPackageDirectoryPublisher.create(
    targetPath,
    options.nonce,
    options.owner,
    options.cleanupFailureSink
  );
  let writer: ImmutableFileWriter | undefined;
  let currentPath: string | undefined;
  let nextSequence = 0;
  let manifest: WorkPackageManifestV1 | undefined;
  let expectedFiles = new Map<string, ImmutableFileExpectation>();
  let phase: "START" | "MANIFEST" | "FILES" | "DONE" = "START";
  let writerIndex = 0;
  try {
    for await (const event of readWorkPackageExportEvents(input, options.signal)) {
      if (phase === "DONE") throw new Error("EXPORT_EVENT_INVALID");
      if (phase === "START") {
        if (event.type !== "PACKAGE_START") throw new Error("EXPORT_EVENT_INVALID");
        writer = await publisher.directory.createImmutableFileWriter(
          event.manifest,
          writerNonce(options.nonce, writerIndex)
        );
        writerIndex += 1;
        currentPath = "manifest.json";
        nextSequence = 0;
        phase = "MANIFEST";
        continue;
      }
      if (writer !== undefined && currentPath !== undefined) {
        const result = await consumeOpenFile(event, writer, currentPath, nextSequence);
        if (event.type === "FILE_CHUNK") nextSequence += 1;
        if (result === "OPEN") continue;
        writer = undefined;
        currentPath = undefined;
        if (phase === "MANIFEST") {
          manifest = await readManifest(publisher);
          expectedFiles = new Map(inputFiles(manifest).map((file) => [file.path, file]));
          phase = "FILES";
        }
        continue;
      }
      if (phase !== "FILES" || manifest === undefined) {
        throw new Error("EXPORT_EVENT_INVALID");
      }
      if (event.type === "FILE_START") {
        const expected = expectedFiles.get(event.file.path);
        if (expected === undefined || !sameFile(expected, event.file)) {
          throw new Error("EXPORT_EVENT_INVALID");
        }
        writer = await publisher.directory.createImmutableFileWriter(
          expected,
          writerNonce(options.nonce, writerIndex)
        );
        writerIndex += 1;
        currentPath = expected.path;
        nextSequence = 0;
        expectedFiles.delete(expected.path);
        continue;
      }
      if (
        event.type !== "PACKAGE_END" ||
        event.packageId !== manifest.packageId ||
        expectedFiles.size !== 0
      ) {
        throw new Error("EXPORT_EVENT_INVALID");
      }
      phase = "DONE";
    }
    if (phase !== "DONE" || manifest === undefined) throw new Error("EXPORT_STREAM_TRUNCATED");
    await publisher.prepareForValidation();
    const validated = await validateWorkPackageDirectory(publisher.directory, options.owner);
    await publisher.publish();
    return {
      packageId: manifest.packageId,
      manifestSha256: validated.manifestSha256,
      targetPath
    };
  } catch (error) {
    const cleanups: readonly (() => Promise<void>)[] = [
      async (): Promise<void> => await writer?.abort(),
      async (): Promise<void> => await publisher.abort()
    ];
    for (const cleanup of cleanups) {
      try {
        await cleanup();
      } catch {
        await options.cleanupFailureSink
          ?.record({ code: "TEMP_CLEANUP_FAILED" })
          .catch(() => undefined);
      }
    }
    throw error;
  }
}
