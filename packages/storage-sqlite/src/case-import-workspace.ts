import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/** No-shell process start-identity lookup. */
export interface ProcessLiveness {
  /** Return the process start identity or null when the PID is not live. */
  processStartedAt(pid: number): Promise<string | null>;
}

/** Strict temporary workspace owner identity. */
export interface CaseImportWorkspaceOwner {
  /** Owning process ID. */
  readonly pid: number;
  /** OS process start identity used to detect PID reuse. */
  readonly processStartedAt: string;
  /** Unpredictable ownership nonce. */
  readonly nonce: string;
}

/** One newly owned Case import workspace. */
export interface OwnedCaseImportWorkspace {
  /** Canonical workspace path below the temporary root. */
  readonly path: string;
  /** Strict owner fact persisted in the workspace. */
  readonly owner: CaseImportWorkspaceOwner;
}

/** Workspace manager construction options. */
export interface CaseImportWorkspaceManagerOptions {
  /** Trusted lexical/canonical containment root supplied by the composition root. */
  readonly containmentRoot: string;
  /** Controlled temporary root. */
  readonly temporaryRoot: string;
  /** Process identity adapter. */
  readonly processLiveness: ProcessLiveness;
  /** Current epoch milliseconds. */
  readonly now: () => number;
  /** Unpredictable nonce source. */
  readonly nonce: () => string;
  /** Current process ID. */
  readonly pid: number;
  /** Minimum age before a dead workspace is removable. */
  readonly ttlMs: number;
  /** Closed internal workspace family prefix. */
  readonly workspacePrefix?: "case-import-" | "case-export-" | "work-package-export-" | undefined;
  /** Optional safe internal security event sink. */
  readonly onSecurityEvent?: ((event: WorkspaceSecurityEvent) => void | Promise<void>) | undefined;
}

/** Safe internal workspace security event. */
export type WorkspaceSecurityEvent =
  | "TEMP_OWNER_INVALID"
  | "TEMP_SYMLINK_QUARANTINED"
  | "TEMP_OWNER_CHANGED"
  | "TEMP_CONTAINMENT_REJECTED"
  | "TEMP_CLEANUP_FAILED";

const WORKSPACE_PREFIX = "case-import-";
const OWNER_FILE = "owner.json";

// Parse an exact owner object and reject extra keys or ambiguous values.
function parseOwner(value: unknown): CaseImportWorkspaceOwner | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(source).sort();
  if (keys.join(",") !== "nonce,pid,processStartedAt") return null;
  if (!Number.isInteger(source.pid) || (source.pid as number) <= 0) return null;
  if (typeof source.processStartedAt !== "string" || source.processStartedAt.length === 0) {
    return null;
  }
  if (typeof source.nonce !== "string" || source.nonce.length === 0) return null;
  return {
    pid: source.pid as number,
    processStartedAt: source.processStartedAt,
    nonce: source.nonce
  };
}

