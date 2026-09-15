import { describe, expect, it } from "vitest";

import {
  classifyEvaluatorProviderFailure,
  evaluatorModelErrorFromProvider,
  EVALUATOR_ERROR_DETAIL_SEPARATOR,
  MAX_PROVIDER_RETRY_AFTER_MS
} from "../src/evaluator-model-errors.ts";

// 复刻一次上游 Provider 限流失败：状态码、厂商码、Retry-After 都必须被保留。
function throttleFailure(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return Object.assign(new Error("Requests throttling triggered. Please try again later."), {
    status: 429,
    error: { code: "Throttling.BurstRate", message: "burst rate exceeded" },
    headers: new Map([["retry-after", "2"]]),
    ...overrides
  });
}

describe("Evaluator Provider 失败分类", () => {
  it("保留限流的状态码、厂商码与 Retry-After，并标记为可重试", () => {
    const { error, detail } = classifyEvaluatorProviderFailure(throttleFailure());

    expect(error.code).toBe("PROVIDER_REQUEST_FAILED");
    expect(detail).toEqual({
      status: 429,
      providerCode: "Throttling.BurstRate",
      providerMessage: "Requests throttling triggered. Please try again later.",
      transient: true,
      retryAfterMs: 2_000
    });
    expect(error.diagnostic()).toBe(
      `PROVIDER_REQUEST_FAILED${EVALUATOR_ERROR_DETAIL_SEPARATOR}HTTP 429 Throttling.BurstRate Requests throttling triggered. Please try again later.`
    );
  });

  it("400/422 归为能力不支持，其余状态归为请求失败", () => {
    expect(classifyEvaluatorProviderFailure(throttleFailure({ status: 400 })).error.code).toBe(
      "PROVIDER_CAPABILITY_UNSUPPORTED"
    );
    expect(classifyEvaluatorProviderFailure(throttleFailure({ status: 422 })).error.code).toBe(
      "PROVIDER_CAPABILITY_UNSUPPORTED"
    );
    expect(classifyEvaluatorProviderFailure(throttleFailure({ status: 503 })).error.code).toBe(
      "PROVIDER_REQUEST_FAILED"
    );
  });

  it("非瞬态失败不标记可重试，取消不是 Provider 故障", () => {
    const unauthorized = classifyEvaluatorProviderFailure(
      Object.assign(new Error("invalid api key"), { status: 401 })
    );
    expect(unauthorized.detail.transient).toBe(false);

    const aborted = classifyEvaluatorProviderFailure(
      Object.assign(new Error("aborted"), { name: "AbortError", code: "ABORT_ERR" })
    );
    expect(aborted.detail.transient).toBe(false);

    const socket = classifyEvaluatorProviderFailure(
      Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })
    );
    expect(socket.detail.transient).toBe(true);
  });

  it("Retry-After 被上限截断，缺失时不回退猜测", () => {
    const capped = classifyEvaluatorProviderFailure(
      throttleFailure({ headers: new Map([["retry-after", "600"]]) })
    );
    expect(capped.detail.retryAfterMs).toBe(MAX_PROVIDER_RETRY_AFTER_MS);

    const missing = classifyEvaluatorProviderFailure(throttleFailure({ headers: undefined }));
    expect(missing.detail.retryAfterMs).toBeNull();
  });

  it("脱敏凭证与长不透明串，并限制消息长度", () => {
    const { detail } = classifyEvaluatorProviderFailure(
      Object.assign(
        new Error(
          `invalid key sk-abcdefghijklmnopqrstuvwxyz123456 trace ${"Z".repeat(40)} ${"x".repeat(400)}`
        ),
        { status: 500 }
      )
    );
    expect(detail.providerMessage).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(detail.providerMessage).not.toContain("Z".repeat(40));
    expect(detail.providerMessage).toContain("[REDACTED]");
    expect((detail.providerMessage ?? "").length).toBeLessThanOrEqual(161);
  });

  it("兼容旧入口：只返回稳定错误", () => {
    const error = evaluatorModelErrorFromProvider(throttleFailure());
    expect(error.code).toBe("PROVIDER_REQUEST_FAILED");
    expect(error.detail?.status).toBe(429);
  });
});
