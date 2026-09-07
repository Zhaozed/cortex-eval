import { rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  FrozenEvaluationCaseInput,
  FrozenEvaluationCaseSource,
  FrozenEvaluationRestResult
} from "@cortex-eval/application/src/features/evaluation/frozen-evaluation-engine.ts";
import type { PromptfooImportCase } from "@cortex-eval/application/src/features/evaluation/promptfoo-result-importer.ts";
import type { ImportedEvalCase } from "@cortex-eval/application/src/features/evaluation/promptfoo-result-importer.ts";
import type { OfflineRestCaseResult } from "@cortex-eval/application/src/features/runs/offline-rest-execution-service.ts";
import type { FrozenRunCase } from "@cortex-eval/application/src/features/runs/run-rest-models.ts";
import {
  EvalCaseV1Schema,
  RestArtifactCaseV1Schema,
  type EvalCaseV1
} from "@cortex-eval/contracts/src/artifact-contracts.ts";
import { CaseDefinitionV1Schema } from "@cortex-eval/contracts/src/case-contracts.ts";
import { caseDefinitionJson } from "@cortex-eval/domain/src/domain-case-projection.ts";
import { createPromptfooTemporaryDirectory } from "@cortex-eval/evaluation-adapters/src/promptfoo-temporary-directory.ts";
import { workPackageCaseDefinitionFromV1 } from "@cortex-eval/work-package/src/work-package-input-reader.ts";
import { workPackageRestArtifactCase } from "@cortex-eval/work-package/src/work-package-rest-artifact-writer.ts";
import { workPackageRestApplicationResult } from "@cortex-eval/work-package/src/work-package-rest-retry-reader.ts";

const STAGING_BATCH_SIZE = 128;

/** Controlled factory for one command-private Evaluation staging store. */
export interface WorkPackageEvaluationStagingFactory {
  /** Create a fresh owner-only bounded staging store. */
  readonly create: () => Promise<WorkPackageEvaluationStagingStore>;
}

interface StagingRow {
  /** Frozen Case ordinal. */
  readonly ordinal: number;
  /** Stable Case key. */
  readonly caseKey: string;
  /** Frozen Case Definition identity. */
  readonly definitionHash: string;
  /** Strict Case Definition v1 JSON. */
  readonly caseDefinition: string;
  /** Strict REST Artifact Case v1 JSON. */
  readonly restResult: string;
  /** Optional validated reusable Eval Case JSON. */
  readonly reusableResult: string | null;
  /** Optional newly imported Eval Case JSON. */
  readonly importedResult: string | null;
}

// Reject SQLite or JSON boundary drift before values re-enter Evaluation logic.
function stagingRow(value: unknown): StagingRow {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("WORK_PACKAGE_INVALID");
  }
  const source = value as Readonly<Record<string, unknown>>;
  if (
    typeof source.ordinal !== "number" ||
    !Number.isSafeInteger(source.ordinal) ||
    source.ordinal < 0 ||
    typeof source.case_key !== "string" ||
    typeof source.definition_hash !== "string" ||
    typeof source.case_definition !== "string" ||
    typeof source.rest_result !== "string" ||
    (source.reusable_result !== null && typeof source.reusable_result !== "string") ||
    (source.imported_result !== null && typeof source.imported_result !== "string")
  ) {
    throw new Error("WORK_PACKAGE_INVALID");
  }
  return {
    ordinal: source.ordinal,
    caseKey: source.case_key,
    definitionHash: source.definition_hash,
    caseDefinition: source.case_definition,
    restResult: source.rest_result,
    reusableResult: source.reusable_result,
    importedResult: source.imported_result
  };
}

// Parse only private staging JSON and preserve one stable package error.
function parseStagingJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error("WORK_PACKAGE_INVALID", { cause: error });
  }
}

// Restore one strict frozen Case from scalar identity plus Case Definition v1.
function frozenCase(row: StagingRow): FrozenRunCase {
  const definition = workPackageCaseDefinitionFromV1(
    CaseDefinitionV1Schema.parse(parseStagingJson(row.caseDefinition))
  );
  if (definition.caseKey !== row.caseKey) throw new Error("WORK_PACKAGE_INVALID");
  return {
    caseKey: row.caseKey,
    ordinal: row.ordinal,
    definitionHash: row.definitionHash,
    definition
  };
}

