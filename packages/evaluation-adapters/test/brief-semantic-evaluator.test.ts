import { JsonObjectSchema } from "@cortex-eval/contracts/src/contracts-primitives.ts";
import type { JevEvaluationRequestV1 } from "@cortex-eval/contracts/src/semantic-evaluation-contracts.ts";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { CaseDefinitionV1Schema } from "@cortex-eval/contracts/src/case-contracts.ts";
import { compileJevDecisionPlan } from "@cortex-eval/authoring/src/jev-decision-plan.ts";
import { evaluateBrief } from "../src/brief-semantic-evaluator.ts";
import { createJevSemanticEvaluator } from "../src/jev-semantic-evaluator.ts";
import type { JevProvider, JevProviderDecision } from "../src/jev-evaluator.ts";
import { createJevHttpProvider } from "../src/jev-http-provider.ts";
import { prepareRestRequest } from "../src/rest-request-preparer.ts";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("fixture");
  return value;
}

function fixture(
  type: "daily" | "meeting" = "daily"
): ReturnType<typeof CaseDefinitionV1Schema.parse> {
  return CaseDefinitionV1Schema.parse(
    JSON.parse(
      readFileSync(
        new URL(`../../../test_suite/brief-content/${type}.case.json`, import.meta.url),
        "utf8"
      )
    )
  );
}
function setup(
  type: "daily" | "meeting" = "daily",
  answers: Record<string, string> = {}
): {
  definition: ReturnType<typeof fixture>;
  contract: NonNullable<ReturnType<typeof fixture>["semanticEvaluation"]>;
  plan: ReturnType<typeof compileJevDecisionPlan>;
  provider: JevProvider;
  requestBody: ReturnType<typeof fixture>["vars"]["request_body"];
  parsedOutput: {
    brief_type: "daily" | "meeting";
    generation_status: string;
    presentation_status: string;
    llm_called: boolean;
    delivered: boolean;
    output: { text: string; cards: { title: string }[] };
    model_input: { private: string };
    model_result: { hidden: string };
  };
} {
  const definition = fixture(type);
  const contract = required(definition.semanticEvaluation);
  const plan = compileJevDecisionPlan(contract);
  const provider: JevProvider = {
    id: "fake-judge",
    evaluate: vi.fn((request: JevEvaluationRequestV1): Promise<readonly JevProviderDecision[]> =>
      Promise.resolve(
        request.plan.questions.map((q) => ({
          questionId: q.id,
          kind: q.kind,
          value: answers[q.id] ?? "PASS",
          reason: "材料支持；已核对最终输出",
          evidence: ["确认20个核心案例"]
        }))
      )
    )
  };
  return {
    definition,
    contract,
    plan,
    provider,
    requestBody: definition.vars.request_body,
    parsedOutput: {
      brief_type: type,
      generation_status: "generated",
      presentation_status: "cards",
      llm_called: true,
      delivered: false,
      output: { text: "确认20个核心案例", cards: [{ title: "确认脱敏权限" }] },
      model_input: { private: "不能作为输出" },
      model_result: { hidden: "也不是最终输出" }
    }
  };
}

