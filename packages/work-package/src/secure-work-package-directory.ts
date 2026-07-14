import { createHash, type Hash } from "node:crypto";
import { ftruncate, read, write } from "node:fs";

import { openVerifiedDirectory } from "./secure-directory-handoff.ts";
import { removeEntryTreeAt } from "./secure-directory-tree.ts";
import { validateMaterializedFilePaths } from "./work-package-path-policy.ts";
import {
  closeNativeFileDescriptor,
  duplicateNativeFileDescriptor,
  fsyncNativeFileDescriptor,
  linkFileExclusiveAt,
  lockFileExclusiveNonblocking,
  mkdirAt,
  openDirectoryAt,
  openFileAt,
  readDirectoryNames,
  renameReplaceAt,
  statAt,
  statNativeFileDescriptor,
  unlockFile,
  unlinkAt,
  type NativeEntryFacts
} from "./secure-directory-native.ts";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const LOCK_FILE_NAME = ".cortex-work-package.lock";
const NONCE_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const STREAM_CHUNK_BYTES = 1024 * 1024;

/** Diagnostic owner written only after the stable lock has been acquired. */
export interface WorkPackageLockOwner {
  /** Current operating-system process ID. */
  readonly pid: number;
  /** Operating-system process start identity used to detect PID reuse. */
  readonly processStartedAt: string;
  /** Current Execution identity or null for package-only operations. */
  readonly executionId: string | null;
  /** UTC lock acquisition time. */
  readonly acquiredAt: string;
}

/** Optional safe observer for post-commit temporary cleanup failures. */
export interface SecureWorkPackageDirectoryOptions {
  /** Receive only a stable event code without path or file content. */
  readonly onCleanupFailure?: (() => void | Promise<void>) | undefined;
  /** Flush one directory descriptor after a visible entry mutation. */
  readonly syncDirectoryDescriptor?: ((descriptor: number) => void) | undefined;
}

/** Expected immutable file identity supplied before streaming begins. */
export interface ImmutableFileExpectation {
  /** Runtime-profile relative target path. */
  readonly path: string;
  /** Expected lowercase SHA-256. */
  readonly sha256: string;
  /** Exact expected byte count. */
  readonly sizeBytes: number;
}

/** Stable file-system identity captured at the exact immutable publication boundary. */
export interface ImmutableFilePublicationIdentity {
  /** Exact device identity without numeric precision loss. */
  readonly device: string;
  /** Exact inode identity without numeric precision loss. */
  readonly inode: string;
}

/** Immutable integrity plus the non-persisted identity required only for compensation. */
export interface PublishedImmutableFile {
  /** Portable integrity persisted in contracts and Manifests. */
  readonly integrity: ImmutableFileExpectation;
  /** Process-local publication identity never serialized into Work Package contracts. */
  readonly publicationIdentity: ImmutableFilePublicationIdentity;
}

type ImmutableWriterPolicy =
  | { readonly kind: "EXPECTED"; readonly expectation: ImmutableFileExpectation }
  | { readonly kind: "COMPUTED"; readonly path: string; readonly maximumBytes: number };

/** One no-follow entry observed below the stable package root. */
export interface SecureDirectoryEntry {
  /** Runtime-profile relative path. */
  readonly path: string;
  /** Leaf object kind without symlink traversal. */
  readonly kind: NativeEntryFacts["kind"];
  /** POSIX permission bits. */
  readonly mode: number;
  /** Current object size. */
  readonly sizeBytes: number;
  /** Current hard-link count. */
  readonly linkCount: number;
}

