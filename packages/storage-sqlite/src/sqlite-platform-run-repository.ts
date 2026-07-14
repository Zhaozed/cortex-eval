import type {
  ClaimRunStageResult,
  CompleteRestStageInput,
  FailPlatformRunInput,
  PlatformRunRepository,
  PlatformRunResourceReader,
  PlatformRunTransaction,
  PlatformRunTransactionManager,
  RequestRunCancellationResult
} from "@cortex-eval/application/src/features/runs/platform-run-ports.ts";
import type {
  PlatformRun,
  PlatformRunDetail,
  PlatformRunPage,
  PlatformRunProgress,
  PlatformRunQuery,
  RestResultPage,
  RestResultQuery,
  RunArtifactManifest,
  StoredRestCaseResult
} from "@cortex-eval/application/src/features/runs/platform-run-models.ts";
import type {
  ConfigurationResource,
  ConfigurationResourceKind
} from "@cortex-eval/application/src/features/configurations/configuration-models.ts";
import type {
  StoredTestCase,
  TestSuite
} from "@cortex-eval/application/src/features/test-suites/test-suite-models.ts";
import { canonicalJson } from "@cortex-eval/domain/src/domain-canonical-hash.ts";
import { sql, type Kysely } from "kysely";

import {
  mapPlatformRunDetailRow,
  mapPlatformRunProgressRow,
  mapPlatformRunRow,
  mapRunManifest,
  mapStoredRestResult,
  platformRestResultHashMatches,
  platformRunInsertValues,
  requireRunTimestamp,
  restResultInsertValues
} from "./sqlite-platform-run-mappers.ts";
import {
  SqliteConfigurationRepository,
  SqliteTestSuiteRepository,
  SqliteTransactionConflictError
} from "./sqlite-application-repositories.ts";
import { SqliteRowInvalidError } from "./sqlite-row-mappers.ts";
import type { SqliteDatabaseSchema } from "./sqlite-schema.ts";

/** Kysely implementation of transaction-bound platform Run persistence. */
export class SqlitePlatformRunRepository implements PlatformRunRepository {
  /** Bound database or transaction handle. */
  readonly #database: Kysely<SqliteDatabaseSchema>;

  /** Bind all Run operations to one managed transaction. */
  public constructor(database: Kysely<SqliteDatabaseSchema>) {
    this.#database = database;
  }

  /** Insert one fully frozen READY/REST platform Run. */
  public async insertPlatformRun(value: PlatformRun): Promise<void> {
    if (
      value.status !== "READY" ||
      value.stage !== "REST" ||
      value.lockRevision !== 0 ||
      value.suite.cases.length === 0
    ) {
      throw new SqliteRowInvalidError();
    }
    requireRunTimestamp(value.createdAt);
    await this.#database.insertInto("run_log").values(platformRunInsertValues(value)).execute();
  }

  /** Insert one frozen rerun and its selected reusable REST successes atomically. */
  public async insertPlatformRerun(
    value: PlatformRun,
    reusedRestResults: readonly StoredRestCaseResult[]
  ): Promise<void> {
    const sourceRunId = value.sourceRunId;
    if (
      sourceRunId === null ||
      value.rerunMode === "NONE" ||
      value.restCompletedCount !== reusedRestResults.length ||
      value.restErrorCount !== 0 ||
      (value.rerunMode === "FORCE" && reusedRestResults.length !== 0)
    ) {
      throw new SqliteRowInvalidError();
    }
    const source = await this.getPlatformRun(sourceRunId);
    if (
      source?.runContextHash !== value.runContextHash ||
      source.suite.cases.length !== value.suite.cases.length ||
      source.suite.cases.some((item, index) => {
        const target = value.suite.cases[index];
        return (
          target?.caseKey !== item.caseKey ||
          target.ordinal !== item.ordinal ||
          target.definitionHash !== item.definitionHash
        );
      })
    ) {
      throw new SqliteRowInvalidError();
    }
    for (const result of reusedRestResults) {
      const provenance = result.provenance;
      const sourceResult = await this.getRestResult(sourceRunId, result.caseKey);
      if (
        result.runId !== value.id ||
        result.status !== "SUCCEEDED" ||
        provenance?.sourceKind !== "RUN" ||
        provenance.sourceId !== sourceRunId ||
        provenance.sourceResultHash !== result.resultHash ||
        sourceResult?.status !== "SUCCEEDED" ||
        sourceResult.ordinal !== result.ordinal ||
        sourceResult.caseDefinitionHash !== result.caseDefinitionHash ||
        sourceResult.resultHash !== result.resultHash
      ) {
        throw new SqliteRowInvalidError();
      }
    }
    await this.insertPlatformRun(value);
    if (reusedRestResults.length > 0) {
      await this.#database
        .insertInto("case_result")
        .values(reusedRestResults.map(restResultInsertValues))
        .execute();
    }
  }

