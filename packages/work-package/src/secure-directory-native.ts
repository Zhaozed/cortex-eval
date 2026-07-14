import { createRequire } from "node:module";

/** Native file open modes kept deliberately smaller than POSIX flags. */
export type NativeFileOpenMode = "CREATE_EXCLUSIVE" | "CREATE_OR_OPEN" | "OPEN_READ";

/** Native directory entry kinds observable without following a symbolic link. */
export type NativeEntryKind = "FILE" | "DIRECTORY" | "SYMLINK" | "OTHER";

/** Safe facts returned for one directory entry. */
export interface NativeEntryFacts {
  /** Leaf object kind without symlink traversal. */
  readonly kind: NativeEntryKind;
  /** POSIX owner/group/other permission bits. */
  readonly mode: number;
  /** Current object size in bytes. */
  readonly sizeBytes: number;
  /** Hard-link count used to reject forged control files. */
  readonly linkCount: number;
  /** Last directory-entry content change time in epoch milliseconds. */
  readonly modifiedAtMs: number;
  /** Stable device identity represented without numeric precision loss. */
  readonly device: string;
  /** Stable inode identity represented without numeric precision loss. */
  readonly inode: string;
}

interface SecureDirectoryBinding {
  openSecureDirectory(path: string): number;
  openDirectoryAt(parent: number, name: string): number;
  openFileAt(parent: number, name: string, mode: NativeFileOpenMode, permissions: number): number;
  closeFd(descriptor: number): void;
  duplicateFd(descriptor: number): number;
  fsyncFd(descriptor: number): void;
  mkdirAt(parent: number, name: string, permissions: number): void;
  linkFileExclusiveAt(
    sourceParent: number,
    sourceName: string,
    targetParent: number,
    targetName: string
  ): void;
  renameExclusiveAt(
    sourceParent: number,
    sourceName: string,
    targetParent: number,
    targetName: string
  ): void;
  renameReplaceAt(
    sourceParent: number,
    sourceName: string,
    targetParent: number,
    targetName: string
  ): void;
  statAt(parent: number, name: string): NativeEntryFacts;
  statFd(descriptor: number): NativeEntryFacts;
  readDirectoryNames(parent: number): string[];
  unlinkAt(parent: number, name: string, kind: "FILE" | "DIRECTORY"): void;
  lockFileExclusiveNonblocking(descriptor: number): boolean;
  unlockFile(descriptor: number): void;
}

if (process.platform !== "darwin" || process.arch !== "arm64" || process.versions.napi !== "10") {
  throw new Error("WORK_PACKAGE_NATIVE_UNSUPPORTED");
}

const require = createRequire(import.meta.url);
const binding = require("../native/build/Release/cortex_secure_fs.node") as SecureDirectoryBinding;

/** Securely open an absolute directory through no-follow components. */
export const openSecureDirectory = (path: string): number => binding.openSecureDirectory(path);
/** Open a no-follow child directory relative to a stable parent descriptor. */
export const openDirectoryAt = (parent: number, name: string): number =>
  binding.openDirectoryAt(parent, name);
/** Open or create a regular child file relative to a stable parent descriptor. */
export const openFileAt = (
  parent: number,
  name: string,
  mode: NativeFileOpenMode,
  permissions: number
): number => binding.openFileAt(parent, name, mode, permissions);
/** Close one descriptor owned by the caller. */
export const closeNativeFileDescriptor = (descriptor: number): void => {
  binding.closeFd(descriptor);
};
/** Duplicate one stable descriptor for a longer-lived streaming operation. */
export const duplicateNativeFileDescriptor = (descriptor: number): number =>
  binding.duplicateFd(descriptor);
/** Flush one file or directory descriptor. */
export const fsyncNativeFileDescriptor = (descriptor: number): void => {
  binding.fsyncFd(descriptor);
};
/** Create one child directory relative to a stable parent descriptor. */
export const mkdirAt = (parent: number, name: string, permissions: number): void => {
  binding.mkdirAt(parent, name, permissions);
};
/** Publish one immutable regular file with atomic create-only semantics. */
export const linkFileExclusiveAt = (
  sourceParent: number,
  sourceName: string,
  targetParent: number,
  targetName: string
): void => {
  binding.linkFileExclusiveAt(sourceParent, sourceName, targetParent, targetName);
};
/** Publish or isolate one object with atomic no-replace rename semantics. */
export const renameExclusiveAt = (
  sourceParent: number,
  sourceName: string,
  targetParent: number,
  targetName: string
): void => {
  binding.renameExclusiveAt(sourceParent, sourceName, targetParent, targetName);
};
/** Atomically replace the mutable execution state file. */
export const renameReplaceAt = (
  sourceParent: number,
  sourceName: string,
  targetParent: number,
  targetName: string
): void => {
  binding.renameReplaceAt(sourceParent, sourceName, targetParent, targetName);
};
/** Inspect one child without following symbolic links. */
export const statAt = (parent: number, name: string): NativeEntryFacts =>
  binding.statAt(parent, name);
/** Inspect an already opened stable file or directory descriptor. */
export const statNativeFileDescriptor = (descriptor: number): NativeEntryFacts =>
  binding.statFd(descriptor);
/** List stable child names in deterministic order. */
export function readDirectoryNames(parent: number): readonly string[] {
  return binding.readDirectoryNames(parent).sort((left, right) => left.localeCompare(right));
}
/** Remove an already type-checked child without following symbolic links. */
export const unlinkAt = (parent: number, name: string, kind: "FILE" | "DIRECTORY"): void => {
  binding.unlinkAt(parent, name, kind);
};
/** Attempt one non-blocking exclusive flock on a stable inode. */
export const lockFileExclusiveNonblocking = (descriptor: number): boolean =>
  binding.lockFileExclusiveNonblocking(descriptor);
/** Release a stable inode flock held by the caller. */
export const unlockFile = (descriptor: number): void => {
  binding.unlockFile(descriptor);
};
