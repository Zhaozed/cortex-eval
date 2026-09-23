import type { DomainJsonValue } from "@cortex-eval/domain/src/domain-canonical-hash.ts";
import { hashEvalResult, hashFinalCaseResult } from "@cortex-eval/domain/src/domain-hash-inputs.ts";

import type { ImportedEvalCase } from "./promptfoo-result-importer.ts";
import type { PlatformSemanticEvaluation } from "./semantic-evaluation-port.ts";

/** Attach one JEV result and recompute all identities affected by semantic grading. */
export function enrichEvalCaseWithSemanticEvaluation(input: {
  readonly item: ImportedEvalCase;
  readonly semanticEvaluation: PlatformSemanticEvaluation;
  readonly caseDefinitionHash: string;
  readonly restResultHash: string;
}): ImportedEvalCase {
  const { item, semanticEvaluation } = input;
  if (item.status !== "PASS" && item.status !== "FAIL") {
    throw new Error("JEV_RESULT_STATUS_UNSUPPORTED");
  }
  const semanticPassed = semanticEvaluation.result.passed;
  const status = item.status === "PASS" && semanticPassed ? "PASS" : "FAIL";
  const promptfooSuccess = item.promptfooSuccess === true && semanticPassed;
  const score =
    item.score === null
      ? null
      : Math.max(0, Math.min(1, Math.min(item.score, semanticEvaluation.result.score)));
  const reason = semanticPassed
    ? item.reason
    : [item.reason, ...semanticEvaluation.result.blockingFailures]
        .filter((value): value is string => value !== null && value.trim() !== "")
        .join("; ") || "JEV semantic evaluation failed";
  const evalResultHash = hashEvalResult({
    contractVersion: "cortex.eval-result.v1",
    caseKey: item.caseKey,
    status,
    promptfooSuccess,
    score,
    reason,
    evaluationError: item.evaluationError,
    assertions: item.assertions,
    diffs: item.diffs,
    metrics: item.metrics,
    semanticEvaluation: semanticEvaluation as unknown as DomainJsonValue
  });
  return {
    ...item,
    status,
    promptfooSuccess,
    score,
    reason,
    semanticEvaluation,
    evalResultHash,
    finalCaseResultHash: hashFinalCaseResult({
      contractVersion: "cortex.final-case-result.v1",
      caseDefinitionHash: input.caseDefinitionHash,
      restResultHash: input.restResultHash,
      evalResultHash
    })
  };
}
