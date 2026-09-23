import { describe, expect, it } from "vitest";
import { compileJevDecisionPlan } from "../../authoring/src/jev-decision-plan.ts";
import {
  SEMANTIC_EVALUATION_CONTRACT_V1,
  SemanticEvaluationContractV1Schema
} from "@cortex-eval/contracts/src/semantic-evaluation-contracts.ts";
import { evaluateWithJev, type JevProvider } from "../src/jev-evaluator.ts";
import { normalizeAgentTrace } from "../src/jev-trace-normalizer.ts";

describe("JEV evaluator", () => {
  const contract = SemanticEvaluationContractV1Schema.parse({
    contractVersion: SEMANTIC_EVALUATION_CONTRACT_V1,
    goal: "查询会议",
    successCriteria: ["返回真实结果"],
    enabledDimensions: ["task-outcome", "tool-use", "response"],
    riskLevel: "LOW"
  });

  it("normalizes variable provider traces without requiring one exact tool sequence", () => {
    const trace = normalizeAgentTrace({
      task: "查询会议",
      duration_ms: 1200,
      parsed_output: {
        tool_executions: [
          {
            tool_request_id: "call-1",
            calls: [{ name: "calendar.search", param: { day: "tomorrow" } }],
            outcome: "success"
          }
        ],
        final_answer: "明天有一个会议。"
      }
    });
    expect(trace.toolCalls[0]?.name).toBe("calendar.search");
    expect(trace.finalAnswer).toBe("明天有一个会议。");
    expect(trace.timing.durationMs).toBe(1200);
  });

  it("aggregates typed JEV decisions into a blocking result", async () => {
    const plan = compileJevDecisionPlan(contract);
    const provider: JevProvider = {
      id: "fake-jev",
      evaluate() {
        return Promise.resolve(
          plan.questions.map((question) => ({
            questionId: question.id,
            kind: question.kind,
            value: question.kind === "SCORE" ? 5 : true,
            confidence: 0.9,
            evidence: ["trace evidence"]
          }))
        );
      }
    };
    const result = await evaluateWithJev({
      contract,
      plan,
      trace: normalizeAgentTrace({ task: "查询会议", final_answer: "明天有一个会议。" }),
      provider
    });
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
    expect(result.blockingFailures).toEqual([]);
  });

  it("fails the Case when a blocking semantic decision is false", async () => {
    const plan = compileJevDecisionPlan(contract);
    const provider: JevProvider = {
      id: "fake-jev",
      evaluate() {
        return Promise.resolve(
          plan.questions.map((question) => ({
            questionId: question.id,
            kind: question.kind,
            value: question.id === "task-outcome.completed" ? false : true,
            reason: question.id === "task-outcome.completed" ? "没有完成。" : undefined
          }))
        );
      }
    };
    const result = await evaluateWithJev({
      contract,
      plan,
      trace: normalizeAgentTrace({ task: "查询会议" }),
      provider
    });
    expect(result.passed).toBe(false);
    expect(result.blockingFailures[0]).toContain("task-outcome.completed:");
    expect(result.blockingFailures[0]).not.toContain("未达到通过条件");
    expect(result.decisions[0]?.providerReason).toBe("没有完成。");
    expect(result.decisions[0]?.platformReason).toContain("JEV 判定未通过");
    expect(result.decisions[0]?.evidenceRefs).toContain("trace.task");
  });
  it("does not block or score recovery when no tool failure exists", async () => {
    const contractWithTools = SemanticEvaluationContractV1Schema.parse({
      ...contract,
      enabledDimensions: ["tool-use"],
      toolPolicy: { requiredTools: ["calendar.search"], maxRetries: 0 }
    });
    const plan = compileJevDecisionPlan(contractWithTools);
    const provider: JevProvider = {
      id: "fake-jev",
      evaluate() {
        return Promise.resolve(
          plan.questions.map((question) => ({
            questionId: question.id,
            kind: question.kind,
            value: question.id === "tool-use.recovery" ? false : true
          }))
        );
      }
    };
    const result = await evaluateWithJev({
      contract: contractWithTools,
      plan,
      trace: normalizeAgentTrace({
        task: "查询会议",
        parsed_output: {
          tool_executions: [
            {
              calls: [{ name: "calendar.search", outcome: "success" }]
            }
          ]
        }
      }),
      provider
    });
    const recovery = result.decisions.find((item) => item.questionId === "tool-use.recovery");
    expect(recovery?.applicable).toBe(false);
    expect(result.blockingFailures).not.toContain(expect.stringContaining("tool-use.recovery"));
    expect(result.warnings.some((item) => item.includes("失败恢复不适用"))).toBe(true);
  });
});

describe("JEV platform explanations", () => {
  it("explains missing tools and response facts instead of using a generic fallback", async () => {
    const contractWithRules = SemanticEvaluationContractV1Schema.parse({
      contractVersion: SEMANTIC_EVALUATION_CONTRACT_V1,
      goal: "查询任务",
      successCriteria: ["返回真实任务"],
      responseRequiredFacts: ["任务数量", "任务标题"],
      responseForbiddenClaims: ["任务不存在"],
      enabledDimensions: ["tool-use", "response", "a2ui"],
      toolPolicy: {
        allowedTools: ["list_task_collections", "list_tasks"],
        requiredTools: ["list_task_collections", "list_tasks"],
        requiredOrder: ["list_task_collections", "list_tasks"],
        maxRetries: 0
      },
      a2ui: { expectedComponents: ["InfoChip", "List"] }
    });
    const plan = compileJevDecisionPlan(contractWithRules);
    const trace = normalizeAgentTrace({
      task: "查询任务",
      parsed_output: {
        tool_executions: [
          {
            calls: [{ name: "list_tasks", outcome: "success" }],
            terminals: [
              {
                tool_result: {
                  status: "SUCCESS",
                  result: { total: 1, tasks: [{ title: "发布" }] }
                }
              }
            ]
          }
        ],
        a2ui: [
          {
            source_tool_name: "list_tasks",
            messages: [{ updateComponents: { components: [{ component: "InfoChip" }] } }]
          }
        ],
        reply_text: "任务不存在"
      }
    });
    const provider: JevProvider = {
      id: "fake-jev",
      evaluate() {
        return Promise.resolve(
          plan.questions.map((question) => ({
            questionId: question.id,
            kind: question.kind,
            value:
              question.id === "tool-use.plan" || question.id === "response.correct" ? false : true
          }))
        );
      }
    };
    const result = await evaluateWithJev({ contract: contractWithRules, plan, trace, provider });
    const tool = result.decisions.find((item) => item.questionId === "tool-use.plan");
    const response = result.decisions.find((item) => item.questionId === "response.correct");
    const a2ui = result.decisions.find((item) => item.questionId === "a2ui.choice");
    expect(tool?.platformReason).toContain("缺少必需工具");
    expect(tool?.platformReason).toContain("未按顺序观察到");
    expect(response?.platformReason).toContain("命中禁止输出");
    expect(response?.platformReason).toContain("要求覆盖");
    expect(a2ui?.platformReason).not.toContain("缺少必需组件");
    expect(result.blockingFailures.join("\n")).not.toContain("未达到通过条件");
  });
});
