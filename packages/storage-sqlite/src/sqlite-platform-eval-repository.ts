import type {
  CompletePlatformEvalStageInput,
  CompletePlatformEvalStageResult,
  PlatformEvalRepository,
  PlatformEvalTransaction,
  PlatformEvalTransactionManager
} from "@cortex-eval/application/src/features/evaluation/platform-eval-ports.ts";
import type {
  PlatformEvalResultPage,
  PlatformEvalResultQuery
} from "@cortex-eval/application/src/features/evaluation/platform-eval-models.ts";
import { canonicalJson } from "@cortex-eval/domain/src/domain-canonical-hash.ts";
import {
  hashEvalResultSet,
  hashFinalCaseResult
} from "@cortex-eval/domain/src/domain-hash-inputs.ts";
import { type Kysely } from "kysely";

import { mapRunManifest, requireRunTimestamp } from "./sqlite-platform-run-mappers.ts";
import {
  evalResultInsertValues,
  mapPlatformEvalResult,
  platformEvalResultHashMatches,
  type EvalResultRowProjection
} from "./sqlite-platform-eval-mappers.ts";
import { SqliteTransactionConflictError } from "./sqlite-application-repositories.ts";
import { SqliteRowInvalidError } from "./sqlite-row-mappers.ts";
import type { SqliteDatabaseSchema } from "./sqlite-schema.ts";

// Return whether an external error is one of the only retryable SQLite lock conflicts.
function isSqliteBusy(error: unknown): boolean {
  if (error === null || typeof error !== "object" || !("code" in error)) return false;
  return error.code === "SQLITE_BUSY" || error.code === "SQLITE_BUSY_SNAPSHOT";
}

// Validate complete ordered Eval identities and their semantic result-set hash.
function inputIsAligned(input: CompletePlatformEvalStageInput): boolean {
  if (
    !Number.isInteger(input.expectedTotal) ||
    input.expectedTotal < 1 ||
    input.results.length !== input.expectedTotal
  ) {
    return false;
  }
  const caseKeys = new Set<string>();
  for (const [index, result] of input.results.entries()) {
    if (
      result.runId !== input.runId ||
      result.ordinal !== index ||
      caseKeys.has(result.caseKey) ||
      result.createdAt !== input.updatedAt ||
      result.updatedAt !== input.updatedAt ||
      !platformEvalResultHashMatches(result)
    ) {
      return false;
    }
    caseKeys.add(result.caseKey);
  }
  const resultSetHash = hashEvalResultSet({
    contractVersion: "cortex.eval-result-set.v1",
    owner: { kind: "RUN", id: input.runId },
    evaluationContextHash: input.evaluationContextHash,
    cases: input.results.map((item) => ({
      caseKey: item.caseKey,
      ordinal: item.ordinal,
      evalResultHash: item.evalResultHash
    }))
  });
  return resultSetHash === input.resultSetHash;
}

/** Kysely implementation of atomic platform Evaluation persistence. */
export class SqlitePlatformEvalRepository implements PlatformEvalRepository {
  /** Bound database or transaction handle. */
  readonly #database: Kysely<SqliteDatabaseSchema>;

  /** Bind all Evaluation operations to one managed transaction. */
  public constructor(database: Kysely<SqliteDatabaseSchema>) {
    this.#database = database;
  }

