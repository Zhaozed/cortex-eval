import { describe, expect, it } from "vitest";
import { createJevHttpProvider } from "../src/jev-http-provider.ts";

describe("JEV HTTP provider", () => {
  it("maps the platform contract to TypeSafe System One and normalizes typed answers", async () => {
    let received: unknown;
    const provider = createJevHttpProvider(
      {
        providerType: "HTTP",
        endpoint: "https://api.typesafe.ai/v1/systemone",
        model: "jev-latest"
      },
      {
        fetchImpl: (_input, init): Promise<Response> => {
          const body = typeof init?.body === "string" ? init.body : "{}";
          received = JSON.parse(body);
          return Promise.resolve(
            new Response(
              JSON.stringify({
                model: "jev-1.13.0",
                answers: {
                  "task-outcome.completed": {
                    type: "noul",
                    noul: 0.95,
                    confidence: 0.95,
                    reason: "工具调用成功且最终回复与结果一致。",
                    probabilities: { true: 0.95, false: 0.05 },
                    evidence: ["tool_result.status=SUCCESS"]
                  }
                }
              }),
              { status: 200, headers: { "content-type": "application/json" } }
            )
          );
        }
      }
    );
    const decisions = await provider.evaluate({
      contract: {
        contractVersion: "cortex.semantic-evaluation-contract.v1",
        goal: "完成任务",
        evaluatorPrompt: "只依据可见 Trace 判断，不要因措辞漂亮而加分。",
        model: "jev-case-smoke",
        successCriteria: ["完成"],
        forbiddenBehaviors: [],
        enabledDimensions: ["task-outcome"],
        riskLevel: "LOW",
        scorePassThreshold: 0.6,
        toolPolicy: undefined,
        a2ui: undefined,
        context: undefined
      },
      plan: {
        contractVersion: "cortex.semantic-evaluation-contract.v1",
        questions: [
          {
            id: "task-outcome.completed",
            dimension: "task-outcome",
            kind: "BOOLEAN",
            question: "是否完成？",
            blocking: true
          }
        ]
      },
      trace: {
        contractVersion: "cortex.agent-trace.v1",
        task: "完成任务",
        messages: [],
        router: { candidates: [] },
        planner: { steps: [], status: "unknown" },
        toolCalls: [],
        a2ui: [],
        finalAnswer: "完成",
        timing: {},
        raw: {},
        normalizationWarnings: []
      }
    });
    expect(decisions[0]?.value).toBe(true);
    expect(decisions[0]?.probability).toBe(0.95);
    expect(decisions[0]?.providerReason).toBe("工具调用成功且最终回复与结果一致。");
    expect(decisions[0]?.providerResponse).toEqual({
      type: "noul",
      noul: 0.95,
      confidence: 0.95,
      reason: "工具调用成功且最终回复与结果一致。",
      probabilities: { true: 0.95, false: 0.05 },
      evidence: ["tool_result.status=SUCCESS"]
    });
    expect(decisions[0]?.evidence).toContain('JEV evidence: ["tool_result.status=SUCCESS"]');
    expect((received as { model: string }).model).toBe("jev-case-smoke");
    expect(
      (received as { state: { agent_trace: unknown; evaluator_prompt: string } }).state
        .evaluator_prompt
    ).toContain("可见 Trace");
    expect((received as { state: { agent_trace: unknown } }).state.agent_trace).toBeDefined();
    expect(
      (received as { questions: Record<string, { type: string }> }).questions[
        "task-outcome.completed"
      ]?.type
    ).toBe("noul");
  });

  it("maps choice and score answers, including official score indexing", async () => {
    const provider = createJevHttpProvider(
      {
        providerType: "HTTP",
        endpoint: "https://api.typesafe.ai/v1/systemone",
        model: "jev-latest"
      },
      {
        fetchImpl: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                answers: {
                  route: { type: "choice", choice: "tasks", confidence: 0.8 },
                  quality: { type: "score", score: 4, confidence: 0.7 }
                }
              }),
              { status: 200 }
            )
          )
      }
    );
    const decisions = await provider.evaluate({
      contract: {
        contractVersion: "cortex.semantic-evaluation-contract.v1",
        goal: "评测",
        successCriteria: ["路由正确"],
        enabledDimensions: ["routing"],
        riskLevel: "LOW"
      },
      plan: {
        contractVersion: "cortex.semantic-evaluation-contract.v1",
        questions: [
          {
            id: "route",
            dimension: "routing",
            kind: "CHOICE",
            question: "选择路由",
            choices: ["tasks", "calendar"],
            blocking: true
          },
          {
            id: "quality",
            dimension: "routing",
            kind: "SCORE",
            question: "质量",
            scale: { min: 1, max: 5, step: 1 },
            blocking: true
          }
        ]
      },
      trace: {
        contractVersion: "cortex.agent-trace.v1",
        task: "评测",
        messages: [],
        router: { candidates: [] },
        planner: { steps: [], status: "unknown" },
        toolCalls: [],
        a2ui: [],
        finalAnswer: "",
        timing: {},
        raw: {},
        normalizationWarnings: []
      }
    });
    expect(decisions.map((item) => item.value)).toEqual(["tasks", 5]);
  });
  it("preserves only a safe bounded diagnostic for an HTTP error response", async () => {
    const provider = createJevHttpProvider(
      {
        providerType: "HTTP",
        endpoint: "https://api.typesafe.ai/v1/systemone",
        model: "jev-latest"
      },
      {
        fetchImpl: () =>
          Promise.resolve(
            new Response(JSON.stringify({ detail: { error_type: "max_tokens_exceeded" } }), {
              status: 400,
              headers: { "content-type": "application/json" }
            })
          )
      }
    );

    await expect(
      provider.evaluate({
        contract: {
          contractVersion: "cortex.semantic-evaluation-contract.v1",
          goal: "评测",
          successCriteria: ["完成"],
          enabledDimensions: ["task-outcome"],
          riskLevel: "LOW"
        },
        plan: {
          contractVersion: "cortex.semantic-evaluation-contract.v1",
          questions: [
            {
              id: "completed",
              dimension: "task-outcome",
              kind: "BOOLEAN",
              question: "是否完成？",
              blocking: true
            }
          ]
        },
        trace: {
          contractVersion: "cortex.agent-trace.v1",
          task: "评测",
          messages: [],
          router: { candidates: [] },
          planner: { steps: [], status: "unknown" },
          toolCalls: [],
          a2ui: [],
          finalAnswer: "",
          timing: {},
          raw: {},
          normalizationWarnings: []
        }
      })
    ).rejects.toThrow("JEV_HTTP_FAILED:400:MAX_TOKENS_EXCEEDED");
  });
});
