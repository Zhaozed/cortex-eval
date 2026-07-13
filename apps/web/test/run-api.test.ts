// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import { createRunApi, type RunEventSource } from "../src/lib/run-api.ts";
import { requestBody, requestUrl } from "./request-fixture.ts";
import { runDetail } from "./run-test-fixture.ts";

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
