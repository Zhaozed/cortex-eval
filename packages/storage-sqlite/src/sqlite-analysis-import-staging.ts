import { chmod, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type {
  AnalysisImportStagingFactory,
  AnalysisImportStagingSession,
  CaseAnalysisTransaction,
  StagedAnalysisRepository
} from "@cortex-eval/application/src/features/case-analysis/case-analysis-ports.ts";
import type {
  ReconcileStagedAnalysisInput,
  StagedImportedAnalysisCase
} from "@cortex-eval/application/src/features/case-analysis/case-analysis-models.ts";
import { analysisProposalJson } from "@cortex-eval/domain/src/domain-analysis-projection.ts";
import { canonicalJson } from "@cortex-eval/domain/src/domain-canonical-hash.ts";
import Database from "better-sqlite3";
import { sql, type Kysely } from "kysely";

import {
  CaseImportWorkspaceManager,
  PsProcessLiveness,
  type OwnedCaseImportWorkspace,
  type WorkspaceSecurityEvent
} from "./case-import-workspace.ts";
import {
  serializeAnalysisPromptSnapshot,
  serializeAnalyzerSnapshot
} from "./sqlite-case-analysis-mappers.ts";
import { SqliteCaseAnalysisRepository } from "./sqlite-case-analysis-repository.ts";
import {
  SqliteConfigurationRepository,
  SqliteRunReferenceRepository,
  SqliteTestSuiteRepository
} from "./sqlite-application-repositories.ts";
import type { SqliteDatabaseSchema } from "./sqlite-schema.ts";
import { SqliteTransactionConflictError } from "./sqlite-transaction-manager.ts";

const STAGING_SCHEMA = `
CREATE TABLE staged_analysis (
  id TEXT PRIMARY KEY,
  case_key TEXT NOT NULL UNIQUE,
  final_case_result_hash TEXT NOT NULL,
  analysis_input_hash TEXT NOT NULL,
  analysis_result_hash TEXT NOT NULL,
  analysis_status TEXT NOT NULL CHECK (analysis_status IN ('SUCCEEDED', 'ERROR')),
  classification TEXT,
  confidence REAL,
  evidence_json TEXT,
  explanation TEXT,
  recommended_action TEXT,
  proposal_json TEXT,
  base_definition_hash TEXT,
  error_code TEXT,
  error_message TEXT
) STRICT
`;

// Configure one isolated staging writer before it can receive cleaned rows.
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

// Serialize one already-cleaned terminal Case into staging columns.
function stagedValues(value: StagedImportedAnalysisCase): readonly unknown[] {
  if (value.status === "ERROR") {
    return [
      value.id,
      value.caseKey,
      value.finalCaseResultHash,
      value.analysisInputHash,
      value.analysisResultHash,
      value.status,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      value.errorCode,
      value.errorMessage
    ];
  }
  const proposal = value.output.proposal;
  return [
    value.id,
    value.caseKey,
    value.finalCaseResultHash,
    value.analysisInputHash,
    value.analysisResultHash,
    value.status,
    value.output.classification,
    value.output.confidence,
    canonicalJson(value.output.evidence.map((item) => ({ ...item }))),
    value.output.explanation,
    value.output.recommendedAction,
    proposal === undefined ? null : canonicalJson(analysisProposalJson(proposal)),
    proposal?.baseDefinitionHash ?? null,
    null,
    null
  ];
}

/** ATTACH-bound deterministic Analysis reconciliation operations. */
class SqliteStagedAnalysisRepository implements StagedAnalysisRepository {
  readonly #database: Kysely<SqliteDatabaseSchema>;

  /** Bind staged operations to one leased main connection. */
  public constructor(database: Kysely<SqliteDatabaseSchema>) {
    this.#database = database;
  }

  /** Verify dependencies and bulk-upsert all non-idempotent current Analysis rows. */
  public async reconcileCurrent(
    input: ReconcileStagedAnalysisInput
  ): Promise<{ readonly ok: true; readonly importedCount: number } | { readonly ok: false }> {
    const invalid = await sql<{ readonly case_key: string }>`
      SELECT staged.case_key
      FROM analysis_import_stage.staged_analysis AS staged
      LEFT JOIN eval_result AS evaluation
        ON evaluation.run_id = ${input.runId}
       AND evaluation.case_key = staged.case_key
      LEFT JOIN case_analysis AS current
        ON current.run_id = ${input.runId}
       AND current.case_key = staged.case_key
      WHERE evaluation.case_key IS NULL
         OR evaluation.eval_status NOT IN ('FAIL', 'EVALUATION_ERROR')
         OR evaluation.final_case_result_hash <> staged.final_case_result_hash
         OR (
           current.analysis_input_hash = staged.analysis_input_hash
           AND (
             current.analysis_result_hash IS NULL
             OR current.analysis_result_hash <> staged.analysis_result_hash
           )
         )
         OR (
           current.analysis_status = 'RUNNING'
           AND current.analysis_input_hash <> staged.analysis_input_hash
         )
      LIMIT 1
    `.execute(this.#database);
    if (invalid.rows[0] !== undefined) return { ok: false };

    const countResult = await sql<{ readonly imported_count: number }>`
      SELECT COUNT(*) AS imported_count
      FROM analysis_import_stage.staged_analysis AS staged
      LEFT JOIN case_analysis AS current
        ON current.run_id = ${input.runId}
       AND current.case_key = staged.case_key
      WHERE current.id IS NULL OR current.analysis_input_hash <> staged.analysis_input_hash
    `.execute(this.#database);
    const importedCount = countResult.rows[0]?.imported_count ?? 0;
    const promptSnapshot = serializeAnalysisPromptSnapshot(input.prompt);
    const analyzerSnapshot = serializeAnalyzerSnapshot(input.analyzer);
    const executionLimits = canonicalJson({ ...input.analysisExecutionLimits });

    await sql`
      INSERT INTO case_analysis (
        id, run_id, case_key, final_case_result_hash, analysis_revision,
        analysis_prompt_key, analysis_prompt_hash, analysis_prompt_snapshot_json,
        analysis_prompt_id, analyzer_config_hash, analyzer_config_id, analyzer_provider,
        analyzer_model, analyzer_snapshot_json, analysis_input_contract_version,
        analysis_output_contract_version, analysis_input_hash, analysis_execution_limits_json,
        analysis_status, classification, confidence, evidence_json, explanation,
        recommended_action, proposal_json, decision, apply_status, base_definition_hash,
        applied_definition_hash, analysis_result_hash, error_code, error_message,
        created_at, updated_at
      )
      SELECT
        staged.id, ${input.runId}, staged.case_key, staged.final_case_result_hash, 3,
        ${input.prompt.promptKey}, ${input.prompt.promptHash}, ${promptSnapshot},
        ${input.prompt.sourceId}, ${input.analyzer.configHash}, ${input.analyzer.sourceId},
        ${input.analyzer.provider}, ${input.analyzer.model}, ${analyzerSnapshot},
        'cortex.analysis-input.v1', 'cortex.analysis-output.v1', staged.analysis_input_hash,
        ${executionLimits}, staged.analysis_status, staged.classification, staged.confidence,
        staged.evidence_json, staged.explanation, staged.recommended_action, staged.proposal_json,
        CASE WHEN staged.proposal_json IS NULL THEN 'NO_PROPOSAL' ELSE 'PENDING' END,
        CASE WHEN staged.proposal_json IS NULL THEN 'NOT_APPLICABLE' ELSE 'NOT_APPLIED' END,
        staged.base_definition_hash, NULL, staged.analysis_result_hash,
        staged.error_code, staged.error_message, ${input.timestamp}, ${input.timestamp}
      FROM analysis_import_stage.staged_analysis AS staged
      WHERE true
      ON CONFLICT(run_id, case_key) DO UPDATE SET
        id = excluded.id,
        final_case_result_hash = excluded.final_case_result_hash,
        analysis_revision = case_analysis.analysis_revision + 3,
        analysis_prompt_key = excluded.analysis_prompt_key,
        analysis_prompt_hash = excluded.analysis_prompt_hash,
        analysis_prompt_snapshot_json = excluded.analysis_prompt_snapshot_json,
        analysis_prompt_id = excluded.analysis_prompt_id,
        analyzer_config_hash = excluded.analyzer_config_hash,
        analyzer_config_id = excluded.analyzer_config_id,
        analyzer_provider = excluded.analyzer_provider,
        analyzer_model = excluded.analyzer_model,
        analyzer_snapshot_json = excluded.analyzer_snapshot_json,
        analysis_input_contract_version = excluded.analysis_input_contract_version,
        analysis_output_contract_version = excluded.analysis_output_contract_version,
        analysis_input_hash = excluded.analysis_input_hash,
        analysis_execution_limits_json = excluded.analysis_execution_limits_json,
        analysis_status = excluded.analysis_status,
        classification = excluded.classification,
        confidence = excluded.confidence,
        evidence_json = excluded.evidence_json,
        explanation = excluded.explanation,
        recommended_action = excluded.recommended_action,
        proposal_json = excluded.proposal_json,
        decision = excluded.decision,
        apply_status = excluded.apply_status,
        base_definition_hash = excluded.base_definition_hash,
        applied_definition_hash = NULL,
        analysis_result_hash = excluded.analysis_result_hash,
        error_code = excluded.error_code,
        error_message = excluded.error_message,
        updated_at = excluded.updated_at
      WHERE case_analysis.analysis_input_hash <> excluded.analysis_input_hash
    `.execute(this.#database);
    return { ok: true, importedCount };
  }
}

/** One isolated SQLite Analysis staging workspace. */
class SqliteAnalysisImportStagingSession implements AnalysisImportStagingSession {
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

  /** Persist one clean Case and classify only duplicate Case keys. */
  public stage(value: StagedImportedAnalysisCase): Promise<"STAGED" | "CASE_KEY_DUPLICATE"> {
    const writer = this.#writer;
    if (writer === null) throw new Error("ANALYSIS_IMPORT_STAGING_CLOSED");
    try {
      writer
        .prepare(
          `INSERT INTO staged_analysis (
            id, case_key, final_case_result_hash, analysis_input_hash, analysis_result_hash,
            analysis_status, classification, confidence, evidence_json, explanation,
            recommended_action, proposal_json, base_definition_hash, error_code, error_message
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        return Promise.resolve("CASE_KEY_DUPLICATE");
      }
      throw error;
    }
  }

  /** Attach staging read-only and run one bounded main transaction. */
  public async withStagedTransaction<T>(
    work: (
      transaction: CaseAnalysisTransaction,
      stagedAnalyses: StagedAnalysisRepository
    ) => Promise<T>
  ): Promise<T> {
    this.#closeWriter();
    const canonicalDatabasePath = await realpath(this.#databasePath);
    await chmod(canonicalDatabasePath, 0o400);
    return this.#mainDatabase.connection().execute(async (database): Promise<T> => {
      await sql`ATTACH DATABASE ${canonicalDatabasePath} AS analysis_import_stage`.execute(
        database
      );
      let outcome:
        { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: Error };
      try {
        outcome = await this.#executeTransaction(database, work);
      } catch (error) {
        outcome = {
          ok: false,
          error:
            error instanceof Error
              ? error
              : new Error("ANALYSIS_IMPORT_TRANSACTION_FAILED", { cause: error })
        };
      }
      let detachError: Error | null = null;
      try {
        await sql.raw("DETACH DATABASE analysis_import_stage").execute(database);
      } catch (error) {
        detachError =
          error instanceof Error
            ? error
            : new Error("ANALYSIS_IMPORT_STAGING_DETACH_FAILED", { cause: error });
      }
      if (!outcome.ok) {
        if (detachError !== null) {
          throw new AggregateError(
            [outcome.error, detachError],
            "ANALYSIS_IMPORT_TRANSACTION_AND_DETACH_FAILED"
          );
        }
        throw outcome.error;
      }
      if (detachError !== null) throw detachError;
      return outcome.value;
    });
  }

  // Execute only database reconciliation and bounded Busy retries.
  async #executeTransaction<T>(
    database: Kysely<SqliteDatabaseSchema>,
    work: (
      transaction: CaseAnalysisTransaction,
      stagedAnalyses: StagedAnalysisRepository
    ) => Promise<T>
  ): Promise<{ readonly ok: true; readonly value: T }> {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      let began = false;
      try {
        await sql.raw("BEGIN IMMEDIATE").execute(database);
        began = true;
        const value = await work(
          {
            analyses: new SqliteCaseAnalysisRepository(database),
            testSuites: new SqliteTestSuiteRepository(database),
            configurations: new SqliteConfigurationRepository(database),
            runs: new SqliteRunReferenceRepository(database)
          },
          new SqliteStagedAnalysisRepository(database)
        );
        await sql.raw("COMMIT").execute(database);
        return { ok: true, value };
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
    throw new SqliteTransactionConflictError();
  }

  /** Close handles and delete only this owned workspace. */
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

/** External Analysis staging factory options. */
export interface SqliteAnalysisImportStagingFactoryOptions {
  /** Safe workspace event sink supplied by the composition root. */
  readonly onSecurityEvent?: ((event: WorkspaceSecurityEvent) => void | Promise<void>) | undefined;
}

/** Factory for isolated external Analysis import SQLite workspaces. */
export class SqliteAnalysisImportStagingFactory implements AnalysisImportStagingFactory {
  readonly #mainDatabase: Kysely<SqliteDatabaseSchema>;
  readonly #workspaceManager: CaseImportWorkspaceManager;

  /** Bind staging creation to one main database and absolute project root. */
  public constructor(
    mainDatabase: Kysely<SqliteDatabaseSchema>,
    projectRoot: string,
    options: SqliteAnalysisImportStagingFactoryOptions = {}
  ) {
    this.#mainDatabase = mainDatabase;
    this.#workspaceManager = new CaseImportWorkspaceManager({
      containmentRoot: projectRoot,
      temporaryRoot: join(projectRoot, ".cortex-eval", "tmp"),
      processLiveness: new PsProcessLiveness(),
      now: Date.now,
      nonce: randomUUID,
      pid: process.pid,
      ttlMs: 24 * 60 * 60 * 1000,
      workspacePrefix: "analysis-import-",
      onSecurityEvent: options.onSecurityEvent
    });
  }

  /** Create one 0700 workspace and 0600 journal-free staging database. */
  public async open(): Promise<AnalysisImportStagingSession> {
    const workspace = await this.#workspaceManager.create();
    const databasePath = join(workspace.path, "analysis.sqlite3");
    let writer: Database.Database | null = null;
    try {
      writer = new Database(databasePath);
      await chmod(databasePath, 0o600);
      initializeStagingWriter(writer);
      return new SqliteAnalysisImportStagingSession(
        this.#mainDatabase,
        workspace,
        this.#workspaceManager,
        databasePath,
        writer
      );
    } catch (error) {
      if (writer !== null) writer.close();
      await this.#workspaceManager.cleanupOwned(workspace).catch(() => undefined);
      throw error;
    }
  }

  /** Run owner-aware stale staging cleanup during Local Server startup. */
  public cleanupStale(): Promise<void> {
    return this.#workspaceManager.cleanupStale();
  }
}
