import { performance } from "node:perf_hooks";

/** Stable environment facts attached to a benchmark run. */
export interface BenchmarkEnvironment {
  /** Operating system platform. */
  platform: NodeJS.Platform;
  /** CPU architecture. */
  architecture: string;
  /** Node.js version. */
  nodeVersion: string;
}

/** Benchmark samples and nearest-rank percentiles. */
export interface BenchmarkResult {
  /** Captured runtime environment. */
  environment: BenchmarkEnvironment;
  /** Raw measurements in milliseconds. */
  samplesMs: number[];
  /** Median measurement. */
  medianMs: number;
  /** Nearest-rank p95. */
  p95Ms: number;
  /** Nearest-rank p99. */
  p99Ms: number;
}

// Calculate a nearest-rank percentile from non-empty samples.
function nearestRank(sorted: readonly number[], percentile: number): number {
  const index = Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1);
  const value = sorted[index];
  if (value === undefined) {
    throw new Error("BENCHMARK_EMPTY_SAMPLES");
  }
  return value;
}

// Run isolated warmups and measurements for one deterministic operation.
export async function runBenchmark(
  operation: () => void | Promise<void>,
  warmups: number,
  measurements: number
): Promise<BenchmarkResult> {
  if (warmups < 0 || measurements < 1) {
    throw new Error("BENCHMARK_SAMPLE_COUNT");
  }
  for (let index = 0; index < warmups; index += 1) {
    await operation();
  }
  const samplesMs: number[] = [];
  for (let index = 0; index < measurements; index += 1) {
    const startedAt = performance.now();
    await operation();
    samplesMs.push(performance.now() - startedAt);
  }
  const sorted = [...samplesMs].sort((left, right) => left - right);
  return {
    environment: {
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.version
    },
    samplesMs,
    medianMs: nearestRank(sorted, 50),
    p95Ms: nearestRank(sorted, 95),
    p99Ms: nearestRank(sorted, 99)
  };
}
