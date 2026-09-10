import { chmod, realpath } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type {
  ApplicationTransaction,
  CaseImportImpact,
  CaseImportStagingFactory,
  CaseImportStagingSession,
  StagedCaseRepository
} from "@cortex-eval/application/src/application-ports.ts";
import type { StoredTestCase } from "@cortex-eval/application/src/features/test-suites/test-suite-models.ts";
import { canonicalJson } from "@cortex-eval/domain/src/domain-canonical-hash.ts";
import Database from "better-sqlite3";
import { sql, type Kysely } from "kysely";

import {
  SqliteConfigurationRepository,
  SqliteRunReferenceRepository,
  SqliteTestSuiteRepository
} from "./sqlite-application-repositories.ts";
import type { SqliteDatabaseSchema } from "./sqlite-schema.ts";
import { SqliteTransactionConflictError } from "./sqlite-transaction-manager.ts";
import {
  CaseImportWorkspaceManager,
  PsProcessLiveness,
  type OwnedCaseImportWorkspace,
  type WorkspaceSecurityEvent
} from "./case-import-workspace.ts";

const STAGING_SCHEMA = `
CREATE TABLE staged_case (
  id TEXT PRIMARY KEY,
  case_key TEXT NOT NULL UNIQUE,
  ordinal INTEGER NOT NULL UNIQUE,
  description TEXT NOT NULL,
  business_module TEXT NOT NULL,
  scenario_tag TEXT NOT NULL,
  assertion_types_json TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  rubric_prompt_keys_json TEXT NOT NULL,
  definition_hash TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT
`;

// Configure one newly opened external staging database before it can escape the factory.
function initializeStagingWriter(writer: Database.Database): void {
  writer.pragma("journal_mode = OFF");
  writer.pragma("synchronous = OFF");
  writer.pragma("temp_store = MEMORY");
  writer.exec(STAGING_SCHEMA);
}

// Recognize only SQLite lock conflicts for bounded transaction restart.
function isSqliteBusy(error: unknown): boolean {
  if (error === null || typeof error !== "object" || !("code" in error)) return false;
  return error.code === "SQLITE_BUSY" || error.code === "SQLITE_BUSY_SNAPSHOT";
}

// Return the exact staged table insert values without retaining caller objects.
function stagedValues(value: StoredTestCase): readonly unknown[] {
  return [
    value.id,
    value.caseKey,
    value.ordinal,
    value.description,
    value.businessModule,
    value.scenarioTag,
    canonicalJson([...value.assertionTypes]),
    canonicalJson([...value.metrics]),
    canonicalJson(value.definitionJson),
    canonicalJson([...value.rubricPromptKeys]),
    value.definitionHash,
    value.revision,
    value.createdAt,
    value.updatedAt
  ];
}

/** ATTACH-bound staged Case operations on one leased main connection. */
class SqliteStagedCaseRepository implements StagedCaseRepository {
  readonly #database: Kysely<SqliteDatabaseSchema>;

  /** Bind staged operations to the leased main connection. */
  public constructor(database: Kysely<SqliteDatabaseSchema>) {
    this.#database = database;
  }