  /** Read one strict platform Run without touching imported history. */
  public async getPlatformRun(runId: string): Promise<PlatformRun | null> {
    const row = await this.#database
      .selectFrom("run_log")
      .selectAll()
      .where("id", "=", runId)
      .where("source_type", "=", "PLATFORM")
      .executeTakeFirst();
    return row === undefined ? null : mapPlatformRunRow(row);
  }

  /** Read one bounded detail without selecting the Suite Case array or Prompt messages. */
  public async getPlatformRunDetail(runId: string): Promise<PlatformRunDetail | null> {
    const row = await this.#database
      .selectFrom("run_log")
      .select([
        "id",
        "source_type",
        "source_run_id",
        "rerun_mode",
        "endpoint_snapshot_json",
        "evaluator_snapshot_json",
        "run_context_hash",
        "promptfoo_version",
        "contract_versions_json",
        "run_execution_limits_json",
        "run_mode",
        "status",
        "stage",
        "lock_revision",
        "cancel_requested_at",
        "rest_completed_count",
        "rest_error_count",
        "eval_completed_count",
        "eval_pass_count",
        "eval_fail_count",
        "eval_error_count",
        "eval_not_evaluated_count",
        "result_set_hash",
        "artifact_manifest_json",
        "error_code",
        "error_message",
        "started_at",
        "completed_at",
        "created_at",
        "updated_at",
        sql<string>`json_extract(suite_snapshot_json, '$.id')`.as("snapshot_suite_id"),
        sql<string>`json_extract(suite_snapshot_json, '$.name')`.as("snapshot_suite_name"),
        sql<string>`json_extract(suite_snapshot_json, '$.suiteHash')`.as("snapshot_suite_hash"),
        sql<number>`json_array_length(json_extract(suite_snapshot_json, '$.cases'))`.as(
          "snapshot_case_count"
        ),
        sql<string>`coalesce((
          select json_group_array(json_object(
            'sourceId', json_extract(prompt.value, '$.sourceId'),
            'name', json_extract(prompt.value, '$.name'),
            'promptHash', json_extract(prompt.value, '$.promptHash'),
            'promptKey', json_extract(prompt.value, '$.definition.promptKey')
          ))
          from json_each(json_extract(run_log.rubric_prompts_snapshot_json, '$.items')) as prompt
        ), '[]')`.as("rubric_prompt_summaries_json")
      ])
      .where("id", "=", runId)
      .where("source_type", "=", "PLATFORM")
      .executeTakeFirst();
    return row === undefined ? null : mapPlatformRunDetailRow(row);
  }

  /** Read one small state projection for polling and short CAS decisions. */
  public async getPlatformRunProgress(runId: string): Promise<PlatformRunProgress | null> {
    const row = await this.#database
      .selectFrom("run_log")
      .select([
        "id",
        "source_type",
        "status",
        "stage",
        "lock_revision",
        "cancel_requested_at",
        "rest_completed_count",
        "rest_error_count",
        "eval_completed_count",
        "eval_pass_count",
        "eval_fail_count",
        "eval_error_count",
        "eval_not_evaluated_count",
        "result_set_hash",
        "artifact_manifest_json",
        "error_code",
        "error_message",
        "started_at",
        "completed_at",
        "created_at",
        "updated_at",
        sql<number>`json_array_length(json_extract(suite_snapshot_json, '$.cases'))`.as(
          "snapshot_case_count"
        )
      ])
      .where("id", "=", runId)
      .where("source_type", "=", "PLATFORM")
      .executeTakeFirst();
    return row === undefined ? null : mapPlatformRunProgressRow(row);
  }

