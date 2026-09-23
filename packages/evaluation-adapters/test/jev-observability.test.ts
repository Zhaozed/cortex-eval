import { JsonObjectSchema } from "@cortex-eval/contracts/src/contracts-primitives.ts";
import type { PlatformSemanticEvaluation } from "@cortex-eval/application/src/features/evaluation/semantic-evaluation-port.ts";
import { describe, expect, it } from "vitest";
import {
  SemanticEvaluationContractV1Schema,
  JevCaseEvaluationV1Schema
} from "@cortex-eval/contracts/src/semantic-evaluation-contracts.ts";
import type { CaseDefinition } from "@cortex-eval/domain/src/domain-evaluation.ts";
import { compileJevDecisionPlan } from "@cortex-eval/authoring/src/jev-decision-plan.ts";
import { createJevSemanticEvaluator } from "../src/jev-semantic-evaluator.ts";
import { createJevHttpProvider } from "../src/jev-http-provider.ts";
import { aggregateJevDecisions, type JevProvider } from "../src/jev-evaluator.ts";
import { normalizeAgentTrace } from "../src/jev-trace-normalizer.ts";

const contract = SemanticEvaluationContractV1Schema.parse({
  contractVersion: "cortex.semantic-evaluation-contract.v1",
  goal: "查询任务",
  successCriteria: ["返回真实结果"],
  enabledDimensions: ["task-outcome"],
  riskLevel: "LOW"
});
const plan = compileJevDecisionPlan(contract);
const request = { contract, plan, trace: normalizeAgentTrace({ task: "查询任务" }) };
const definition: CaseDefinition = {
  caseKey: "test",
  description: "test",
  threshold: 1,
  task: "agent-e2e",
  requestBody: { text: "查询今天未完成任务" },
  metadata: { requestId: "request", taskId: "task", businessModule: "task", scenarioTag: "test" },
  assertions: [],
  semanticEvaluation: JsonObjectSchema.parse(contract)
};

describe("JEV observability", () => {
  it.each([
    [
      { input_tokens: 11256, output_tokens: 209 },
      { inputTokens: 11256, outputTokens: 209 }
    ],
    [
      { input_tokens: 0, output_tokens: 0 },
      { inputTokens: 0, outputTokens: 0 }
    ],
    [{ input_tokens: -1, output_tokens: "209" }, {}],
    [{ input_tokens: 1.5, output_tokens: Number.MAX_SAFE_INTEGER + 1 }, {}],
    [undefined, {}]
  ])("keeps only real nonnegative integer usage: %j", async (usage, expected) => {
    const provider = createJevHttpProvider(
      { providerType: "HTTP" },
      {
        fetchImpl: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                usage,
                answers: Object.fromEntries(
                  plan.questions.map((q) => [q.id, { type: "noul", noul: 0.9 }])
                )
              })
            )
          )
      }
    );
    let recorded: unknown;
    await provider.evaluate(request, undefined, (value) => {
      recorded = value;
    });
    expect(recorded).toEqual(expected);
  });

  it("isolates usage across concurrent Cases and separates Agent latency from judge latency", async () => {
    const provider: JevProvider = {
      id: "fake",
      async evaluate(input, _signal, onUsage) {
        const first = input.trace.task === "查询今天未完成任务";
        expect(input.trace.timing.durationMs).toBe(23985);
        await new Promise((resolve) => setTimeout(resolve, first ? 15 : 1));
        onUsage?.({ inputTokens: first ? 11256 : 10, outputTokens: first ? 209 : 0 });
        return input.plan.questions.map((q) => ({ questionId: q.id, kind: q.kind, value: true }));
      }
    };
    const evaluator = createJevSemanticEvaluator({ provider });
    const run = (caseDefinition: CaseDefinition): Promise<PlatformSemanticEvaluation> =>
      evaluator.evaluate({
        caseDefinition,
        providerOutput: {
          ok: false,
          errorMessage: "fixture",
          parsedOutput: { final_answer: "无任务" }
        },
        durationMs: 23985,
        signal: new AbortController().signal
      });
    const [first, second] = await Promise.all([
      run(definition),
      run({ ...definition, requestBody: { text: "other" } })
    ]);
    expect(first.metrics).toMatchObject({
      requestCount: 1,
      inputTokens: 11256,
      outputTokens: 209,
      usageComplete: true
    });
    expect(second.metrics).toMatchObject({ inputTokens: 10, outputTokens: 0 });
    expect(first.metrics?.durationMs).toBeLessThan(23985);
    expect(JevCaseEvaluationV1Schema.parse(first)).toEqual(first);
  });

  it("preserves missing usage as unknown", async () => {
    const evaluator = createJevSemanticEvaluator({
      provider: {
        id: "legacy",
        evaluate(input) {
          return Promise.resolve(
            input.plan.questions.map((q) => ({ questionId: q.id, kind: q.kind, value: true }))
          );
        }
      }
    });
    const result = await evaluator.evaluate({
      caseDefinition: definition,
      providerOutput: { ok: false, errorMessage: "fixture" },
      signal: new AbortController().signal
    });
    expect(result.metrics).toMatchObject({ usageComplete: false, requestCount: 1 });
    expect(result.metrics).not.toHaveProperty("inputTokens");
  });

  it("saves a nonblocking FAIL independently from overall PASS", () => {
    const q = {
      id: "quality",
      question: "是否正确？",
      dimension: "response" as const,
      kind: "BOOLEAN" as const,
      blocking: false
    };
    const result = aggregateJevDecisions(contract, { ...plan, questions: [q] }, [
      {
        questionId: q.id,
        kind: "BOOLEAN",
        value: false,
        applicable: true,
        evidence: [],
        evidenceRefs: []
      }
    ]);
    expect(result.passed).toBe(true);
    expect(result.decisions[0]).toMatchObject({
      verdict: "FAIL",
      blocking: false,
      question: q.question
    });
  });
});
