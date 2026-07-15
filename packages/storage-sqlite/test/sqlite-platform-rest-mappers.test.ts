import type { StoredRestCaseResult } from "@cortex-eval/application/src/features/runs/platform-run-models.ts";
import { hashRestResult } from "@cortex-eval/domain/src/domain-hash-inputs.ts";
import { describe, expect, it } from "vitest";

import type { CaseResultTable } from "../src/sqlite-schema.ts";
import {
  mapStoredRestResult,
  requireRunTimestamp,
  restResultInsertValues
} from "../src/sqlite-platform-rest-mappers.ts";
import { sqliteRunCaseDefinition } from "../test-support/sqlite-platform-run-fixtures.ts";

const RUN_ID = "01900000-0000-7000-8000-000000000001";
const SOURCE_ID = "01900000-0000-7000-8000-000000000002";
const NOW = "2026-07-15T00:00:00.000Z";
const DEFINITION_HASH = "a".repeat(64);

function success(
  ok: boolean,
  provenance: StoredRestCaseResult["provenance"] = null
): Extract<StoredRestCaseResult, { status: "SUCCEEDED" }> {
  const providerOutput = ok
    ? {
        ok: true as const,
        taskName: "route",
        resolvedConfig: { model: "fixture" },
        parsedOutput: { answer: "ok" }
      }
    : { ok: false as const, errorMessage: "business error" };
  const resultHash = hashRestResult({
    contractVersion: "cortex.rest-result.v1",
    caseKey: "case-1",
    caseDefinitionHash: DEFINITION_HASH,
    result: { status: "SUCCEEDED", httpStatus: 200, providerOutput }
  });
  return {
    runId: RUN_ID,
    caseKey: "case-1",
    ordinal: 0,
    definition: sqliteRunCaseDefinition("case-1"),
    caseDefinitionHash: DEFINITION_HASH,
    status: "SUCCEEDED",
    httpStatus: 200,
    providerOutput,
    errorType: null,
    errorMessage: null,
    durationMs: 10,
    completedAt: NOW,
    resultHash,
    provenance
  };
}

function failure(
  provenance: StoredRestCaseResult["provenance"] = null
): Extract<StoredRestCaseResult, { status: "ERROR" }> {
  const resultHash = hashRestResult({
    contractVersion: "cortex.rest-result.v1",
    caseKey: "case-1",
    caseDefinitionHash: DEFINITION_HASH,
    result: { status: "ERROR", httpStatus: null, errorType: "NETWORK" }
  });
  return {
    runId: RUN_ID,
    caseKey: "case-1",
    ordinal: 0,
    definition: sqliteRunCaseDefinition("case-1"),
    caseDefinitionHash: DEFINITION_HASH,
    status: "ERROR",
    httpStatus: null,
    providerOutput: null,
    errorType: "NETWORK",
    errorMessage: "network error",
    durationMs: 10,
    completedAt: NOW,
    resultHash,
    provenance
  };
}

function row(value: StoredRestCaseResult): CaseResultTable {
  return restResultInsertValues(value) as CaseResultTable;
}

describe("SQLite 平台 REST 行映射", () => {
  it("双向映射 Provider 成功、业务错误、REST 错误和两种复用来源", () => {
    const runReuse = {
      sourceKind: "RUN" as const,
      sourceId: SOURCE_ID,
      sourceResultHash: success(true).resultHash
    };
    const executionReuse = {
      sourceKind: "EXECUTION" as const,
      sourceId: SOURCE_ID,
      sourceResultHash: success(true).resultHash
    };

    expect(mapStoredRestResult(row(success(true, runReuse)))).toMatchObject({
      status: "SUCCEEDED",
      providerOutput: { ok: true, taskName: "route" },
      provenance: runReuse
    });
    expect(mapStoredRestResult(row(success(false, executionReuse)))).toMatchObject({
      providerOutput: { ok: false, errorMessage: "business error" },
      provenance: executionReuse
    });
    expect(mapStoredRestResult(row(failure()))).toMatchObject({
      status: "ERROR",
      errorType: "NETWORK",
      provenance: null
    });
    expect(restResultInsertValues(success(true, runReuse))).toMatchObject({
      reused_from_run_id: SOURCE_ID,
      reused_from_execution_id: null
    });
    expect(restResultInsertValues(success(true, executionReuse))).toMatchObject({
      reused_from_run_id: null,
      reused_from_execution_id: SOURCE_ID
    });
  });

  it("拒绝损坏定义、成功形状、错误形状、来源和语义 Hash", () => {
    const validSuccess = row(success(true));
    const validFailure = row(failure());
    const corrupted: readonly CaseResultTable[] = [
      { ...validSuccess, case_definition_json: "{" },
      { ...validSuccess, case_key: "different" },
      { ...validSuccess, provider_output_json: null },
      { ...validSuccess, provider_output_json: "{}" },
      { ...validSuccess, http_status: null },
      { ...validSuccess, error_type: "NETWORK" },
      { ...validSuccess, error_message: "unexpected" },
      { ...validSuccess, run_result_hash: "b".repeat(64) },
      { ...validFailure, provider_output_json: validSuccess.provider_output_json },
      { ...validFailure, error_message: null },
      { ...validFailure, error_type: null },
      { ...validFailure, error_type: "UNSUPPORTED" },
      { ...validSuccess, reused_from_run_id: SOURCE_ID },
      {
        ...validSuccess,
        reused_result_hash: "invalid",
        reused_from_run_id: SOURCE_ID
      },
      {
        ...validSuccess,
        reused_result_hash: validSuccess.run_result_hash,
        reused_from_run_id: SOURCE_ID,
        reused_from_execution_id: SOURCE_ID
      },
      {
        ...validSuccess,
        reused_result_hash: validSuccess.run_result_hash,
        reused_from_run_id: null,
        reused_from_execution_id: null
      }
    ];

    for (const value of corrupted) {
      expect(() => mapStoredRestResult(value)).toThrow("SQLITE_ROW_INVALID");
    }
  });

  it("只接受精确 UTC Run 时间戳", () => {
    expect(() => requireRunTimestamp(NOW)).not.toThrow();
    expect(() => requireRunTimestamp("2026-07-15")).toThrow("SQLITE_ROW_INVALID");
  });
});