  /** Query bounded recent summaries without loading frozen Case definitions. */
  public async queryPlatformRuns(query: PlatformRunQuery): Promise<PlatformRunPage> {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 200) {
      throw new SqliteRowInvalidError();
    }
    let builder = this.#database
      .selectFrom("run_log")
      .select([
        "id",
        "run_mode",
        "status",
        "stage",
        "lock_revision",
        "cancel_requested_at",
        "rest_completed_count",
        "rest_error_count",
        "eval_completed_count",
        "eval_pass_count",
        "eval_fail_count",
        "eval_error_count",
        "eval_not_evaluated_count",
        "created_at",
        "updated_at",
        sql<string>`json_extract(suite_snapshot_json, '$.id')`.as("snapshot_suite_id"),
        sql<string>`json_extract(suite_snapshot_json, '$.name')`.as("snapshot_suite_name"),
        sql<number>`json_array_length(json_extract(suite_snapshot_json, '$.cases'))`.as(
          "snapshot_case_count"
        )
      ])
      .where("source_type", "=", "PLATFORM")
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(query.limit + 1);
    if (query.afterCursor !== undefined) {
      const cursor = query.afterCursor;
      builder = builder.where((expression) =>
        expression.or([
          expression("created_at", "<", cursor.createdAt),
          expression.and([
            expression("created_at", "=", cursor.createdAt),
            expression("id", "<", cursor.id)
          ])
        ])
      );
    }
    const rows = await builder.execute();
    const hasMore = rows.length > query.limit;
    const visible = hasMore ? rows.slice(0, query.limit) : rows;
    const items = visible.map((row) => {
      if (
        typeof row.snapshot_suite_id !== "string" ||
        typeof row.snapshot_suite_name !== "string" ||
        !Number.isInteger(row.snapshot_case_count) ||
        row.snapshot_case_count < 1
      ) {
        throw new SqliteRowInvalidError();
      }
      return {
        id: row.id,
        sourceType: "PLATFORM" as const,
        suiteId: row.snapshot_suite_id,
        suiteName: row.snapshot_suite_name,
        runMode: row.run_mode,
        status: row.status,
        stage: row.stage,
        lockRevision: row.lock_revision,
        cancelRequestedAt: row.cancel_requested_at,
        restTotalCount: row.snapshot_case_count,
        restCompletedCount: row.rest_completed_count,
        restErrorCount: row.rest_error_count,
        evalCompletedCount: row.eval_completed_count,
        evalPassCount: row.eval_pass_count,
        evalFailCount: row.eval_fail_count,
        evalErrorCount: row.eval_error_count,
        evalNotEvaluatedCount: row.eval_not_evaluated_count,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    });
    const last = items.at(-1);
    return {
      items,
      nextCursor: hasMore && last !== undefined ? { createdAt: last.createdAt, id: last.id } : null
    };
  }

  /** Claim one READY stage through exact status, stage and Revision predicates. */
  public async claimStage(
    runId: string,
    expectedRevision: number,
    updatedAt: string
  ): Promise<ClaimRunStageResult> {
    requireRunTimestamp(updatedAt);
    try {
      const result = await this.#database
        .updateTable("run_log")
        .set((expression) => ({
          status: "RUNNING",
          lock_revision: expression("lock_revision", "+", 1),
          started_at: expression.fn.coalesce("started_at", expression.val(updatedAt)),
          updated_at: updatedAt
        }))
        .where("id", "=", runId)
        .where("source_type", "=", "PLATFORM")
        .where("status", "=", "READY")
        .where("stage", "!=", "DONE")
        .where("lock_revision", "=", expectedRevision)
        .returningAll()
        .executeTakeFirst();
      if (result !== undefined) return { ok: true, run: mapPlatformRunRow(result) };
    } catch (error) {
      if (isSqliteUnique(error)) return { ok: false, reason: "GLOBAL_RUNNING" };
      throw error;
    }
    const exists = await this.#runExists(runId);
    return { ok: false, reason: exists ? "STATE_OR_REVISION" : "NOT_FOUND" };
  }

  /** Record an explicit cross-process cancellation request through CAS. */
  public async requestCancel(
    runId: string,
    expectedRevision: number,
    updatedAt: string
  ): Promise<RequestRunCancellationResult> {
    requireRunTimestamp(updatedAt);
    const result = await this.#database
      .updateTable("run_log")
      .set((expression) => ({
        cancel_requested_at: updatedAt,
        lock_revision: expression("lock_revision", "+", 1),
        updated_at: updatedAt
      }))
      .where("id", "=", runId)
      .where("source_type", "=", "PLATFORM")
      .where("status", "=", "RUNNING")
      .where("stage", "!=", "DONE")
      .where("cancel_requested_at", "is", null)
      .where("lock_revision", "=", expectedRevision)
      .returning("id")
      .executeTakeFirst();
    if (result !== undefined) {
      const run = await this.getPlatformRunProgress(result.id);
      if (run === null) throw new SqliteTransactionConflictError();
      return { ok: true, run };
    }
    const exists = await this.#runExists(runId);
    return { ok: false, reason: exists ? "STATE_OR_REVISION" : "NOT_FOUND" };
  }