// Restore one strict Application REST result from its transport projection.
function restResult(row: StagingRow): OfflineRestCaseResult {
  const result = workPackageRestApplicationResult(
    RestArtifactCaseV1Schema.parse(parseStagingJson(row.restResult))
  );
  if (
    result.caseKey !== row.caseKey ||
    result.ordinal !== row.ordinal ||
    result.caseDefinitionHash !== row.definitionHash
  ) {
    throw new Error("WORK_PACKAGE_INVALID");
  }
  return result;
}

// Convert one clean Provider Output to the strict Importer JSON shape.
function providerOutputJson(
  value: Extract<OfflineRestCaseResult, { readonly status: "SUCCEEDED" }>["providerOutput"]
): PromptfooImportCase["restResult"] {
  if (!value.ok) {
    return {
      status: "SUCCEEDED",
      resultHash: "",
      providerOutput: { ok: false, errorMessage: value.errorMessage }
    };
  }
  return {
    status: "SUCCEEDED",
    resultHash: "",
    providerOutput: {
      ok: true,
      task_name: value.taskName,
      resolved_config: value.resolvedConfig,
      parsed_output: value.parsedOutput
    }
  };
}

// Build one strict Importer input without retaining adjacent Cases.
function importCase(row: StagingRow): PromptfooImportCase {
  const testCase = frozenCase(row);
  const rest = restResult(row);
  if (rest.status === "ERROR") {
    return {
      caseKey: testCase.caseKey,
      ordinal: testCase.ordinal,
      caseDefinitionHash: testCase.definitionHash,
      definition: testCase.definition,
      restResult: { status: "ERROR", resultHash: rest.resultHash }
    };
  }
  const provider = providerOutputJson(rest.providerOutput);
  if (provider.status !== "SUCCEEDED") throw new Error("WORK_PACKAGE_INVALID");
  return {
    caseKey: testCase.caseKey,
    ordinal: testCase.ordinal,
    caseDefinitionHash: testCase.definitionHash,
    definition: testCase.definition,
    restResult: { ...provider, resultHash: rest.resultHash }
  };
}

// Convert one staged REST result to the bounded shared Engine contract.
function engineRestResult(value: OfflineRestCaseResult): FrozenEvaluationRestResult {
  const identity = {
    caseKey: value.caseKey,
    ordinal: value.ordinal,
    caseDefinitionHash: value.caseDefinitionHash
  };
  return value.status === "SUCCEEDED"
    ? { ...identity, status: "SUCCEEDED", providerOutput: value.providerOutput }
    : { ...identity, status: "ERROR", providerOutput: null };
}

/** Owner-private SQLite staging for bounded offline Evaluation joins and ordering. */
export class WorkPackageEvaluationStagingStore {
  /** Owner-only disposable directory. */
  readonly #directory: string;
  /** Synchronous local SQLite connection used only inside one command. */
  readonly #database: DatabaseSync;
  #importBatchCount = 0;
  #importTransactionOpen = false;
  #closed = false;

  private constructor(directory: string, database: DatabaseSync) {
    this.#directory = directory;
    this.#database = database;
  }

  /** Create one isolated store below an explicitly contained temporary parent. */
  public static async create(
    containmentRoot: string,
    temporaryParent: string
  ): Promise<WorkPackageEvaluationStagingStore> {
    const directory = await createPromptfooTemporaryDirectory(containmentRoot, temporaryParent);
    try {
      const database = new DatabaseSync(join(directory, "evaluation-staging.sqlite"));
      database.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA temp_store=FILE;");
      database.exec(`
        CREATE TABLE evaluation_cases (
          ordinal INTEGER PRIMARY KEY,
          case_key TEXT NOT NULL UNIQUE,
          definition_hash TEXT NOT NULL,
          case_definition TEXT NOT NULL,
          rest_result TEXT NOT NULL,
          rest_status TEXT NOT NULL CHECK (rest_status IN ('SUCCEEDED', 'ERROR')),
          reusable_result TEXT,
          imported_result TEXT
        ) STRICT;
      `);
      return new WorkPackageEvaluationStagingStore(directory, database);
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw new Error("EVALUATION_STAGE_FAILED", { cause: error });
    }
  }

