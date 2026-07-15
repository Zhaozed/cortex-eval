import type {
  CanonicalArtifactSnapshotReader,
  CanonicalEntityKey,
  CanonicalEntityReference,
  CanonicalEntityType,
  CanonicalExpectedArtifact,
  CanonicalSnapshotReader,
  CanonicalSourceEntity
} from "@cortex-eval/application/src/features/canonical-export/canonical-export-projection-service.ts";
import {
  canonicalJson,
  type DomainJsonObject,
  type DomainJsonValue
} from "@cortex-eval/domain/src/domain-canonical-hash.ts";
import { chmod, lstat } from "node:fs/promises";
import { join } from "node:path";

import Database from "better-sqlite3";
import type { Selectable } from "kysely";

import {
  type CaseImportWorkspaceManager,
  type OwnedCaseImportWorkspace
} from "./case-import-workspace.ts";
import {
  mapAnalysisPromptResource,
  mapEndpointResource,
  mapLlmResource,
  mapRubricPromptResource
} from "./sqlite-configuration-mappers.ts";
import { mapStoredTestCase } from "./sqlite-row-mappers.ts";
import { mapStoredRestResult } from "./sqlite-platform-rest-mappers.ts";
import { mapPlatformEvalResult } from "./sqlite-platform-eval-mappers.ts";
import { mapCurrentCaseAnalysis } from "./sqlite-case-analysis-mappers.ts";
import {
  mapImportedManifest,
  mapPlatformRunRow,
  mapRunManifest
} from "./sqlite-platform-run-mappers.ts";
import { mapImportedReportRunRow } from "./sqlite-imported-report-mappers.ts";
import type {
  CaseAnalysisTable,
  CaseResultTable,
  EvalResultTable,
  RunLogTable,
  TestCaseTable
} from "./sqlite-schema.ts";

interface EntityTableSpec {
  /** Export entity discriminator. */
  readonly entityType: CanonicalEntityType;
  /** Trusted internal table name. */
  readonly table: string;
  /** Frozen v1 column set. */
  readonly columns: readonly string[];
  /** SQLite binary sort expression. */
  readonly orderBy: string;
  /** Optional trusted join required by the payload. */
  readonly join?: string | undefined;
}

