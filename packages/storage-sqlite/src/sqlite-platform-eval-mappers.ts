import type { PlatformEvalCaseResult } from "@cortex-eval/application/src/features/evaluation/platform-eval-models.ts";
import {
  canonicalJson,
  type DomainJsonValue
} from "@cortex-eval/domain/src/domain-canonical-hash.ts";
import { hashEvalResult, hashFinalCaseResult } from "@cortex-eval/domain/src/domain-hash-inputs.ts";
import type { Insertable } from "kysely";
import { z } from "zod";

import { SqliteRowInvalidError } from "./sqlite-row-mappers.ts";
import type { EvalResultTable } from "./sqlite-schema.ts";
import { SemanticEvaluationSchema } from "./sqlite-semantic-evaluation-schemas.ts";

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const JsonValueSchema: z.ZodType<DomainJsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema)
  ])
);
const AssertionSchema = z.strictObject({
  index: z.number().int().nonnegative(),
  definitionHash: Sha256Schema,
  type: z.string().trim().min(1),
  metric: z.string().trim().min(1),
  weight: z.number().nonnegative(),
  status: z.enum(["PASS", "FAIL", "ERROR", "SKIPPED"]),
  score: z.number().nullable(),
  reason: z.string().trim().min(1).nullable()
});
const DiffSchema = z.strictObject({
  assertionIndex: z.number().int().nonnegative(),
  instancePath: z.string(),
  schemaPath: z.string().min(1),
  keyword: z.string().min(1),
  expectedConstraint: JsonValueSchema,
  actual: JsonValueSchema,
  reason: z.string().trim().min(1),
  validatorVersion: z.string().trim().min(1),
  schemaDialect: z.string().trim().min(1),
  diffContractVersion: z.literal("cortex.assertion-diff.v1")
});
const MetricSchema = z.strictObject({
  metric: z.string().trim().min(1),
  status: z.enum(["PASS", "FAIL", "ERROR", "SKIPPED", "NOT_EVALUATED"])
});
const TokenUsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative()
});
const EvidenceSchema = z.strictObject({
  present: z.literal(true),
  path: z.string().trim().min(1),
  expectedSha256: Sha256Schema,
  expectedSizeBytes: z.number().int().nonnegative()
});
const ProvenanceSchema = z.strictObject({
  sourceKind: z.enum(["RUN", "EXECUTION"]),
  sourceId: z.uuid(),
  sourceResultHash: Sha256Schema
});
const EvalCaseStorageSchema = z
  .strictObject({
    caseKey: z.string().trim().min(1),
    ordinal: z.number().int().nonnegative(),
    status: z.enum(["PASS", "FAIL", "EVALUATION_ERROR", "NOT_EVALUATED"]),
    promptfooSuccess: z.boolean().nullable(),
    score: z.number().nullable(),
    reason: z.string().trim().min(1).nullable(),
    evaluationError: z.strictObject({ code: z.string().trim().min(1) }).nullable(),
    assertions: z.array(AssertionSchema),
    diffs: z.array(DiffSchema),
    metrics: z.array(MetricSchema),
    semanticEvaluation: SemanticEvaluationSchema.nullable(),
    latencyMs: z.number().nonnegative().nullable(),
    tokenUsage: TokenUsageSchema.nullable(),
    cost: z.number().nonnegative().nullable(),
    rawEvidence: EvidenceSchema.nullable(),
    evalResultHash: Sha256Schema,
    finalCaseResultHash: Sha256Schema,
    provenance: ProvenanceSchema.nullable()
  })
  .superRefine((value, context) => {
    const observed = value.status === "PASS" || value.status === "FAIL";
    if (
      (observed &&
        (value.promptfooSuccess !== (value.status === "PASS") ||
          value.score === null ||
          value.evaluationError !== null)) ||
      (value.status === "EVALUATION_ERROR" &&
        (value.promptfooSuccess !== null ||
          value.score !== null ||
          value.evaluationError === null)) ||
      (value.status === "NOT_EVALUATED" &&
        (value.promptfooSuccess !== null ||
          value.score !== null ||
          value.reason !== null ||
          value.evaluationError !== null ||
          value.assertions.length !== 0 ||
          value.diffs.length !== 0 ||
          value.latencyMs !== null ||
          value.tokenUsage !== null ||
          value.cost !== null ||
          value.rawEvidence !== null))
    ) {
      context.addIssue({ code: "custom", message: "EVAL_STATUS_SHAPE" });
    }
  });

