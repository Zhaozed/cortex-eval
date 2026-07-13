import { describe, expect, it } from "vitest";

import {
  CreatePlatformRunRequestV1Schema,
  PlatformRunDetailV1Schema,
  RunCasePageV1Schema,
  RunPreflightV1Schema,
  RunStreamEnvelopeV1Schema
} from "../src/run-api-contracts.ts";

const RUN_ID = "018f1e2d-3c4b-7abc-8def-0123456789ab";
const CONFIG_ID = "018f1e2d-3c4b-7abc-8def-1123456789ab";
const HASH = "b".repeat(64);
const TIME = "2026-07-13T01:02:03.004Z";

describe("平台 Run API v1", () => {
  it("创建请求接受省略默认限制或完整版本化限制", () => {
    const selection = {
      suiteId: RUN_ID,
      endpointConfigId: CONFIG_ID,
      evaluatorConfigId: RUN_ID,
      runMode: "STAGED" as const
    };
    expect(CreatePlatformRunRequestV1Schema.parse(selection)).toEqual(selection);
    expect(
      CreatePlatformRunRequestV1Schema.parse({
        ...selection,
        runExecutionLimits: {
          contractVersion: "cortex.run-execution-limits.v1",
          restConcurrency: 64,
          evalConcurrency: 16
        }
      }).runExecutionLimits?.restConcurrency
    ).toBe(64);
    expect(
      CreatePlatformRunRequestV1Schema.safeParse({
        ...selection,
        runExecutionLimits: {
          contractVersion: "cortex.run-execution-limits.v1",
          restConcurrency: 65,
          evalConcurrency: 2
        }
      }).success
    ).toBe(false);
  });

  it("预检显式返回冻结前依赖与默认限制", () => {
    const value = {
      suiteId: RUN_ID,
      endpointConfigId: CONFIG_ID,
      evaluatorConfigId: RUN_ID,
      caseCount: 1,
      rubricPromptKeys: ["quality"],
      requiredEnvKeys: { REST: ["ENDPOINT_KEY"], EVALUATION: ["GEMINI_API_KEY"] },
      endpointTimeoutMs: 600_000,
      defaultRunExecutionLimits: {
        contractVersion: "cortex.run-execution-limits.v1",
        restConcurrency: 4,
        evalConcurrency: 2
      }
    };
    expect(RunPreflightV1Schema.parse(value)).toEqual(value);
  });

  it("Run Detail 只含有界冻结摘要，不接受完整 Cases", () => {
    const value = {
      id: RUN_ID,
      sourceType: "PLATFORM",
      sourceRunId: null,
      rerunMode: "NONE",
      suite: { id: RUN_ID, name: "Suite", hash: HASH, caseCount: 1 },
      endpoint: {
        sourceId: CONFIG_ID,
        name: "Endpoint",
        configHash: HASH,
        config: {
          contractVersion: "cortex.endpoint-config.v1",
          urlTemplate: "http://127.0.0.1/run/{{vars.task}}",
          method: "POST",
          headers: {},
          bodySelector: "/request_body",
          timeoutMs: 100,
          defaultConcurrency: 4
        }
      },
      evaluator: {
        sourceId: RUN_ID,
        name: "Evaluator",
        configHash: HASH,
        config: {
          contractVersion: "cortex.llm-config.v1",
          providerType: "GOOGLE_GEMINI",
          model: "gemini-test",
          thinkingLevel: "OFF",
          temperature: 0,
          topP: 1,
          maxOutputTokens: 100,
          timeoutMs: 100,
          structuredOutput: "JSON_OBJECT",
          apiKey: { kind: "ENV_SECRET", envKey: "GEMINI_API_KEY" }
        }
      },
      rubricPrompts: [{ promptKey: "quality", name: "Quality", promptHash: HASH }],
      promptfooVersion: "0.121.18",
      contractVersions: {
        runSnapshot: "cortex.run-snapshot.v1",
        caseDefinition: "cortex.case-definition.v1",
        platformRestResults: "cortex.platform-rest-results.v1"
      },
      runContextHash: HASH,
      runExecutionLimits: {
        contractVersion: "cortex.run-execution-limits.v1",
        restConcurrency: 4,
        evalConcurrency: 2
      },
      runMode: "STAGED",
      status: "READY",
      stage: "REST",
      lockRevision: 0,
      cancelRequestedAt: null,
      rest: { total: 1, completed: 0, succeeded: 0, error: 0 },
      artifactManifest: {
        contractVersion: "cortex.artifact-manifest.v1",
        owner: { kind: "RUN", id: RUN_ID },
        artifacts: []
      },
      artifactAvailability: [],
      errorCode: null,
      startedAt: null,
      completedAt: null,
      createdAt: TIME,
      updatedAt: TIME
    };
    expect(PlatformRunDetailV1Schema.parse(value).suite.caseCount).toBe(1);
    expect(PlatformRunDetailV1Schema.safeParse({ ...value, cases: [] }).success).toBe(false);
  });

  it("Case Page 只允许真实已落库结果，SSE 事件携带闭合进度", () => {
    const page = {
      items: [
        {
          runId: RUN_ID,
          caseKey: "case-1",
          ordinal: 0,
          status: "ERROR",
          httpStatus: null,
          errorType: "CANCELLED",
          durationMs: 1,
          completedAt: TIME,
          resultHash: HASH
        }
      ],
      nextCursor: null
    };
    expect(RunCasePageV1Schema.parse(page).items).toHaveLength(1);
    expect(
      RunCasePageV1Schema.safeParse({
        items: [{ ...page.items[0], status: "PENDING" }],
        nextCursor: null
      }).success
    ).toBe(false);
    expect(
      RunStreamEnvelopeV1Schema.parse({
        type: "EVENT",
        sequence: 2,
        event: "REST_PROGRESS",
        progress: {
          runId: RUN_ID,
          status: "RUNNING",
          stage: "REST",
          lockRevision: 2,
          cancelRequestedAt: null,
          rest: { total: 1, completed: 1, succeeded: 0, error: 1 },
          updatedAt: TIME
        }
      }).sequence
    ).toBe(2);
  });
});
