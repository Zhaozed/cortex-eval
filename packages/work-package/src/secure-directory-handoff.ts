import { lstat, realpath } from "node:fs/promises";

import {
  closeNativeFileDescriptor,
  openSecureDirectory,
  statNativeFileDescriptor
} from "./secure-directory-native.ts";

/** Open one lexical directory and prove its canonical path-to-fd identity did not change. */
export async function openVerifiedDirectory(
  path: string,
  requiredMode: number | null
): Promise<number> {
  const lexicalFacts = await lstat(path, { bigint: true });
  if (!lexicalFacts.isDirectory() || lexicalFacts.isSymbolicLink()) {
    throw new Error("WORK_PACKAGE_PATH_INVALID");
  }
  const canonicalPath = await realpath(path);
  const before = await lstat(canonicalPath, { bigint: true });
  const descriptor = openSecureDirectory(canonicalPath);
  try {
    const opened = statNativeFileDescriptor(descriptor);
    const after = await lstat(canonicalPath, { bigint: true });
    if (
      opened.kind !== "DIRECTORY" ||
      (requiredMode !== null && opened.mode !== requiredMode) ||
      opened.device !== before.dev.toString() ||
      opened.inode !== before.ino.toString() ||
      opened.device !== after.dev.toString() ||
      opened.inode !== after.ino.toString()
    ) {
      throw new Error("WORK_PACKAGE_PATH_INVALID");
    }
    return descriptor;
  } catch (error) {
    closeNativeFileDescriptor(descriptor);
    throw error;
  }
}
