import type {
  CurrentCaseAnalysis,
  StoredAnalysisPromptSnapshot,
  StoredAnalyzerSnapshot
} from "@cortex-eval/application/src/features/case-analysis/case-analysis-models.ts";
import type {
  AnalysisProposalDraft,
  AnalysisResultDraft
} from "@cortex-eval/domain/src/domain-analysis.ts";
import { validateAnalysisResult } from "@cortex-eval/domain/src/domain-analysis.ts";
import { analysisProposalJson } from "@cortex-eval/domain/src/domain-analysis-projection.ts";
import { canonicalJson } from "@cortex-eval/domain/src/domain-canonical-hash.ts";
import { hashAnalysisResult } from "@cortex-eval/domain/src/domain-hash-inputs.ts";
import type { Selectable } from "kysely";
import { z } from "zod";

import type { CaseAnalysisTable } from "./sqlite-schema.ts";
import {
  assertionFromV1,
  CaseDefinitionV1Schema,
  caseFromV1,
  parseJson,
  PersistedAssertionSchema,
  PersistedJsonObjectSchema
} from "./sqlite-platform-run-mappers.ts";
import { SqliteRowInvalidError } from "./sqlite-row-mappers.ts";

/** Complete selected row used by the current Analysis mapper. */
export type CaseAnalysisRow = Selectable<CaseAnalysisTable>;

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const HashSchema = z.string().regex(HASH_PATTERN);
const AnalysisEvidenceSchema = z.strictObject({
  source: z.enum([
    "case_definition",
    "provider_output",
    "failed_assertions",
    "expected_actual_diffs",
    "llm_rubric_results",
    "run_context"
  ]),
  fieldPath: z
    .string()
    .regex(/^(?:\/(?:[^~/]|~[01])*)*$/)
    .nullable(),
  conclusion: z.string().trim().min(1)
});
const AnalysisProposalSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("REPLACE_CASE"),
    baseDefinitionHash: HashSchema,
    casePayload: CaseDefinitionV1Schema
  }),
  z.strictObject({
    action: z.literal("ADD_ASSERTION"),
    baseDefinitionHash: HashSchema,
    targetAssertionIndex: z.number().int().nonnegative(),
    assertion: PersistedAssertionSchema
  }),
  z.strictObject({
    action: z.literal("REPLACE_ASSERTION"),
    baseDefinitionHash: HashSchema,
    targetAssertionIndex: z.number().int().nonnegative(),
    targetAssertionDefinitionHash: HashSchema,
    assertion: PersistedAssertionSchema
  }),
  z.strictObject({
    action: z.literal("REMOVE_ASSERTION"),
    baseDefinitionHash: HashSchema,
    targetAssertionIndex: z.number().int().nonnegative(),
    targetAssertionDefinitionHash: HashSchema
  })
]);
const AnalysisExecutionLimitsSchema = z.strictObject({
  contractVersion: z.literal("cortex.analysis-execution-limits.v1"),
  analysisConcurrency: z.number().int().min(1).max(8)
});

// Map one strict transport Proposal back into the pure Domain union.
function proposalFromJson(serialized: string): AnalysisProposalDraft {
  const value = parseJson(AnalysisProposalSchema, serialized);
  if (value.action === "REPLACE_CASE") {
    return {
      action: value.action,
      baseDefinitionHash: value.baseDefinitionHash,
      casePayload: caseFromV1(value.casePayload)
    };
  }
  if (value.action === "ADD_ASSERTION") {
    return {
      action: value.action,
      baseDefinitionHash: value.baseDefinitionHash,
      targetAssertionIndex: value.targetAssertionIndex,
      assertion: assertionFromV1(value.assertion)
    };
  }
  if (value.action === "REPLACE_ASSERTION") {
    return {
      action: value.action,
      baseDefinitionHash: value.baseDefinitionHash,
      targetAssertionIndex: value.targetAssertionIndex,
      targetAssertionDefinitionHash: value.targetAssertionDefinitionHash,
      assertion: assertionFromV1(value.assertion)
    };
  }
  return {
    action: value.action,
    baseDefinitionHash: value.baseDefinitionHash,
    targetAssertionIndex: value.targetAssertionIndex,
    targetAssertionDefinitionHash: value.targetAssertionDefinitionHash
  };
}

