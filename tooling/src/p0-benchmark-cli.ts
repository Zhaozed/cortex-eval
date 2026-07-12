import { runBenchmark } from "./benchmark-harness.ts";
import { generateBenchmarkCases } from "./deterministic-cases.ts";

const result = await runBenchmark(
  () => {
    const cases = generateBenchmarkCases(1_000, 20260713);
    JSON.stringify(cases);
  },
  1,
  5
);
process.stdout.write(`${JSON.stringify(result)}\n`);