const TABLE_SPECS: readonly EntityTableSpec[] = [
  {
    entityType: "TEST_SUITE",
    table: "test_suite",
    columns: [
      "id",
      "name",
      "description",
      "case_count",
      "suite_hash",
      "revision",
      "created_at",
      "updated_at"
    ],
    orderBy: "test_suite.id COLLATE BINARY"
  },
  {
    entityType: "TEST_CASE",
    table: "test_case",
    columns: [
      "id",
      "suite_id",
      "case_key",
      "ordinal",
      "description",
      "business_module",
      "scenario_tag",
      "assertion_types_json",
      "metrics_json",
      "definition_json",
      "rubric_prompt_keys_json",
      "definition_hash",
      "revision",
      "created_at",
      "updated_at"
    ],
    orderBy: "test_case.id COLLATE BINARY"
  },
  {
    entityType: "ENDPOINT_CONFIG",
    table: "endpoint_config",
    columns: [
      "id",
      "name",
      "url_template",
      "method",
      "headers_json",
      "body_selector",
      "timeout_ms",
      "default_concurrency",
      "config_hash",
      "revision",
      "created_at",
      "updated_at"
    ],
    orderBy: "endpoint_config.id COLLATE BINARY"
  },
  {
    entityType: "LLM_CONFIG",
    table: "llm_config",
    columns: [
      "id",
      "name",
      "provider_type",
      "model",
      "options_json",
      "secret_refs_json",
      "config_hash",
      "revision",
      "created_at",
      "updated_at"
    ],
    orderBy: "llm_config.id COLLATE BINARY"
  },
  {
    entityType: "RUBRIC_PROMPT",
    table: "llm_rubric_prompt",
    columns: [
      "id",
      "prompt_key",
      "name",
      "messages_json",
      "prompt_hash",
      "revision",
      "created_at",
      "updated_at"
    ],
    orderBy: "llm_rubric_prompt.id COLLATE BINARY"
  },
  {
    entityType: "ANALYSIS_PROMPT",
    table: "case_analysis_prompt",
    columns: [
      "id",
      "prompt_key",
      "name",
      "messages_template_json",
      "prompt_hash",
      "revision",
      "created_at",
      "updated_at"
    ],
    orderBy: "case_analysis_prompt.id COLLATE BINARY"
  },
  {
    entityType: "RUN",
    table: "run_log",
    columns: [
      "id",
      "source_type",
      "source_package_id",
      "execution_id",
      "source_run_id",
      "rerun_mode",
      "suite_id",
      "endpoint_config_id",
      "evaluator_config_id",
      "suite_snapshot_json",
      "endpoint_snapshot_json",
      "evaluator_snapshot_json",
      "rubric_prompts_snapshot_json",
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
      "summary_json",
      "result_set_hash",
      "evaluation_context_hash",
      "evaluation_result_set_hash",
      "report_result_set_hash",
      "artifact_manifest_json",
      "analysis_import_identity_json",
      "error_code",
      "error_message",
      "started_at",
      "completed_at",
      "created_at",
      "updated_at"
    ],
    orderBy: "run_log.id COLLATE BINARY"
  },
  {
    entityType: "CASE_RESULT",
    table: "case_result",
    columns: [
      "run_id",
      "case_key",
      "ordinal",
      "case_definition_json",
      "case_definition_hash",
      "rest_status",
      "http_status",
      "provider_output_json",
      "duration_ms",
      "error_type",
      "error_message",
      "completed_at",
      "run_result_hash",
      "reused_from_run_id",
      "reused_from_execution_id",
      "reused_result_hash"
    ],
    orderBy: "case_result.run_id COLLATE BINARY, case_result.case_key COLLATE BINARY"
  },
  {
    entityType: "EVAL_RESULT",
    table: "eval_result",
    columns: [
      "run_id",
      "case_key",
      "eval_status",
      "promptfoo_success",
      "score",
      "reason",
      "evaluation_error",
      "assertion_results_json",
      "expected_actual_diffs_json",
      "metric_results_json",
      "latency_ms",
      "token_usage_json",
      "cost",
      "allowlist_raw_evidence_json",
      "eval_result_hash",
      "final_case_result_hash",
      "reused_from_run_id",
      "reused_from_execution_id",
      "reused_eval_result_hash",
      "created_at",
      "updated_at",
      "ordinal",
      "case_definition_hash",
      "run_result_hash"
    ],
    join: "JOIN case_result ON case_result.run_id = eval_result.run_id AND case_result.case_key = eval_result.case_key",
    orderBy: "eval_result.run_id COLLATE BINARY, eval_result.case_key COLLATE BINARY"
  },
  {
    entityType: "CASE_ANALYSIS",
    table: "case_analysis",
    columns: [
      "id",
      "run_id",
      "case_key",
      "final_case_result_hash",
      "analysis_revision",
      "analysis_prompt_key",
      "analysis_prompt_hash",
      "analysis_prompt_snapshot_json",
      "analysis_prompt_id",
      "analyzer_config_hash",
      "analyzer_config_id",
      "analyzer_provider",
      "analyzer_model",
      "analyzer_snapshot_json",
      "analysis_input_contract_version",
      "analysis_output_contract_version",
      "analysis_input_hash",
      "analysis_execution_limits_json",
      "analysis_status",
      "classification",
      "confidence",
      "evidence_json",
      "explanation",
      "recommended_action",
      "proposal_json",
      "decision",
      "apply_status",
      "base_definition_hash",
      "applied_definition_hash",
      "analysis_result_hash",
      "error_code",
      "error_message",
      "created_at",
      "updated_at"
    ],
    orderBy: "case_analysis.id COLLATE BINARY"
  }
] as const;

type DatabaseScalar = string | number | null;
type DatabaseRow = Readonly<Record<string, DatabaseScalar>>;

// Check one untrusted native SQLite row before any mapping logic consumes it.
function databaseRow(value: unknown, expectedColumns: readonly string[]): DatabaseRow {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("CANONICAL_SNAPSHOT_ROW_INVALID");
  }
  const source = value as Readonly<Record<string, unknown>>;
  const actualColumns = Object.keys(source);
  if (
    actualColumns.length !== expectedColumns.length ||
    actualColumns.some((column) => !expectedColumns.includes(column))
  ) {
    throw new Error("CANONICAL_SNAPSHOT_ROW_INVALID");
  }
  const result: Record<string, DatabaseScalar> = {};
  for (const column of expectedColumns) {
    const member = source[column];
    if (member !== null && typeof member !== "string" && typeof member !== "number") {
      throw new Error("CANONICAL_SNAPSHOT_ROW_INVALID");
    }
    result[column] = member;
  }
  return result;
}

