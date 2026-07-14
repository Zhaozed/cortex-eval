import {
  closeNativeFileDescriptor,
  fsyncNativeFileDescriptor,
  openDirectoryAt,
  readDirectoryNames,
  statAt,
  unlinkAt
} from "./secure-directory-native.ts";

/** Remove one stable-fd tree without following a symbolic link. */
export function removeEntryTreeAt(parent: number, name: string): void {
  const facts = statAt(parent, name);
  if (facts.kind === "FILE") {
    unlinkAt(parent, name, "FILE");
    return;
  }
  if (facts.kind !== "DIRECTORY") throw new Error("TEMP_CONTAINMENT_REJECTED");
  const directory = openDirectoryAt(parent, name);
  try {
    for (const child of readDirectoryNames(directory)) removeEntryTreeAt(directory, child);
    fsyncNativeFileDescriptor(directory);
  } finally {
    closeNativeFileDescriptor(directory);
  }
  unlinkAt(parent, name, "DIRECTORY");
}
