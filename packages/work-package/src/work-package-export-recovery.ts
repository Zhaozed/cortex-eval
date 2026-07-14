import { openVerifiedDirectory } from "./secure-directory-handoff.ts";
import {
  closeNativeFileDescriptor,
  fsyncNativeFileDescriptor,
  openDirectoryAt,
  readDirectoryNames,
  statAt,
  statNativeFileDescriptor,
  type NativeEntryFacts
} from "./secure-directory-native.ts";
import { removeEntryTreeAt } from "./secure-directory-tree.ts";
import { SecureWorkPackageDirectory } from "./secure-work-package-directory.ts";
import { WORK_PACKAGE_EXPORT_STAGING_PREFIX } from "./work-package-directory-publisher.ts";

const OWNER_PATH = ".cortex-export-owner.json";
const OWNER_MAXIMUM_BYTES = 4 * 1024;
const NONCE = /^[A-Za-z0-9_-]{8,128}$/;
const TARGET_NAME = /^[A-Za-z0-9._-]+$/;

/** No-shell process start-identity lookup used to detect PID reuse. */
export interface WorkPackageProcessLiveness {
  /** Return the process start identity, or null when the PID is not live. */
  processStartedAt(pid: number): Promise<string | null>;
}

/** Safe crash-recovery events without paths or owner content. */
export type WorkPackageExportRecoveryEvent =
  | "TEMP_OWNER_INVALID"
  | "TEMP_SYMLINK_QUARANTINED"
  | "TEMP_OWNER_CHANGED"
  | "TEMP_CONTAINMENT_REJECTED"
  | "TEMP_CLEANUP_FAILED";

/** Dependencies and policy for one startup recovery pass. */
export interface WorkPackageExportRecoveryOptions {
  /** Process identity adapter. */
  readonly processLiveness: WorkPackageProcessLiveness;
  /** Current epoch milliseconds. */
  readonly now: () => number;
  /** Minimum age before inactive staging is removable. */
  readonly ttlMs: number;
  /** Optional safe security-event sink. */
  readonly onSecurityEvent?:
    ((event: WorkPackageExportRecoveryEvent) => void | Promise<void>) | undefined;
}

interface ExportOwner {
  readonly nonce: string;
  readonly pid: number;
  readonly processStartedAt: string;
  readonly createdAt: string;
  readonly targetName: string;
}

type OwnerRead =
  | { readonly kind: "MISSING" }
  | { readonly kind: "INVALID" }
  | { readonly kind: "VALID"; readonly owner: ExportOwner };

function errorMessage(error: unknown): string | null {
  return error instanceof Error ? error.message : null;
}

function sameIdentity(left: NativeEntryFacts, right: NativeEntryFacts): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function parseOwner(value: unknown, expectedNonce: string): ExportOwner | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Readonly<Record<string, unknown>>;
  if (Object.keys(source).sort().join(",") !== "createdAt,nonce,pid,processStartedAt,targetName") {
    return null;
  }
  if (source.nonce !== expectedNonce || !NONCE.test(expectedNonce)) return null;
  if (!Number.isSafeInteger(source.pid) || (source.pid as number) <= 0) return null;
  if (typeof source.processStartedAt !== "string" || source.processStartedAt.length === 0) {
    return null;
  }
  if (
    typeof source.createdAt !== "string" ||
    !Number.isFinite(Date.parse(source.createdAt)) ||
    typeof source.targetName !== "string" ||
    !TARGET_NAME.test(source.targetName) ||
    source.targetName === "." ||
    source.targetName === ".."
  ) {
    return null;
  }
  return {
    nonce: source.nonce,
    pid: source.pid as number,
    processStartedAt: source.processStartedAt,
    createdAt: source.createdAt,
    targetName: source.targetName
  };
}

async function readOwner(
  directory: SecureWorkPackageDirectory,
  expectedNonce: string
): Promise<OwnerRead> {
  let bytes: Buffer;
  try {
    bytes = await directory.readFileBounded(OWNER_PATH, OWNER_MAXIMUM_BYTES);
  } catch (error) {
    if (errorMessage(error) === "ARTIFACT_MISSING") return { kind: "MISSING" };
    return { kind: "INVALID" };
  }
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    const owner = parseOwner(value, expectedNonce);
    return owner === null ? { kind: "INVALID" } : { kind: "VALID", owner };
  } catch {
    return { kind: "INVALID" };
  }
}