// Read one required string database member.
function stringMember(row: DatabaseRow, name: string): string {
  const value = row[name];
  if (typeof value !== "string") throw new Error("CANONICAL_SNAPSHOT_ROW_INVALID");
  return value;
}

// Read one optional string database member.
function optionalStringMember(row: DatabaseRow, name: string): string | null {
  const value = row[name];
  if (value !== null && typeof value !== "string") {
    throw new Error("CANONICAL_SNAPSHOT_ROW_INVALID");
  }
  return value;
}

// Read one required finite number database member.
function numberMember(row: DatabaseRow, name: string): number {
  const value = row[name];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("CANONICAL_SNAPSHOT_ROW_INVALID");
  }
  return value;
}

// Convert a frozen snake_case database field to its v1 DTO member name.
function camelCase(value: string): string {
  return value.replace(/_([a-z])/g, (_match, character: string) => character.toUpperCase());
}

// Parse and validate one JSON database member as RFC 8785-compatible data.
function jsonMember(value: string): DomainJsonValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
    canonicalJson(parsed as DomainJsonValue);
  } catch {
    throw new Error("CANONICAL_SNAPSHOT_ROW_INVALID");
  }
  return parsed as DomainJsonValue;
}

// Project a frozen row into a database-neutral camelCase JSON payload.
function rawPayload(row: DatabaseRow, columns: readonly string[]): DomainJsonObject {
  const result: DomainJsonObject = {};
  for (const column of columns) {
    const value = row[column];
    if (value === undefined) throw new Error("CANONICAL_SNAPSHOT_ROW_INVALID");
    const isJson = column.endsWith("_json") || column === "evaluation_error";
    result[camelCase(column)] = isJson && typeof value === "string" ? jsonMember(value) : value;
  }
  if ("promptfooSuccess" in result && typeof result.promptfooSuccess === "number") {
    if (result.promptfooSuccess !== 0 && result.promptfooSuccess !== 1) {
      throw new Error("CANONICAL_SNAPSHOT_ROW_INVALID");
    }
    result.promptfooSuccess = result.promptfooSuccess === 1;
  }
  return result;
}

// Convert one already-clean mapped resource into a database-neutral JSON object.
function mappedPayload(value: unknown): DomainJsonObject {
  try {
    const serialized = canonicalJson(value as DomainJsonValue);
    const parsed: unknown = JSON.parse(serialized);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("CANONICAL_SNAPSHOT_ROW_INVALID");
    }
    return parsed as DomainJsonObject;
  } catch {
    throw new Error("CANONICAL_SNAPSHOT_ROW_INVALID");
  }
}

