import type { CurrentCaseAnalysis } from "../src/lib/run-api.ts";
import type { DashboardCase } from "../src/features/runs/run-dashboard-model.ts";
import { RUN_ID } from "./run-test-fixture.ts";
export function traceAnalysisFixture(row: DashboardCase): CurrentCaseAnalysis {
  return {
    contractVersion: "cortex.current-case-analysis.v1",
    id: RUN_ID,
    runId: RUN_ID,
    caseKey: row.caseKey,
    finalCaseResultHash: row.evaluation!.finalCaseResultHash,
    revision: 1,
    prompt: { sourceId: null, promptKey: "analysis", promptHash: "a".repeat(64) },
    analyzer: {
      sourceId: null,
      configHash: "a".repeat(64),
      provider: "OPENAI_COMPATIBLE",
      model: "fixture-analyzer"
    },
    analysisInputHash: "a".repeat(64),
    analysisExecutionLimits: {
      contractVersion: "cortex.analysis-execution-limits.v1",
      analysisConcurrency: 1
    },
    status: "SUCCEEDED",
    output: {
      contractVersion: "cortex.analysis-output.v1",
      classification: "NORMAL_FAILURE",
      confidence: 0.8,
      evidence: [
        {
          source: "provider_output",
          fieldPath: "/parsedOutput/timeline/0/payload/tool_call/name",
          conclusion: "检查工具选择是否符合查询要求"
        }
      ],
      explanation: "需核对工具参数",
      recommendedAction: "对照业务规则人工确认",
      proposal: null
    },
    analysisResultHash: "a".repeat(64),
    decision: "NO_PROPOSAL",
    applyStatus: "NOT_APPLICABLE",
    baseDefinitionHash: "a".repeat(64),
    appliedDefinitionHash: null,
    errorCode: null,
    errorMessage: null,
    createdAt: "2026-09-10T00:00:00Z",
    updatedAt: "2026-09-10T00:00:00Z"
  };
}