// Map one optional successful output and reject dirty cross-field combinations.
function outputFromRow(row: CaseAnalysisRow): AnalysisResultDraft | null {
  if (row.analysis_status !== "SUCCEEDED") {
    if (
      row.classification !== null ||
      row.confidence !== null ||
      row.evidence_json !== null ||
      row.explanation !== null ||
      row.recommended_action !== null ||
      row.proposal_json !== null
    ) {
      throw new SqliteRowInvalidError();
    }
    return null;
  }
  if (
    row.classification === null ||
    row.confidence === null ||
    row.evidence_json === null ||
    row.explanation === null ||
    row.recommended_action === null
  ) {
    throw new SqliteRowInvalidError();
  }
  const evidence = parseJson(AnalysisEvidenceSchema.array().min(1), row.evidence_json);
  const proposal = row.proposal_json === null ? undefined : proposalFromJson(row.proposal_json);
  return {
    classification: row.classification,
    confidence: row.confidence,
    evidence,
    explanation: row.explanation,
    recommendedAction: row.recommended_action,
    ...(proposal === undefined ? {} : { proposal })
  };
}

// Parse one redacted snapshot without accepting arrays or scalar JSON.
function snapshot(serialized: string): ReturnType<typeof PersistedJsonObjectSchema.parse> {
  return parseJson(PersistedJsonObjectSchema, serialized);
}

// Reject persisted lifecycle, Proposal and decision fields that cannot describe one real state.
function validatePersistedState(row: CaseAnalysisRow, output: AnalysisResultDraft | null): void {
  const proposal = output?.proposal;
  if (row.analysis_status !== "SUCCEEDED") {
    if (
      row.decision !== "NO_PROPOSAL" ||
      row.apply_status !== "NOT_APPLICABLE" ||
      row.base_definition_hash !== null ||
      row.applied_definition_hash !== null
    ) {
      throw new SqliteRowInvalidError();
    }
    if (row.analysis_status === "ERROR") {
      if (
        row.error_code === null ||
        row.error_code.trim() === "" ||
        row.error_message === null ||
        row.error_message.trim() === ""
      ) {
        throw new SqliteRowInvalidError();
      }
      return;
    }
    if (
      row.analysis_result_hash !== null ||
      row.error_code !== null ||
      row.error_message !== null
    ) {
      throw new SqliteRowInvalidError();
    }
    return;
  }

  if (output === null || !validateAnalysisResult(output).ok) throw new SqliteRowInvalidError();
  if (row.error_code !== null || row.error_message !== null) throw new SqliteRowInvalidError();
  if (proposal === undefined) {
    if (
      row.decision !== "NO_PROPOSAL" ||
      row.apply_status !== "NOT_APPLICABLE" ||
      row.base_definition_hash !== null ||
      row.applied_definition_hash !== null
    ) {
      throw new SqliteRowInvalidError();
    }
    return;
  }
  if (
    row.base_definition_hash !== proposal.baseDefinitionHash ||
    !HASH_PATTERN.test(row.base_definition_hash)
  ) {
    throw new SqliteRowInvalidError();
  }
  if (row.decision === "PENDING" || row.decision === "REJECTED") {
    if (row.apply_status !== "NOT_APPLIED" || row.applied_definition_hash !== null) {
      throw new SqliteRowInvalidError();
    }
    return;
  }
  if (row.decision !== "ACCEPTED" && row.decision !== "EDITED_AND_ACCEPTED") {
    throw new SqliteRowInvalidError();
  }
  if (row.apply_status === "APPLIED") {
    if (row.applied_definition_hash === null || !HASH_PATTERN.test(row.applied_definition_hash)) {
      throw new SqliteRowInvalidError();
    }
    return;
  }
  if (row.apply_status !== "CONFLICT" || row.applied_definition_hash !== null) {
    throw new SqliteRowInvalidError();
  }
}

