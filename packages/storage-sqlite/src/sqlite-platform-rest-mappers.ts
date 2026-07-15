import type { StoredRestCaseResult } from "@cortex-eval/application/src/features/runs/platform-run-models.ts";
import type { RestExecutionErrorType } from "@cortex-eval/application/src/features/runs/run-rest-models.ts";
import { canonicalJson } from "@cortex-eval/domain/src/domain-canonical-hash.ts";
import { caseDefinitionJson } from "@cortex-eval/domain/src/domain-case-projection.ts";
import { hashRestResult } from "@cortex-eval/domain/src/domain-hash-inputs.ts";
import type { Insertable, Selectable } from "kysely";

import {
  caseFromV1,
  CaseDefinitionV1Schema,
  parseJson,
  providerOutputFromV1,
  ProviderOutputV1Schema,
  providerOutputToV1,
  Sha256Schema,
  UtcDateTimeSchema
} from "./sqlite-platform-run-mappers.ts";
import { SqliteRowInvalidError } from "./sqlite-row-mappers.ts";
import type { CaseResultTable } from "./sqlite-schema.ts";

/** Map and validate one persisted REST Case result row. */
export function mapStoredRestResult(row: Selectable<CaseResultTable>): StoredRestCaseResult {
  const definitionV1 = parseJson(CaseDefinitionV1Schema, row.case_definition_json);
  const definition = caseFromV1(definitionV1);
  if (definition.caseKey !== row.case_key) throw new SqliteRowInvalidError();
  const provenance = mapRestProvenance(row);
  if (row.rest_status === "SUCCEEDED") {
    if (
      row.provider_output_json === null ||
      row.http_status === null ||
      row.error_type !== null ||
      row.error_message !== null
    ) {
      throw new SqliteRowInvalidError();
    }
    const providerOutput = providerOutputFromV1(
      parseJson(ProviderOutputV1Schema, row.provider_output_json)
    );
    const result: StoredRestCaseResult = {
      runId: row.run_id,
      caseKey: row.case_key,
      ordinal: row.ordinal,
      definition,
      caseDefinitionHash: row.case_definition_hash,
      status: "SUCCEEDED",
      httpStatus: row.http_status,
      providerOutput,
      errorType: null,
      errorMessage: null,
      durationMs: row.duration_ms,
      completedAt: row.completed_at,
      resultHash: row.run_result_hash,
      provenance
    };
    if (!platformRestResultHashMatches(result)) throw new SqliteRowInvalidError();
    return result;
  }
  const errorType = restErrorType(row.error_type);
  if (row.provider_output_json !== null || row.error_message === null) {
    throw new SqliteRowInvalidError();
  }
  const result: StoredRestCaseResult = {
    runId: row.run_id,
    caseKey: row.case_key,
    ordinal: row.ordinal,
    definition,
    caseDefinitionHash: row.case_definition_hash,
    status: "ERROR",
    httpStatus: row.http_status,
    providerOutput: null,
    errorType,
    errorMessage: row.error_message,
    durationMs: row.duration_ms,
    completedAt: row.completed_at,
    resultHash: row.run_result_hash,
    provenance
  };
  if (!platformRestResultHashMatches(result)) throw new SqliteRowInvalidError();
  return result;
}

/** Recompute one REST semantic hash before accepting a caller or persisted row. */
export function platformRestResultHashMatches(value: StoredRestCaseResult): boolean {
  const resultHash =
    value.status === "SUCCEEDED"
      ? hashRestResult({
          contractVersion: "cortex.rest-result.v1",
          caseKey: value.caseKey,
          caseDefinitionHash: value.caseDefinitionHash,
          result: {
            status: "SUCCEEDED",
            httpStatus: value.httpStatus,
            providerOutput: value.providerOutput
          }
        })
      : hashRestResult({
          contractVersion: "cortex.rest-result.v1",
          caseKey: value.caseKey,
          caseDefinitionHash: value.caseDefinitionHash,
          result: {
            status: "ERROR",
            httpStatus: value.httpStatus,
            errorType: value.errorType
          }
        });
  return resultHash === value.resultHash;
}

// Convert the three nullable persistence columns into one closed provenance fact.
function mapRestProvenance(row: Selectable<CaseResultTable>): StoredRestCaseResult["provenance"] {
  const sourceHash = row.reused_result_hash;
  const runId = row.reused_from_run_id;
  const executionId = row.reused_from_execution_id;
  if (sourceHash === null) {
    if (runId !== null || executionId !== null) throw new SqliteRowInvalidError();
    return null;
  }
  if (!Sha256Schema.safeParse(sourceHash).success || (runId === null) === (executionId === null)) {
    throw new SqliteRowInvalidError();
  }
  if (runId !== null) {
    return { sourceKind: "RUN", sourceId: runId, sourceResultHash: sourceHash };
  }
  if (executionId === null) throw new SqliteRowInvalidError();
  return { sourceKind: "EXECUTION", sourceId: executionId, sourceResultHash: sourceHash };
}

// Narrow one persisted error type into the closed Application union.
function restErrorType(value: string | null): RestExecutionErrorType {
  const supported = new Set([
    "TIMEOUT",
    "NETWORK",
    "HTTP_STATUS",
    "RESPONSE_PARSE",
    "PROVIDER_OUTPUT_INVALID",
    "TEMPLATE_INPUT",
    "CANCELLED"
  ]);
  if (value === null || !supported.has(value)) throw new SqliteRowInvalidError();
  return value as RestExecutionErrorType;
}

/** Convert one already-valid REST result into exact insert values. */
export function restResultInsertValues(value: StoredRestCaseResult): Insertable<CaseResultTable> {
  return {
    run_id: value.runId,
    case_key: value.caseKey,
    ordinal: value.ordinal,
    case_definition_json: canonicalJson(caseDefinitionJson(value.definition)),
    case_definition_hash: value.caseDefinitionHash,
    rest_status: value.status,
    http_status: value.httpStatus,
    provider_output_json:
      value.status === "SUCCEEDED" ? canonicalJson(providerOutputToV1(value.providerOutput)) : null,
    duration_ms: value.durationMs,
    error_type: value.errorType,
    error_message: value.errorMessage,
    completed_at: value.completedAt,
    run_result_hash: value.resultHash,
    reused_from_run_id: value.provenance?.sourceKind === "RUN" ? value.provenance.sourceId : null,
    reused_from_execution_id:
      value.provenance?.sourceKind === "EXECUTION" ? value.provenance.sourceId : null,
    reused_result_hash: value.provenance?.sourceResultHash ?? null
  };
}

/** Validate one complete timestamp before a Run write is attempted. */
export function requireRunTimestamp(value: string): void {
  if (!UtcDateTimeSchema.safeParse(value).success) throw new SqliteRowInvalidError();
}
