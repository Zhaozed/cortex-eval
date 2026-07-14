import type { WorkPackageExportEventV1 } from "@cortex-eval/contracts/src/work-package-runtime-contracts.ts";

import type { SecureWorkPackageDirectory } from "./secure-work-package-directory.ts";
import type { ValidatedWorkPackage } from "./work-package-validator.ts";

interface ExportFileDescriptor {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

function inputFiles(value: ValidatedWorkPackage): readonly ExportFileDescriptor[] {
  const inputs = value.manifest.inputs;
  return [
    inputs.tests,
    inputs.endpoint,
    inputs.evaluator,
    inputs.analyzer,
    inputs.analysisPrompt,
    inputs.envExample,
    ...inputs.rubricPrompts
  ].map((file) => ({ path: file.path, sha256: file.sha256, sizeBytes: file.sizeBytes }));
}

function requireActive(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new Error("REQUEST_ABORTED");
}

async function* fileEvents(
  directory: SecureWorkPackageDirectory,
  file: ExportFileDescriptor,
  includeStart: boolean,
  signal?: AbortSignal
): AsyncGenerator<WorkPackageExportEventV1> {
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

/** Emit Manifest-first typed events for immutable package inputs only. */
export async function* streamWorkPackageExportEvents(
  directory: SecureWorkPackageDirectory,
  value: ValidatedWorkPackage,
  signal?: AbortSignal
): AsyncGenerator<WorkPackageExportEventV1> {
  requireActive(signal);
  const manifest = {
    path: "manifest.json" as const,
    sha256: value.manifestSha256,
    sizeBytes: value.manifestSizeBytes
  };
  yield { type: "PACKAGE_START", manifest };
  yield* fileEvents(directory, manifest, false, signal);
  for (const file of inputFiles(value)) yield* fileEvents(directory, file, true, signal);
  requireActive(signal);
  yield { type: "PACKAGE_END", packageId: value.manifest.packageId };
}

/** Encode canonical LF-delimited export events with transport backpressure. */
export async function* encodeWorkPackageExport(
  directory: SecureWorkPackageDirectory,
  value: ValidatedWorkPackage,
  signal?: AbortSignal
): AsyncGenerator<Buffer> {
  for await (const event of streamWorkPackageExportEvents(directory, value, signal)) {
    yield Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
  }
}
