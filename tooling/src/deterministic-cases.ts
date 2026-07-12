/** Deterministic Case used only by the performance harness. */
export interface BenchmarkCase {
  /** Human-readable Case description. */
  description: string;
  /** Stable filtering metadata. */
  metadata: {
    /** Stable business Case ID. */
    case_id: string;
    /** Generated business module. */
    business_module: string;
    /** Generated scenario tag. */
    scenario_tag: string;
  };
  /** Endpoint input variables. */
  vars: {
    /** Endpoint task selector. */
    task: string;
    /** Endpoint JSON request body. */
    request_body: { value: number };
  };
  /** Minimal stable assertion set. */
  assert: readonly [{ type: "is-json"; metric: "结构正确"; value: { type: "object" } }];
}

// Advance a small deterministic generator suitable for repeatable fixtures.
function nextRandom(state: number): number {
  return (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
}

// Generate the fixed-size benchmark dataset without using wall time or randomness.
export function generateBenchmarkCases(count: number, seed: number): BenchmarkCase[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error("BENCHMARK_CASE_COUNT");
  }
  let state = seed >>> 0;
  return Array.from({ length: count }, (_, index) => {
    state = nextRandom(state);
    return {
      description: `基准 Case ${index + 1}`,
      metadata: {
        case_id: `benchmark-${String(index + 1).padStart(4, "0")}`,
        business_module: `module-${state % 8}`,
        scenario_tag: `scenario-${state % 16}`
      },
      vars: { task: `task-${state % 4}`, request_body: { value: state } },
      assert: [{ type: "is-json", metric: "结构正确", value: { type: "object" } }]
    };
  });
}