  /** Atomically reconcile, persist and advance one complete Evaluation stage. */
  public async completeStage(
    input: CompletePlatformEvalStageInput
  ): Promise<CompletePlatformEvalStageResult> {
    requireRunTimestamp(input.updatedAt);
    if (!inputIsAligned(input)) return { ok: false, reason: "RESULT_ALIGNMENT" };
    const evalManifestJson = canonicalJson({
      contractVersion: input.artifactManifest.contractVersion,
      owner: { ...input.artifactManifest.owner },
      artifacts: input.artifactManifest.artifacts.map((item) => ({ ...item }))
    });
    const evalManifest = mapRunManifest(evalManifestJson, input.runId);
    const rawArtifact = evalManifest.artifacts.find(
      (item) => item.kind === "RAW_PROMPTFOO_EVIDENCE"
    );
    const normalizedArtifact = evalManifest.artifacts.find(
      (item) => item.kind === "NORMALIZED_EVAL_RESULTS"
    );
    if (
      rawArtifact === undefined ||
      normalizedArtifact === undefined ||
      evalManifest.artifacts.length !== 2
    ) {
      return { ok: false, reason: "RESULT_ALIGNMENT" };
    }
    const evidenceMismatch = input.results.some((result) => {
      const evidence = result.rawEvidence;
      return (
        result.provenance === null &&
        evidence !== null &&
        (evidence.path !== rawArtifact.path ||
          evidence.expectedSha256 !== rawArtifact.expectedSha256 ||
          evidence.expectedSizeBytes !== rawArtifact.expectedSizeBytes)
      );
    });
    if (evidenceMismatch) return { ok: false, reason: "RESULT_ALIGNMENT" };
    const run = await this.#database
      .selectFrom("run_log")
      .select([
        "status",
        "stage",
        "lock_revision",
        "cancel_requested_at",
        "source_run_id",
        "rerun_mode",
        "artifact_manifest_json"
      ])
      .where("id", "=", input.runId)
      .where("source_type", "=", "PLATFORM")
      .executeTakeFirst();
    if (
      run?.status !== "RUNNING" ||
      run.stage !== "EVALUATION" ||
      run.lock_revision !== input.expectedRevision ||
      run.cancel_requested_at !== null
    ) {
      return { ok: false, reason: "STATE_OR_REVISION" };
    }
    const restManifest = mapRunManifest(run.artifact_manifest_json, input.runId);
    if (restManifest.artifacts.length !== 1 || restManifest.artifacts[0]?.kind !== "REST_RESULTS") {
      return { ok: false, reason: "RESULT_ALIGNMENT" };
    }
    const manifestJson = canonicalJson({
      contractVersion: restManifest.contractVersion,
      owner: { ...restManifest.owner },
      artifacts: [
        ...restManifest.artifacts.map((item) => ({ ...item })),
        { ...rawArtifact },
        { ...normalizedArtifact }
      ]
    });
    mapRunManifest(manifestJson, input.runId);
    const restRows = await this.#database
      .selectFrom("case_result")
      .select([
        "case_key",
        "ordinal",
        "case_definition_hash",
        "rest_status",
        "run_result_hash",
        "reused_from_run_id",
        "reused_from_execution_id",
        "reused_result_hash"
      ])
      .where("run_id", "=", input.runId)
      .orderBy("ordinal", "asc")
      .execute();
    if (restRows.length !== input.expectedTotal) {
      return { ok: false, reason: "RESULT_ALIGNMENT" };
    }
    const reusedResults = input.results.filter((result) => result.provenance !== null);
    const sourceEvalByCase = new Map<
      string,
      {
        readonly evalStatus: string;
        readonly evalResultHash: string;
        readonly rawEvidenceJson: string;
      }
    >();
    if (reusedResults.length > 0) {
      if (run.rerun_mode !== "RETRY_FAILED" || run.source_run_id === null) {
        return { ok: false, reason: "RESULT_ALIGNMENT" };
      }
      const sourceRows = await this.#database
        .selectFrom("eval_result")
        .select(["case_key", "eval_status", "eval_result_hash", "allowlist_raw_evidence_json"])
        .where("run_id", "=", run.source_run_id)
        .execute();
      for (const source of sourceRows) {
        sourceEvalByCase.set(source.case_key, {
          evalStatus: source.eval_status,
          evalResultHash: source.eval_result_hash,
          rawEvidenceJson: source.allowlist_raw_evidence_json
        });
      }
    }
    for (const [index, result] of input.results.entries()) {
      const rest = restRows[index];
      const provenance = result.provenance;
      const sourceEval = sourceEvalByCase.get(result.caseKey);
      if (
        rest?.case_key !== result.caseKey ||
        rest.ordinal !== result.ordinal ||
        (rest.rest_status === "ERROR" && result.status !== "NOT_EVALUATED") ||
        (rest.rest_status === "SUCCEEDED" && result.status === "NOT_EVALUATED") ||
        hashFinalCaseResult({
          contractVersion: "cortex.final-case-result.v1",
          caseDefinitionHash: rest.case_definition_hash,
          restResultHash: rest.run_result_hash,
          evalResultHash: result.evalResultHash
        }) !== result.finalCaseResultHash ||
        (provenance !== null &&
          (provenance.sourceKind !== "RUN" ||
            provenance.sourceId !== run.source_run_id ||
            provenance.sourceResultHash !== result.evalResultHash ||
            (result.status !== "PASS" && result.status !== "FAIL") ||
            sourceEval?.evalResultHash !== provenance.sourceResultHash ||
            sourceEval.rawEvidenceJson !==
              (result.rawEvidence === null
                ? canonicalJson(null)
                : canonicalJson({ ...result.rawEvidence })) ||
            (sourceEval.evalStatus !== "PASS" && sourceEval.evalStatus !== "FAIL") ||
            rest.reused_from_run_id !== provenance.sourceId ||
            rest.reused_from_execution_id !== null ||
            rest.reused_result_hash === null))
      ) {
        return { ok: false, reason: "RESULT_ALIGNMENT" };
      }
    }
    const existing = await this.#database
      .selectFrom("eval_result")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("run_id", "=", input.runId)
      .executeTakeFirstOrThrow();
    if (existing.count !== 0) return { ok: false, reason: "RESULT_ALIGNMENT" };
    await this.#database
      .insertInto("eval_result")
      .values(input.results.map(evalResultInsertValues))
      .execute();
    const evalErrorCount = input.results.filter(
      (item) => item.status === "EVALUATION_ERROR"
    ).length;
    const evalPassCount = input.results.filter((item) => item.status === "PASS").length;
    const evalFailCount = input.results.filter((item) => item.status === "FAIL").length;
    const evalNotEvaluatedCount = input.results.filter(
      (item) => item.status === "NOT_EVALUATED"
    ).length;
    const update = await this.#database
      .updateTable("run_log")
      .set({
        status: "READY",
        stage: "REPORT",
        lock_revision: input.expectedRevision + 1,
        eval_completed_count: input.expectedTotal,
        eval_pass_count: evalPassCount,
        eval_fail_count: evalFailCount,
        eval_error_count: evalErrorCount,
        eval_not_evaluated_count: evalNotEvaluatedCount,
        result_set_hash: input.resultSetHash,
        artifact_manifest_json: manifestJson,
        updated_at: input.updatedAt
      })
      .where("id", "=", input.runId)
      .where("source_type", "=", "PLATFORM")
      .where("status", "=", "RUNNING")
      .where("stage", "=", "EVALUATION")
      .where("lock_revision", "=", input.expectedRevision)
      .where("cancel_requested_at", "is", null)
      .executeTakeFirst();
    if (Number(update.numUpdatedRows) !== 1) {
      throw new SqliteTransactionConflictError();
    }
    return {
      ok: true,
      progress: {
        runId: input.runId,
        status: "READY",
        stage: "REPORT",
        lockRevision: input.expectedRevision + 1,
        evalCompletedCount: input.expectedTotal,
        evalPassCount,
        evalFailCount,
        evalErrorCount,
        evalNotEvaluatedCount,
        resultSetHash: input.resultSetHash
      }
    };
  }

