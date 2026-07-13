import { chmod, lstat, mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { Migrator } from "kysely/migration";

import { CortexMigrationProvider } from "./sqlite-initial-migration.ts";
import { SqliteTransactionManager } from "./sqlite-application-repositories.ts";
import {
  SqliteCaseImportStagingFactory,
  type SqliteCaseImportStagingFactoryOptions
} from "./sqlite-case-import-staging.ts";
import type { WorkspaceSecurityEvent } from "./case-import-workspace.ts";
import type { SqliteDatabaseSchema } from "./sqlite-schema.ts";

/** Exact current business table allowlist. */
export const BUSINESS_TABLES = [
  "case_analysis",
  "case_analysis_prompt",
  "case_result",
  "endpoint_config",
  "eval_result",
  "llm_config",
  "llm_rubric_prompt",
  "run_log",
  "test_case",
  "test_suite"
] as const;

/** Connection PRAGMA facts used by Runtime Doctor and tests. */
export interface SqliteConnectionPragmas {
  /** Whether SQLite enforces foreign keys on this connection. */
  readonly foreignKeys: boolean;
  /** Active journal mode. */
  readonly journalMode: string;
  /** Busy wait in milliseconds. */
  readonly busyTimeoutMs: number;
  /** Controlled synchronous mode. */
  readonly synchronous: string;
}

/** Storage initialization options supplied by the composition root. */
export interface SqliteStorageOptions {
  /** Absolute project root resolved outside Storage. */
  readonly projectRoot: string;
}

/** Stable SQLite initialization failure. */
export class SqliteInitializationError extends Error {
  /** Stable machine-readable error code. */
  public readonly code: "SQLITE_PROJECT_ROOT_INVALID" | "SQLITE_INITIALIZATION_FAILED";

  /** Create one initialization failure without exposing a local path. */
  public constructor(
    code: "SQLITE_PROJECT_ROOT_INVALID" | "SQLITE_INITIALIZATION_FAILED",
    options?: ErrorOptions
  ) {
    super(code, options);
    this.name = "SqliteInitializationError";
    this.code = code;
  }
}

/** Open migrated SQLite storage owned by one composition root. */
export class SqliteStorage {
  /** Absolute database file path. */
  public readonly databasePath: string;
  readonly #database: Kysely<SqliteDatabaseSchema>;
  readonly #nativeDatabase: Database.Database;
  readonly #projectRoot: string;
  #closed = false;

  /** Constructed only after connection policy and migrations succeed. */
  public constructor(
    databasePath: string,
    database: Kysely<SqliteDatabaseSchema>,
    nativeDatabase: Database.Database,
    projectRoot: string
  ) {
    this.databasePath = databasePath;
    this.#database = database;
    this.#nativeDatabase = nativeDatabase;
    this.#projectRoot = projectRoot;
  }

  /** Read controlled connection facts without exposing the native handle. */
  public inspectConnectionPragmas(): Promise<SqliteConnectionPragmas> {
    const foreignKeys = readPragmaNumber(this.#nativeDatabase, "foreign_keys") === 1;
    const journalMode = readPragmaString(this.#nativeDatabase, "journal_mode");
    const busyTimeoutMs = readPragmaNumber(this.#nativeDatabase, "busy_timeout");
    const synchronousValue = readPragmaNumber(this.#nativeDatabase, "synchronous");
    const synchronous = synchronousValue === 2 ? "full" : String(synchronousValue);
    return Promise.resolve({ foreignKeys, journalMode, busyTimeoutMs, synchronous });
  }

  /** Create the Application short-transaction boundary for this connection. */
  public createTransactionManager(): SqliteTransactionManager {
    return new SqliteTransactionManager(this.#database);
  }

  /** Create isolated external Case import staging sessions for this storage. */
  public createCaseImportStagingFactory(
    onSecurityEvent?: (event: WorkspaceSecurityEvent) => void | Promise<void>,
    options: Pick<SqliteCaseImportStagingFactoryOptions, "initializeWriter"> = {}
  ): SqliteCaseImportStagingFactory {
    return new SqliteCaseImportStagingFactory(this.#database, this.#projectRoot, {
      ...options,
      onSecurityEvent
    });
  }

  /** Close the Kysely driver and native database exactly once. */
  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#database.destroy();
  }
}

/** Resolve the fixed default database below an explicit absolute project root. */
export function resolveDefaultDatabasePath(projectRoot: string): string {
  if (!isAbsolute(projectRoot)) throw new SqliteInitializationError("SQLITE_PROJECT_ROOT_INVALID");
  return join(projectRoot, ".cortex-eval", "db", "cortex-eval.sqlite3");
}

// Confirm one canonical child stays strictly below its canonical containment root.
function isContained(root: string, child: string): boolean {
  const path = relative(root, child);
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

// Return only a filesystem error code without trusting other thrown fields.
function filesystemErrorCode(error: unknown): unknown {
  return error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
}

// Create or validate one real directory before any permission mutation can follow a symlink.
async function ensureContainedDirectory(
  canonicalContainmentRoot: string,
  directoryPath: string
): Promise<string> {
  const before = await lstat(directoryPath).catch(() => null);
  if (before === null) {
    await mkdir(directoryPath, { mode: 0o700 }).catch((error: unknown): void => {
      if (filesystemErrorCode(error) !== "EEXIST") throw error;
    });
  }
  const facts = await lstat(directoryPath).catch(() => null);
  const canonicalPath = await realpath(directoryPath).catch(() => null);
  if (
    facts === null ||
    !facts.isDirectory() ||
    facts.isSymbolicLink() ||
    canonicalPath === null ||
    !isContained(canonicalContainmentRoot, canonicalPath)
  ) {
    throw new SqliteInitializationError("SQLITE_INITIALIZATION_FAILED");
  }
  await chmod(canonicalPath, 0o700);
  const currentFacts = await lstat(directoryPath).catch(() => null);
  const currentPath = await realpath(directoryPath).catch(() => null);
  if (
    currentFacts === null ||
    !currentFacts.isDirectory() ||
    currentFacts.isSymbolicLink() ||
    currentPath !== canonicalPath
  ) {
    throw new SqliteInitializationError("SQLITE_INITIALIZATION_FAILED");
  }
  return canonicalPath;
}

// Read one scalar numeric PRAGMA from the already-configured native connection.
function readPragmaNumber(database: Database.Database, name: string): number {
  const row: unknown = database.pragma(name, { simple: true });
  if (typeof row !== "number") throw new SqliteInitializationError("SQLITE_INITIALIZATION_FAILED");
  return row;
}

// Read one scalar string PRAGMA from the already-configured native connection.
function readPragmaString(database: Database.Database, name: string): string {
  const row: unknown = database.pragma(name, { simple: true });
  if (typeof row !== "string") throw new SqliteInitializationError("SQLITE_INITIALIZATION_FAILED");
  return row.toLowerCase();
}

// Restrict an existing file when present without treating absence as a failure.
async function restrictExistingFile(path: string): Promise<void> {
  const file = await lstat(path).catch(() => null);
  if (file === null) return;
  if (!file.isFile() || file.isSymbolicLink()) {
    throw new SqliteInitializationError("SQLITE_INITIALIZATION_FAILED");
  }
  await chmod(path, 0o600);
}

// Apply connection-local policy before Kysely can execute any query.
function configureConnection(database: Database.Database): void {
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  database.pragma("synchronous = FULL");
  database.pragma("journal_mode = WAL");
}

/** Create directories, initialize one policy-compliant connection and migrate it. */
export async function initializeSqliteStorage(
  options: SqliteStorageOptions
): Promise<SqliteStorage> {
  const databasePath = resolveDefaultDatabasePath(options.projectRoot);
  const stateDirectory = join(options.projectRoot, ".cortex-eval");
  const databaseDirectory = join(stateDirectory, "db");
  let nativeDatabase: Database.Database | null = null;
  let database: Kysely<SqliteDatabaseSchema> | null = null;
  try {
    const canonicalProjectRoot = await realpath(options.projectRoot);
    const projectFacts = await stat(canonicalProjectRoot);
    if (!projectFacts.isDirectory()) {
      throw new SqliteInitializationError("SQLITE_INITIALIZATION_FAILED");
    }
    const canonicalStateDirectory = await ensureContainedDirectory(
      canonicalProjectRoot,
      stateDirectory
    );
    await ensureContainedDirectory(canonicalStateDirectory, databaseDirectory);
    await restrictExistingFile(databasePath);
    await restrictExistingFile(`${databasePath}-wal`);
    await restrictExistingFile(`${databasePath}-shm`);
    nativeDatabase = new Database(databasePath);
    await chmod(databasePath, 0o600);
    configureConnection(nativeDatabase);
    database = new Kysely<SqliteDatabaseSchema>({
      dialect: new SqliteDialect({ database: nativeDatabase })
    });
    const migrator = new Migrator({ db: database, provider: new CortexMigrationProvider() });
    const result = await migrator.migrateToLatest();
    if (result.error !== undefined) {
      if (result.error instanceof Error) throw result.error;
      throw new SqliteInitializationError("SQLITE_INITIALIZATION_FAILED");
    }
    await restrictExistingFile(`${databasePath}-wal`);
    await restrictExistingFile(`${databasePath}-shm`);
    return new SqliteStorage(databasePath, database, nativeDatabase, options.projectRoot);
  } catch (error) {
    if (database !== null) await database.destroy().catch(() => undefined);
    else if (nativeDatabase !== null) nativeDatabase.close();
    if (error instanceof SqliteInitializationError) throw error;
    throw new SqliteInitializationError("SQLITE_INITIALIZATION_FAILED", { cause: error });
  }
}
