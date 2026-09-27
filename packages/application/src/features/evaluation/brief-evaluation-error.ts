import { hashEvalResult, hashFinalCaseResult } from "@cortex-eval/domain/src/domain-hash-inputs.ts";
import type { ImportedEvalCase } from "./promptfoo-result-importer.ts";

/** Judge uncertainty/invalid evidence is a Case evaluation error, not a zero-quality judgment. */
export function briefEvaluationError(input: {
  readonly item: ImportedEvalCase;
  readonly error: unknown;
  readonly caseDefinitionHash: string;
  readonly restResultHash: string;
}): ImportedEvalCase {
  const known = new Set([
    "BRIEF_JUDGE_REVIEW_REQUIRED",
    "BRIEF_LLM_NOT_CONFIGURED",
    "BRIEF_JUDGE_TIMEOUT",
    "JEV_NOT_CONFIGURED",
    "BRIEF_JUDGE_EVIDENCE_MISSING",
    "BRIEF_JUDGE_DECISION_INVALID",
    "BRIEF_HALLUCINATION_QUOTE_MISSING",
    "BRIEF_OUTPUT_TYPE_MISMATCH",
    "BRIEF_REPLAY_REQUEST_INVALID",
    "BRIEF_TYPE_MISMATCH",
    "BRIEF_SOURCE_REF_MISSING"
  ]);
  const proposed = input.error instanceof Error ? input.error.message.split(":")[0] : undefined;
  const code = proposed !== undefined && known.has(proposed) ? proposed : "BRIEF_JUDGE_FAILED";
  const result = {
    ...input.item,
    status: "EVALUATION_ERROR" as const,
    score: null,
    promptfooSuccess: null,
    reason: `${code}：Brief 裁判未形成可确认结论，请复核或重试；不计为内容零分`,
    evaluationError: { code }
  };
  const evalResultHash = hashEvalResult({
    contractVersion: "cortex.eval-result.v1",
    caseKey: result.caseKey,
    status: result.status,
    promptfooSuccess: null,
    score: null,
    reason: result.reason,
    evaluationError: result.evaluationError,
    assertions: result.assertions,
    diffs: result.diffs,
    metrics: result.metrics
  });
  return {
    ...result,
    evalResultHash,
    finalCaseResultHash: hashFinalCaseResult({
      contractVersion: "cortex.final-case-result.v1",
      caseDefinitionHash: input.caseDefinitionHash,
      restResultHash: input.restResultHash,
      evalResultHash
    })
  };
}