  /** Idempotently persist one dispatched result and update durable counters. */
  public async recordRestResult(
    value: StoredRestCaseResult,
    updatedAt: string
  ): Promise<PlatformRunProgress | null> {
    requireRunTimestamp(updatedAt);
    if (!Number.isInteger(value.ordinal) || value.ordinal < 0) throw new SqliteRowInvalidError();
    const casePath = `$.cases[${value.ordinal}]`;
    const run = await this.#database
      .selectFrom("run_log")
      .select([
        "status",
        "stage",
        "source_run_id",
        "rerun_mode",
        sql<string>`json_extract(suite_snapshot_json, ${`${casePath}.caseKey`})`.as(
          "frozen_case_key"
        ),
        sql<string>`json_extract(suite_snapshot_json, ${`${casePath}.definitionHash`})`.as(
          "frozen_definition_hash"
        )
      ])
      .where("id", "=", value.runId)
      .where("source_type", "=", "PLATFORM")
      .executeTakeFirst();
    if (run?.status !== "RUNNING" || run.stage !== "REST") return null;
    if (
      run.frozen_case_key !== value.caseKey ||
      run.frozen_definition_hash !== value.caseDefinitionHash ||
      !platformRestResultHashMatches(value)
    ) {
      throw new SqliteRowInvalidError();
    }
    const provenance = value.provenance;
    if (provenance !== null) {
      if (
        provenance.sourceKind !== "RUN" ||
        run.rerun_mode !== "RETRY_FAILED" ||
        run.source_run_id !== provenance.sourceId ||
        value.status !== "SUCCEEDED" ||
        value.resultHash !== provenance.sourceResultHash
      ) {
        throw new SqliteRowInvalidError();
      }
      const source = await this.#database
        .selectFrom("case_result")
        .select(["ordinal", "case_definition_hash", "rest_status", "run_result_hash"])
        .where("run_id", "=", provenance.sourceId)
        .where("case_key", "=", value.caseKey)
        .executeTakeFirst();
      if (
        source?.ordinal !== value.ordinal ||
        source.case_definition_hash !== value.caseDefinitionHash ||
        source.rest_status !== "SUCCEEDED" ||
        source.run_result_hash !== provenance.sourceResultHash
      ) {
        throw new SqliteRowInvalidError();
      }
    }
    const inserted = await this.#database
      .insertInto("case_result")
      .values(restResultInsertValues(value))
      .onConflict((conflict) => conflict.columns(["run_id", "case_key"]).doNothing())
      .returning("case_key")
      .executeTakeFirst();
    if (inserted === undefined) return this.getPlatformRunProgress(value.runId);
    const updated = await this.#database
      .updateTable("run_log")
      .set((expression) => ({
        rest_completed_count: expression("rest_completed_count", "+", 1),
        rest_error_count:
          value.status === "ERROR"
            ? expression("rest_error_count", "+", 1)
            : expression.ref("rest_error_count"),
        lock_revision: expression("lock_revision", "+", 1),
        updated_at: updatedAt
      }))
      .where("id", "=", value.runId)
      .where("source_type", "=", "PLATFORM")
      .where("status", "=", "RUNNING")
      .where("stage", "=", "REST")
      .returning("id")
      .executeTakeFirst();
    if (updated === undefined) throw new SqliteTransactionConflictError();
    return this.getPlatformRunProgress(updated.id);
  }

  /** Commit a complete REST result set only before cancellation wins. */
  public async completeRestStage(
    input: CompleteRestStageInput
  ): Promise<PlatformRunProgress | null> {
    requireRunTimestamp(input.updatedAt);
    const manifestJson = canonicalJson({
      contractVersion: input.artifactManifest.contractVersion,
      owner: { ...input.artifactManifest.owner },
      artifacts: input.artifactManifest.artifacts.map((item) => ({ ...item }))
    });
    const result = await this.#database
      .updateTable("run_log")
      .set((expression) => ({
        status: "READY",
        stage: "EVALUATION",
        result_set_hash: input.resultSetHash,
        artifact_manifest_json: manifestJson,
        lock_revision: expression("lock_revision", "+", 1),
        updated_at: input.updatedAt
      }))
      .where("id", "=", input.runId)
      .where("source_type", "=", "PLATFORM")
      .where("status", "=", "RUNNING")
      .where("stage", "=", "REST")
      .where("cancel_requested_at", "is", null)
      .where("lock_revision", "=", input.expectedRevision)
      .where("rest_completed_count", "=", input.expectedTotal)
      .returning("id")
      .executeTakeFirst();
    return result === undefined ? null : this.getPlatformRunProgress(result.id);
  }

