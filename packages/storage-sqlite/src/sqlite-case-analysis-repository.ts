import type {
  CompleteCurrentAnalysisInput,
  CurrentAnalysisMutationResult,
  CurrentCaseAnalysis,
  ImportedAnalysisIdentity,
  ImportedAnalysisRunContext,
  RecordProposalApplicationInput,
  ReplaceCurrentAnalysisInput
} from "@cortex-eval/application/src/features/case-analysis/case-analysis-models.ts";
import type {
  CaseAnalysisRepository,
  CaseAnalysisTransaction,
  CaseAnalysisTransactionManager
} from "@cortex-eval/application/src/features/case-analysis/case-analysis-ports.ts";
import { analysisProposalJson } from "@cortex-eval/domain/src/domain-analysis-projection.ts";
import { validateAnalysisResult } from "@cortex-eval/domain/src/domain-analysis.ts";
import { canonicalJson } from "@cortex-eval/domain/src/domain-canonical-hash.ts";
import { hashAnalysisResult } from "@cortex-eval/domain/src/domain-hash-inputs.ts";
import type { Insertable, Kysely } from "kysely";
import { z } from "zod";

import {
  mapCurrentCaseAnalysis,
  serializeAnalysisPromptSnapshot,
  serializeAnalysisProposal,
  serializeAnalyzerSnapshot,
  type CaseAnalysisRow
} from "./sqlite-case-analysis-mappers.ts";
import { requireRunTimestamp } from "./sqlite-platform-rest-mappers.ts";
import { SqliteRowInvalidError } from "./sqlite-row-mappers.ts";
import type { SqliteDatabaseSchema } from "./sqlite-schema.ts";
import { SqliteTransactionConflictError } from "./sqlite-transaction-manager.ts";
import {
  SqliteConfigurationRepository,
  SqliteRunReferenceRepository,
  SqliteTestSuiteRepository
} from "./sqlite-application-repositories.ts";

// Recognize only SQLite lock conflicts for bounded short-transaction restart.
function isSqliteBusy(error: unknown): boolean {
  if (error === null || typeof error !== "object" || !("code" in error)) return false;
  return error.code === "SQLITE_BUSY" || error.code === "SQLITE_BUSY_SNAPSHOT";
}

// Return the current row for one Run/Case without mapping nullable query absence.
async function currentRow(
  database: Kysely<SqliteDatabaseSchema>,
  runId: string,
  caseKey: string
): Promise<CaseAnalysisRow | null> {
  return (
    (await database
      .selectFrom("case_analysis")
      .selectAll()
      .where("run_id", "=", runId)
      .where("case_key", "=", caseKey)
      .executeTakeFirst()) ?? null
  );
}

// Return one current row by invocation identity.
async function rowById(
  database: Kysely<SqliteDatabaseSchema>,
  id: string
): Promise<CaseAnalysisRow | null> {
  return (
    (await database
      .selectFrom("case_analysis")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst()) ?? null
  );
}

// Return one uniform conditional mutation conflict.
function mutationConflict(
  reason: "ANALYSIS_REVISION_CONFLICT" | "ANALYSIS_STATE_CONFLICT",
  current: CaseAnalysisRow | null
): CurrentAnalysisMutationResult {
  return {
    ok: false,
    reason,
    current: current === null ? null : mapCurrentCaseAnalysis(current)
  };
}

const ImportedAnalysisIdentitySchema = z.strictObject({
  selector: z.enum(["failed", "errors", "all"]),
  reportResultSetHash: z.string().regex(/^[0-9a-f]{64}$/),
  finalCaseResultSetHash: z.string().regex(/^[0-9a-f]{64}$/),
  analysisResultSetHash: z.string().regex(/^[0-9a-f]{64}$/),
  artifactPath: z
    .string()
    .regex(
      /^executions\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/analysis-results\.json$/
    ),
  artifactSha256: z.string().regex(/^[0-9a-f]{64}$/),
  artifactSizeBytes: z.number().int().nonnegative()
});

