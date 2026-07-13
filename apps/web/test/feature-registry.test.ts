import { describe, expect, it, vi } from "vitest";

import {
  CURRENT_FEATURES,
  countCursorResources,
  resourceDashboardContributions
} from "../src/features/feature-registry.ts";

describe("P5 Feature Contribution", () => {
  it("注册已闭环资源页面与平台 Run", () => {
    expect(CURRENT_FEATURES.map((feature) => feature.id)).toEqual([
      "dashboard",
      "runs",
      "test-suites",
      "endpoint-configs",
      "llm-configs",
      "rubric-prompts",
      "analysis-prompts"
    ]);
    expect(CURRENT_FEATURES.some((feature) => ["reports", "analysis"].includes(feature.id))).toBe(
      false
    );
  });

  it("Dashboard 只注册六类资源数量", () => {
    expect(resourceDashboardContributions.map((item) => item.id)).toEqual([
      "test-suites",
      "cases",
      "endpoint-configs",
      "llm-configs",
      "rubric-prompts",
      "analysis-prompts"
    ]);
  });

  it("逐页聚合精确数量并传递取消信号", async () => {
    const signal = new AbortController().signal;
    const loadPage = vi
      .fn<
        (
          cursor: string | null,
          signal: AbortSignal
        ) => Promise<{ count: number; next: string | null }>
      >()
      .mockResolvedValueOnce({ count: 2, next: "res_v1_next" })
      .mockResolvedValueOnce({ count: 1, next: null });

    await expect(countCursorResources(loadPage, signal)).resolves.toBe(3);
    expect(loadPage).toHaveBeenNthCalledWith(1, null, signal);
    expect(loadPage).toHaveBeenNthCalledWith(2, "res_v1_next", signal);
  });

  it("拒绝服务端循环 cursor，避免永久 Loading", async () => {
    const loadPage = vi
      .fn<
        (
          cursor: string | null,
          signal: AbortSignal
        ) => Promise<{ count: number; next: string | null }>
      >()
      .mockResolvedValueOnce({ count: 1, next: "res_v1_loop" })
      .mockResolvedValueOnce({ count: 1, next: "res_v1_loop" });

    await expect(countCursorResources(loadPage, new AbortController().signal)).rejects.toThrow(
      "CLIENT_CURSOR_LOOP"
    );
  });
});