  /** Query complete normalized Eval facts in frozen order. */
  public async queryResults(query: PlatformEvalResultQuery): Promise<PlatformEvalResultPage> {
    if (
      !Number.isInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > 200 ||
      (query.afterOrdinal !== undefined &&
        (!Number.isInteger(query.afterOrdinal) || query.afterOrdinal < 0))
    ) {
      throw new SqliteRowInvalidError();
    }
    let builder = this.#database
      .selectFrom("eval_result")
      .innerJoin("case_result", (join) =>
        join
          .onRef("case_result.run_id", "=", "eval_result.run_id")
          .onRef("case_result.case_key", "=", "eval_result.case_key")
      )
      .selectAll("eval_result")
      .select([
        "case_result.ordinal as ordinal",
        "case_result.case_definition_hash as case_definition_hash",
        "case_result.run_result_hash as run_result_hash"
      ])
      .where("eval_result.run_id", "=", query.runId)
      .orderBy("case_result.ordinal", "asc")
      .limit(query.limit + 1);
    if (query.afterOrdinal !== undefined) {
      builder = builder.where("case_result.ordinal", ">", query.afterOrdinal);
    }
    const rows = (await builder.execute()) as EvalResultRowProjection[];
    const hasMore = rows.length > query.limit;
    const visible = hasMore ? rows.slice(0, query.limit) : rows;
    return {
      items: visible.map(mapPlatformEvalResult),
      nextCursor: hasMore ? (visible.at(-1)?.ordinal ?? null) : null
    };
  }
}

/** Managed short-transaction boundary dedicated to Evaluation persistence. */
export class SqlitePlatformEvalTransactionManager implements PlatformEvalTransactionManager {
  /** Configured storage connection. */
  readonly #database: Kysely<SqliteDatabaseSchema>;

  /** Bind the manager to one configured Kysely connection. */
  public constructor(database: Kysely<SqliteDatabaseSchema>) {
    this.#database = database;
  }

  /** Execute database-only Evaluation work with bounded SQLite Busy retries. */
  public async execute<T>(work: (transaction: PlatformEvalTransaction) => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        return await this.#database
          .transaction()
          .execute(async (database) =>
            work({ evaluations: new SqlitePlatformEvalRepository(database) })
          );
      } catch (error) {
        if (!isSqliteBusy(error)) throw error;
        if (attempt === 4) throw new SqliteTransactionConflictError();
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    throw new SqliteTransactionConflictError();
  }
}
