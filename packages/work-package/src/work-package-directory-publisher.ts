import { isAbsolute, basename, dirname } from "node:path";

import { openVerifiedDirectory } from "./secure-directory-handoff.ts";
import {
  closeNativeFileDescriptor,
  fsyncNativeFileDescriptor,
  mkdirAt,
  openDirectoryAt,
  renameExclusiveAt,
  statAt,
  type NativeEntryFacts
} from "./secure-directory-native.ts";
import { removeEntryTreeAt } from "./secure-directory-tree.ts";
import {
  SecureWorkPackageDirectory,
  type WorkPackageLockOwner
} from "./secure-work-package-directory.ts";

const TARGET_NAME = /^[A-Za-z0-9._-]+$/;
const NONCE = /^[A-Za-z0-9_-]{8,128}$/;
const OWNER_PATH = ".cortex-export-owner.json";

/** Reserved namespace used only by unpublished export staging directories. */
export const WORK_PACKAGE_EXPORT_STAGING_PREFIX = ".cortex-export-";

// Read one stable native error code without depending on system prose.
function errorCode(error: unknown): string | null {
  if (error === null || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function sameIdentity(left: NativeEntryFacts, right: NativeEntryFacts): boolean {
  return left.device === right.device && left.inode === right.inode;
}

/** Validate one export target and return its parent without touching the filesystem. */
export function workPackageExportParentPath(targetPath: string): string {
  const targetName = basename(targetPath);
  if (
    !isAbsolute(targetPath) ||
    !TARGET_NAME.test(targetName) ||
    targetName === "." ||
    targetName === ".." ||
    targetName.startsWith(WORK_PACKAGE_EXPORT_STAGING_PREFIX) ||
    Buffer.byteLength(targetName, "utf8") > 255
  ) {
    throw new Error("WORK_PACKAGE_TARGET_INVALID");
  }
  return dirname(targetPath);
}

/** Sanitized failure fact for an unpublished staging cleanup. */
export interface WorkPackageCleanupFailure {
  /** Stable private cleanup failure code. */
  readonly code: "TEMP_CLEANUP_FAILED";
}

/** Resilient observer that cannot replace the package operation outcome. */
export interface WorkPackageCleanupFailureSink {
  /** Record one sanitized staging cleanup failure. */
  readonly record: (failure: WorkPackageCleanupFailure) => Promise<void>;
}

/** One unpublished owner-identified package staging directory. */
export class WorkPackageDirectoryPublisher {
  readonly #parentDescriptor: number;
  readonly #stagingName: string;
  readonly #targetName: string;
  readonly #directory: SecureWorkPackageDirectory;
  readonly #cleanupFailureSink: WorkPackageCleanupFailureSink | undefined;
  readonly #syncDirectoryDescriptor: (descriptor: number) => void;
  #directoryClosed = false;
  #ownerRemoved = false;
  #closed = false;
  #published = false;

  private constructor(input: {
    readonly parentDescriptor: number;
    readonly stagingName: string;
    readonly targetName: string;
    readonly directory: SecureWorkPackageDirectory;
    readonly cleanupFailureSink: WorkPackageCleanupFailureSink | undefined;
    readonly syncDirectoryDescriptor: (descriptor: number) => void;
  }) {
    this.#parentDescriptor = input.parentDescriptor;
    this.#stagingName = input.stagingName;
    this.#targetName = input.targetName;
    this.#directory = input.directory;
    this.#cleanupFailureSink = input.cleanupFailureSink;
    this.#syncDirectoryDescriptor = input.syncDirectoryDescriptor;
  }

  /** Create durable staging ownership before receiving external bytes. */
  public static async create(
    targetPath: string,
    nonce: string,
    owner: WorkPackageLockOwner,
    cleanupFailureSink?: WorkPackageCleanupFailureSink,
    syncDirectoryDescriptor: (descriptor: number) => void = fsyncNativeFileDescriptor
  ): Promise<WorkPackageDirectoryPublisher> {
    const targetName = basename(targetPath);
    const parentPath = workPackageExportParentPath(targetPath);
    if (!NONCE.test(nonce)) {
      throw new Error("WORK_PACKAGE_TARGET_INVALID");
    }
    const parentDescriptor = await openVerifiedDirectory(parentPath, null);
    const stagingName = `${WORK_PACKAGE_EXPORT_STAGING_PREFIX}${nonce}`;
    let ownershipTransferred = false;
    let stagingCreated = false;
    try {
      mkdirAt(parentDescriptor, stagingName, 0o700);
      stagingCreated = true;
      fsyncNativeFileDescriptor(parentDescriptor);
      const stagingDescriptor = openDirectoryAt(parentDescriptor, stagingName);
      const directory = SecureWorkPackageDirectory.adoptOwnedDescriptor(stagingDescriptor);
      const publisher = new WorkPackageDirectoryPublisher({
        parentDescriptor,
        stagingName,
        targetName,
        directory,
        cleanupFailureSink,
        syncDirectoryDescriptor
      });
      ownershipTransferred = true;
      try {
        const metadata = Buffer.from(
          `${JSON.stringify({
            nonce,
            pid: owner.pid,
            processStartedAt: owner.processStartedAt,
            createdAt: owner.acquiredAt,
            targetName
          })}\n`,
          "utf8"
        );
        await directory.writeImmutableFile(OWNER_PATH, metadata, `owner-${nonce}`);
      } catch (error) {
        await publisher.#abortAndReportCleanupFailure();
        throw error;
      }
      return publisher;
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        closeNativeFileDescriptor(parentDescriptor);
        throw new Error("WORK_PACKAGE_STAGING_EXISTS", { cause: error });
      }
      if (!ownershipTransferred) {
        if (stagingCreated) {
          try {
            removeEntryTreeAt(parentDescriptor, stagingName);
            fsyncNativeFileDescriptor(parentDescriptor);
          } catch {
            // The original creation failure remains authoritative before ownership transfer.
          }
        }
        closeNativeFileDescriptor(parentDescriptor);
      }
      throw error;
    }
  }

  /** Stable package directory receiving streamed files. */
  public get directory(): SecureWorkPackageDirectory {
    if (this.#closed) throw new Error("WORK_PACKAGE_PUBLISHER_CLOSED");
    return this.#directory;
  }

  /** Remove staging ownership only when the complete package is ready for validation. */
  public async prepareForValidation(): Promise<void> {
    if (this.#closed) throw new Error("WORK_PACKAGE_PUBLISHER_CLOSED");
    if (this.#ownerRemoved) return;
    await this.#directory.removeFile(OWNER_PATH);
    this.#ownerRemoved = true;
  }

  /** Remove staging-only ownership and atomically publish the whole directory. */
  public async publish(): Promise<void> {
    if (this.#closed) throw new Error("WORK_PACKAGE_PUBLISHER_CLOSED");
    await this.prepareForValidation();
    this.#closeDirectory();
    let renamed = false;
    let publishedFacts: NativeEntryFacts | null = null;
    try {
      renameExclusiveAt(
        this.#parentDescriptor,
        this.#stagingName,
        this.#parentDescriptor,
        this.#targetName
      );
      renamed = true;
      publishedFacts = statAt(this.#parentDescriptor, this.#targetName);
      this.#syncDirectoryDescriptor(this.#parentDescriptor);
      this.#published = true;
      this.#closed = true;
      closeNativeFileDescriptor(this.#parentDescriptor);
    } catch (error) {
      const primary =
        !renamed && (errorCode(error) === "EEXIST" || errorCode(error) === "ENOTEMPTY")
          ? new Error("WORK_PACKAGE_TARGET_EXISTS", { cause: error })
          : new Error("ARTIFACT_WRITE_FAILED", { cause: error });
      if (renamed) await this.#restoreRenamedTarget(publishedFacts);
      await this.#abortAndReportCleanupFailure();
      throw primary;
    }
  }

  /** Remove unpublished staging with stable-fd no-follow recursion. */
  public abort(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#closeDirectory();
    if (!this.#published) {
      try {
        removeEntryTreeAt(this.#parentDescriptor, this.#stagingName);
        fsyncNativeFileDescriptor(this.#parentDescriptor);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") {
          this.#closed = true;
          closeNativeFileDescriptor(this.#parentDescriptor);
          throw new Error("TEMP_CLEANUP_FAILED", { cause: error });
        }
      }
    }
    this.#closed = true;
    closeNativeFileDescriptor(this.#parentDescriptor);
    return Promise.resolve();
  }

  #closeDirectory(): void {
    if (this.#directoryClosed) return;
    this.#directoryClosed = true;
    this.#directory.close();
  }

  // Clean an unpublished staging directory while preserving the caller's primary outcome.
  async #abortAndReportCleanupFailure(): Promise<void> {
    try {
      await this.abort();
    } catch {
      await this.#cleanupFailureSink
        ?.record({ code: "TEMP_CLEANUP_FAILED" })
        .catch(() => undefined);
    }
  }

  // Restore the unpublished staging name after rename crossed the visibility boundary.
  async #restoreRenamedTarget(publishedFacts: NativeEntryFacts | null): Promise<void> {
    try {
      if (publishedFacts === null) throw new Error("TEMP_CLEANUP_FAILED");
      const currentFacts = statAt(this.#parentDescriptor, this.#targetName);
      if (currentFacts.kind !== "DIRECTORY" || !sameIdentity(currentFacts, publishedFacts)) {
        throw new Error("TEMP_CLEANUP_FAILED");
      }
      renameExclusiveAt(
        this.#parentDescriptor,
        this.#targetName,
        this.#parentDescriptor,
        this.#stagingName
      );
      this.#syncDirectoryDescriptor(this.#parentDescriptor);
    } catch {
      await this.#cleanupFailureSink
        ?.record({ code: "TEMP_CLEANUP_FAILED" })
        .catch(() => undefined);
    }
  }
}