/** Eval row plus joined frozen identity facts required for semantic verification. */
export interface EvalResultRowProjection extends EvalResultTable {
  /** Frozen Case order from the REST result. */
  readonly ordinal: number;
  /** Frozen Case definition hash. */
  readonly case_definition_hash: string;
  /** Semantic REST result hash. */
  readonly run_result_hash: string;
}

// Parse one JSON field and collapse parser details into the storage boundary error.
function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new SqliteRowInvalidError();
  }
}

// Convert persisted provenance columns into the normalized Artifact shape.
function mapProvenance(row: EvalResultTable): PlatformEvalCaseResult["provenance"] {
  if (row.reused_eval_result_hash === null) {
    if (row.reused_from_run_id !== null || row.reused_from_execution_id !== null) {
      throw new SqliteRowInvalidError();
    }
    return null;
  }
  if ((row.reused_from_run_id === null) === (row.reused_from_execution_id === null)) {
    throw new SqliteRowInvalidError();
  }
  if (row.reused_from_run_id !== null) {
    return {
      sourceKind: "RUN",
      sourceId: row.reused_from_run_id,
      sourceResultHash: row.reused_eval_result_hash
    };
  }
  const executionId = row.reused_from_execution_id;
  if (executionId === null) throw new SqliteRowInvalidError();
  return {
    sourceKind: "EXECUTION",
    sourceId: executionId,
    sourceResultHash: row.reused_eval_result_hash
  };
}

// Recompute the semantic Eval hash from normalized facts only.
function semanticEvalResultHash(
  value: PlatformEvalCaseResult,
  semanticEvaluation: DomainJsonValue | undefined =
    value.semanticEvaluation == null
      ? undefined
      : (value.semanticEvaluation as unknown as DomainJsonValue)
): string {
  return hashEvalResult({
    contractVersion: "cortex.eval-result.v1",
    caseKey: value.caseKey,
    status: value.status,
    promptfooSuccess: value.promptfooSuccess,
    score: value.score,
    reason: value.reason,
    evaluationError: value.evaluationError,
    assertions: value.assertions,
    diffs: value.diffs,
    metrics: value.metrics,
    ...(semanticEvaluation === undefined ? {} : { semanticEvaluation })
  });
}

/**
 * Historical Eval rows were persisted before semantic evaluation became part of the
 * per-Case hash. Keep those immutable rows readable while all new rows use the
 * semantic-aware hash above.
 */
function legacySemanticEvalResultHash(value: PlatformEvalCaseResult): string {
  return hashEvalResult({
    contractVersion: "cortex.eval-result.v1",
    caseKey: value.caseKey,
    status: value.status,
    promptfooSuccess: value.promptfooSuccess,
    score: value.score,
    reason: value.reason,
    evaluationError: value.evaluationError,
    assertions: value.assertions,
    diffs: value.diffs,
    metrics: value.metrics
  });
}

/** Return whether one normalized Eval result owns its declared semantic hash. */
export function platformEvalResultHashMatches(value: PlatformEvalCaseResult): boolean {
  return semanticEvalResultHash(value) === value.evalResultHash;
}

/** Convert one normalized Eval result into exact SQLite insert values. */
export function evalResultInsertValues(value: PlatformEvalCaseResult): Insertable<EvalResultTable> {
  const parsed = EvalCaseStorageSchema.safeParse({
    caseKey: value.caseKey,
    ordinal: value.ordinal,
    status: value.status,
    promptfooSuccess: value.promptfooSuccess,
    score: value.score,
    reason: value.reason,
    evaluationError: value.evaluationError,
    assertions: value.assertions,
    diffs: value.diffs,
    metrics: value.metrics,
    semanticEvaluation: value.semanticEvaluation ?? null,
    latencyMs: value.latencyMs,
    tokenUsage: value.tokenUsage,
    cost: value.cost,
    rawEvidence: value.rawEvidence,
    evalResultHash: value.evalResultHash,
    finalCaseResultHash: value.finalCaseResultHash,
    provenance: value.provenance
  });
  if (!parsed.success || !platformEvalResultHashMatches(value)) {
    throw new SqliteRowInvalidError();
  }
  return {
    run_id: value.runId,
    case_key: value.caseKey,
    eval_status: value.status,
    promptfoo_success: value.promptfooSuccess === null ? null : value.promptfooSuccess ? 1 : 0,
    score: value.score,
    reason: value.reason,
    evaluation_error: value.evaluationError === null ? null : canonicalJson(value.evaluationError),
    assertion_results_json: canonicalJson(value.assertions.map((item) => ({ ...item }))),
    expected_actual_diffs_json: canonicalJson(value.diffs.map((item) => ({ ...item }))),
    metric_results_json: canonicalJson(value.metrics.map((item) => ({ ...item }))),
    latency_ms: value.latencyMs,
    token_usage_json: value.tokenUsage === null ? null : canonicalJson({ ...value.tokenUsage }),
    cost: value.cost,
    semantic_evaluation_json:
      value.semanticEvaluation === null || value.semanticEvaluation === undefined
        ? null
        : canonicalJson(value.semanticEvaluation as unknown as DomainJsonValue),
    allowlist_raw_evidence_json:
      value.rawEvidence === null ? canonicalJson(null) : canonicalJson({ ...value.rawEvidence }),
    eval_result_hash: value.evalResultHash,
    final_case_result_hash: value.finalCaseResultHash,
    reused_from_run_id: value.provenance?.sourceKind === "RUN" ? value.provenance.sourceId : null,
    reused_from_execution_id:
      value.provenance?.sourceKind === "EXECUTION" ? value.provenance.sourceId : null,
    reused_eval_result_hash: value.provenance?.sourceResultHash ?? null,
    created_at: value.createdAt,
    updated_at: value.updatedAt
  };
}