// Read and strictly validate one owner file without surfacing its content.
async function readOwner(workspacePath: string): Promise<CaseImportWorkspaceOwner | null> {
  try {
    const text = await readFile(join(workspacePath, OWNER_FILE), "utf8");
    return parseOwner(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

// Compare all owner identity fields to close cleanup races.
function sameOwner(left: CaseImportWorkspaceOwner, right: CaseImportWorkspaceOwner): boolean {
  return (
    left.pid === right.pid &&
    left.processStartedAt === right.processStartedAt &&
    left.nonce === right.nonce
  );
}

// Confirm a canonical child stays strictly below its canonical root.
function isContained(root: string, child: string): boolean {
  const path = relative(root, child);
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

/** macOS process start lookup using `ps` without a shell. */
export class PsProcessLiveness implements ProcessLiveness {
  /** Read one exact process start identity with a bounded command timeout. */
  public processStartedAt(pid: number): Promise<string | null> {
    return new Promise((resolve) => {
      execFile(
        "/bin/ps",
        ["-o", "lstart=", "-p", String(pid)],
        { encoding: "utf8", timeout: 1_000, shell: false },
        (error, stdout) => {
          if (error !== null) {
            resolve(null);
            return;
          }
          const value = stdout.trim();
          resolve(value.length === 0 ? null : value);
        }
      );
    });
  }
}

/** Symlink-safe Case import workspace lifecycle manager. */
export class CaseImportWorkspaceManager {
  readonly #options: CaseImportWorkspaceManagerOptions;
  readonly #workspacePrefix: "case-import-" | "case-export-" | "work-package-export-";

  /** Create a manager over one controlled temporary root. */
  public constructor(options: CaseImportWorkspaceManagerOptions) {
    this.#options = options;
    this.#workspacePrefix = options.workspacePrefix ?? WORKSPACE_PREFIX;
  }

  /** Remove only old, dead, owner-stable workspaces and quarantine malformed entries. */
  public async cleanupStale(): Promise<void> {
    const root = await this.#ensureRoot();
    const entries = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.name.startsWith(this.#workspacePrefix))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const workspacePath = join(root, entry.name);
      const facts = await lstat(workspacePath).catch(() => null);
      if (facts === null) continue;
      if (facts.isSymbolicLink()) {
        await this.#quarantine(workspacePath, entry.name, "TEMP_SYMLINK_QUARANTINED");
        continue;
      }
      if (!facts.isDirectory()) {
        await this.#quarantine(workspacePath, entry.name, "TEMP_OWNER_INVALID");
        continue;
      }
      const originalOwner = await readOwner(workspacePath);
      if (originalOwner === null) {
        if (this.#options.now() - facts.mtimeMs < this.#options.ttlMs) continue;
        await this.#quarantine(workspacePath, entry.name, "TEMP_OWNER_INVALID");
        continue;
      }
      const liveStartedAt = await this.#options.processLiveness.processStartedAt(originalOwner.pid);
      if (liveStartedAt === originalOwner.processStartedAt) continue;
      if (this.#options.now() - facts.mtimeMs < this.#options.ttlMs) continue;
      const currentOwner = await readOwner(workspacePath);
      if (currentOwner === null || !sameOwner(currentOwner, originalOwner)) {
        await this.#emit("TEMP_OWNER_CHANGED");
        continue;
      }
      const currentFacts = await lstat(workspacePath).catch(() => null);
      if (currentFacts === null || !currentFacts.isDirectory() || currentFacts.isSymbolicLink()) {
        await this.#emit("TEMP_CONTAINMENT_REJECTED");
        continue;
      }
      const canonicalWorkspace = await realpath(workspacePath).catch(() => null);
      if (canonicalWorkspace === null || !isContained(root, canonicalWorkspace)) {
        await this.#emit("TEMP_CONTAINMENT_REJECTED");
        continue;
      }
      await rm(canonicalWorkspace, { recursive: true, force: true }).catch(async () => {
        await this.#emit("TEMP_CLEANUP_FAILED");
      });
    }
  }

  /** Create one owner-identified 0700 workspace after stale cleanup. */
  public async create(): Promise<OwnedCaseImportWorkspace> {
    const root = await this.#ensureRoot();
    await this.cleanupStale();
    const processStartedAt = await this.#options.processLiveness.processStartedAt(
      this.#options.pid
    );
    if (processStartedAt === null) throw new Error("PROCESS_IDENTITY_UNAVAILABLE");
    const workspacePath = await mkdtemp(join(root, this.#workspacePrefix));
    try {
      await chmod(workspacePath, 0o700);
      const owner: CaseImportWorkspaceOwner = {
        pid: this.#options.pid,
        processStartedAt,
        nonce: this.#options.nonce()
      };
      const ownerPath = join(workspacePath, OWNER_FILE);
      await writeFile(ownerPath, JSON.stringify(owner), { encoding: "utf8", mode: 0o600 });
      await chmod(ownerPath, 0o600);
      return { path: await realpath(workspacePath), owner };
    } catch (error) {
      await this.#cleanupIncomplete(workspacePath);
      throw error;
    }
  }

  /** Remove one active workspace only when its complete owner identity still matches. */
  public async cleanupOwned(workspace: OwnedCaseImportWorkspace): Promise<void> {
    const root = await this.#ensureRoot();
    const facts = await lstat(workspace.path).catch(() => null);
    if (facts === null) return;
    if (!facts.isDirectory() || facts.isSymbolicLink()) {
      await this.#emit("TEMP_CONTAINMENT_REJECTED");
      return;
    }
    const currentOwner = await readOwner(workspace.path);
    if (currentOwner === null || !sameOwner(currentOwner, workspace.owner)) {
      await this.#emit("TEMP_OWNER_CHANGED");
      return;
    }
    const canonicalWorkspace = await realpath(workspace.path).catch(() => null);
    if (canonicalWorkspace === null || !isContained(root, canonicalWorkspace)) {
      await this.#emit("TEMP_CONTAINMENT_REJECTED");
      return;
    }
    try {
      await rm(canonicalWorkspace, { recursive: true, force: true });
    } catch (error) {
      await this.#emit("TEMP_CLEANUP_FAILED");
      throw error;
    }
  }

  // Ensure the controlled temporary root exists with owner-only permissions.
  async #ensureRoot(): Promise<string> {
    const containmentPath = resolve(this.#options.containmentRoot);
    const temporaryPath = resolve(this.#options.temporaryRoot);
    if (
      !isAbsolute(this.#options.containmentRoot) ||
      !isAbsolute(this.#options.temporaryRoot) ||
      !isContained(containmentPath, temporaryPath)
    ) {
      return this.#rejectRoot();
    }
    const canonicalContainment = await realpath(containmentPath).catch(() => null);
    const parentPath = dirname(temporaryPath);
    const parentFacts = await lstat(parentPath).catch(() => null);
    if (
      canonicalContainment === null ||
      parentFacts === null ||
      !parentFacts.isDirectory() ||
      parentFacts.isSymbolicLink()
    ) {
      return this.#rejectRoot();
    }
    const canonicalParent = await realpath(parentPath).catch(() => null);
    if (
      canonicalParent === null ||
      (canonicalParent !== canonicalContainment &&
        !isContained(canonicalContainment, canonicalParent))
    ) {
      return this.#rejectRoot();
    }
    const before = await lstat(temporaryPath).catch(() => null);
    if (before === null) {
      await mkdir(temporaryPath, { mode: 0o700 }).catch((error: unknown): void => {
        const code =
          error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
        if (code !== "EEXIST") throw error;
      });
    }
    const facts = await lstat(temporaryPath).catch(() => null);
    const canonicalRoot = await realpath(temporaryPath).catch(() => null);
    if (
      facts === null ||
      !facts.isDirectory() ||
      facts.isSymbolicLink() ||
      canonicalRoot === null ||
      !isContained(canonicalContainment, canonicalRoot)
    ) {
      return this.#rejectRoot();
    }
    await chmod(canonicalRoot, 0o700);
    const currentFacts = await lstat(temporaryPath).catch(() => null);
    const currentRoot = await realpath(temporaryPath).catch(() => null);
    if (
      currentFacts === null ||
      !currentFacts.isDirectory() ||
      currentFacts.isSymbolicLink() ||
      currentRoot !== canonicalRoot
    ) {
      return this.#rejectRoot();
    }
    return canonicalRoot;
  }

  // Remove a partially initialized unique workspace only after fresh containment checks.
  async #cleanupIncomplete(workspacePath: string): Promise<void> {
    const facts = await lstat(workspacePath).catch(() => null);
    if (facts === null) return;
    if (!facts.isDirectory() || facts.isSymbolicLink()) {
      await this.#emit("TEMP_CONTAINMENT_REJECTED").catch(() => undefined);
      return;
    }
    const root = await this.#ensureRoot().catch(() => null);
    const canonicalWorkspace = await realpath(workspacePath).catch(() => null);
    if (root === null || canonicalWorkspace === null || !isContained(root, canonicalWorkspace)) {
      await this.#emit("TEMP_CONTAINMENT_REJECTED").catch(() => undefined);
      return;
    }
    await rm(canonicalWorkspace, { recursive: true, force: true }).catch(async () => {
      await this.#emit("TEMP_CLEANUP_FAILED").catch(() => undefined);
    });
  }

  // Rename a malformed entry inside the same root without following it.
  async #quarantine(
    workspacePath: string,
    name: string,
    event: WorkspaceSecurityEvent
  ): Promise<void> {
    const target = join(dirname(workspacePath), `quarantine-${name}-${this.#options.nonce()}`);
    await rename(workspacePath, target).catch(() => undefined);
    await this.#emit(event);
  }

  // Emit only a safe event code; presentation text belongs to the logging boundary.
  async #emit(event: WorkspaceSecurityEvent): Promise<void> {
    await this.#options.onSecurityEvent?.(event);
  }

  // Reject an untrusted root before any scan or permission mutation can follow it.
  async #rejectRoot(): Promise<never> {
    await this.#emit("TEMP_CONTAINMENT_REJECTED").catch(() => undefined);
    throw new Error("TEMP_ROOT_INVALID");
  }
}
