import type {
  ApplicationTransaction,
  TransactionManager
} from "@cortex-eval/application/src/application-ports.ts";
import type { Kysely } from "kysely";

import {
  SqliteConfigurationRepository,
  SqliteRunReferenceRepository,
  SqliteTestSuiteRepository
} from "./sqlite-application-repositories.ts";
import type { SqliteDatabaseSchema } from "./sqlite-schema.ts";

/** Kysely managed transaction exposing only transaction-bound repositories. */
export class SqliteTransactionManager implements TransactionManager {
  readonly #database: Kysely<SqliteDatabaseSchema>;

  /** Bind the manager to one configured Kysely connection. */
  public constructor(database: Kysely<SqliteDatabaseSchema>) {
    this.#database = database;
  }

  /** Execute database-only work and restart only SQLite Busy short transactions. */
  public async execute<T>(work: (transaction: ApplicationTransaction) => Promise<T>): Promise<T> {
    const maximumAttempts = 4;
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      try {
        return await this.#database.transaction().execute(async (database) =>
          work({
            testSuites: new SqliteTestSuiteRepository(database),
            configurations: new SqliteConfigurationRepository(database),
            runs: new SqliteRunReferenceRepository(database)
          })
        );
      } catch (error) {
        if (!isSqliteBusy(error)) throw error;
        if (attempt === maximumAttempts) throw new SqliteTransactionConflictError();
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    throw new SqliteTransactionConflictError();
  }
}

/** Stable storage conflict after bounded SQLite Busy transaction restarts. */
export class SqliteTransactionConflictError extends Error {
  /** Stable machine-readable error code. */
  public readonly code = "STORAGE_TRANSACTION_CONFLICT" as const;

  /** Create one path-safe transaction conflict. */
  public constructor() {
    super("STORAGE_TRANSACTION_CONFLICT");
    this.name = "SqliteTransactionConflictError";
  }
}

// Recognize only SQLite lock conflicts; all other failures propagate unchanged.
function isSqliteBusy(error: unknown): boolean {
  if (error === null || typeof error !== "object" || !("code" in error)) return false;
  const code = error.code;
  return code === "SQLITE_BUSY" || code === "SQLITE_BUSY_SNAPSHOT";
}