  /** Return the first missing current Rubric Prompt key in input order. */
  public async findFirstMissingRubricPrompt(): Promise<{
    readonly index: number;
    readonly caseKey: string;
    readonly promptKey: string;
  } | null> {
    const result = await sql<{
      readonly ordinal: number;
      readonly case_key: string;
      readonly prompt_key: string;
    }>`
      SELECT staged.ordinal, staged.case_key, json_each.value AS prompt_key
      FROM case_import_stage.staged_case AS staged,
           json_each(staged.rubric_prompt_keys_json)
      LEFT JOIN llm_rubric_prompt ON llm_rubric_prompt.prompt_key = json_each.value
      WHERE llm_rubric_prompt.id IS NULL
      ORDER BY staged.ordinal, json_each.value
      LIMIT 1
    `.execute(this.#database);
    const row = result.rows[0];
    return row === undefined
      ? null
      : { index: row.ordinal, caseKey: row.case_key, promptKey: row.prompt_key };
  }

  /** SQL aggregates preserve bounded memory for large imports. */
  public async compareCases(suiteId: string): Promise<CaseImportImpact> {
    const result = await sql<CaseImportImpact>`
      SELECT
        COALESCE(SUM(CASE WHEN current.id IS NULL THEN 1 ELSE 0 END), 0) AS added,
        COALESCE(SUM(CASE WHEN current.id IS NOT NULL AND current.definition_hash != staged.definition_hash THEN 1 ELSE 0 END), 0) AS modified,
        COALESCE(SUM(CASE WHEN current.definition_hash = staged.definition_hash THEN 1 ELSE 0 END), 0) AS unchanged,
        COALESCE(SUM(CASE WHEN current.id IS NOT NULL AND current.ordinal != staged.ordinal THEN 1 ELSE 0 END), 0) AS reordered,
        (SELECT COUNT(*) FROM test_case AS old WHERE old.suite_id = ${suiteId}
          AND NOT EXISTS (SELECT 1 FROM case_import_stage.staged_case AS incoming WHERE incoming.case_key = old.case_key)) AS removed
      FROM case_import_stage.staged_case AS staged
      LEFT JOIN test_case AS current ON current.suite_id = ${suiteId} AND current.case_key = staged.case_key
    `.execute(this.#database);
    const row = result.rows[0];
    if (!row) throw new Error("CASE_IMPORT_COMPARISON_FAILED");
    return row;
  }

  /** Delete current Cases and bulk-copy the staged projection in Ordinal order. */
  public async replaceCases(suiteId: string): Promise<void> {
    await sql`DELETE FROM test_case WHERE suite_id = ${suiteId}`.execute(this.#database);
    await sql`
      INSERT INTO test_case (
        id, suite_id, case_key, ordinal, description, business_module, scenario_tag,
        assertion_types_json, metrics_json, definition_json, rubric_prompt_keys_json,
        definition_hash, revision, created_at, updated_at
      )
      SELECT
        id, ${suiteId}, case_key, ordinal, description, business_module, scenario_tag,
        assertion_types_json, metrics_json, definition_json, rubric_prompt_keys_json,
        definition_hash, revision, created_at, updated_at
      FROM case_import_stage.staged_case
      ORDER BY ordinal
    `.execute(this.#database);
  }
}

/** One isolated external SQLite staging workspace. */
class SqliteCaseImportStagingSession implements CaseImportStagingSession {
  readonly #mainDatabase: Kysely<SqliteDatabaseSchema>;
  readonly #workspace: OwnedCaseImportWorkspace;
  readonly #workspaceManager: CaseImportWorkspaceManager;
  readonly #databasePath: string;
  #writer: Database.Database | null;

  /** Bind one owned workspace, writer and main database. */
  public constructor(
    mainDatabase: Kysely<SqliteDatabaseSchema>,
    workspace: OwnedCaseImportWorkspace,
    workspaceManager: CaseImportWorkspaceManager,
    databasePath: string,
    writer: Database.Database
  ) {
    this.#mainDatabase = mainDatabase;
    this.#workspace = workspace;
    this.#workspaceManager = workspaceManager;
    this.#databasePath = databasePath;
    this.#writer = writer;
  }

  /** Persist one prepared Case and classify only the expected duplicate key. */
  public stage(value: StoredTestCase): Promise<"STAGED" | "CASE_ID_DUPLICATE"> {
    const writer = this.#writer;
    if (writer === null) throw new Error("CASE_IMPORT_STAGING_CLOSED");
    try {
      writer
        .prepare(
          `INSERT INTO staged_case (
            id, case_key, ordinal, description, business_module, scenario_tag,
            assertion_types_json, metrics_json, definition_json, rubric_prompt_keys_json,
            definition_hash, revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(...stagedValues(value));
      return Promise.resolve("STAGED");
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "SQLITE_CONSTRAINT_UNIQUE"
      ) {
        return Promise.resolve("CASE_ID_DUPLICATE");
      }
      throw error;
    }
  }

  /** Attach this closed staging file read-only and run one managed main transaction. */
  public async withStagedTransaction<T>(
    work: (transaction: ApplicationTransaction, stagedCases: StagedCaseRepository) => Promise<T>
  ): Promise<T> {
    this.#closeWriter();
    const canonicalDatabasePath = await realpath(this.#databasePath);
    await chmod(canonicalDatabasePath, 0o400);
    return this.#mainDatabase.connection().execute<T>(async (database): Promise<T> => {
      await sql`ATTACH DATABASE ${canonicalDatabasePath} AS case_import_stage`.execute(database);
      let transactionResult:
        { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: Error } = {
        ok: false,
        error: new SqliteTransactionConflictError()
      };
      try {
        for (let attempt = 1; attempt <= 4; attempt += 1) {
          let began = false;
          try {
            await sql.raw("BEGIN IMMEDIATE").execute(database);
            began = true;
            const result = await work(
              {
                testSuites: new SqliteTestSuiteRepository(database),
                configurations: new SqliteConfigurationRepository(database),
                runs: new SqliteRunReferenceRepository(database)
              },
              new SqliteStagedCaseRepository(database)
            );
            await sql.raw("COMMIT").execute(database);
            transactionResult = { ok: true, value: result };
            break;
          } catch (error) {
            if (began)
              await sql
                .raw("ROLLBACK")
                .execute(database)
                .catch(() => undefined);
            if (!isSqliteBusy(error)) throw error;
            if (attempt === 4) throw new SqliteTransactionConflictError();
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
        }
      } catch (error) {
        transactionResult = {
          ok: false,
          error:
            error instanceof Error
              ? error
              : new Error("CASE_IMPORT_TRANSACTION_FAILED", { cause: error })
        };
      }

      let detachError: Error | undefined;
      try {
        await sql.raw("DETACH DATABASE case_import_stage").execute(database);
        const attached = await sql<{ readonly name: string }>`PRAGMA database_list`.execute(
          database
        );
        if (attached.rows.some((row) => row.name === "case_import_stage")) {
          throw new Error("CASE_IMPORT_STAGING_DETACH_FAILED");
        }
      } catch (error) {
        detachError =
          error instanceof Error
            ? error
            : new Error("CASE_IMPORT_STAGING_DETACH_FAILED", { cause: error });
      }

      if (!transactionResult.ok) {
        if (detachError !== undefined) {
          throw new AggregateError(
            [transactionResult.error, detachError],
            "CASE_IMPORT_TRANSACTION_AND_DETACH_FAILED"
          );
        }
        throw transactionResult.error;
      }
      if (detachError !== undefined) throw detachError;
      return transactionResult.value;
    });
  }

  /** Close handles and delete only the workspace whose owner nonce still matches. */
  public async cleanup(): Promise<void> {
    this.#closeWriter();
    await this.#workspaceManager.cleanupOwned(this.#workspace);
  }

  // Close the synchronous staging writer exactly once.
  #closeWriter(): void {
    if (this.#writer === null) return;
    this.#writer.close();
    this.#writer = null;
  }
}

/** External Case staging factory options. */
export interface SqliteCaseImportStagingFactoryOptions {
  /** Explicit workspace manager used by focused storage tests. */
  readonly workspaceManager?: CaseImportWorkspaceManager | undefined;
  /** Safe workspace event sink supplied by the composition root. */
  readonly onSecurityEvent?: ((event: WorkspaceSecurityEvent) => void | Promise<void>) | undefined;
  /** Explicit writer initialization boundary used by failure-path tests. */
  readonly initializeWriter?: ((writer: Database.Database) => void) | undefined;
}

/** Factory for external Case import SQLite workspaces. */
export class SqliteCaseImportStagingFactory implements CaseImportStagingFactory {
  readonly #mainDatabase: Kysely<SqliteDatabaseSchema>;
  readonly #workspaceManager: CaseImportWorkspaceManager;
  readonly #initializeWriter: (writer: Database.Database) => void;

  /** Bind staging creation to one main database and absolute project root. */
  public constructor(
    mainDatabase: Kysely<SqliteDatabaseSchema>,
    projectRoot: string,
    options: SqliteCaseImportStagingFactoryOptions = {}
  ) {
    this.#mainDatabase = mainDatabase;
    this.#initializeWriter = options.initializeWriter ?? initializeStagingWriter;
    this.#workspaceManager =
      options.workspaceManager ??
      new CaseImportWorkspaceManager({
        containmentRoot: projectRoot,
        temporaryRoot: join(projectRoot, ".cortex-eval", "tmp"),
        processLiveness: new PsProcessLiveness(),
        now: Date.now,
        nonce: randomUUID,
        pid: process.pid,
        ttlMs: 24 * 60 * 60 * 1000,
        onSecurityEvent: options.onSecurityEvent
      });
  }

  /** Create one 0700 workspace and 0600 journal-free staging database. */
  public async open(): Promise<CaseImportStagingSession> {
    const workspace = await this.#workspaceManager.create();
    const databasePath = join(workspace.path, "cases.sqlite3");
    let writer: Database.Database | null = null;
    try {
      writer = new Database(databasePath);
      await chmod(databasePath, 0o600);
      this.#initializeWriter(writer);
      return new SqliteCaseImportStagingSession(
        this.#mainDatabase,
        workspace,
        this.#workspaceManager,
        databasePath,
        writer
      );
    } catch (error) {
      if (writer !== null) {
        try {
          writer.close();
        } catch {
          // Workspace cleanup remains the final best-effort resource boundary.
        }
      }
      await this.#workspaceManager.cleanupOwned(workspace).catch(() => undefined);
      throw error;
    }
  }

  /** Run the owner-aware stale cleanup during Local Server startup. */
  public cleanupStale(): Promise<void> {
    return this.#workspaceManager.cleanupStale();
  }
}