  /** Commit final cancellation after the owner settled dispatched work. */
  public async commitCancellation(
    runId: string,
    expectedRevision: number,
    completedAt: string
  ): Promise<PlatformRunProgress | null> {
    requireRunTimestamp(completedAt);
    const result = await this.#database
      .updateTable("run_log")
      .set((expression) => ({
        status: "CANCELLED",
        stage: "DONE",
        lock_revision: expression("lock_revision", "+", 1),
        completed_at: completedAt,
        updated_at: completedAt
      }))
      .where("id", "=", runId)
      .where("source_type", "=", "PLATFORM")
      .where("status", "=", "RUNNING")
      .where("stage", "!=", "DONE")
      .where("cancel_requested_at", "is not", null)
      .where("lock_revision", "=", expectedRevision)
      .returning("id")
      .executeTakeFirst();
    return result === undefined ? null : this.getPlatformRunProgress(result.id);
  }

  /** Commit one active or automatic-handoff stage failure while cancellation remains absent. */
  public async failRun(input: FailPlatformRunInput): Promise<PlatformRunProgress | null> {
    requireRunTimestamp(input.completedAt);
    const result = await this.#database
      .updateTable("run_log")
      .set((expression) => ({
        status: "FAILED",
        stage: "DONE",
        lock_revision: expression("lock_revision", "+", 1),
        error_code: input.errorCode,
        error_message: input.errorMessage,
        completed_at: input.completedAt,
        updated_at: input.completedAt
      }))
      .where("id", "=", input.runId)
      .where("source_type", "=", "PLATFORM")
      .where("status", "in", ["READY", "RUNNING"])
      .where("stage", "!=", "DONE")
      .where("cancel_requested_at", "is", null)
      .where("lock_revision", "=", input.expectedRevision)
      .returning("id")
      .executeTakeFirst();
    return result === undefined ? null : this.getPlatformRunProgress(result.id);
  }

  /** Commit runtime interruption, including correction of a raced active-stage commit. */
  public async interruptRun(
    runId: string,
    expectedRevision: number,
    completedAt: string
  ): Promise<PlatformRunProgress | null> {
    requireRunTimestamp(completedAt);
    const result = await this.#database
      .updateTable("run_log")
      .set((expression) => ({
        status: "INTERRUPTED",
        stage: "DONE",
        lock_revision: expression("lock_revision", "+", 1),
        completed_at: completedAt,
        updated_at: completedAt
      }))
      .where("id", "=", runId)
      .where("source_type", "=", "PLATFORM")
      .where("status", "in", ["RUNNING", "READY"])
      .where("stage", "!=", "DONE")
      .where("lock_revision", "=", expectedRevision)
      .returning("id")
      .executeTakeFirst();
    return result === undefined ? null : this.getPlatformRunProgress(result.id);
  }

  /** Convert abandoned platform Runs to explicit terminal interruption facts. */
  public async recoverRunning(completedAt: string): Promise<readonly PlatformRunProgress[]> {
    requireRunTimestamp(completedAt);
    const rows = await this.#database
      .updateTable("run_log")
      .set((expression) => ({
        status: "INTERRUPTED",
        stage: "DONE",
        lock_revision: expression("lock_revision", "+", 1),
        completed_at: completedAt,
        updated_at: completedAt
      }))
      .where("source_type", "=", "PLATFORM")
      .where("status", "=", "RUNNING")
      .returning("id")
      .execute();
    const recovered = await Promise.all(
      rows.map(async (row) => this.getPlatformRunProgress(row.id))
    );
    if (recovered.some((run) => run === null)) throw new SqliteTransactionConflictError();
    return recovered.filter((run): run is PlatformRunProgress => run !== null);
  }