describe("Brief atomic replay evaluator", () => {
  it.each(["daily", "meeting"] as const)(
    "%s uses each atomic ID and full frozen material, not live IO or model_input",
    async (type) => {
      const input = setup(type);
      const result = await evaluateBrief(input);
      expect(result.passed).toBe(true);
      expect(result.score).toBeCloseTo(1);
      expect(input.plan.questions.every((q) => q.id.startsWith("brief."))).toBe(true);
      expect(input.plan.questions).toHaveLength(
        required(input.contract.brief).checklist.length + 2
      );
      const call = vi.mocked(input.provider).evaluate.mock.calls[0];
      expect(call?.[0].trace.raw).toEqual({
        bundle: input.requestBody.bundle,
        generated: input.parsedOutput.output
      });
      expect(
        result.decisions.find((d) => d.questionId === "brief.P0.core_cases")?.evidenceRefs
      ).toContain(`bundle${required(required(input.contract.brief).checklist[0]).sourceRefs[0]}`);
    }
  );
  it("scores missing P0 independently without making optional P1 a veto", async () => {
    const input = setup("meeting", { "brief.P1.meeting_time": "FAIL" });
    const result = await evaluateBrief({
      ...input,
      contract: { ...input.contract, scorePassThreshold: 0.75 }
    });
    expect(result.score).toBeCloseTo(0.8);
    expect(result.passed).toBe(true);
    const missing = await evaluateBrief(setup("meeting", { "brief.P0.core_cases": "FAIL" }));
    expect(missing.score).toBeCloseTo(0.75);
    expect(missing.passed).toBe(false);
  });
  it("P2 pass means excluded; noise average includes the global noise check", async () => {
    const result = await evaluateBrief(setup("daily", { "brief.P2.evergreen": "FAIL" }));
    expect(result.decisions.find((d) => d.questionId === "brief.metric.noise")?.value).toBe(0.5);
    expect(result.score).toBeCloseTo(0.8125);
  });
  it("renormalizes empty tiers instead of gifting recall", async () => {
    const input = setup();
    required(input.contract.brief).checklist = required(input.contract.brief).checklist.filter(
      (c) => c.tier === "P2"
    );
    input.plan = compileJevDecisionPlan(input.contract);
    const result = await evaluateBrief(input);
    expect(result.score).toBeCloseTo(1);
    expect(result.decisions.find((d) => d.questionId === "brief.metric.P0")?.applicable).toBe(
      false
    );
  });
  it("hallucination is a zero gate only with an actual generated quote", async () => {
    const input = setup("daily", { "brief.grounded": "FAIL" });
    expect((await evaluateBrief(input)).score).toBe(0);
    const original = input.provider.evaluate.bind(input.provider);
    input.provider.evaluate = async (request, signal): Promise<readonly JevProviderDecision[]> =>
      (await original(request, signal)).map((a) =>
        a.questionId === "brief.grounded" ? { ...a, evidence: ["不存在的引文"] } : a
      );
    await expect(evaluateBrief(input)).rejects.toThrow("BRIEF_HALLUCINATION_QUOTE_MISSING");
  });
  it("uncertainty and missing decisions are evaluation errors, not hallucination zero", async () => {
    await expect(evaluateBrief(setup("daily", { "brief.grounded": "UNKNOWN" }))).rejects.toThrow(
      "BRIEF_JUDGE_REVIEW_REQUIRED"
    );
    const input = setup();
    input.provider.evaluate = (): Promise<readonly JevProviderDecision[]> => Promise.resolve([]);
    await expect(evaluateBrief(input)).rejects.toThrow("BRIEF_JUDGE_DECISION_INVALID");
  });
  it("rejects duplicated/wrong kind/unsupported judge answers and missing evidence", async () => {
    for (const variant of ["duplicate", "kind", "value", "evidence"]) {
      const input = setup();
      const answers = await input.provider.evaluate({
        contract: input.contract,
        plan: input.plan,
        trace: {} as never
      });
      input.provider.evaluate = (): Promise<readonly JevProviderDecision[]> =>
        Promise.resolve(
          answers.map((a, i) =>
            variant === "duplicate"
              ? { ...a, questionId: "same" }
              : i !== 0
                ? a
                : variant === "kind"
                  ? { ...a, kind: "BOOLEAN", value: true }
                  : variant === "value"
                    ? { ...a, value: "MAYBE" }
                    : { questionId: a.questionId, kind: a.kind, value: a.value }
          )
        );
      await expect(evaluateBrief(input)).rejects.toThrow(/BRIEF_JUDGE_/);
    }
  });
  it("does not treat provider probabilities or blank evidence as an explanation", async () => {
    for (const evidence of [['JEV probabilities: {"PASS":1}'], [" "]]) {
      const input = setup("daily");
      const original = input.provider.evaluate.bind(input.provider);
      input.provider.evaluate = async (request, signal): Promise<readonly JevProviderDecision[]> =>
        (await original(request, signal)).map((a) => ({
          ...a,
          value: a.questionId.startsWith("brief.P0.") ? "FAIL" : "PASS",
          reason: "",
          evidence
        }));
      await expect(evaluateBrief(input)).rejects.toThrow("BRIEF_JUDGE_EVIDENCE_MISSING");
    }
  });
  it("checks structure deterministically, including Unicode and configured fallback", async () => {
    const input = setup();
    required(input.contract.brief).constraints = {
      maxCards: 0,
      allowedGenerationStatuses: ["generated"]
    };
    const result = await evaluateBrief(input);
    expect(result.score).toBeCloseTo(1);
    expect(result.passed).toBe(false);
    expect(result.blockingFailures).toContain("brief.structure:容量约束不符合");
    input.parsedOutput.output = { text: "😀", cards: [] };
    const original = input.provider.evaluate.bind(input.provider);
    input.provider.evaluate = async (request, signal): Promise<readonly JevProviderDecision[]> =>
      (await original(request, signal)).map((a) => ({ ...a, evidence: ["😀"] }));
    input.parsedOutput.generation_status = "fact_only_fallback";
    required(input.contract.brief).constraints = {
      maxTextChars: 1,
      maxCards: 0,
      allowedGenerationStatuses: ["fact_only_fallback"]
    };
    expect((await evaluateBrief(input)).passed).toBe(true);
    required(input.contract.brief).constraints.allowedGenerationStatuses = ["generated"];
    expect((await evaluateBrief(input)).blockingFailures).toContain(
      "brief.generation:生成状态不符合Case要求"
    );
  });
  it("rejects bad request/type/source references before calling judge", async () => {
    for (const variant of ["type", "source", "leak"]) {
      const input = setup();
      if (variant === "type") required(input.contract.brief).briefType = "meeting";
      if (variant === "source")
        required(required(input.contract.brief).checklist[0]).sourceRefs = ["/not-there"];
      if (variant === "leak") input.requestBody.ground_truth = {};
      await expect(evaluateBrief(input)).rejects.toThrow(/BRIEF_/);
      expect(vi.mocked(input.provider).evaluate.mock.calls).toHaveLength(0);
    }
  });
  it("honors an already aborted run without dispatching judge", async () => {
    const input = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(evaluateBrief({ ...input, signal: controller.signal })).rejects.toThrow();
    expect(vi.mocked(input.provider).evaluate.mock.calls).toHaveLength(0);
  });
  it("accepts evidence through the actual HTTP adapter without live network calls", async () => {
    const input = setup();
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            answers: Object.fromEntries(
              input.plan.questions.map((q) => [
                q.id,
                {
                  type: "choice",
                  choice: "PASS",
                  reason: "已核对材料与最终输出",
                  evidence: { quote: "确认20个核心案例" }
                }
              ])
            )
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    );
    const provider = createJevHttpProvider(
      { providerType: "HTTP", endpoint: "https://judge.example.test/v1/systemone", model: "test" },
      { fetchImpl }
    );
    expect((await evaluateBrief({ ...input, provider })).passed).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("integrates existing semantic port and REST body selector without sending GT", async () => {
    const input = setup();
    const domain = {
      caseKey: "brief",
      description: "brief",
      threshold: 1,
      task: "brief",
      requestBody: input.requestBody,
      metadata: { requestId: "r", taskId: "t", businessModule: "brief_daily", scenarioTag: "test" },
      semanticEvaluation: JsonObjectSchema.parse(input.contract),
      assertions: []
    };
    const result = await createJevSemanticEvaluator({ provider: input.provider }).evaluate({
      caseDefinition: domain,
      providerOutput: {
        ok: true,
        taskName: "EVAL_BRIEF_REPLAY",
        resolvedConfig: {},
        parsedOutput: input.parsedOutput
      },
      signal: new AbortController().signal
    });
    expect(result.planVersion).toBe("cortex.brief-atomic-plan.v1");
    const request = prepareRestRequest(
      { caseKey: "brief", ordinal: 0, definitionHash: "a".repeat(64), definition: domain },
      {
        urlTemplate: "http://localhost:8000/eval/e2e/brief/replay",
        method: "POST",
        headers: {},
        bodySelector: "/request_body",
        timeoutMs: 150000,
        defaultConcurrency: 2
      },
      () => undefined
    );
    expect(JSON.parse(new TextDecoder().decode(request.body))).toEqual(input.requestBody);
    expect(new TextDecoder().decode(request.body)).not.toContain("checklist");
  });
});