// Validate current Configuration rows through the same mapper used by Application reads.
function configurationPayload(
  entityType: "ENDPOINT_CONFIG" | "LLM_CONFIG" | "RUBRIC_PROMPT" | "ANALYSIS_PROMPT",
  row: DatabaseRow
): DomainJsonObject {
  try {
    if (entityType === "ENDPOINT_CONFIG") {
      const method = stringMember(row, "method");
      if (method !== "POST") throw new Error("CANONICAL_SNAPSHOT_ROW_INVALID");
      return mappedPayload(
        mapEndpointResource({
          id: stringMember(row, "id"),
          name: stringMember(row, "name"),
          url_template: stringMember(row, "url_template"),
          method,
          headers_json: stringMember(row, "headers_json"),
          body_selector: stringMember(row, "body_selector"),
          timeout_ms: numberMember(row, "timeout_ms"),
          default_concurrency: numberMember(row, "default_concurrency"),
          config_hash: stringMember(row, "config_hash"),
          revision: numberMember(row, "revision"),
          created_at: stringMember(row, "created_at"),
          updated_at: stringMember(row, "updated_at")
        })
      );
    }
    if (entityType === "LLM_CONFIG") {
      const providerType = stringMember(row, "provider_type");
      if (providerType !== "GOOGLE_GEMINI" && providerType !== "OPENAI_COMPATIBLE") {
        throw new Error("CANONICAL_SNAPSHOT_ROW_INVALID");
      }
      return mappedPayload(
        mapLlmResource({
          id: stringMember(row, "id"),
          name: stringMember(row, "name"),
          provider_type: providerType,
          model: stringMember(row, "model"),
          options_json: stringMember(row, "options_json"),
          secret_refs_json: stringMember(row, "secret_refs_json"),
          config_hash: stringMember(row, "config_hash"),
          revision: numberMember(row, "revision"),
          created_at: stringMember(row, "created_at"),
          updated_at: stringMember(row, "updated_at")
        })
      );
    }
    const common = {
      id: stringMember(row, "id"),
      prompt_key: stringMember(row, "prompt_key"),
      name: stringMember(row, "name"),
      prompt_hash: stringMember(row, "prompt_hash"),
      revision: numberMember(row, "revision"),
      created_at: stringMember(row, "created_at"),
      updated_at: stringMember(row, "updated_at")
    };
    return entityType === "RUBRIC_PROMPT"
      ? mappedPayload(
          mapRubricPromptResource({
            ...common,
            messages_json: stringMember(row, "messages_json")
          })
        )
      : mappedPayload(
          mapAnalysisPromptResource({
            ...common,
            messages_template_json: stringMember(row, "messages_template_json")
          })
        );
  } catch {
    throw new Error("CANONICAL_SNAPSHOT_ROW_INVALID");
  }
}

// Select an entity-specific validated projection before any payload leaves Storage.
function payload(
  entityType: CanonicalEntityType,
  row: DatabaseRow,
  columns: readonly string[]
): DomainJsonObject {
  if (
    entityType === "ENDPOINT_CONFIG" ||
    entityType === "LLM_CONFIG" ||
    entityType === "RUBRIC_PROMPT" ||
    entityType === "ANALYSIS_PROMPT"
  ) {
    return configurationPayload(entityType, row);
  }
  try {
    if (entityType === "TEST_CASE") {
      return mappedPayload(mapStoredTestCase(row as unknown as Selectable<TestCaseTable>));
    }
    if (entityType === "RUN") {
      const run = row as unknown as Selectable<RunLogTable>;
      return mappedPayload(
        stringMember(row, "source_type") === "OFFLINE_IMPORT"
          ? mapImportedReportRunRow(run)
          : mapPlatformRunRow(run)
      );
    }
    if (entityType === "CASE_RESULT") {
      return mappedPayload(mapStoredRestResult(row as unknown as Selectable<CaseResultTable>));
    }
    if (entityType === "EVAL_RESULT") {
      return mappedPayload(
        mapPlatformEvalResult(
          row as unknown as Selectable<EvalResultTable> & {
            readonly ordinal: number;
            readonly case_definition_hash: string;
            readonly run_result_hash: string;
          }
        )
      );
    }
    if (entityType === "CASE_ANALYSIS") {
      return mappedPayload(mapCurrentCaseAnalysis(row as unknown as Selectable<CaseAnalysisTable>));
    }
  } catch {
    throw new Error("CANONICAL_SNAPSHOT_ROW_INVALID");
  }
  return rawPayload(row, columns);
}

// Reject cancellation at every backup boundary without retaining a narrowed Signal state.
function requireActive(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new Error("REQUEST_ABORTED");
}

// Resolve a frozen entity key from its table identity.
function entityKey(entityType: CanonicalEntityType, row: DatabaseRow): CanonicalEntityKey {
  if (entityType === "CASE_RESULT" || entityType === "EVAL_RESULT") {
    return { runId: stringMember(row, "run_id"), caseKey: stringMember(row, "case_key") };
  }
  return { id: stringMember(row, "id") };
}

// Add one UUID reference only when a nullable current relationship still exists.
function optionalUuidReference(
  references: CanonicalEntityReference[],
  entityType: CanonicalEntityType,
  value: string | null
): void {
  if (value !== null) references.push({ entityType, entityKey: { id: value } });
}