/** Map and semantically verify one persisted normalized Eval result. */
export function mapPlatformEvalResult(row: EvalResultRowProjection): PlatformEvalCaseResult {
  const provenance = mapProvenance(row);
  const semanticEvaluationJson = (row as unknown as {
    readonly semantic_evaluation_json?: string | null;
  }).semantic_evaluation_json;
  const parsed = EvalCaseStorageSchema.safeParse({
    caseKey: row.case_key,
    ordinal: row.ordinal,
    status: row.eval_status,
    promptfooSuccess:
      row.promptfoo_success === null ? null : row.promptfoo_success === 1 ? true : false,
    score: row.score,
    reason: row.reason,
    evaluationError: row.evaluation_error === null ? null : parseJson(row.evaluation_error),
    assertions: parseJson(row.assertion_results_json),
    diffs: parseJson(row.expected_actual_diffs_json),
    metrics: parseJson(row.metric_results_json),
    semanticEvaluation:
      semanticEvaluationJson === null || semanticEvaluationJson === undefined
        ? null
        : parseJson(semanticEvaluationJson),
    latencyMs: row.latency_ms,
    tokenUsage: row.token_usage_json === null ? null : parseJson(row.token_usage_json),
    cost: row.cost,
    rawEvidence: parseJson(row.allowlist_raw_evidence_json),
    evalResultHash: row.eval_result_hash,
    finalCaseResultHash: row.final_case_result_hash,
    provenance
  });
  if (!parsed.success) throw new SqliteRowInvalidError();
  const value = parsed.data;
  const { semanticEvaluation, ...withoutSemanticEvaluation } = value;
  const result: PlatformEvalCaseResult = {
    runId: row.run_id,
    ...withoutSemanticEvaluation,
    ...(semanticEvaluation === null ? {} : { semanticEvaluation }),
    rawEvidence:
      value.rawEvidence === null
        ? null
        : {
            present: true,
            path: value.rawEvidence.path,
            expectedSha256: value.rawEvidence.expectedSha256,
            expectedSizeBytes: value.rawEvidence.expectedSizeBytes
          },
    provenance,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
  // Zod applies defaults to older semantic payloads (for example,
  // `applicable`, `evidence`, and `evidenceRefs`). Validate both the normalized
  // representation returned by this mapper and the exact JSON representation
  // that was used when the historical hash was written.
  const semanticHashCandidates = [
    semanticEvalResultHash(result),
    semanticEvaluationJson === null || semanticEvaluationJson === undefined
      ? null
      : semanticEvalResultHash(result, parseJson(semanticEvaluationJson) as DomainJsonValue),
    legacySemanticEvalResultHash(result)
  ].filter((candidate): candidate is string => candidate !== null);
  const validHashPair = semanticHashCandidates.some((candidate) => {
    if (candidate !== value.evalResultHash) return false;
    return (
      hashFinalCaseResult({
        contractVersion: "cortex.final-case-result.v1",
        caseDefinitionHash: row.case_definition_hash,
        restResultHash: row.run_result_hash,
        evalResultHash: candidate
      }) === value.finalCaseResultHash
    );
  });
  if (!validHashPair) throw new SqliteRowInvalidError();
  return result;
}
