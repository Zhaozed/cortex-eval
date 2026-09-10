import { describe, expect, it } from "vitest";

import {
  CreatePlatformRunRequestV1Schema,
  CreatePlatformRerunRequestV1Schema,
  PlatformRerunCreatedV1Schema,
  PlatformRunDetailV1Schema,
  RunCasePageV1Schema,
  RunEvalPageV1Schema,
  RunPreflightV1Schema,
  RunReportCaseListQueryV1Schema,
  RunReportCasePageV1Schema,
  RunReportOverviewV1Schema,
  RunStreamEventTypeV1Schema,
  RunStreamEnvelopeV1Schema
} from "../src/run-api-contracts.ts";

const RUN_ID = "018f1e2d-3c4b-7abc-8def-0123456789ab";
const CONFIG_ID = "018f1e2d-3c4b-7abc-8def-1123456789ab";
const HASH = "b".repeat(64);
const TIME = "2026-07-13T01:02:03.004Z";

describe("平台 Run API v1", () => {
  it("Retry/Force 请求创建新 Run 身份并返回精确复用与执行数量", () => {
    expect(CreatePlatformRerunRequestV1Schema.parse({ mode: "RETRY_FAILED" })).toEqual({
      mode: "RETRY_FAILED"
    });
    expect(CreatePlatformRerunRequestV1Schema.safeParse({ mode: "NONE" }).success).toBe(false);
    expect(
      PlatformRerunCreatedV1Schema.parse({
        runId: RUN_ID,
        sourceRunId: CONFIG_ID,
        rerunMode: "FORCE",
        status: "READY",
        stage: "REST",
        lockRevision: 0,
        counts: { reuseRest: 0, executeRest: 3, reuseEval: 0, executeEval: 3 }
      })
    ).toMatchObject({
      runId: RUN_ID,
      sourceRunId: CONFIG_ID,
      rerunMode: "FORCE",
      counts: { executeRest: 3, executeEval: 3 }
    });
  });

  it("Report Overview 和 Case Page 显式携带独立 Evaluation/Report 版本与证据状态", () => {
    const context = {
      contractVersion: "cortex.report-context.v1" as const,
      runContextHash: HASH,
      suite: { sourceId: RUN_ID, name: "Suite", suiteHash: HASH },
      endpoint: {
        sourceId: CONFIG_ID,
        name: "Endpoint",
        configHash: HASH,
        config: {
          contractVersion: "cortex.endpoint-config.v1" as const,
          urlTemplate: "http://127.0.0.1/run/{{vars.task}}",
          method: "POST" as const,
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
          contractVersion: "cortex.llm-config.v1" as const,
          providerType: "GOOGLE_GEMINI" as const,
          model: "gemini-test",
          thinkingLevel: "OFF" as const,
          temperature: 0,
          topP: 1,
          maxOutputTokens: 100,
          timeoutMs: 100,
          structuredOutput: "JSON_OBJECT" as const,
          apiKey: { kind: "ENV_SECRET" as const, envKey: "GEMINI_API_KEY" }
        }
      },
      rubricPrompts: [],
      promptfooVersion: "0.121.18" as const,
      runExecutionLimits: {
        contractVersion: "cortex.run-execution-limits.v1" as const,
        restConcurrency: 4,
        evalConcurrency: 2
      }
    };
    const summary = {
      total: 1,
      restSucceeded: 1,
      restError: 0,
      evalPass: 1,
      evalFail: 0,
      evalError: 0,
      notEvaluated: 0,
      effectivePassRate: 1,
      evaluatedPassRate: 1,
      coverageRate: 1
    };
    expect(
      RunReportOverviewV1Schema.parse({
        runId: RUN_ID,
        sourceType: "PLATFORM",
        sourceRunId: null,
        rerunMode: "NONE",
        completedAt: TIME,
        context,
        evaluationContextHash: HASH,
        evaluationResultSetHash: "c".repeat(64),
        reportResultSetHash: "d".repeat(64),
        summary,
        byMetric: [
          {
            metric: "quality",
            pass: 1,
            fail: 0,
            error: 0,
            skipped: 0,
            notEvaluated: 0,
            passRate: 1
          }
        ],
        artifactAvailability: []
      }).evaluationResultSetHash
    ).toBe("c".repeat(64));
    const reportCase = {
      caseKey: "case-1",
      ordinal: 0,
      definitionHash: HASH,
      definition: {
        contractVersion: "cortex.case-definition.v1",
        description: "Case",
        threshold: 1,
        vars: { task: "route", request_body: {} },
        metadata: {
          case_id: "case-1",
          req_id: "req-1",
          task_id: "task-1",
          business_module: "chat",
          scenario_tag: "smoke"
        },
        assert: [{ type: "equals", metric: "quality", weight: 1, value: "ok" }]
      },
      rest: {
        caseKey: "case-1",
        ordinal: 0,
        caseDefinitionHash: HASH,
        status: "SUCCEEDED",
        httpStatus: 200,
        providerOutput: { ok: false, err_msg: "business" },
        durationMs: 1,
        completedAt: TIME,
        resultHash: HASH,
        provenance: null
      },
      evaluation: {
        caseKey: "case-1",
        ordinal: 0,
        status: "PASS",
        promptfooSuccess: true,
        score: 1,
        reason: "ok",
        evaluationError: null,
        assertions: [],
        diffs: [],
        metrics: [{ metric: "quality", status: "PASS" }],
        latencyMs: null,
        tokenUsage: null,
        cost: null,
        rawEvidence: null,
        evalResultHash: HASH,
        finalCaseResultHash: HASH,
        provenance: null
      },
      rawEvidenceStatus: "ABSENT"
    };
    expect(
      RunReportCasePageV1Schema.parse({ items: [reportCase], nextCursor: null }).items[0]
        ?.rawEvidenceStatus
    ).toBe("ABSENT");
    expect(
      RunReportCaseListQueryV1Schema.safeParse({ limit: 20, evalStatus: ["UNKNOWN"] }).success
    ).toBe(false);
    expect(
      RunReportCaseListQueryV1Schema.parse({
        restStatus: "SUCCEEDED",
        evalStatus: "PASS",
        metric: "quality"
      })
    ).toMatchObject({
      restStatus: ["SUCCEEDED"],
      evalStatus: ["PASS"],
      metric: ["quality"]
    });
  });

  it("SSE 不暴露没有持久进度事实支撑的 Evaluation Progress 事件", () => {
    expect(() => RunStreamEventTypeV1Schema.parse("EVALUATION_PROGRESS")).toThrow();
    expect(RunStreamEventTypeV1Schema.parse("EVALUATION_STARTED")).toBe("EVALUATION_STARTED");
    expect(RunStreamEventTypeV1Schema.parse("EVALUATION_COMPLETED")).toBe("EVALUATION_COMPLETED");
  });

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
      evaluation: {
        total: 1,
        completed: 0,
        passed: 0,
        failed: 0,
        error: 0,
        notEvaluated: 0
      },
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
          evaluation: {
            total: 1,
            completed: 0,
            passed: 0,
            failed: 0,
            error: 0,
            notEvaluated: 0
          },
          updatedAt: TIME
        }
      }).sequence
    ).toBe(2);
    expect(
      RunStreamEnvelopeV1Schema.safeParse({
        type: "EVENT",
        sequence: 3,
        event: "EVALUATION_COMPLETED",
        progress: {
          runId: RUN_ID,
          status: "READY",
          stage: "REPORT",
          lockRevision: 3,
          cancelRequestedAt: null,
          rest: { total: 1, completed: 1, succeeded: 1, error: 0 },
          evaluation: {
            total: 1,
            completed: 1,
            passed: 0,
            failed: 0,
            error: 0,
            notEvaluated: 0
          },
          updatedAt: TIME
        }
      }).success
    ).toBe(false);
  });

  it("Evaluation Page 返回版本化完整规范化结果，不暴露 Raw 正文", () => {
    const page = {
      items: [
        {
          runId: RUN_ID,
          createdAt: TIME,
          updatedAt: TIME,
          result: {
            caseKey: "case-1",
            ordinal: 0,
            status: "NOT_EVALUATED",
            promptfooSuccess: null,
            score: null,
            reason: null,
            evaluationError: null,
            assertions: [],
            diffs: [],
            metrics: [{ metric: "quality", status: "NOT_EVALUATED" }],
            latencyMs: null,
            tokenUsage: null,
            cost: null,
            rawEvidence: null,
            evalResultHash: HASH,
            finalCaseResultHash: HASH,
            provenance: null
          }
        }
      ],
      nextCursor: null
    };

    expect(RunEvalPageV1Schema.parse(page).items).toHaveLength(1);
    expect(
      RunEvalPageV1Schema.safeParse({
        ...page,
        items: [{ ...page.items[0], raw: { secret: true } }]
      }).success
    ).toBe(false);
  });
});

