// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import { createRunApi, type RunEventSource } from "../src/lib/run-api.ts";
import { requestBody, requestUrl } from "./request-fixture.ts";
import { runDetail, runEvalPage } from "./run-test-fixture.ts";

const RUN_ID = "018f0f4e-7b7a-7cc0-8000-000000000001";
const SUITE_ID = "018f0f4e-7b7a-7cc0-8000-000000000002";
const ENDPOINT_ID = "018f0f4e-7b7a-7cc0-8000-000000000003";
const EVALUATOR_ID = "018f0f4e-7b7a-7cc0-8000-000000000004";
const TIME = "2026-07-13T00:00:00.000Z";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

class FakeRunEventSource implements RunEventSource {
  readonly #listeners = new Map<string, (event: Event) => void>();
  /** Whether the subscription was released. */
  public closed = false;

  /** Register one named SSE listener. */
  public addEventListener(type: string, listener: (event: Event) => void): void {
    this.#listeners.set(type, listener);
  }

  /** Release this fake source. */
  public close(): void {
    this.closed = true;
  }

  /** Emit one named test event. */
  public emit(type: string, event: Event): void {
    this.#listeners.get(type)?.(event);
  }
}

describe("Run API Client", () => {
  it("严格验证预检、创建、列表和 Revision 写请求", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.endsWith("/preflight")) {
        return Promise.resolve(
          response({
            suiteId: SUITE_ID,
            endpointConfigId: ENDPOINT_ID,
            evaluatorConfigId: EVALUATOR_ID,
            caseCount: 3,
            rubricPromptKeys: ["quality"],
            requiredEnvKeys: { REST: ["REST_TOKEN"], EVALUATION: ["GEMINI_API_KEY"] },
            endpointTimeoutMs: 60_000,
            defaultRunExecutionLimits: {
              contractVersion: "cortex.run-execution-limits.v1",
              restConcurrency: 4,
              evalConcurrency: 2
            }
          })
        );
      }
      if (url === "/api/v1/runs?limit=5") {
        return Promise.resolve(
          response({
            items: [
              {
                id: RUN_ID,
                sourceType: "PLATFORM",
                suiteId: SUITE_ID,
                suiteName: "客服回归集",
                runMode: "STAGED",
                status: "RUNNING",
                stage: "REST",
                lockRevision: 1,
                cancelRequestedAt: null,
                rest: { total: 3, completed: 1, succeeded: 1, error: 0 },
                evaluation: {
                  total: 3,
                  completed: 0,
                  passed: 0,
                  failed: 0,
                  error: 0,
                  notEvaluated: 0
                },
                createdAt: TIME,
                updatedAt: TIME
              }
            ],
            nextCursor: null
          })
        );
      }
      if (url.endsWith("/start")) {
        return Promise.resolve(
          response({
            runId: RUN_ID,
            status: "RUNNING",
            stage: "REST",
            lockRevision: 1,
            cancelRequestedAt: null,
            rest: { total: 3, completed: 0, succeeded: 0, error: 0 },
            evaluation: {
              total: 3,
              completed: 0,
              passed: 0,
              failed: 0,
              error: 0,
              notEvaluated: 0
            },
            updatedAt: TIME
          })
        );
      }
      return Promise.resolve(response({ invalid: true }));
    });
    const api = createRunApi(fetcher);
    const selection = {
      suiteId: SUITE_ID,
      endpointConfigId: ENDPOINT_ID,
      evaluatorConfigId: EVALUATOR_ID
    };

    await expect(api.preflight(selection, new AbortController().signal)).resolves.toMatchObject({
      caseCount: 3,
      requiredEnvKeys: { REST: ["REST_TOKEN"] }
    });
    await expect(
      api.listRuns({ limit: 5, cursor: null }, new AbortController().signal)
    ).resolves.toMatchObject({ items: [{ id: RUN_ID, sourceType: "PLATFORM" }] });
    await api.start(RUN_ID, 0, new AbortController().signal);

    expect(requestBody(fetcher.mock.calls[0]?.[1])).toBe(JSON.stringify(selection));
    expect(fetcher).toHaveBeenCalledWith(
      `/api/v1/runs/${RUN_ID}/start`,
      expect.objectContaining({ body: JSON.stringify({ expectedRevision: 0 }) })
    );
  });

  it("创建响应必须绑定 Endpoint、Evaluator、模式和全部执行限制", async () => {
    const input = {
      suiteId: SUITE_ID,
      endpointConfigId: ENDPOINT_ID,
      evaluatorConfigId: EVALUATOR_ID,
      runMode: "STAGED" as const,
      runExecutionLimits: {
        contractVersion: "cortex.run-execution-limits.v1" as const,
        restConcurrency: 4,
        evalConcurrency: 2
      }
    };
    const mismatches = [
      { ...runDetail(), endpoint: { ...runDetail().endpoint, sourceId: RUN_ID } },
      { ...runDetail(), evaluator: { ...runDetail().evaluator, sourceId: RUN_ID } },
      { ...runDetail(), runMode: "PIPELINE" as const },
      {
        ...runDetail(),
        runExecutionLimits: { ...runDetail().runExecutionLimits, restConcurrency: 5 }
      },
      {
        ...runDetail(),
        runExecutionLimits: { ...runDetail().runExecutionLimits, evalConcurrency: 3 }
      }
    ];
    for (const mismatch of mismatches) {
      const api = createRunApi(() => Promise.resolve(response(mismatch, 201)));
      await expect(api.create(input, new AbortController().signal)).rejects.toMatchObject({
        code: "CLIENT_RESPONSE_INVALID"
      });
    }
  });

  it("查询归一化 Evaluation 结果时绑定 Run 身份", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(runEvalPage));
    const api = createRunApi(fetcher);

    await expect(
      api.listEvaluations({ runId: RUN_ID, limit: 20, cursor: null }, new AbortController().signal)
    ).resolves.toEqual(runEvalPage);
    const request = fetcher.mock.calls[0]?.[0];
    if (request === undefined) throw new Error("TEST_REQUEST_MISSING");
    expect(requestUrl(request)).toBe(`/api/v1/runs/${RUN_ID}/evaluations?limit=20`);
    expect(fetcher.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);

    const mismatch = {
      ...runEvalPage,
      items: [{ ...runEvalPage.items[0], runId: SUITE_ID }]
    };
    await expect(
      createRunApi(() => Promise.resolve(response(mismatch))).listEvaluations(
        { runId: RUN_ID, limit: 20, cursor: null },
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: "CLIENT_RESPONSE_INVALID" });
  });

  it("严格读取 Report、编码组合过滤并绑定 Report 与重跑身份", async () => {
    const hash = "a".repeat(64);
    const overview = {
      runId: RUN_ID,
      sourceType: "OFFLINE_IMPORT",
      sourceRunId: null,
      rerunMode: "NONE",
      completedAt: TIME,
      context: {
        contractVersion: "cortex.report-context.v1",
        runContextHash: hash,
        suite: { sourceId: SUITE_ID, name: "客服回归集", suiteHash: hash },
        endpoint: {
          sourceId: ENDPOINT_ID,
          name: "客服 Endpoint",
          configHash: hash,
          config: runDetail().endpoint.config
        },
        evaluator: {
          sourceId: EVALUATOR_ID,
          name: "Gemini Evaluator",
          configHash: hash,
          config: runDetail().evaluator.config
        },
        rubricPrompts: [],
        promptfooVersion: "0.121.18",
        runExecutionLimits: runDetail().runExecutionLimits
      },
      evaluationContextHash: hash,
      evaluationResultSetHash: hash,
      reportResultSetHash: hash,
      summary: {
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
      },
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
      artifactAvailability: [
        {
          kind: "RAW_PROMPTFOO_EVIDENCE",
          path: `executions/${RUN_ID}/promptfoo-raw.json`,
          status: "MISSING"
        }
      ]
    } as const;
    const reportCase = {
      caseKey: "case-1",
      ordinal: 0,
      definitionHash: hash,
      definition: {
        contractVersion: "cortex.case-definition.v1",
        description: "客服请求",
        threshold: 1,
        vars: { task: "route", request_body: { input: "你好" } },
        metadata: {
          req_id: "req-1",
          task_id: "task-1",
          case_id: "case-1",
          business_module: "客服",
          scenario_tag: "smoke"
        },
        assert: [{ type: "equals", metric: "quality", value: true, weight: 1 }]
      },
      rest: {
        caseKey: "case-1",
        ordinal: 0,
        caseDefinitionHash: hash,
        status: "SUCCEEDED",
        httpStatus: 200,
        providerOutput: {
          ok: true,
          task_name: "route",
          resolved_config: {},
          parsed_output: { reply: "你好" }
        },
        durationMs: 25,
        completedAt: TIME,
        resultHash: hash,
        provenance: null
      },
      evaluation: runEvalPage.items[0]?.result,
      rawEvidenceStatus: "MISSING"
    } as const;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === `/api/v1/runs/${RUN_ID}/report`) return Promise.resolve(response(overview));
      if (url.includes("/report/cases?")) {
        return Promise.resolve(response({ items: [reportCase], nextCursor: null }));
      }
      if (url.endsWith("/report/cases/case-1")) return Promise.resolve(response(reportCase));
      if (url.endsWith("/reruns")) {
        return Promise.resolve(
          response(
            {
              runId: SUITE_ID,
              sourceRunId: RUN_ID,
              rerunMode: "RETRY_FAILED",
              status: "READY",
              stage: "REST",
              lockRevision: 0,
              counts: { reuseRest: 1, executeRest: 0, reuseEval: 1, executeEval: 0 }
            },
            201
          )
        );
      }
      return Promise.resolve(response({ invalid: true }));
    });
    const api = createRunApi(fetcher);
    const signal = new AbortController().signal;

    await expect(api.getReport(RUN_ID, signal)).resolves.toEqual(overview);
    await expect(
      api.listReportCases(
        {
          runId: RUN_ID,
          limit: 20,
          cursor: null,
          restStatus: ["SUCCEEDED"],
          evalStatus: ["PASS", "FAIL"],
          metrics: ["quality"],
          businessModules: ["客服"],
          scenarioTags: ["smoke"]
        },
        signal
      )
    ).resolves.toEqual({ items: [reportCase], nextCursor: null });
    await expect(api.getReportCase(RUN_ID, "case-1", signal)).resolves.toEqual(reportCase);
    await expect(api.createRerun(RUN_ID, "RETRY_FAILED", signal)).resolves.toMatchObject({
      sourceRunId: RUN_ID,
      rerunMode: "RETRY_FAILED"
    });

    expect(requestUrl(fetcher.mock.calls[1]?.[0] ?? "")).toBe(
      `/api/v1/runs/${RUN_ID}/report/cases?businessModule=%E5%AE%A2%E6%9C%8D&evalStatus=PASS&evalStatus=FAIL&limit=20&metric=quality&restStatus=SUCCEEDED&scenarioTag=smoke`
    );
    expect(requestBody(fetcher.mock.calls[3]?.[1])).toBe(JSON.stringify({ mode: "RETRY_FAILED" }));
  });

  it("只把身份匹配且符合契约的 SSE Envelope 交给页面", () => {
    const source = new FakeRunEventSource();
    const onEnvelope = vi.fn();
    const onError = vi.fn();
    const api = createRunApi(fetch, () => source);
    const subscription = api.subscribe(RUN_ID, onEnvelope, onError);
    source.emit(
      "snapshot",
      new MessageEvent("snapshot", {
        data: JSON.stringify({
          type: "SNAPSHOT",
          sequence: 1,
          progress: {
            runId: RUN_ID,
            status: "RUNNING",
            stage: "REST",
            lockRevision: 1,
            cancelRequestedAt: null,
            rest: { total: 3, completed: 1, succeeded: 1, error: 0 },
            evaluation: {
              total: 3,
              completed: 0,
              passed: 0,
              failed: 0,
              error: 0,
              notEvaluated: 0
            },
            updatedAt: TIME
          }
        })
      })
    );
    source.emit(
      "progress",
      new MessageEvent("progress", {
        data: JSON.stringify({
          type: "EVENT",
          sequence: 2,
          event: "REST_PROGRESS",
          progress: {
            runId: SUITE_ID,
            status: "RUNNING",
            stage: "REST",
            lockRevision: 2,
            cancelRequestedAt: null,
            rest: { total: 3, completed: 2, succeeded: 2, error: 0 },
            evaluation: {
              total: 3,
              completed: 0,
              passed: 0,
              failed: 0,
              error: 0,
              notEvaluated: 0
            },
            updatedAt: TIME
          }
        })
      })
    );
    source.emit("progress", new Event("progress"));
    source.emit("progress", new MessageEvent("progress", { data: "{" }));

    expect(onEnvelope).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(3);
    subscription.close();
    expect(source.closed).toBe(true);
  });
});