  /** Join complete replayable Case and REST streams into bounded disk staging. */
  public async stageInputs(
    cases: AsyncIterable<FrozenRunCase>,
    restResults: AsyncIterable<OfflineRestCaseResult>,
    expectedCaseCount: number,
    signal: AbortSignal
  ): Promise<void> {
    this.#requireOpen();
    const insert = this.#database.prepare(`
      INSERT INTO evaluation_cases (
        ordinal, case_key, definition_hash, case_definition, rest_result, rest_status
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const caseReader = cases[Symbol.asyncIterator]();
    const restReader = restResults[Symbol.asyncIterator]();
    let count = 0;
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      for (;;) {
        if (signal.aborted) throw new Error("REQUEST_ABORTED");
        const [caseStep, restStep] = await Promise.all([caseReader.next(), restReader.next()]);
        if (caseStep.done || restStep.done) {
          if (caseStep.done !== restStep.done || count !== expectedCaseCount) {
            throw new Error("WORK_PACKAGE_INVALID");
          }
          break;
        }
        const testCase = caseStep.value;
        const rest = restStep.value;
        if (
          testCase.ordinal !== count ||
          rest.ordinal !== count ||
          testCase.caseKey !== rest.caseKey ||
          testCase.definitionHash !== rest.caseDefinitionHash
        ) {
          throw new Error("WORK_PACKAGE_INVALID");
        }
        const caseDefinition = CaseDefinitionV1Schema.parse(
          caseDefinitionJson(testCase.definition)
        );
        const transportRest = workPackageRestArtifactCase(rest);
        insert.run(
          count,
          testCase.caseKey,
          testCase.definitionHash,
          JSON.stringify(caseDefinition),
          JSON.stringify(transportRest),
          rest.status
        );
        count += 1;
        if (count % STAGING_BATCH_SIZE === 0) {
          this.#database.exec("COMMIT; BEGIN IMMEDIATE");
        }
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  /** Add only fully verified reusable PASS/FAIL facts by exact ordinal identity. */
  public async stageReusable(
    results: AsyncIterable<EvalCaseV1>,
    signal: AbortSignal
  ): Promise<void> {
    this.#requireOpen();
    const update = this.#database.prepare(`
      UPDATE evaluation_cases
      SET reusable_result = ?
      WHERE ordinal = ? AND case_key = ? AND rest_status = 'SUCCEEDED'
        AND reusable_result IS NULL AND imported_result IS NULL
    `);
    let count = 0;
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      for await (const value of results) {
        if (signal.aborted) throw new Error("REQUEST_ABORTED");
        const clean = EvalCaseV1Schema.parse(value);
        const result = update.run(JSON.stringify(clean), clean.ordinal, clean.caseKey);
        if (result.changes !== 1) throw new Error("WORK_PACKAGE_INVALID");
        count += 1;
        if (count % STAGING_BATCH_SIZE === 0) {
          this.#database.exec("COMMIT; BEGIN IMMEDIATE");
        }
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  /** Replay only non-reused joined Cases for the shared Promptfoo Engine. */
  public caseSource(): FrozenEvaluationCaseSource {
    this.#requireOpen();
    const database = this.#database;
    return {
      open: async function* (): AsyncGenerator<FrozenEvaluationCaseInput> {
        for (const value of database
          .prepare(
            `SELECT ordinal, case_key, definition_hash, case_definition, rest_result,
                    reusable_result, imported_result
             FROM evaluation_cases WHERE reusable_result IS NULL ORDER BY ordinal`
          )
          .iterate()) {
          const row = stagingRow(value);
          yield await Promise.resolve({
            testCase: frozenCase(row),
            restResult: engineRestResult(restResult(row))
          });
        }
      }
    };
  }

  /** Replay REST-success, non-reused Cases for fixed runtime preflight. */
  public async *openPreflightCases(): AsyncGenerator<FrozenRunCase> {
    this.#requireOpen();
    for (const value of this.#database
      .prepare(
        `SELECT ordinal, case_key, definition_hash, case_definition, rest_result,
                reusable_result, imported_result
         FROM evaluation_cases
         WHERE reusable_result IS NULL AND rest_status = 'SUCCEEDED'
         ORDER BY ordinal`
      )
      .iterate()) {
      yield await Promise.resolve(frozenCase(stagingRow(value)));
    }
  }

  /** Look up one non-reused strict expected Case by Raw Row identity. */
  public findPendingImportCase(caseKey: string): PromptfooImportCase | null {
    this.#requireOpen();
    const value = this.#database
      .prepare(
        `SELECT ordinal, case_key, definition_hash, case_definition, rest_result,
                reusable_result, imported_result
         FROM evaluation_cases WHERE case_key = ? AND reusable_result IS NULL`
      )
      .get(caseKey);
    return value === undefined ? null : importCase(stagingRow(value));
  }

  /** Store one strict imported result and reject duplicate Raw Case identities. */
  public storeImported(value: ImportedEvalCase): void {
    this.#requireOpen();
    if (!this.#importTransactionOpen) {
      this.#database.exec("BEGIN IMMEDIATE");
      this.#importTransactionOpen = true;
    }
    const clean = EvalCaseV1Schema.parse(value);
    const result = this.#database
      .prepare(
        `UPDATE evaluation_cases SET imported_result = ?
         WHERE ordinal = ? AND case_key = ? AND reusable_result IS NULL
           AND imported_result IS NULL`
      )
      .run(JSON.stringify(clean), clean.ordinal, clean.caseKey);
    if (result.changes !== 1) throw new Error("PROMPTFOO_IMPORT_CASE_DUPLICATE");
    this.#importBatchCount += 1;
    if (this.#importBatchCount === STAGING_BATCH_SIZE) this.commitImportedBatch();
  }

  /** Commit the current imported-result batch before a dependent read. */
  public commitImportedBatch(): void {
    this.#requireOpen();
    if (!this.#importTransactionOpen) return;
    this.#database.exec("COMMIT");
    this.#importTransactionOpen = false;
    this.#importBatchCount = 0;
  }

  /** Roll back only the current uncommitted imported-result batch. */
  public rollbackImportedBatch(): void {
    this.#requireOpen();
    if (!this.#importTransactionOpen) return;
    this.#database.exec("ROLLBACK");
    this.#importTransactionOpen = false;
    this.#importBatchCount = 0;
  }

  /** Replay pending Cases missing a Raw Row so the Importer can create explicit results. */
  public async *openMissingImportCases(): AsyncGenerator<PromptfooImportCase> {
    this.#requireOpen();
    let previousOrdinal = -1;
    for (;;) {
      const value = this.#database
        .prepare(
          `SELECT ordinal, case_key, definition_hash, case_definition, rest_result,
                  reusable_result, imported_result
           FROM evaluation_cases
           WHERE ordinal > ? AND reusable_result IS NULL AND imported_result IS NULL
           ORDER BY ordinal LIMIT 1`
        )
        .get(previousOrdinal);
      if (value === undefined) return;
      const row = stagingRow(value);
      previousOrdinal = row.ordinal;
      yield await Promise.resolve(importCase(row));
    }
  }

  /** Replay the complete merged normalized result set in frozen order. */
  public async *openFinalResults(): AsyncGenerator<EvalCaseV1> {
    this.#requireOpen();
    for (const value of this.#database
      .prepare(
        `SELECT ordinal, case_key, definition_hash, case_definition, rest_result,
                reusable_result, imported_result
         FROM evaluation_cases ORDER BY ordinal`
      )
      .iterate()) {
      const row = stagingRow(value);
      const encoded = row.reusableResult ?? row.importedResult;
      if (encoded === null) throw new Error("WORK_PACKAGE_INVALID");
      const result = EvalCaseV1Schema.parse(parseStagingJson(encoded));
      if (result.ordinal !== row.ordinal || result.caseKey !== row.caseKey) {
        throw new Error("WORK_PACKAGE_INVALID");
      }
      yield await Promise.resolve(result);
    }
  }

  /** Close SQLite and reclaim the complete owner-private staging directory. */
  public async dispose(): Promise<void> {
    if (this.#closed) return;
    if (this.#importTransactionOpen) this.#database.exec("ROLLBACK");
    this.#closed = true;
    this.#database.close();
    await rm(this.#directory, { recursive: true, force: true });
  }

  #requireOpen(): void {
    if (this.#closed) throw new Error("EVALUATION_STAGING_CLOSED");
  }
}