it("accepts bounded labels for creation/rerun, rejects blank names and invalid metadata", () => {
  const selection = {
    suiteId: RUN_ID,
    endpointConfigId: CONFIG_ID,
    evaluatorConfigId: CONFIG_ID,
    runMode: "PIPELINE"
  };
  expect(
    CreatePlatformRunRequestV1Schema.parse({
      ...selection,
      name: " 测跨日 ",
      description: " 验证时间规则 "
    })
  ).toMatchObject({ name: "测跨日", description: "验证时间规则" });
  expect(CreatePlatformRunRequestV1Schema.safeParse(selection).success).toBe(true);
  for (const metadata of [
    { name: "   " },
    { name: "a".repeat(121) },
    { description: "a".repeat(2001) },
    { name: 123 },
    { purpose: "unknown" }
  ]) {
    expect(CreatePlatformRunRequestV1Schema.safeParse({ ...selection, ...metadata }).success).toBe(
      false
    );
    expect(
      CreatePlatformRerunRequestV1Schema.safeParse({ mode: "FORCE", ...metadata }).success
    ).toBe(false);
  }
  expect(CreatePlatformRerunRequestV1Schema.parse({ mode: "FORCE", description: "" })).toEqual({
    mode: "FORCE",
    description: ""
  });
});
