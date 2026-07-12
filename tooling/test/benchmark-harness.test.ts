import { describe, expect, it } from "vitest";

import { runBenchmark } from "../src/benchmark-harness.ts";

describe("Benchmark Harness", () => {
  it("分离预热与样本并记录环境和 nearest-rank", async () => {
    let calls = 0;
    const result = await runBenchmark(
      () => {
        calls += 1;
      },
      2,
      5
    );
    expect(calls).toBe(7);
    expect(result.samplesMs).toHaveLength(5);
    expect(result.environment).toMatchObject({ architecture: "arm64", nodeVersion: "v24.18.0" });
    expect(result.medianMs).toBeGreaterThanOrEqual(0);
    expect(result.p95Ms).toBeGreaterThanOrEqual(result.medianMs);
    expect(result.p99Ms).toBeGreaterThanOrEqual(result.p95Ms);
  });

  it("拒绝空测量与负预热", async () => {
    await expect(runBenchmark(() => undefined, -1, 1)).rejects.toThrow("BENCHMARK_SAMPLE_COUNT");
    await expect(runBenchmark(() => undefined, 0, 0)).rejects.toThrow("BENCHMARK_SAMPLE_COUNT");
  });
});
