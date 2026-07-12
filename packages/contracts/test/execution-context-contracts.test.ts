import { describe, expect, it } from "vitest";

import {
  AnalysisSnapshotV1Schema,
  RunSnapshotV1Schema
} from "../src/execution-context-contracts.ts";

const ID = "018f1e2d-3c4b-7abc-8def-0123456789ab";
const HASH = "c".repeat(64);

const llm = {
  contractVersion: "cortex.llm-config.v1",
  providerType: "GOOGLE_GEMINI",
  model: "gemini-model",
  thinkingLevel: "MEDIUM",
  temperature: 0.2,
  topP: 0.9,
  maxOutputTokens: 2048,
  timeoutMs: 30_000,
  apiKey: { kind: "ENV_SECRET", envKey: "GEMINI_API_KEY" },
  structuredOutput: "JSON_SCHEMA"
};

describe("冻结执行上下文 v1", () => {
  it("Run Snapshot 只含 REST/Eval 所需资源、脱敏配置、版本和限制", () => {
    const value = {
      contractVersion: "cortex.run-snapshot.v1",
      suiteId: ID,
      suiteHash: HASH,
      cases: [
        {
          caseKey: "case-1",
          ordinal: 0,
          definitionHash: HASH,
          definition: {
            contractVersion: "cortex.case-definition.v1",
            description: "示例",
            threshold: 1,
            vars: { task: "route", request_body: {} },
            metadata: {
              case_id: "case-1",
              req_id: "req-1",
              task_id: "task-1",
              business_module: "Slack",
              scenario_tag: "reply"
            },
            assert: [{ type: "equals", metric: "answer", value: "ok" }]
          }
        }
      ],
      endpoint: {
        configHash: HASH,
        config: {
          contractVersion: "cortex.endpoint-config.v1",
          urlTemplate: "https://example.com/run",
          method: "POST",
          headers: { Authorization: { kind: "ENV_SECRET", envKey: "ENDPOINT_TOKEN" } },
          bodySelector: "/request_body",
          timeoutMs: 60_000,
          defaultConcurrency: 4
        }
      },
      evaluator: { configHash: HASH, config: llm },
      rubricPrompts: [
        {
          promptKey: "rubric-1",
          name: "Rubric",
          messages: [{ role: "SYSTEM", content: "判断质量" }],
          promptHash: HASH
        }
      ],
      promptfooVersion: "0.121.18",
      runExecutionLimits: {
        contractVersion: "cortex.run-execution-limits.v1",
        restConcurrency: 4,
        evalConcurrency: 2
      },
      runContextHash: HASH
    };
    expect(RunSnapshotV1Schema.parse(value).cases).toHaveLength(1);
    expect(RunSnapshotV1Schema.safeParse({ ...value, analyzer: llm }).success).toBe(false);
  });

  it("Analysis Snapshot 独立冻结 Analyzer、Prompt、结果身份和限制", () => {
    const value = {
      contractVersion: "cortex.analysis-snapshot.v1",
      caseKey: "case-1",
      finalCaseResultHash: HASH,
      analyzer: { configHash: HASH, config: llm },
      analysisPrompt: {
        promptKey: "analysis-1",
        name: "Analysis",
        messages: [{ role: "SYSTEM", content: "分析 {{case_definition}}" }],
        promptHash: HASH
      },
      analysisExecutionLimits: {
        contractVersion: "cortex.analysis-execution-limits.v1",
        analysisConcurrency: 1
      },
      analysisInputContractVersion: "cortex.analysis-input.v1",
      analysisOutputContractVersion: "cortex.analysis-output.v1",
      analysisInputHash: HASH
    };
    expect(AnalysisSnapshotV1Schema.parse(value).analysisInputHash).toBe(HASH);
  });
});