  /** Query real REST results in frozen Ordinal order. */
  public async queryRestResults(query: RestResultQuery): Promise<RestResultPage> {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100) {
      throw new SqliteRowInvalidError();
    }
    let builder = this.#database
      .selectFrom("case_result")
      .selectAll()
      .where("run_id", "=", query.runId)
      .orderBy("ordinal")
      .limit(query.limit + 1);
    if (query.afterOrdinal !== undefined) {
      builder = builder.where("ordinal", ">", query.afterOrdinal);
    }
    const rows = await builder.execute();
    const hasMore = rows.length > query.limit;
    const visible = hasMore ? rows.slice(0, query.limit) : rows;
    const last = visible.at(-1);
    return {
      items: visible.map(mapStoredRestResult),
      nextCursor: hasMore && last !== undefined ? last.ordinal : null
    };
  }

  /** Read one real REST Case result. */
  public async getRestResult(runId: string, caseKey: string): Promise<StoredRestCaseResult | null> {
    const row = await this.#database
      .selectFrom("case_result")
      .selectAll()
      .where("run_id", "=", runId)
      .where("case_key", "=", caseKey)
      .executeTakeFirst();
    return row === undefined ? null : mapStoredRestResult(row);
  }

  /** List strict platform Manifests for startup orphan cleanup. */
  public async listPlatformRunManifests(): Promise<readonly RunArtifactManifest[]> {
    const rows = await this.#database
      .selectFrom("run_log")
      .select(["id", "artifact_manifest_json"])
      .where("source_type", "=", "PLATFORM")
      .execute();
    return rows.map((row) => mapRunManifest(row.artifact_manifest_json, row.id));
  }

  // Check only platform Run existence when classifying a failed conditional write.
  async #runExists(runId: string): Promise<boolean> {
    const row = await this.#database
      .selectFrom("run_log")
      .select("id")
      .where("id", "=", runId)
      .where("source_type", "=", "PLATFORM")
      .executeTakeFirst();
    return row !== undefined;
  }
}

/** Narrow current-resource reader bound to the same Run creation transaction. */
export class SqlitePlatformRunResourceReader implements PlatformRunResourceReader {
  /** Existing typed current Suite repository. */
  readonly #testSuites: SqliteTestSuiteRepository;
  /** Existing typed current Configuration repository. */
  readonly #configurations: SqliteConfigurationRepository;

  /** Bind both current-resource readers to one managed transaction. */
  public constructor(database: Kysely<SqliteDatabaseSchema>) {
    this.#testSuites = new SqliteTestSuiteRepository(database);
    this.#configurations = new SqliteConfigurationRepository(database);
  }

  /** Read one current Suite. */
  public getSuite(suiteId: string): Promise<TestSuite | null> {
    return this.#testSuites.getSuite(suiteId);
  }

  /** Read all current Cases in exact Ordinal order. */
  public listCases(suiteId: string): Promise<readonly StoredTestCase[]> {
    return this.#testSuites.listCases(suiteId);
  }

  /** Read one exact current Configuration. */
  public getConfiguration(
    kind: ConfigurationResourceKind,
    id: string
  ): Promise<ConfigurationResource | null> {
    return this.#configurations.getResource(kind, id);
  }

  /** List all current Rubric Prompts for referenced-key selection. */
  public listRubricPrompts(): Promise<readonly ConfigurationResource[]> {
    return this.#configurations.listResources("LLM_RUBRIC_PROMPT");
  }
}

/** Managed short-transaction boundary dedicated to Run orchestration. */
export class SqlitePlatformRunTransactionManager implements PlatformRunTransactionManager {
  /** Configured storage connection. */
  readonly #database: Kysely<SqliteDatabaseSchema>;

  /** Bind the manager to one configured Kysely connection. */
  public constructor(database: Kysely<SqliteDatabaseSchema>) {
    this.#database = database;
  }

  /** Execute database-only Run work with bounded SQLite Busy retries. */
  public async execute<T>(work: (transaction: PlatformRunTransaction) => Promise<T>): Promise<T> {
    const maximumAttempts = 4;
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      try {
        return await this.#database.transaction().execute(async (database) =>
          work({
            resources: new SqlitePlatformRunResourceReader(database),
            runs: new SqlitePlatformRunRepository(database)
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

// Recognize only SQLite lock conflicts.
function isSqliteBusy(error: unknown): boolean {
  if (error === null || typeof error !== "object" || !("code" in error)) return false;
  return error.code === "SQLITE_BUSY" || error.code === "SQLITE_BUSY_SNAPSHOT";
}

// Recognize one unique constraint without depending on driver message text.
function isSqliteUnique(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}