/** Immutable owner-only SQLite snapshot used by the complete export pipeline. */
export class SqliteCanonicalExportSnapshot
  implements CanonicalSnapshotReader, CanonicalArtifactSnapshotReader
{
  /** Canonical 0600 snapshot database path. */
  public readonly databasePath: string;
  /** Canonical owner workspace path. */
  public readonly workspacePath: string;
  readonly #database: Database.Database;
  readonly #workspaces: CaseImportWorkspaceManager;
  readonly #workspace: OwnedCaseImportWorkspace;
  #closed = false;

  /** Bind a read-only database to one exact owner workspace. */
  public constructor(
    databasePath: string,
    database: Database.Database,
    workspaces: CaseImportWorkspaceManager,
    workspace: OwnedCaseImportWorkspace
  ) {
    this.databasePath = databasePath;
    this.workspacePath = workspace.path;
    this.#database = database;
    this.#workspaces = workspaces;
    this.#workspace = workspace;
  }

  /** Stream one frozen entity type in explicit SQLite BINARY order. */
  public async *stream(entityType: CanonicalEntityType): AsyncGenerator<CanonicalSourceEntity> {
    if (this.#closed) throw new Error("CANONICAL_SNAPSHOT_CLOSED");
    await Promise.resolve();
    const spec = TABLE_SPECS.find((candidate) => candidate.entityType === entityType);
    if (spec === undefined) throw new Error("CANONICAL_ENTITY_TYPE_INVALID");
    const selectedColumns = spec.columns.map((column) => {
      if (entityType === "EVAL_RESULT" && column === "ordinal") {
        return "case_result.ordinal AS ordinal";
      }
      if (
        entityType === "EVAL_RESULT" &&
        (column === "case_definition_hash" || column === "run_result_hash")
      ) {
        return `case_result.${column} AS ${column}`;
      }
      return `${spec.table}.${column}`;
    });
    const sql = `SELECT ${selectedColumns.join(", ")} FROM ${spec.table} ${spec.join ?? ""} ORDER BY ${spec.orderBy}`;
    const statement = this.#database.prepare(sql).raw(false);
    for (const dirty of statement.iterate()) {
      const row = databaseRow(dirty, spec.columns);
      yield {
        entityType,
        entityKey: entityKey(entityType, row),
        payload: payload(entityType, row, spec.columns),
        references: this.#references(entityType, row)
      };
    }
  }

  /** Stream expected Artifact metadata using the Canonical Run as migration owner. */
  public async *streamArtifacts(): AsyncGenerator<CanonicalExpectedArtifact> {
    if (this.#closed) throw new Error("CANONICAL_SNAPSHOT_CLOSED");
    await Promise.resolve();
    const statement = this.#database.prepare(
      `SELECT id, source_type, execution_id, artifact_manifest_json
       FROM run_log ORDER BY id COLLATE BINARY`
    );
    for (const dirty of statement.iterate()) {
      const row = databaseRow(dirty, [
        "id",
        "source_type",
        "execution_id",
        "artifact_manifest_json"
      ]);
      const runId = stringMember(row, "id");
      const sourceType = stringMember(row, "source_type");
      const executionId = optionalStringMember(row, "execution_id");
      let manifest: ReturnType<typeof mapRunManifest> | ReturnType<typeof mapImportedManifest>;
      try {
        if (sourceType === "PLATFORM" && executionId === null) {
          manifest = mapRunManifest(stringMember(row, "artifact_manifest_json"), runId);
        } else if (sourceType === "OFFLINE_IMPORT" && executionId !== null) {
          manifest = mapImportedManifest(stringMember(row, "artifact_manifest_json"), executionId);
        } else {
          throw new Error("CANONICAL_SNAPSHOT_ROW_INVALID");
        }
      } catch {
        throw new Error("CANONICAL_SNAPSHOT_ROW_INVALID");
      }
      const artifacts = [...manifest.artifacts].sort((left, right) =>
        left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0
      );
      for (const artifact of artifacts) {
        yield {
          owner: { type: "RUN", key: { id: runId } },
          kind: artifact.kind,
          sourcePath: artifact.path,
          expectedSha256: artifact.expectedSha256,
          expectedSizeBytes: artifact.expectedSizeBytes
        };
      }
    }
  }

  /** Close the snapshot handle and remove only its still-owned workspace. */
  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#database.close();
    await this.#workspaces.cleanupOwned(this.#workspace);
  }

  // Build the closed strong-reference matrix; external Execution IDs stay payload-only.
  #references(
    entityType: CanonicalEntityType,
    row: DatabaseRow
  ): readonly CanonicalEntityReference[] {
    const references: CanonicalEntityReference[] = [];
    if (entityType === "TEST_CASE") {
      references.push({
        entityType: "TEST_SUITE",
        entityKey: { id: stringMember(row, "suite_id") }
      });
      const promptKeys = jsonMember(stringMember(row, "rubric_prompt_keys_json"));
      if (!Array.isArray(promptKeys) || promptKeys.some((key) => typeof key !== "string")) {
        throw new Error("CANONICAL_SNAPSHOT_ROW_INVALID");
      }
      const prompt = this.#database.prepare(
        "SELECT id FROM llm_rubric_prompt WHERE prompt_key = ?"
      );
      for (const promptKey of promptKeys) {
        const target = databaseRow(prompt.get(promptKey), ["id"]);
        references.push({
          entityType: "RUBRIC_PROMPT",
          entityKey: { id: stringMember(target, "id") }
        });
      }
    }
    if (entityType === "RUN") {
      optionalUuidReference(references, "RUN", optionalStringMember(row, "source_run_id"));
      optionalUuidReference(references, "TEST_SUITE", optionalStringMember(row, "suite_id"));
      optionalUuidReference(
        references,
        "ENDPOINT_CONFIG",
        optionalStringMember(row, "endpoint_config_id")
      );
      optionalUuidReference(
        references,
        "LLM_CONFIG",
        optionalStringMember(row, "evaluator_config_id")
      );
    }
    if (entityType === "CASE_RESULT" || entityType === "EVAL_RESULT") {
      const runId = stringMember(row, "run_id");
      const caseKey = stringMember(row, "case_key");
      references.push({ entityType: "RUN", entityKey: { id: runId } });
      if (entityType === "EVAL_RESULT") {
        references.push({ entityType: "CASE_RESULT", entityKey: { runId, caseKey } });
      }
      optionalUuidReference(references, "RUN", optionalStringMember(row, "reused_from_run_id"));
    }
    if (entityType === "CASE_ANALYSIS") {
      const runId = stringMember(row, "run_id");
      const caseKey = stringMember(row, "case_key");
      references.push(
        { entityType: "RUN", entityKey: { id: runId } },
        { entityType: "EVAL_RESULT", entityKey: { runId, caseKey } }
      );
      optionalUuidReference(
        references,
        "ANALYSIS_PROMPT",
        optionalStringMember(row, "analysis_prompt_id")
      );
      optionalUuidReference(
        references,
        "LLM_CONFIG",
        optionalStringMember(row, "analyzer_config_id")
      );
    }
    return references;
  }
}