// Recompute the semantic terminal identity rather than trusting its persisted copy.
function validateResultHash(row: CaseAnalysisRow, output: AnalysisResultDraft | null): void {
  if (row.analysis_status === "PENDING" || row.analysis_status === "RUNNING") return;
  if (row.analysis_result_hash === null) throw new SqliteRowInvalidError();
  const result =
    row.analysis_status === "ERROR"
      ? { status: "ERROR" as const, errorCode: row.error_code ?? "" }
      : {
          status: "SUCCEEDED" as const,
          classification: output?.classification ?? "NORMAL_FAILURE",
          confidence: output?.confidence ?? Number.NaN,
          evidence: output?.evidence ?? [],
          explanation: output?.explanation ?? "",
          recommendedAction: output?.recommendedAction ?? "",
          proposal: output?.proposal === undefined ? null : analysisProposalJson(output.proposal)
        };
  const expected = hashAnalysisResult({
    contractVersion: "cortex.analysis-result.v1",
    caseKey: row.case_key,
    finalCaseResultHash: row.final_case_result_hash,
    analysisInputHash: row.analysis_input_hash,
    result
  });
  if (expected !== row.analysis_result_hash) throw new SqliteRowInvalidError();
}

/** Map and cross-check one persisted current Analysis row. */
export function mapCurrentCaseAnalysis(row: CaseAnalysisRow): CurrentCaseAnalysis {
  if (
    !Number.isInteger(row.analysis_revision) ||
    row.analysis_revision < 1 ||
    !HASH_PATTERN.test(row.final_case_result_hash) ||
    !HASH_PATTERN.test(row.analysis_prompt_hash) ||
    !HASH_PATTERN.test(row.analyzer_config_hash) ||
    !HASH_PATTERN.test(row.analysis_input_hash)
  ) {
    throw new SqliteRowInvalidError();
  }
  const output = outputFromRow(row);
  const terminal = row.analysis_status === "SUCCEEDED" || row.analysis_status === "ERROR";
  if (terminal !== (row.analysis_result_hash !== null)) throw new SqliteRowInvalidError();
  if (row.analysis_result_hash !== null && !HASH_PATTERN.test(row.analysis_result_hash)) {
    throw new SqliteRowInvalidError();
  }
  if (
    row.analysis_status === "ERROR"
      ? row.error_code === null || row.error_message === null
      : row.error_code !== null || row.error_message !== null
  ) {
    throw new SqliteRowInvalidError();
  }
  validatePersistedState(row, output);
  validateResultHash(row, output);
  const prompt: StoredAnalysisPromptSnapshot = {
    sourceId: row.analysis_prompt_id,
    promptKey: row.analysis_prompt_key,
    promptHash: row.analysis_prompt_hash,
    snapshot: snapshot(row.analysis_prompt_snapshot_json)
  };
  const analyzer: StoredAnalyzerSnapshot = {
    sourceId: row.analyzer_config_id,
    configHash: row.analyzer_config_hash,
    provider: row.analyzer_provider,
    model: row.analyzer_model,
    snapshot: snapshot(row.analyzer_snapshot_json)
  };
  if (
    row.analysis_input_contract_version !== "cortex.analysis-input.v1" ||
    row.analysis_output_contract_version !== "cortex.analysis-output.v1"
  ) {
    throw new SqliteRowInvalidError();
  }
  return {
    id: row.id,
    runId: row.run_id,
    caseKey: row.case_key,
    finalCaseResultHash: row.final_case_result_hash,
    revision: row.analysis_revision,
    prompt,
    analyzer,
    analysisInputContractVersion: "cortex.analysis-input.v1",
    analysisOutputContractVersion: "cortex.analysis-output.v1",
    analysisInputHash: row.analysis_input_hash,
    analysisExecutionLimits: parseJson(
      AnalysisExecutionLimitsSchema,
      row.analysis_execution_limits_json
    ),
    status: row.analysis_status,
    output,
    analysisResultHash: row.analysis_result_hash,
    decision: row.decision,
    applyStatus: row.apply_status,
    baseDefinitionHash: row.base_definition_hash,
    appliedDefinitionHash: row.applied_definition_hash,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/** Serialize one optional pure Domain Proposal into the stable protocol JSON. */
export function serializeAnalysisProposal(value: AnalysisProposalDraft | undefined): string | null {
  return value === undefined ? null : canonicalJson(analysisProposalJson(value));
}

/** Serialize one Prompt snapshot after it has crossed a clean Application boundary. */
export function serializeAnalysisPromptSnapshot(value: StoredAnalysisPromptSnapshot): string {
  return canonicalJson(value.snapshot);
}

/** Serialize one Analyzer snapshot after it has crossed a clean Application boundary. */
export function serializeAnalyzerSnapshot(value: StoredAnalyzerSnapshot): string {
  return canonicalJson(value.snapshot);
}