// Return one stable system error code without depending on platform prose.
function errorCode(error: unknown): string | null {
  if (error === null || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

// Write a complete bounded buffer to one already opened descriptor.
async function writeDescriptorAt(
  descriptor: number,
  value: Uint8Array,
  fileOffset: number
): Promise<void> {
  let offset = 0;
  while (offset < value.byteLength) {
    const written = await new Promise<number>((resolve, reject) => {
      write(
        descriptor,
        value,
        offset,
        value.byteLength - offset,
        fileOffset + offset,
        (error, count) => {
          if (error !== null) reject(error);
          else resolve(count);
        }
      );
    });
    if (written <= 0) throw new Error("ARTIFACT_WRITE_FAILED");
    offset += written;
  }
}

// Write one complete new file from its beginning.
function writeDescriptor(descriptor: number, value: Uint8Array): Promise<void> {
  return writeDescriptorAt(descriptor, value, 0);
}

// Read an exact bounded file without trusting a path after the descriptor is open.
async function readDescriptor(descriptor: number, sizeBytes: number): Promise<Buffer> {
  const value = Buffer.alloc(sizeBytes);
  let offset = 0;
  while (offset < sizeBytes) {
    const count = await new Promise<number>((resolve, reject) => {
      read(descriptor, value, offset, sizeBytes - offset, offset, (error, bytesRead) => {
        if (error !== null) reject(error);
        else resolve(bytesRead);
      });
    });
    if (count === 0) throw new Error("WORK_PACKAGE_FILE_CHANGED");
    offset += count;
  }
  return value;
}

// Truncate lock diagnostics before overwriting the stable inode.
function truncateDescriptor(descriptor: number): Promise<void> {
  return new Promise((resolve, reject) => {
    ftruncate(descriptor, 0, (error) => {
      if (error !== null) reject(error);
      else resolve();
    });
  });
}

// Compare exact file-system identity across path-to-fd handoff boundaries.
function sameIdentity(left: NativeEntryFacts, right: NativeEntryFacts): boolean {
  return left.device === right.device && left.inode === right.inode;
}

// Keep cleanup observation outside the primary file operation outcome.
async function reportCleanupFailure(
  observer: (() => void | Promise<void>) | undefined
): Promise<void> {
  await Promise.resolve(observer?.()).catch(() => undefined);
}

// Remove only the exact hard-link target just created from the retained temporary inode.
async function cleanupLinkedTarget(input: {
  readonly parentDescriptor: number;
  readonly temporaryName: string;
  readonly targetName: string;
  readonly syncDirectoryDescriptor: (descriptor: number) => void;
  readonly onCleanupFailure: (() => void | Promise<void>) | undefined;
}): Promise<void> {
  try {
    const temporary = statAt(input.parentDescriptor, input.temporaryName);
    const target = statAt(input.parentDescriptor, input.targetName);
    if (temporary.kind !== "FILE" || target.kind !== "FILE" || !sameIdentity(temporary, target)) {
      throw new Error("TEMP_CONTAINMENT_REJECTED");
    }
    unlinkAt(input.parentDescriptor, input.targetName, "FILE");
    input.syncDirectoryDescriptor(input.parentDescriptor);
  } catch {
    await reportCleanupFailure(input.onCleanupFailure);
  }
}

/** One held package lock over an inode that is never replaced or deleted. */
export class WorkPackageLock {
  readonly #descriptor: number;
  #released = false;

  /** Construct only after an exclusive flock succeeds. */
  public constructor(descriptor: number) {
    this.#descriptor = descriptor;
  }

  /** Release the kernel lock and close its descriptor exactly once. */
  public release(): Promise<void> {
    if (this.#released) return Promise.resolve();
    this.#released = true;
    unlockFile(this.#descriptor);
    closeNativeFileDescriptor(this.#descriptor);
    return Promise.resolve();
  }
}

/** Bounded streaming writer that publishes only an exact immutable file. */
export class ImmutableFileWriter {
  readonly #parentDescriptor: number;
  readonly #fileDescriptor: number;
  readonly #temporaryName: string;
  readonly #targetName: string;
  readonly #policy: ImmutableWriterPolicy;
  readonly #hash: Hash = createHash("sha256");
  readonly #onCleanupFailure: (() => void | Promise<void>) | undefined;
  readonly #syncDirectoryDescriptor: (descriptor: number) => void;
  #sizeBytes = 0;
  #fileClosed = false;
  #closed = false;

  /** Construct only around a newly created owner-only temporary file. */
  public constructor(input: {
    readonly parentDescriptor: number;
    readonly fileDescriptor: number;
    readonly temporaryName: string;
    readonly targetName: string;
    readonly policy: ImmutableWriterPolicy;
    readonly onCleanupFailure: (() => void | Promise<void>) | undefined;
    readonly syncDirectoryDescriptor: (descriptor: number) => void;
  }) {
    this.#parentDescriptor = input.parentDescriptor;
    this.#fileDescriptor = input.fileDescriptor;
    this.#temporaryName = input.temporaryName;
    this.#targetName = input.targetName;
    this.#policy = input.policy;
    this.#onCleanupFailure = input.onCleanupFailure;
    this.#syncDirectoryDescriptor = input.syncDirectoryDescriptor;
  }

  /** Append one chunk without allowing declared-size overrun. */
  public async append(chunk: Uint8Array): Promise<void> {
    if (this.#closed) throw new Error("ARTIFACT_WRITER_CLOSED");
    const maximumBytes =
      this.#policy.kind === "EXPECTED"
        ? this.#policy.expectation.sizeBytes
        : this.#policy.maximumBytes;
    if (this.#sizeBytes + chunk.byteLength > maximumBytes) {
      const code =
        this.#policy.kind === "EXPECTED"
          ? "ARTIFACT_HASH_MISMATCH"
          : "WORK_PACKAGE_INPUT_TOO_LARGE";
      throw new Error(code);
    }
    try {
      await writeDescriptorAt(this.#fileDescriptor, chunk, this.#sizeBytes);
    } catch (error) {
      throw new Error("ARTIFACT_WRITE_FAILED", { cause: error });
    }
    this.#hash.update(chunk);
    this.#sizeBytes += chunk.byteLength;
  }

  /** Durably publish the target only when exact size and hash both match. */
  public async commit(): Promise<PublishedImmutableFile> {
    if (this.#closed) throw new Error("ARTIFACT_WRITER_CLOSED");
    const sha256 = this.#hash.digest("hex");
    const result: ImmutableFileExpectation = {
      path: this.#policy.kind === "EXPECTED" ? this.#policy.expectation.path : this.#policy.path,
      sha256,
      sizeBytes: this.#sizeBytes
    };
    if (
      this.#policy.kind === "EXPECTED" &&
      (result.sizeBytes !== this.#policy.expectation.sizeBytes ||
        result.sha256 !== this.#policy.expectation.sha256)
    ) {
      await this.abort();
      throw new Error("ARTIFACT_HASH_MISMATCH");
    }
    let linked = false;
    let publicationIdentity: ImmutableFilePublicationIdentity;
    try {
      fsyncNativeFileDescriptor(this.#fileDescriptor);
      closeNativeFileDescriptor(this.#fileDescriptor);
      this.#fileClosed = true;
      linkFileExclusiveAt(
        this.#parentDescriptor,
        this.#temporaryName,
        this.#parentDescriptor,
        this.#targetName
      );
      linked = true;
      const temporaryFacts = statAt(this.#parentDescriptor, this.#temporaryName);
      const targetFacts = statAt(this.#parentDescriptor, this.#targetName);
      if (
        temporaryFacts.kind !== "FILE" ||
        targetFacts.kind !== "FILE" ||
        !sameIdentity(temporaryFacts, targetFacts)
      ) {
        throw new Error("TEMP_CONTAINMENT_REJECTED");
      }
      publicationIdentity = {
        device: targetFacts.device,
        inode: targetFacts.inode
      };
      this.#syncDirectoryDescriptor(this.#parentDescriptor);
    } catch (error) {
      if (linked) {
        await cleanupLinkedTarget({
          parentDescriptor: this.#parentDescriptor,
          temporaryName: this.#temporaryName,
          targetName: this.#targetName,
          syncDirectoryDescriptor: this.#syncDirectoryDescriptor,
          onCleanupFailure: this.#onCleanupFailure
        });
      }
      await this.abort();
      if (!linked && errorCode(error) === "EEXIST") {
        throw new Error("ARTIFACT_ALREADY_COMMITTED", { cause: error });
      }
      throw new Error("ARTIFACT_WRITE_FAILED", { cause: error });
    }
    try {
      unlinkAt(this.#parentDescriptor, this.#temporaryName, "FILE");
      fsyncNativeFileDescriptor(this.#parentDescriptor);
    } catch {
      await reportCleanupFailure(this.#onCleanupFailure);
    }
    this.#closed = true;
    closeNativeFileDescriptor(this.#parentDescriptor);
    return { integrity: result, publicationIdentity };
  }

  /** Remove an unpublished temporary file and release retained descriptors. */
  public async abort(): Promise<void> {
    if (this.#closed) return;
    if (!this.#fileClosed) {
      closeNativeFileDescriptor(this.#fileDescriptor);
      this.#fileClosed = true;
    }
    try {
      const facts = statAt(this.#parentDescriptor, this.#temporaryName);
      if (facts.kind === "FILE") {
        unlinkAt(this.#parentDescriptor, this.#temporaryName, "FILE");
        fsyncNativeFileDescriptor(this.#parentDescriptor);
      } else {
        await reportCleanupFailure(this.#onCleanupFailure);
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT") await reportCleanupFailure(this.#onCleanupFailure);
    }
    this.#closed = true;
    closeNativeFileDescriptor(this.#parentDescriptor);
  }
}

/** Stable-descriptor Work Package file-system operations. */
export class SecureWorkPackageDirectory {
  readonly #rootDescriptor: number;
  readonly #options: SecureWorkPackageDirectoryOptions;
  #closed = false;

  private constructor(rootDescriptor: number, options: SecureWorkPackageDirectoryOptions) {
    this.#rootDescriptor = rootDescriptor;
    this.#options = options;
  }

  /** Canonicalize once, verify identity twice, then retain only the stable directory fd. */
  public static async open(
    path: string,
    options: SecureWorkPackageDirectoryOptions = {}
  ): Promise<SecureWorkPackageDirectory> {
    const descriptor = await openVerifiedDirectory(path, DIRECTORY_MODE);
    return new SecureWorkPackageDirectory(descriptor, options);
  }

  /** Adopt one already verified owner-only directory descriptor. */
  public static adoptOwnedDescriptor(
    descriptor: number,
    options: SecureWorkPackageDirectoryOptions = {}
  ): SecureWorkPackageDirectory {
    const facts = statNativeFileDescriptor(descriptor);
    if (facts.kind !== "DIRECTORY" || facts.mode !== DIRECTORY_MODE) {
      closeNativeFileDescriptor(descriptor);
      throw new Error("WORK_PACKAGE_PATH_INVALID");
    }
    return new SecureWorkPackageDirectory(descriptor, options);
  }

  /** Close the retained package root descriptor. */
  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    closeNativeFileDescriptor(this.#rootDescriptor);
  }

  /** Publish one immutable regular file and never replace an existing object. */
  public async writeImmutableFile(
    relativePath: string,
    value: Uint8Array,
    nonce: string
  ): Promise<void> {
    this.#requireOpen();
    this.#requireNonce(nonce);
    await this.#withParent(relativePath, true, async (parent, leaf) => {
      const temporary = this.#temporaryName(leaf, nonce);
      await this.#writeTemporary(parent, temporary, value);
      const syncDirectoryDescriptor =
        this.#options.syncDirectoryDescriptor ?? fsyncNativeFileDescriptor;
      let linked = false;
      try {
        linkFileExclusiveAt(parent, temporary, parent, leaf);
        linked = true;
        syncDirectoryDescriptor(parent);
      } catch (error) {
        if (linked) {
          await cleanupLinkedTarget({
            parentDescriptor: parent,
            temporaryName: temporary,
            targetName: leaf,
            syncDirectoryDescriptor,
            onCleanupFailure: this.#options.onCleanupFailure
          });
        }
        await this.#cleanupTemporary(parent, temporary, false);
        if (!linked && errorCode(error) === "EEXIST") {
          throw new Error("ARTIFACT_ALREADY_COMMITTED", { cause: error });
        }
        throw new Error("ARTIFACT_WRITE_FAILED", { cause: error });
      }
      await this.#cleanupTemporary(parent, temporary, true);
    });
  }

  /** Create a bounded streaming writer for one future immutable file. */
  public createImmutableFileWriter(
    expected: ImmutableFileExpectation,
    nonce: string
  ): Promise<ImmutableFileWriter> {
    this.#requireOpen();
    this.#requireNonce(nonce);
    if (
      !Number.isSafeInteger(expected.sizeBytes) ||
      expected.sizeBytes < 0 ||
      !/^[a-f0-9]{64}$/.test(expected.sha256)
    ) {
      throw new Error("ARTIFACT_EXPECTATION_INVALID");
    }
    return this.#createStreamWriter(expected.path, nonce, {
      kind: "EXPECTED",
      expectation: expected
    });
  }

  /** Create a bounded writer that returns integrity computed from streamed content. */
  public createComputedFileWriter(
    relativePath: string,
    maximumBytes: number,
    nonce: string
  ): Promise<ImmutableFileWriter> {
    this.#requireOpen();
    this.#requireNonce(nonce);
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
      throw new Error("WORK_PACKAGE_FILE_LIMIT_INVALID");
    }
    return this.#createStreamWriter(relativePath, nonce, {
      kind: "COMPUTED",
      path: relativePath,
      maximumBytes
    });
  }

  #createStreamWriter(
    relativePath: string,
    nonce: string,
    policy: ImmutableWriterPolicy
  ): Promise<ImmutableFileWriter> {
    return this.#withParent(relativePath, true, (parent, leaf) => {
      const retainedParent = duplicateNativeFileDescriptor(parent);
      const temporaryName = this.#temporaryName(leaf, nonce);
      try {
        const fileDescriptor = openFileAt(
          retainedParent,
          temporaryName,
          "CREATE_EXCLUSIVE",
          FILE_MODE
        );
        return new ImmutableFileWriter({
          parentDescriptor: retainedParent,
          fileDescriptor,
          temporaryName,
          targetName: leaf,
          policy,
          onCleanupFailure: this.#options.onCleanupFailure,
          syncDirectoryDescriptor:
            this.#options.syncDirectoryDescriptor ?? fsyncNativeFileDescriptor
        });
      } catch (error) {
        closeNativeFileDescriptor(retainedParent);
        throw error;
      }
    });
  }

  /** Atomically replace the one mutable state file after its complete temp is durable. */
  public async replaceMutableFile(
    relativePath: string,
    value: Uint8Array,
    nonce: string
  ): Promise<void> {
    this.#requireOpen();
    this.#requireNonce(nonce);
    await this.#withParent(relativePath, true, async (parent, leaf) => {
      const temporary = this.#temporaryName(leaf, nonce);
      await this.#writeTemporary(parent, temporary, value);
      try {
        renameReplaceAt(parent, temporary, parent, leaf);
        fsyncNativeFileDescriptor(parent);
      } catch (error) {
        await this.#cleanupTemporary(parent, temporary, false);
        throw new Error("ARTIFACT_WRITE_FAILED", { cause: error });
      }
    });
  }

  /** Read one owner-only, single-link regular file up to an explicit byte ceiling. */
  public async readFileBounded(relativePath: string, maximumBytes: number): Promise<Buffer> {
    this.#requireOpen();
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
      throw new Error("WORK_PACKAGE_FILE_LIMIT_INVALID");
    }
    return this.#withParent(relativePath, false, async (parent, leaf) => {
      let pathFacts: NativeEntryFacts;
      try {
        pathFacts = statAt(parent, leaf);
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          throw new Error("ARTIFACT_MISSING", { cause: error });
        }
        throw error;
      }
      this.#requireRegularFile(pathFacts);
      if (pathFacts.sizeBytes > maximumBytes) throw new Error("WORK_PACKAGE_FILE_TOO_LARGE");
      const descriptor = openFileAt(parent, leaf, "OPEN_READ", FILE_MODE);
      try {
        const opened = statNativeFileDescriptor(descriptor);
        if (!sameIdentity(pathFacts, opened)) throw new Error("WORK_PACKAGE_FILE_CHANGED");
        const value = await readDescriptor(descriptor, opened.sizeBytes);
        const after = statNativeFileDescriptor(descriptor);
        if (!sameIdentity(opened, after) || after.sizeBytes !== opened.sizeBytes) {
          throw new Error("WORK_PACKAGE_FILE_CHANGED");
        }
        return value;
      } finally {
        closeNativeFileDescriptor(descriptor);
      }
    });
  }

  /** Stream one validated regular file through a stable descriptor with bounded chunks. */
  public async *streamFile(
    relativePath: string,
    maximumBytes = Number.MAX_SAFE_INTEGER
  ): AsyncGenerator<Buffer> {
    this.#requireOpen();
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
      throw new Error("WORK_PACKAGE_FILE_LIMIT_INVALID");
    }
    const opened = await this.#openRegularFile(relativePath, maximumBytes);
    let offset = 0;
    try {
      while (offset < opened.facts.sizeBytes) {
        const remaining = opened.facts.sizeBytes - offset;
        const chunk = Buffer.alloc(Math.min(STREAM_CHUNK_BYTES, remaining));
        const count = await new Promise<number>((resolve, reject) => {
          read(opened.descriptor, chunk, 0, chunk.byteLength, offset, (error, bytesRead) => {
            if (error !== null) reject(error);
            else resolve(bytesRead);
          });
        });
        if (count === 0) throw new Error("WORK_PACKAGE_FILE_CHANGED");
        offset += count;
        yield count === chunk.byteLength ? chunk : chunk.subarray(0, count);
      }
      const after = statNativeFileDescriptor(opened.descriptor);
      if (!sameIdentity(opened.facts, after) || after.sizeBytes !== opened.facts.sizeBytes) {
        throw new Error("WORK_PACKAGE_FILE_CHANGED");
      }
    } finally {
      closeNativeFileDescriptor(opened.descriptor);
    }
  }

  /** Acquire the stable root lock and durably replace only its diagnostic content. */
  public async acquireLock(owner: WorkPackageLockOwner): Promise<WorkPackageLock> {
    this.#requireOpen();
    this.#validateOwner(owner);
    const descriptor = openFileAt(
      this.#rootDescriptor,
      LOCK_FILE_NAME,
      "CREATE_OR_OPEN",
      FILE_MODE
    );
    try {
      this.#requireLockFile(statNativeFileDescriptor(descriptor));
      if (!lockFileExclusiveNonblocking(descriptor)) throw new Error("WORK_PACKAGE_LOCKED");
      try {
        const bytes = Buffer.from(JSON.stringify(owner), "utf8");
        await truncateDescriptor(descriptor);
        await writeDescriptor(descriptor, bytes);
        fsyncNativeFileDescriptor(descriptor);
      } catch (error) {
        unlockFile(descriptor);
        throw error;
      }
      return new WorkPackageLock(descriptor);
    } catch (error) {
      closeNativeFileDescriptor(descriptor);
      throw error;
    }
  }

  /** Recursively remove one controlled tree without following any symbolic link. */
  public async removeTree(relativePath: string): Promise<void> {
    this.#requireOpen();
    await this.#withParent(relativePath, false, (parent, leaf) => {
      removeEntryTreeAt(parent, leaf);
      fsyncNativeFileDescriptor(parent);
    });
  }

  /** Remove one controlled regular file without following a symbolic link. */
  public async removeFile(relativePath: string): Promise<void> {
    this.#requireOpen();
    await this.#withParent(relativePath, false, (parent, leaf) => {
      const facts = statAt(parent, leaf);
      if (facts.kind !== "FILE") throw new Error("TEMP_CONTAINMENT_REJECTED");
      unlinkAt(parent, leaf, "FILE");
      fsyncNativeFileDescriptor(parent);
    });
  }

  /** Remove one regular file only while its complete descriptor identity still matches. */
  public async removeFileIfMatches(published: PublishedImmutableFile): Promise<boolean> {
    this.#requireOpen();
    const expectation = published.integrity;
    return await this.#withParent(expectation.path, false, async (parent, leaf) => {
      let pathFacts: NativeEntryFacts;
      try {
        pathFacts = statAt(parent, leaf);
      } catch (error) {
        if (errorCode(error) === "ENOENT") return true;
        throw error;
      }
      this.#requireRegularFile(pathFacts);
      if (
        pathFacts.device !== published.publicationIdentity.device ||
        pathFacts.inode !== published.publicationIdentity.inode
      ) {
        return false;
      }
      if (pathFacts.sizeBytes !== expectation.sizeBytes) return false;
      const descriptor = openFileAt(parent, leaf, "OPEN_READ", FILE_MODE);
      try {
        const opened = statNativeFileDescriptor(descriptor);
        if (!sameIdentity(pathFacts, opened) || opened.sizeBytes !== expectation.sizeBytes) {
          return false;
        }
        const hash = createHash("sha256");
        let offset = 0;
        while (offset < opened.sizeBytes) {
          const remaining = opened.sizeBytes - offset;
          const chunk = Buffer.alloc(Math.min(STREAM_CHUNK_BYTES, remaining));
          const count = await new Promise<number>((resolve, reject) => {
            read(descriptor, chunk, 0, chunk.byteLength, offset, (error, bytesRead) => {
              if (error !== null) reject(error);
              else resolve(bytesRead);
            });
          });
          if (count === 0) return false;
          offset += count;
          hash.update(count === chunk.byteLength ? chunk : chunk.subarray(0, count));
        }
        const afterRead = statNativeFileDescriptor(descriptor);
        const currentPath = statAt(parent, leaf);
        const unchanged =
          sameIdentity(opened, afterRead) &&
          afterRead.sizeBytes === opened.sizeBytes &&
          sameIdentity(opened, currentPath) &&
          currentPath.sizeBytes === opened.sizeBytes &&
          hash.digest("hex") === expectation.sha256;
        if (!unchanged) return false;
        unlinkAt(parent, leaf, "FILE");
        fsyncNativeFileDescriptor(parent);
        return true;
      } finally {
        closeNativeFileDescriptor(descriptor);
      }
    });
  }

  /** List the complete package tree without following symbolic links. */
  public listTree(): readonly SecureDirectoryEntry[] {
    this.#requireOpen();
    const entries: SecureDirectoryEntry[] = [];
    this.#collectEntries(this.#rootDescriptor, "", entries);
    return entries;
  }

  async #withParent<Result>(
    relativePath: string,
    create: boolean,
    operation: (parent: number, leaf: string) => Result | Promise<Result>
  ): Promise<Result> {
    const [parsed] = validateMaterializedFilePaths([relativePath]);
    if (parsed === undefined) throw new Error("WORK_PACKAGE_PATH_INVALID");
    const components = parsed.split("/");
    const leaf = components.pop();
    if (leaf === undefined) throw new Error("WORK_PACKAGE_PATH_INVALID");
    let current = this.#rootDescriptor;
    const opened: number[] = [];
    try {
      for (const component of components) {
        let child: number;
        try {
          child = openDirectoryAt(current, component);
        } catch (error) {
          if (!create || errorCode(error) !== "ENOENT") throw error;
          mkdirAt(current, component, DIRECTORY_MODE);
          fsyncNativeFileDescriptor(current);
          child = openDirectoryAt(current, component);
        }
        const facts = statNativeFileDescriptor(child);
        if (facts.kind !== "DIRECTORY" || facts.mode !== DIRECTORY_MODE) {
          closeNativeFileDescriptor(child);
          throw new Error("WORK_PACKAGE_PATH_INVALID");
        }
        opened.push(child);
        current = child;
      }
      return await operation(current, leaf);
    } finally {
      for (const descriptor of opened.reverse()) closeNativeFileDescriptor(descriptor);
    }
  }

  async #writeTemporary(parent: number, name: string, value: Uint8Array): Promise<void> {
    const descriptor = openFileAt(parent, name, "CREATE_EXCLUSIVE", FILE_MODE);
    try {
      await writeDescriptor(descriptor, value);
      fsyncNativeFileDescriptor(descriptor);
    } catch (error) {
      closeNativeFileDescriptor(descriptor);
      await this.#cleanupTemporary(parent, name, false);
      throw error;
    }
    closeNativeFileDescriptor(descriptor);
  }

  async #openRegularFile(
    relativePath: string,
    maximumBytes: number
  ): Promise<{ readonly descriptor: number; readonly facts: NativeEntryFacts }> {
    return this.#withParent(relativePath, false, (parent, leaf) => {
      let pathFacts: NativeEntryFacts;
      try {
        pathFacts = statAt(parent, leaf);
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          throw new Error("ARTIFACT_MISSING", { cause: error });
        }
        throw error;
      }
      this.#requireRegularFile(pathFacts);
      if (pathFacts.sizeBytes > maximumBytes) throw new Error("WORK_PACKAGE_FILE_TOO_LARGE");
      const descriptor = openFileAt(parent, leaf, "OPEN_READ", FILE_MODE);
      const opened = statNativeFileDescriptor(descriptor);
      if (!sameIdentity(pathFacts, opened) || opened.sizeBytes !== pathFacts.sizeBytes) {
        closeNativeFileDescriptor(descriptor);
        throw new Error("WORK_PACKAGE_FILE_CHANGED");
      }
      return { descriptor, facts: opened };
    });
  }

  async #cleanupTemporary(parent: number, name: string, afterCommit: boolean): Promise<void> {
    try {
      const facts = statAt(parent, name);
      if (facts.kind !== "FILE") throw new Error("TEMP_CONTAINMENT_REJECTED");
      unlinkAt(parent, name, "FILE");
      fsyncNativeFileDescriptor(parent);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      if (!afterCommit) return;
      await reportCleanupFailure(this.#options.onCleanupFailure);
    }
  }

  #collectEntries(parent: number, prefix: string, entries: SecureDirectoryEntry[]): void {
    for (const name of readDirectoryNames(parent)) {
      const facts = statAt(parent, name);
      const path = prefix.length === 0 ? name : `${prefix}/${name}`;
      entries.push({
        path,
        kind: facts.kind,
        mode: facts.mode,
        sizeBytes: facts.sizeBytes,
        linkCount: facts.linkCount
      });
      if (facts.kind !== "DIRECTORY") continue;
      const directory = openDirectoryAt(parent, name);
      try {
        this.#collectEntries(directory, path, entries);
      } finally {
        closeNativeFileDescriptor(directory);
      }
    }
  }

  #temporaryName(leaf: string, nonce: string): string {
    const value = `.${leaf}.cortex-tmp-${nonce}`;
    if (Buffer.byteLength(value, "utf8") > 255) throw new Error("WORK_PACKAGE_PATH_INVALID");
    return value;
  }

  #requireNonce(nonce: string): void {
    if (!NONCE_PATTERN.test(nonce)) throw new Error("WORK_PACKAGE_NONCE_INVALID");
  }

  #requireRegularFile(facts: NativeEntryFacts): void {
    if (facts.kind !== "FILE" || facts.mode !== FILE_MODE || facts.linkCount !== 1) {
      throw new Error("WORK_PACKAGE_FILE_INVALID");
    }
  }

  #requireLockFile(facts: NativeEntryFacts): void {
    if (facts.kind !== "FILE" || facts.mode !== FILE_MODE || facts.linkCount !== 1) {
      throw new Error("WORK_PACKAGE_LOCK_INVALID");
    }
  }

  #requireOpen(): void {
    if (this.#closed) throw new Error("WORK_PACKAGE_DIRECTORY_CLOSED");
  }

  #validateOwner(owner: WorkPackageLockOwner): void {
    if (
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      owner.processStartedAt.length === 0 ||
      owner.acquiredAt.length === 0 ||
      (owner.executionId !== null && owner.executionId.length === 0)
    ) {
      throw new Error("WORK_PACKAGE_LOCK_OWNER_INVALID");
    }
  }
}