// Parse a persisted whole-Artifact identity without allowing dirty JSON into Application.
function importedAnalysisIdentity(serialized: string | null): ImportedAnalysisIdentity | null {
  if (serialized === null) return null;
  try {
    return ImportedAnalysisIdentitySchema.parse(JSON.parse(serialized) as unknown);
  } catch {
    throw new SqliteRowInvalidError();
  }
}

// Build all fields that replace the current invocation and clear its prior decision.
function pendingValues(
  input: ReplaceCurrentAnalysisInput,
  revision: number
): Omit<Insertable<SqliteDatabaseSchema["case_analysis"]>, "run_id" | "case_key" | "created_at"> {
  return {
    id: input.id,
    final_case_result_hash: input.finalCaseResultHash,
    analysis_revision: revision,
    analysis_prompt_key: input.prompt.promptKey,
    analysis_prompt_hash: input.prompt.promptHash,
    analysis_prompt_snapshot_json: serializeAnalysisPromptSnapshot(input.prompt),
    analysis_prompt_id: input.prompt.sourceId,
    analyzer_config_hash: input.analyzer.configHash,
    analyzer_config_id: input.analyzer.sourceId,
    analyzer_provider: input.analyzer.provider,
    analyzer_model: input.analyzer.model,
    analyzer_snapshot_json: serializeAnalyzerSnapshot(input.analyzer),
    analysis_input_contract_version: "cortex.analysis-input.v1" as const,
    analysis_output_contract_version: "cortex.analysis-output.v1" as const,
    analysis_input_hash: input.analysisInputHash,
    analysis_execution_limits_json: canonicalJson({ ...input.analysisExecutionLimits }),
    analysis_status: "PENDING" as const,
    classification: null,
    confidence: null,
    evidence_json: null,
    explanation: null,
    recommended_action: null,
    proposal_json: null,
    decision: "NO_PROPOSAL" as const,
    apply_status: "NOT_APPLICABLE" as const,
    base_definition_hash: null,
    applied_definition_hash: null,
    analysis_result_hash: null,
    error_code: null,
    error_message: null,
    updated_at: input.timestamp
  };
}

/** SQLite implementation of current Run/Case Analysis persistence. */
export class SqliteCaseAnalysisRepository implements CaseAnalysisRepository {
  /** Bound database or transaction handle. */
  readonly #database: Kysely<SqliteDatabaseSchema>;

  /** Bind all current Analysis operations to one managed transaction. */
  public constructor(database: Kysely<SqliteDatabaseSchema>) {
    this.#database = database;
  }

  /** Locate one already imported complete Report Run by offline Execution identity. */
  public async getImportedRunContext(
    executionId: string
  ): Promise<ImportedAnalysisRunContext | null> {
    const row = await this.#database
      .selectFrom("run_log")
      .select([
        "id",
        "source_type",
        "source_package_id",
        "status",
        "stage",
        "report_result_set_hash",
        "analysis_import_identity_json"
      ])
      .where("execution_id", "=", executionId)
      .executeTakeFirst();
    if (row === undefined) return null;
    if (
      row.source_type !== "OFFLINE_IMPORT" ||
      row.source_package_id === null ||
      row.stage !== "DONE" ||
      (row.status !== "COMPLETED" && row.status !== "COMPLETED_WITH_ERRORS") ||
      row.report_result_set_hash === null
    ) {
      throw new SqliteRowInvalidError();
    }
    return {
      runId: row.id,
      packageId: row.source_package_id,
      reportResultSetHash: row.report_result_set_hash,
      analysisIdentity: importedAnalysisIdentity(row.analysis_import_identity_json)
    };
  }

  /** Replace the latest offline whole-Artifact identity after Case imports succeed. */
  public async setImportedAnalysisIdentity(
    executionId: string,
    identity: ImportedAnalysisIdentity
  ): Promise<boolean> {
    const clean = ImportedAnalysisIdentitySchema.parse(identity);
    const updated = await this.#database
      .updateTable("run_log")
      .set({ analysis_import_identity_json: canonicalJson({ ...clean }) })
      .where("execution_id", "=", executionId)
      .where("source_type", "=", "OFFLINE_IMPORT")
      .where("stage", "=", "DONE")
      .where("report_result_set_hash", "=", clean.reportResultSetHash)
      .executeTakeFirst();
    return Number(updated.numUpdatedRows) === 1;
  }