function sameOwner(left: ExportOwner, right: ExportOwner): boolean {
  return (
    left.nonce === right.nonce &&
    left.pid === right.pid &&
    left.processStartedAt === right.processStartedAt &&
    left.createdAt === right.createdAt &&
    left.targetName === right.targetName
  );
}

async function emit(
  options: WorkPackageExportRecoveryOptions,
  event: WorkPackageExportRecoveryEvent
): Promise<void> {
  await options.onSecurityEvent?.(event);
}

async function removeStableEntry(
  parent: number,
  name: string,
  openedFacts: NativeEntryFacts,
  options: WorkPackageExportRecoveryOptions
): Promise<void> {
  const current = statAt(parent, name);
  if (!sameIdentity(current, openedFacts) || current.kind !== "DIRECTORY") {
    await emit(options, "TEMP_CONTAINMENT_REJECTED");
    return;
  }
  try {
    removeEntryTreeAt(parent, name);
    fsyncNativeFileDescriptor(parent);
  } catch (error) {
    await emit(options, "TEMP_CLEANUP_FAILED");
    throw new Error("TEMP_CLEANUP_FAILED", { cause: error });
  }
}

/** Remove only old, inactive, owner-stable export staging directories. */
export async function cleanupStaleWorkPackageExports(
  parentPath: string,
  options: WorkPackageExportRecoveryOptions
): Promise<void> {
  if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs < 0) {
    throw new Error("WORK_PACKAGE_RECOVERY_POLICY_INVALID");
  }
  const parent = await openVerifiedDirectory(parentPath, null);
  try {
    for (const name of readDirectoryNames(parent)) {
      if (!name.startsWith(WORK_PACKAGE_EXPORT_STAGING_PREFIX)) continue;
      const nonce = name.slice(WORK_PACKAGE_EXPORT_STAGING_PREFIX.length);
      const pathFacts = statAt(parent, name);
      if (pathFacts.kind === "SYMLINK") {
        await emit(options, "TEMP_SYMLINK_QUARANTINED");
        continue;
      }
      if (options.now() - pathFacts.modifiedAtMs < options.ttlMs) continue;
      if (pathFacts.kind !== "DIRECTORY" || pathFacts.mode !== 0o700 || !NONCE.test(nonce)) {
        await emit(options, "TEMP_CONTAINMENT_REJECTED");
        continue;
      }
      const descriptor = openDirectoryAt(parent, name);
      const openedFacts = statNativeFileDescriptor(descriptor);
      if (!sameIdentity(pathFacts, openedFacts)) {
        closeNativeFileDescriptor(descriptor);
        await emit(options, "TEMP_CONTAINMENT_REJECTED");
        continue;
      }
      const directory = SecureWorkPackageDirectory.adoptOwnedDescriptor(descriptor);
      const original = await readOwner(directory, nonce);
      if (original.kind === "INVALID") {
        directory.close();
        await emit(options, "TEMP_OWNER_INVALID");
        continue;
      }
      if (original.kind === "MISSING") {
        const current = await readOwner(directory, nonce);
        directory.close();
        if (current.kind !== "MISSING") {
          await emit(options, "TEMP_OWNER_CHANGED");
          continue;
        }
        await removeStableEntry(parent, name, openedFacts, options);
        continue;
      }
      const liveStartedAt = await options.processLiveness.processStartedAt(original.owner.pid);
      if (liveStartedAt === original.owner.processStartedAt) {
        directory.close();
        continue;
      }
      const current = await readOwner(directory, nonce);
      directory.close();
      if (current.kind !== "VALID" || !sameOwner(current.owner, original.owner)) {
        await emit(options, "TEMP_OWNER_CHANGED");
        continue;
      }
      await removeStableEntry(parent, name, openedFacts, options);
    }
  } finally {
    closeNativeFileDescriptor(parent);
  }
}
