import { createHash } from "node:crypto";

import type { SecureWorkPackageDirectory } from "./secure-work-package-directory.ts";

/** Hash and size observed from one stable file descriptor. */
export interface ObservedFileIntegrity {
  /** Lowercase SHA-256 of the complete file bytes. */
  readonly sha256: string;
  /** Complete file size observed while streaming. */
  readonly sizeBytes: number;
}

interface FileIntegrityV1 {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

/** Stream and verify one registered regular file without materializing its aggregate body. */
export async function validateFileIntegrity(
  directory: SecureWorkPackageDirectory,
  expected: FileIntegrityV1,
  maximumBytes = Number.MAX_SAFE_INTEGER
): Promise<ObservedFileIntegrity> {
  if (expected.sizeBytes > maximumBytes) throw new Error("WORK_PACKAGE_INPUT_TOO_LARGE");
  const hash = createHash("sha256");
  let sizeBytes = 0;
  try {
    for await (const chunk of directory.streamFile(expected.path, maximumBytes)) {
      sizeBytes += chunk.byteLength;
      hash.update(chunk);
    }
  } catch (error) {
    if (error instanceof Error && error.message === "WORK_PACKAGE_FILE_TOO_LARGE") {
      throw new Error("WORK_PACKAGE_INPUT_TOO_LARGE", { cause: error });
    }
    throw error;
  }
  const sha256 = hash.digest("hex");
  if (sizeBytes !== expected.sizeBytes || sha256 !== expected.sha256) {
    throw new Error("ARTIFACT_HASH_MISMATCH");
  }
  return { sha256, sizeBytes };
}