  /** Read one Run/Case current Analysis. */
  public async getCurrent(runId: string, caseKey: string): Promise<CurrentCaseAnalysis | null> {
    const row = await currentRow(this.#database, runId, caseKey);
    return row === null ? null : mapCurrentCaseAnalysis(row);
  }

  /** Insert the first Analysis or conditionally replace the current invocation. */
  public async replaceCurrent(
    input: ReplaceCurrentAnalysisInput
  ): Promise<CurrentAnalysisMutationResult> {
    requireRunTimestamp(input.timestamp);
    const run = await this.#database
      .selectFrom("run_log")
      .select(["id", "status", "stage", "report_result_set_hash"])
      .where("id", "=", input.runId)
      .executeTakeFirst();
    if (run === undefined) {
      return { ok: false, reason: "RUN_NOT_FOUND", current: null };
    }
    const evaluation = await this.#database
      .selectFrom("eval_result")
      .select(["eval_status", "final_case_result_hash"])
      .where("run_id", "=", input.runId)
      .where("case_key", "=", input.caseKey)
      .executeTakeFirst();
    if (
      run.stage !== "DONE" ||
      (run.status !== "COMPLETED" && run.status !== "COMPLETED_WITH_ERRORS") ||
      run.report_result_set_hash === null ||
      evaluation?.final_case_result_hash !== input.finalCaseResultHash ||
      (evaluation.eval_status !== "FAIL" && evaluation.eval_status !== "EVALUATION_ERROR")
    ) {
      return {
        ok: false,
        reason: "FINAL_RESULT_MISMATCH",
        current: await this.getCurrent(input.runId, input.caseKey)
      };
    }
    const current = await currentRow(this.#database, input.runId, input.caseKey);
    if (input.expectedRevision === null) {
      if (current !== null) return mutationConflict("ANALYSIS_REVISION_CONFLICT", current);
      await this.#database
        .insertInto("case_analysis")
        .values({
          ...pendingValues(input, 1),
          run_id: input.runId,
          case_key: input.caseKey,
          created_at: input.timestamp
        })
        .executeTakeFirstOrThrow();
      const inserted = await currentRow(this.#database, input.runId, input.caseKey);
      if (inserted === null) throw new Error("CASE_ANALYSIS_INSERT_LOST");
      return { ok: true, analysis: mapCurrentCaseAnalysis(inserted) };
    }
    if (current?.analysis_revision !== input.expectedRevision) {
      return mutationConflict("ANALYSIS_REVISION_CONFLICT", current);
    }
    if (current.analysis_status === "RUNNING") {
      return mutationConflict("ANALYSIS_STATE_CONFLICT", current);
    }
    const updated = await this.#database
      .updateTable("case_analysis")
      .set(pendingValues(input, current.analysis_revision + 1))
      .where("run_id", "=", input.runId)
      .where("case_key", "=", input.caseKey)
      .where("id", "=", current.id)
      .where("analysis_revision", "=", current.analysis_revision)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) !== 1) {
      return mutationConflict(
        "ANALYSIS_REVISION_CONFLICT",
        await currentRow(this.#database, input.runId, input.caseKey)
      );
    }
    const replaced = await currentRow(this.#database, input.runId, input.caseKey);
    if (replaced === null) throw new Error("CASE_ANALYSIS_UPDATE_LOST");
    return { ok: true, analysis: mapCurrentCaseAnalysis(replaced) };
  }

  /** Conditionally claim one PENDING Analysis for model work. */
  public async claim(
    id: string,
    expectedRevision: number,
    timestamp: string
  ): Promise<CurrentAnalysisMutationResult> {
    requireRunTimestamp(timestamp);
    const before = await rowById(this.#database, id);
    if (before?.analysis_revision !== expectedRevision) {
      return mutationConflict("ANALYSIS_REVISION_CONFLICT", before);
    }
    if (before.analysis_status !== "PENDING") {
      return mutationConflict("ANALYSIS_STATE_CONFLICT", before);
    }
    const updated = await this.#database
      .updateTable("case_analysis")
      .set({
        analysis_status: "RUNNING",
        analysis_revision: before.analysis_revision + 1,
        updated_at: timestamp
      })
      .where("id", "=", id)
      .where("analysis_revision", "=", expectedRevision)
      .where("analysis_status", "=", "PENDING")
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) !== 1) {
      return mutationConflict("ANALYSIS_REVISION_CONFLICT", await rowById(this.#database, id));
    }
    const claimed = await rowById(this.#database, id);
    if (claimed === null) throw new Error("CASE_ANALYSIS_CLAIM_LOST");
    return { ok: true, analysis: mapCurrentCaseAnalysis(claimed) };
  }

  /** Conditionally commit one complete success or isolated Case error. */
  public async complete(
    input: CompleteCurrentAnalysisInput
  ): Promise<CurrentAnalysisMutationResult> {
    requireRunTimestamp(input.timestamp);
    const before = await rowById(this.#database, input.id);
    if (before?.analysis_revision !== input.expectedRevision) {
      return mutationConflict("ANALYSIS_REVISION_CONFLICT", before);
    }
    if (before.analysis_status !== "RUNNING") {
      return mutationConflict("ANALYSIS_STATE_CONFLICT", before);
    }
    let values;
    if (input.result.status === "SUCCEEDED") {
      const output = input.result.output;
      if (!validateAnalysisResult(output).ok) {
        return mutationConflict("ANALYSIS_STATE_CONFLICT", before);
      }
      const proposal = output.proposal;
      const expectedHash = hashAnalysisResult({
        contractVersion: "cortex.analysis-result.v1",
        caseKey: before.case_key,
        finalCaseResultHash: before.final_case_result_hash,
        analysisInputHash: before.analysis_input_hash,
        result: {
          status: "SUCCEEDED",
          classification: output.classification,
          confidence: output.confidence,
          evidence: output.evidence,
          explanation: output.explanation,
          recommendedAction: output.recommendedAction,
          proposal: proposal === undefined ? null : analysisProposalJson(proposal)
        }
      });
      if (expectedHash !== input.analysisResultHash) {
        return mutationConflict("ANALYSIS_STATE_CONFLICT", before);
      }
      values = {
        analysis_status: "SUCCEEDED" as const,
        classification: output.classification,
        confidence: output.confidence,
        evidence_json: canonicalJson(output.evidence.map((item) => ({ ...item }))),
        explanation: output.explanation,
        recommended_action: output.recommendedAction,
        proposal_json: serializeAnalysisProposal(proposal),
        decision: proposal === undefined ? ("NO_PROPOSAL" as const) : ("PENDING" as const),
        apply_status:
          proposal === undefined ? ("NOT_APPLICABLE" as const) : ("NOT_APPLIED" as const),
        base_definition_hash: proposal?.baseDefinitionHash ?? null,
        applied_definition_hash: null,
        analysis_result_hash: input.analysisResultHash,
        error_code: null,
        error_message: null
      };
    } else {
      const errorMessage = input.errorMessage;
      if (
        input.result.errorCode.trim() === "" ||
        errorMessage === null ||
        errorMessage.trim() === ""
      ) {
        return mutationConflict("ANALYSIS_STATE_CONFLICT", before);
      }
      const expectedHash = hashAnalysisResult({
        contractVersion: "cortex.analysis-result.v1",
        caseKey: before.case_key,
        finalCaseResultHash: before.final_case_result_hash,
        analysisInputHash: before.analysis_input_hash,
        result: { status: "ERROR", errorCode: input.result.errorCode }
      });
      if (expectedHash !== input.analysisResultHash) {
        return mutationConflict("ANALYSIS_STATE_CONFLICT", before);
      }
      values = {
        analysis_status: "ERROR" as const,
        classification: null,
        confidence: null,
        evidence_json: null,
        explanation: null,
        recommended_action: null,
        proposal_json: null,
        decision: "NO_PROPOSAL" as const,
        apply_status: "NOT_APPLICABLE" as const,
        base_definition_hash: null,
        applied_definition_hash: null,
        analysis_result_hash: input.analysisResultHash,
        error_code: input.result.errorCode,
        error_message: errorMessage
      };
    }
    const updated = await this.#database
      .updateTable("case_analysis")
      .set({
        ...values,
        analysis_revision: before.analysis_revision + 1,
        updated_at: input.timestamp
      })
      .where("id", "=", input.id)
      .where("analysis_revision", "=", input.expectedRevision)
      .where("analysis_status", "=", "RUNNING")
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) !== 1) {
      return mutationConflict(
        "ANALYSIS_REVISION_CONFLICT",
        await rowById(this.#database, input.id)
      );
    }
    const completed = await rowById(this.#database, input.id);
    if (completed === null) throw new Error("CASE_ANALYSIS_COMPLETE_LOST");
    return { ok: true, analysis: mapCurrentCaseAnalysis(completed) };
  }

  /** Conditionally reject one current pending Proposal. */
  public async rejectProposal(
    id: string,
    expectedRevision: number,
    timestamp: string
  ): Promise<CurrentAnalysisMutationResult> {
    requireRunTimestamp(timestamp);
    const before = await rowById(this.#database, id);
    if (before?.analysis_revision !== expectedRevision) {
      return mutationConflict("ANALYSIS_REVISION_CONFLICT", before);
    }
    if (
      before.analysis_status !== "SUCCEEDED" ||
      before.decision !== "PENDING" ||
      before.apply_status !== "NOT_APPLIED" ||
      before.proposal_json === null
    ) {
      return mutationConflict("ANALYSIS_STATE_CONFLICT", before);
    }
    const updated = await this.#database
      .updateTable("case_analysis")
      .set({
        decision: "REJECTED",
        analysis_revision: before.analysis_revision + 1,
        updated_at: timestamp
      })
      .where("id", "=", id)
      .where("analysis_revision", "=", expectedRevision)
      .where("analysis_status", "=", "SUCCEEDED")
      .where("decision", "=", "PENDING")
      .where("apply_status", "=", "NOT_APPLIED")
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) !== 1) {
      return mutationConflict("ANALYSIS_REVISION_CONFLICT", await rowById(this.#database, id));
    }
    const rejected = await rowById(this.#database, id);
    if (rejected === null) throw new Error("CASE_ANALYSIS_REJECT_LOST");
    return { ok: true, analysis: mapCurrentCaseAnalysis(rejected) };
  }

  /** Record one accepted Proposal outcome after its Case mutation in this same transaction. */
  public async recordProposalApplication(
    input: RecordProposalApplicationInput
  ): Promise<CurrentAnalysisMutationResult> {
    requireRunTimestamp(input.timestamp);
    const before = await rowById(this.#database, input.id);
    if (before?.analysis_revision !== input.expectedRevision) {
      return mutationConflict("ANALYSIS_REVISION_CONFLICT", before);
    }
    if (
      before.analysis_status !== "SUCCEEDED" ||
      before.decision !== "PENDING" ||
      before.apply_status !== "NOT_APPLIED" ||
      before.proposal_json === null
    ) {
      return mutationConflict("ANALYSIS_STATE_CONFLICT", before);
    }
    const hashIsValid =
      input.appliedDefinitionHash !== null && /^[0-9a-f]{64}$/.test(input.appliedDefinitionHash);
    if (
      (input.applyStatus === "APPLIED" && !hashIsValid) ||
      (input.applyStatus === "CONFLICT" && input.appliedDefinitionHash !== null)
    ) {
      return mutationConflict("ANALYSIS_STATE_CONFLICT", before);
    }
    const updated = await this.#database
      .updateTable("case_analysis")
      .set({
        decision: input.decision,
        apply_status: input.applyStatus,
        applied_definition_hash: input.appliedDefinitionHash,
        analysis_revision: before.analysis_revision + 1,
        updated_at: input.timestamp
      })
      .where("id", "=", input.id)
      .where("analysis_revision", "=", input.expectedRevision)
      .where("analysis_status", "=", "SUCCEEDED")
      .where("decision", "=", "PENDING")
      .where("apply_status", "=", "NOT_APPLIED")
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) !== 1) {
      return mutationConflict(
        "ANALYSIS_REVISION_CONFLICT",
        await rowById(this.#database, input.id)
      );
    }
    const decided = await rowById(this.#database, input.id);
    if (decided === null) throw new Error("CASE_ANALYSIS_DECISION_LOST");
    return { ok: true, analysis: mapCurrentCaseAnalysis(decided) };
  }

  /** Recover stale PENDING/RUNNING rows into stable current ERROR facts. */
  public async recoverUnfinished(
    timestamp: string,
    errorCode: string,
    errorMessage: string
  ): Promise<number> {
    requireRunTimestamp(timestamp);
    if (errorCode.trim() === "" || errorMessage.trim() === "") return 0;
    const rows = await this.#database
      .selectFrom("case_analysis")
      .selectAll()
      .where("analysis_status", "in", ["PENDING", "RUNNING"])
      .execute();
    return this.#recoverRows(rows, timestamp, errorCode, errorMessage);
  }

  /** Recover stale PENDING/RUNNING rows for one exact Run owner. */
  public async recoverUnfinishedForRun(
    runId: string,
    timestamp: string,
    errorCode: string,
    errorMessage: string
  ): Promise<number> {
    requireRunTimestamp(timestamp);
    if (runId.trim() === "" || errorCode.trim() === "" || errorMessage.trim() === "") return 0;
    const rows = await this.#database
      .selectFrom("case_analysis")
      .selectAll()
      .where("run_id", "=", runId)
      .where("analysis_status", "in", ["PENDING", "RUNNING"])
      .execute();
    return this.#recoverRows(rows, timestamp, errorCode, errorMessage);
  }

  // Convert an already-selected bounded owner set without changing terminal rows.
  async #recoverRows(
    rows: readonly CaseAnalysisRow[],
    timestamp: string,
    errorCode: string,
    errorMessage: string
  ): Promise<number> {
    let recovered = 0;
    for (const row of rows) {
      const resultHash = hashAnalysisResult({
        contractVersion: "cortex.analysis-result.v1",
        caseKey: row.case_key,
        finalCaseResultHash: row.final_case_result_hash,
        analysisInputHash: row.analysis_input_hash,
        result: { status: "ERROR", errorCode }
      });
      const updated = await this.#database
        .updateTable("case_analysis")
        .set({
          analysis_status: "ERROR",
          analysis_revision: row.analysis_revision + 1,
          classification: null,
          confidence: null,
          evidence_json: null,
          explanation: null,
          recommended_action: null,
          proposal_json: null,
          decision: "NO_PROPOSAL",
          apply_status: "NOT_APPLICABLE",
          base_definition_hash: null,
          applied_definition_hash: null,
          analysis_result_hash: resultHash,
          error_code: errorCode,
          error_message: errorMessage,
          updated_at: timestamp
        })
        .where("id", "=", row.id)
        .where("analysis_revision", "=", row.analysis_revision)
        .where("analysis_status", "in", ["PENDING", "RUNNING"])
        .executeTakeFirst();
      recovered += Number(updated.numUpdatedRows);
    }
    return recovered;
  }
}

/** Kysely managed short transaction boundary for current Analysis facts. */
export class SqliteCaseAnalysisTransactionManager implements CaseAnalysisTransactionManager {
  /** Configured shared SQLite connection. */
  readonly #database: Kysely<SqliteDatabaseSchema>;

  /** Bind the manager to one configured Kysely connection. */
  public constructor(database: Kysely<SqliteDatabaseSchema>) {
    this.#database = database;
  }

  /** Execute database-only work and restart only SQLite Busy conflicts. */
  public async execute<T>(work: (transaction: CaseAnalysisTransaction) => Promise<T>): Promise<T> {
    const maximumAttempts = 4;
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      try {
        return await this.#database.transaction().execute((database) =>
          work({
            analyses: new SqliteCaseAnalysisRepository(database),
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
