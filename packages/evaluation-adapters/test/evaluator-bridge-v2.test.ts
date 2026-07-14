import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";

import { describe, expect, it } from "vitest";

import { startEvaluatorBridgeV2 } from "../src/evaluator-bridge-v2.ts";
import { EvaluatorModelError } from "../src/evaluator-model-errors.ts";

const ID = "018f1e2d-3c4b-7abc-8def-0123456789ab";
const HASH = "a".repeat(64);
const TOKEN = "A".repeat(43);
const TOKEN_HASH = createHash("sha256").update(TOKEN).digest("hex");

function requestBody(prompt = "judge this"): Readonly<Record<string, unknown>> {
  return {
    contractVersion: "cortex.evaluator-bridge-request.v2",
    binding: { kind: "RUN", runId: ID },
    evaluationContextHash: HASH,
    prompt
  };
}

// Send one raw HTTP request so the test can control the Host header exactly.
function requestStatusWithHost(url: string, host: string): Promise<number> {
  const target = new URL(url);
  const body = JSON.stringify(requestBody());
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: {
          host,
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body)
        }
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      }
    );
    request.once("error", reject);
    request.end(body);
  });
}

describe("Evaluator Bridge v2", () => {
  it("保留冻结 Provider 的能力不支持错误，不泄露上游响应", async () => {
    const bridge = await startEvaluatorBridgeV2({
      rawCapability: TOKEN,
      capability: {
        contractVersion: "cortex.evaluator-bridge-capability.v2",
        capabilityHash: TOKEN_HASH,
        binding: { kind: "RUN", runId: ID },
        evaluationContextHash: HASH,
        evaluatorConfigHash: HASH,
        maxCalls: 1,
        maxConcurrency: 1,
        timeoutMs: 1_000,
        expiresAt: "2099-01-01T00:00:00.000Z"
      },
      createCallId: () => ID,
      evaluator: {
        generate: () => Promise.reject(new EvaluatorModelError("PROVIDER_CAPABILITY_UNSUPPORTED"))
      }
    });

    try {
      const response = await fetch(bridge.url, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(requestBody())
      });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        status: "ERROR",
        error: { code: "PROVIDER_CAPABILITY_UNSUPPORTED", retryable: false }
      });
    } finally {
      await bridge.close();
    }
  });

  it("达到并发上限时排队而不是把并行评分误报为预算耗尽", async () => {
    let active = 0;
    let maxObserved = 0;
    let releaseFirst: (() => void) | undefined;
    let firstEnteredResolve: (() => void) | undefined;
    const firstEntered = new Promise<void>((resolve) => {
      firstEnteredResolve = resolve;
    });
    const bridge = await startEvaluatorBridgeV2({
      rawCapability: TOKEN,
      capability: {
        contractVersion: "cortex.evaluator-bridge-capability.v2",
        capabilityHash: TOKEN_HASH,
        binding: { kind: "RUN", runId: ID },
        evaluationContextHash: HASH,
        evaluatorConfigHash: HASH,
        maxCalls: 2,
        maxConcurrency: 1,
        timeoutMs: 1_000,
        expiresAt: "2026-07-15T00:00:00.000Z"
      },
      now: () => new Date("2026-07-14T00:00:00.000Z"),
      createCallId: () => ID,
      evaluator: {
        generate: async () => {
          active += 1;
          maxObserved = Math.max(maxObserved, active);
          if (firstEnteredResolve !== undefined) {
            firstEnteredResolve();
            firstEnteredResolve = undefined;
            await new Promise<void>((resolve) => {
              releaseFirst = resolve;
            });
          }
          active -= 1;
          return { text: "ok", structured: null, tokenUsage: null };
        }
      }
    });

    const invoke = (): Promise<Response> =>
      fetch(bridge.url, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(requestBody())
      });
    try {
      const first = invoke();
      await firstEntered;
      const second = invoke();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(bridge.stats()).toEqual({ acceptedCalls: 2, completedCalls: 0, inFlight: 1 });
      releaseFirst?.();
      expect((await first).status).toBe(200);
      expect((await second).status).toBe(200);
      expect(maxObserved).toBe(1);
    } finally {
      releaseFirst?.();
      await bridge.close();
    }
  });

  it("上游忽略超时 Abort 时继续占用真实并发槽直到 Promise 收口", async () => {
    let modelCalls = 0;
    let active = 0;
    let maxObserved = 0;
    let releaseFirst: (() => void) | undefined;
    const bridge = await startEvaluatorBridgeV2({
      rawCapability: TOKEN,
      capability: {
        contractVersion: "cortex.evaluator-bridge-capability.v2",
        capabilityHash: TOKEN_HASH,
        binding: { kind: "RUN", runId: ID },
        evaluationContextHash: HASH,
        evaluatorConfigHash: HASH,
        maxCalls: 2,
        maxConcurrency: 1,
        timeoutMs: 100,
        expiresAt: "2026-07-15T00:00:00.000Z"
      },
      now: () => new Date("2026-07-14T00:00:00.000Z"),
      createCallId: () => ID,
      evaluator: {
        generate: () => {
          modelCalls += 1;
          active += 1;
          maxObserved = Math.max(maxObserved, active);
          if (modelCalls === 1) {
            return new Promise((resolve) => {
              releaseFirst = (): void => {
                active -= 1;
                resolve({ text: "late", structured: null, tokenUsage: null });
              };
            });
          }
          active -= 1;
          return Promise.resolve({ text: "ok", structured: null, tokenUsage: null });
        }
      }
    });
    const invoke = (): Promise<Response> =>
      fetch(bridge.url, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(requestBody())
      });

    try {
      expect((await invoke()).status).toBe(504);
      expect(bridge.stats()).toEqual({ acceptedCalls: 1, completedCalls: 1, inFlight: 1 });
      const second = invoke();
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(modelCalls).toBe(1);
      expect(maxObserved).toBe(1);
      releaseFirst?.();
      expect((await second).status).toBe(200);
      expect(bridge.stats()).toEqual({ acceptedCalls: 2, completedCalls: 2, inFlight: 0 });
    } finally {
      releaseFirst?.();
      await bridge.close();
    }
  });

  it("排队请求在获得并发槽后重新校验 TTL，过期时不调用 Evaluator", async () => {
    let currentTime = new Date("2026-07-14T00:00:00.000Z");
    let modelCalls = 0;
    let releaseFirst: (() => void) | undefined;
    let firstEnteredResolve: (() => void) | undefined;
    const firstEntered = new Promise<void>((resolve) => {
      firstEnteredResolve = resolve;
    });
    const bridge = await startEvaluatorBridgeV2({
      rawCapability: TOKEN,
      capability: {
        contractVersion: "cortex.evaluator-bridge-capability.v2",
        capabilityHash: TOKEN_HASH,
        binding: { kind: "RUN", runId: ID },
        evaluationContextHash: HASH,
        evaluatorConfigHash: HASH,
        maxCalls: 2,
        maxConcurrency: 1,
        timeoutMs: 1_000,
        expiresAt: "2026-07-14T00:00:01.000Z"
      },
      now: () => currentTime,
      createCallId: () => ID,
      evaluator: {
        generate: async () => {
          modelCalls += 1;
          if (modelCalls === 1) {
            firstEnteredResolve?.();
            await new Promise<void>((resolve) => {
              releaseFirst = resolve;
            });
          }
          return { text: "ok", structured: null, tokenUsage: null };
        }
      }
    });
    const invoke = (): Promise<Response> =>
      fetch(bridge.url, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(requestBody())
      });

    try {
      const first = invoke();
      await firstEntered;
      const second = invoke();
      await expect.poll(() => bridge.stats().acceptedCalls).toBe(2);
      currentTime = new Date("2026-07-14T00:00:02.000Z");
      releaseFirst?.();

      expect((await first).status).toBe(200);
      expect((await second).status).toBe(401);
      expect(modelCalls).toBe(1);
      expect(bridge.stats()).toEqual({ acceptedCalls: 2, completedCalls: 2, inFlight: 0 });
    } finally {
      releaseFirst?.();
      await bridge.close();
    }
  });

  it("只接受当前调用期 Capability，并按总预算调用冻结 Evaluator", async () => {
    const prompts: string[] = [];
    const bridge = await startEvaluatorBridgeV2({
      rawCapability: TOKEN,
      capability: {
        contractVersion: "cortex.evaluator-bridge-capability.v2",
        capabilityHash: TOKEN_HASH,
        binding: { kind: "RUN", runId: ID },
        evaluationContextHash: HASH,
        evaluatorConfigHash: HASH,
        maxCalls: 2,
        maxConcurrency: 1,
        timeoutMs: 1_000,
        expiresAt: "2026-07-15T00:00:00.000Z"
      },
      now: () => new Date("2026-07-14T00:00:00.000Z"),
      createCallId: () => ID,
      evaluator: {
        generate: ({ prompt }) => {
          prompts.push(prompt);
          return Promise.resolve({ text: "ok", structured: null, tokenUsage: null });
        }
      }
    });

    try {
      const call = (): Promise<Response> =>
        fetch(bridge.url, {
          method: "POST",
          headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify(requestBody())
        });
      expect((await call()).status).toBe(200);
      expect((await call()).status).toBe(200);
      const exhausted = await call();
      expect(exhausted.status).toBe(429);
      expect(await exhausted.json()).toMatchObject({
        status: "ERROR",
        error: { code: "EVALUATOR_BUDGET_EXCEEDED", retryable: false }
      });
      expect(prompts).toEqual(["judge this", "judge this"]);
      expect(bridge.stats()).toEqual({ acceptedCalls: 2, completedCalls: 2, inFlight: 0 });
    } finally {
      await bridge.close();
    }
  });

  it("拒绝非法 Token、绑定、过期和额外请求字段，不把脏值传给 Evaluator", async () => {
    let modelCalls = 0;
    let currentTime = new Date("2026-07-14T00:00:00.000Z");
    const bridge = await startEvaluatorBridgeV2({
      rawCapability: TOKEN,
      capability: {
        contractVersion: "cortex.evaluator-bridge-capability.v2",
        capabilityHash: TOKEN_HASH,
        binding: { kind: "RUN", runId: ID },
        evaluationContextHash: HASH,
        evaluatorConfigHash: HASH,
        maxCalls: 1,
        maxConcurrency: 1,
        timeoutMs: 1_000,
        expiresAt: "2026-07-14T00:00:01.000Z"
      },
      now: () => currentTime,
      createCallId: () => ID,
      evaluator: {
        generate: () => {
          modelCalls += 1;
          return Promise.resolve({ text: "unexpected", structured: null, tokenUsage: null });
        }
      }
    });

    try {
      const invoke = (token: string, body: Readonly<Record<string, unknown>>): Promise<Response> =>
        fetch(bridge.url, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(body)
        });
      expect(await requestStatusWithHost(bridge.url, "external.example")).toBe(400);
      expect((await invoke("B".repeat(43), requestBody())).status).toBe(401);
      expect(
        (
          await invoke(TOKEN, {
            ...requestBody(),
            binding: { kind: "EXECUTION", executionId: ID }
          })
        ).status
      ).toBe(403);
      expect((await invoke(TOKEN, { ...requestBody(), metric: "quality" })).status).toBe(400);
      currentTime = new Date("2026-07-14T00:00:02.000Z");
      expect((await invoke(TOKEN, requestBody())).status).toBe(401);
      expect(modelCalls).toBe(0);
    } finally {
      await bridge.close();
    }
  });

  it("超时和关闭会取消在途 Evaluator，Bridge 只监听随机回环地址", async () => {
    let aborted = false;
    const bridge = await startEvaluatorBridgeV2({
      rawCapability: TOKEN,
      capability: {
        contractVersion: "cortex.evaluator-bridge-capability.v2",
        capabilityHash: TOKEN_HASH,
        binding: { kind: "RUN", runId: ID },
        evaluationContextHash: HASH,
        evaluatorConfigHash: HASH,
        maxCalls: 1,
        maxConcurrency: 1,
        timeoutMs: 100,
        expiresAt: "2026-07-15T00:00:00.000Z"
      },
      now: () => new Date("2026-07-14T00:00:00.000Z"),
      createCallId: () => ID,
      evaluator: {
        generate: ({ signal }) =>
          new Promise(() => {
            signal.addEventListener(
              "abort",
              () => {
                aborted = true;
              },
              { once: true }
            );
          })
      }
    });

    expect(new URL(bridge.url).hostname).toBe("127.0.0.1");
    const response = await fetch(bridge.url, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(requestBody())
    });
    expect(response.status).toBe(504);
    expect(aborted).toBe(true);
    await expect(bridge.close()).resolves.toBeUndefined();
  });

  it("关闭会收口忽略 Abort 的在途 Evaluator", async () => {
    let enteredResolve: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    const bridge = await startEvaluatorBridgeV2({
      rawCapability: TOKEN,
      capability: {
        contractVersion: "cortex.evaluator-bridge-capability.v2",
        capabilityHash: TOKEN_HASH,
        binding: { kind: "RUN", runId: ID },
        evaluationContextHash: HASH,
        evaluatorConfigHash: HASH,
        maxCalls: 1,
        maxConcurrency: 1,
        timeoutMs: 10_000,
        expiresAt: "2026-07-15T00:00:00.000Z"
      },
      now: () => new Date("2026-07-14T00:00:00.000Z"),
      createCallId: () => ID,
      evaluator: {
        generate: () => {
          enteredResolve?.();
          return new Promise(() => undefined);
        }
      }
    });
    const response = fetch(bridge.url, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(requestBody())
    });
    await entered;

    await expect(bridge.close()).resolves.toBeUndefined();
    expect((await response).status).toBe(499);
    expect(bridge.stats()).toEqual({ acceptedCalls: 1, completedCalls: 1, inFlight: 1 });
  });
});
