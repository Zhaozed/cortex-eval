import type { CurrentCaseAnalysis } from "@cortex-eval/application/src/features/case-analysis/case-analysis-models.ts";
import {
  AnalysisProposalV1Schema,
  CurrentCaseAnalysisV1Schema,
  type CurrentCaseAnalysisV1
} from "@cortex-eval/contracts/src/analysis-contracts.ts";
import { analysisProposalJson } from "@cortex-eval/domain/src/domain-analysis-projection.ts";

/** Project one clean current Analysis without exposing full frozen configuration snapshots. */
export function currentCaseAnalysisV1(value: CurrentCaseAnalysis): CurrentCaseAnalysisV1 {
  const output = value.output;
  return CurrentCaseAnalysisV1Schema.parse({
    contractVersion: "cortex.current-case-analysis.v1",
    id: value.id,
    runId: value.runId,
    caseKey: value.caseKey,
    finalCaseResultHash: value.finalCaseResultHash,
    revision: value.revision,
    prompt: {
      sourceId: value.prompt.sourceId,
      promptKey: value.prompt.promptKey,
      promptHash: value.prompt.promptHash
    },
    analyzer: {
      sourceId: value.analyzer.sourceId,
      configHash: value.analyzer.configHash,
      provider: value.analyzer.provider,
      model: value.analyzer.model
    },
    analysisInputHash: value.analysisInputHash,
    analysisExecutionLimits: value.analysisExecutionLimits,
    status: value.status,
    output:
      output === null
        ? null
        : {
            contractVersion: "cortex.analysis-output.v1",
            classification: output.classification,
            confidence: output.confidence,
            evidence: output.evidence,
            explanation: output.explanation,
            recommendedAction: output.recommendedAction,
            proposal:
              output.proposal === undefined
                ? null
                : AnalysisProposalV1Schema.parse(analysisProposalJson(output.proposal))
          },
    analysisResultHash: value.analysisResultHash,
    decision: value.decision,
    applyStatus: value.applyStatus,
    baseDefinitionHash: value.baseDefinitionHash,
    appliedDefinitionHash: value.appliedDefinitionHash,
    errorCode: value.errorCode,
    errorMessage: value.errorMessage,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  });
}
