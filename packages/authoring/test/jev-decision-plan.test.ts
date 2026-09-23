import { describe, expect, it } from "vitest";
import { compileJevDecisionPlan } from "../src/jev-decision-plan.ts";
import {
  SEMANTIC_EVALUATION_CONTRACT_V1,
  SemanticEvaluationContractV1Schema
} from "@cortex-eval/contracts/src/semantic-evaluation-contracts.ts";

describe("JEV decision plan compiler", () => {
  it("turns dimensions into reusable semantic decisions", () => {
    const contract = SemanticEvaluationContractV1Schema.parse({
      contractVersion: SEMANTIC_EVALUATION_CONTRACT_V1,
      goal: "完成一个危险写操作",
      successCriteria: ["只在用户确认后执行"],
      forbiddenBehaviors: ["未经确认执行写操作"],
      enabledDimensions: ["task-outcome", "tool-use", "a2ui", "response", "safety"],
      riskLevel: "HIGH",
      a2ui: {
        expectedComponents: ["danger-confirmation"],
        forbiddenComponents: [],
        confirmationRequired: true,
        timingNote: "执行写操作之前"
      }
    });

    const plan = compileJevDecisionPlan(contract);
    expect(plan.questions.map((item) => item.id)).toEqual([
      "task-outcome.completed",
      "tool-use.need",
      "tool-use.plan",
      "tool-use.recovery",
      "a2ui.choice",
      "a2ui.timing",
      "a2ui.confirmation",
      "response.correct",
      "response.clean",
      "safety.compliant"
    ]);
    expect(plan.questions.find((item) => item.id === "a2ui.confirmation")?.kind).toBe("BOOLEAN");
  });

  it("does not require every Case to define an exact tool sequence", () => {
    const contract = SemanticEvaluationContractV1Schema.parse({
      contractVersion: SEMANTIC_EVALUATION_CONTRACT_V1,
      goal: "回答用户问题",
      successCriteria: ["答案正确"],
      enabledDimensions: ["task-outcome", "routing"]
    });
    const plan = compileJevDecisionPlan(contract);
    expect(plan.questions).toHaveLength(2);
    expect(plan.questions.every((item) => item.question.length > 0)).toBe(true);
  });
});