/** Create short-lived SQLite backups outside the primary database transaction. */
export class SqliteCanonicalExportSnapshotFactory {
  readonly #source: Database.Database;
  readonly #workspaces: CaseImportWorkspaceManager;

  /** Bind the live connection and controlled workspace manager. */
  public constructor(source: Database.Database, workspaces: CaseImportWorkspaceManager) {
    this.#source = source;
    this.#workspaces = workspaces;
  }

  /** Back up one consistent snapshot, then reopen only the immutable copy. */
  public async create(signal?: AbortSignal): Promise<SqliteCanonicalExportSnapshot> {
    requireActive(signal);
    const workspace = await this.#workspaces.create();
    const databasePath = join(workspace.path, "snapshot.sqlite3");
    try {
      await this.#source.backup(databasePath, {
        progress: () => {
          requireActive(signal);
          return 128;
        }
      });
      requireActive(signal);
      const facts = await lstat(databasePath);
      if (!facts.isFile() || facts.isSymbolicLink()) {
        throw new Error("CANONICAL_SNAPSHOT_INVALID");
      }
      await chmod(databasePath, 0o600);
      const database = new Database(databasePath, { readonly: true, fileMustExist: true });
      database.pragma("query_only = ON");
      database.pragma("foreign_keys = ON");
      return new SqliteCanonicalExportSnapshot(databasePath, database, this.#workspaces, workspace);
    } catch (error) {
      await this.#workspaces.cleanupOwned(workspace).catch(() => undefined);
      throw error;
    }
  }
}
