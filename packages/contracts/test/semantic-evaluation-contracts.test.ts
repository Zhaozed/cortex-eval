import { describe, expect, it } from "vitest";
import { CaseDefinitionV1Schema } from "../src/case-contracts.ts";
import {
  JevDecisionPlanV1Schema,
  SemanticEvaluationContractV1Schema,
  SEMANTIC_EVALUATION_CONTRACT_V1
} from "../src/semantic-evaluation-contracts.ts";

describe("semantic evaluation contracts", () => {
  it("accepts a product-facing contract without prescribing an exact trace", () => {
    const result = SemanticEvaluationContractV1Schema.safeParse({
      contractVersion: SEMANTIC_EVALUATION_CONTRACT_V1,
      goal: "查询用户明天下午的会议",
      successCriteria: ["返回真实会议安排"],
      forbiddenBehaviors: ["未查询日历就虚构结果"],
      enabledDimensions: ["task-outcome", "routing", "tool-use", "response", "safety"],
      riskLevel: "LOW",
      toolPolicy: {
        allowedTools: ["calendar.search"],
        requiredTools: [],
        forbiddenTools: [],
        maxRetries: 1
      }
    });
    expect(result.success).toBe(true);
  });

  it("can be carried as an optional field on a Case without changing legacy Cases", () => {
    const result = CaseDefinitionV1Schema.safeParse({
      contractVersion: "cortex.case-definition.v1",
      description: "semantic case",
      threshold: 1,
      vars: { task: "test", request_body: {} },
      metadata: {
        case_id: "case-1",
        req_id: "req-1",
        task_id: "task-1",
        business_module: "test",
        scenario_tag: "semantic"
      },
      semanticEvaluation: {
        contractVersion: SEMANTIC_EVALUATION_CONTRACT_V1,
        goal: "完成任务",
        successCriteria: ["结果正确"],
        enabledDimensions: ["task-outcome"]
      },
      assert: [{ type: "javascript", metric: "basic", value: "return {pass:true,score:1}" }]
    });
    expect(result.success).toBe(true);
  });

  it("rejects duplicated dimensions and invalid typed question shapes", () => {
    expect(
      SemanticEvaluationContractV1Schema.safeParse({
        contractVersion: SEMANTIC_EVALUATION_CONTRACT_V1,
        goal: "test",
        successCriteria: ["done"],
        enabledDimensions: ["routing", "routing"]
      }).success
    ).toBe(false);
    expect(
      JevDecisionPlanV1Schema.safeParse({
        contractVersion: SEMANTIC_EVALUATION_CONTRACT_V1,
        questions: [
          {
            id: "routing.correct",
            dimension: "routing",
            kind: "CHOICE",
            question: "选择正确路由"
          }
        ]
      }).success
    ).toBe(false);
  });
});
