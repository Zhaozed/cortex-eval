import { describe, expect, it } from "vitest";

import type { AnalysisModelRequest } from "../src/features/case-analysis/case-analysis-model-client.ts";
import {
  analysisProposalFromBoundary,
  analysisResultFromBoundary,
  prepareAnalysisModelRequest,
  type AnalysisBoundaryAssertion,
  type AnalysisBoundaryCase,
  type AnalysisBoundaryOutput
} from "../src/features/case-analysis/case-analysis-model-boundary.ts";

const HASH = "a".repeat(64);

const boundaryAssertion: AnalysisBoundaryAssertion = {
  type: "assert-set",
  metric: "quality",
  value: { expected: true },
  threshold: 0.8,
  weight: 2,
  config: { mode: "strict" },
  rubricPrompt: "prompt://quality",
  transform: "output.answer",
  contextTransform: "context.input",
  assert: [{ type: "equals", metric: "answer", value: "ok" }]
};

const boundaryCase: AnalysisBoundaryCase = {
  contractVersion: "cortex.case-definition.v1",
  description: "replacement",
  threshold: 1,
  vars: { task: "reply", request_body: { text: "hello" } },
  metadata: {
    case_id: "case-1",
    req_id: "req-1",
    task_id: "task-1",
    business_module: "support",
    scenario_tag: "reply"
  },
  assert: [{ type: "equals", metric: "answer", value: "ok" }]
};

const request: AnalysisModelRequest = {
  analyzer: {
    providerType: "GOOGLE_GEMINI",
    model: "gemini-test",
    apiKey: { kind: "ENV_SECRET", envKey: "ANALYZER_KEY" },
    thinkingLevel: "LOW",
    temperature: 0,
    topP: 1,
    maxOutputTokens: 512,
    timeoutMs: 1_000,
    structuredOutput: "JSON_SCHEMA"
  },
  prompt: {
    kind: "CASE_ANALYSIS",
    promptKey: "analysis",
    messages: [
      {
        role: "USER",
        content:
          "{{case_definition}} {{provider_output}} {{failed_assertions}} {{expected_actual_diffs}} {{llm_rubric_results}} {{run_context}}"
      }
    ]
  },
  variables: {
    case_definition: { case: "definition" },
    provider_output: { output: "value" },
    failed_assertions: [{ status: "FAIL" }],
    expected_actual_diffs: [{ actual: "wrong" }],
    llm_rubric_results: [{ score: 0 }],
    run_context: { owner: "run" }
  },
  signal: new AbortController().signal
};

function output(overrides: Partial<AnalysisBoundaryOutput> = {}): AnalysisBoundaryOutput {
  return {
    contractVersion: "cortex.analysis-output.v1",
    classification: "NORMAL_FAILURE",
    confidence: 0.8,
    evidence: [{ source: "run_context", fieldPath: null, conclusion: "上下文事实" }],
    explanation: "失败原因",
    recommendedAction: "修复系统",
    proposal: null,
    ...overrides
  };
}

describe("Case Analysis model boundary", () => {
  it("严格校验冻结资源并渲染全部六个结构变量", () => {
    const prepared = prepareAnalysisModelRequest(request);
    expect(prepared).toMatchObject({ ok: true });
    if (!prepared.ok) throw new Error("TEST_NARROWING_FAILED");
    expect(prepared.messages[0]?.content).toContain('{"case":"definition"}');
    expect(prepared.messages[0]?.content).toContain('[{"status":"FAIL"}]');
    expect(prepared.messages[0]?.content).toContain('[{"actual":"wrong"}]');
    expect(prepared.messages[0]?.content).toContain('[{"score":0}]');

    expect(
      prepareAnalysisModelRequest({
        ...request,
        analyzer: { ...request.analyzer, model: "" }
      }).ok
    ).toBe(false);
    expect(
      prepareAnalysisModelRequest({
        ...request,
        prompt: { ...request.prompt, messages: [{ role: "USER", content: "{{unknown}}" }] }
      }).ok
    ).toBe(false);
  });

  it("把四类 Proposal 和递归 Assertion 完整映射到纯 Domain", () => {
    expect(
      analysisProposalFromBoundary({
        action: "REPLACE_CASE",
        baseDefinitionHash: HASH,
        casePayload: boundaryCase
      })
    ).toMatchObject({ action: "REPLACE_CASE", casePayload: { caseKey: "case-1" } });

    expect(
      analysisProposalFromBoundary({
        action: "ADD_ASSERTION",
        baseDefinitionHash: HASH,
        targetAssertionIndex: 0,
        assertion: boundaryAssertion
      })
    ).toMatchObject({
      action: "ADD_ASSERTION",
      assertion: {
        weight: 2,
        threshold: 0.8,
        config: { mode: "strict" },
        assertions: [{ type: "equals", weight: 1 }]
      }
    });
    expect(
      analysisProposalFromBoundary({
        action: "REPLACE_ASSERTION",
        baseDefinitionHash: HASH,
        targetAssertionIndex: 0,
        targetAssertionDefinitionHash: HASH,
        assertion: { type: "equals", metric: "answer" }
      })
    ).toMatchObject({ action: "REPLACE_ASSERTION", assertion: { weight: 1 } });
    expect(
      analysisProposalFromBoundary({
        action: "REMOVE_ASSERTION",
        baseDefinitionHash: HASH,
        targetAssertionIndex: 0,
        targetAssertionDefinitionHash: HASH
      })
    ).toMatchObject({ action: "REMOVE_ASSERTION" });
  });

  it("只接受满足 Domain 不变量的结构化输出", () => {
    expect(
      analysisResultFromBoundary(
        output({
          proposal: {
            action: "ADD_ASSERTION",
            baseDefinitionHash: HASH,
            targetAssertionIndex: 0,
            assertion: { type: "equals", metric: "answer", value: "ok" }
          }
        })
      )
    ).toMatchObject({
      evidence: [{ source: "run_context", fieldPath: null }],
      proposal: { action: "ADD_ASSERTION" }
    });
    expect(
      analysisResultFromBoundary(
        output({ evidence: [{ source: "run_context", fieldPath: "bad", conclusion: "invalid" }] })
      )
    ).toBeNull();
  });
});
