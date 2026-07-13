/** One navigation capability registered by a closed Feature. */
export interface FeatureContribution {
  /** Stable internal Feature identity. */
  readonly id: string;
  /** Browser path owned by the Feature. */
  readonly path: string;
  /** Externalized Chinese navigation label key. */
  readonly labelKey: string;
}

/** One P4 Dashboard resource count contribution. */
export interface ResourceDashboardContribution {
  /** Stable resource family identity. */
  readonly id: string;
  /** Externalized Chinese resource label key. */
  readonly labelKey: string;
}

/** Closed P4 navigation contributions in display order. */
export const CURRENT_FEATURES: readonly FeatureContribution[] = [
  { id: "dashboard", path: "/", labelKey: "navigation.dashboard" },
  { id: "test-suites", path: "/test-suites", labelKey: "navigation.testSuites" },
  { id: "endpoint-configs", path: "/endpoint-configs", labelKey: "navigation.endpoints" },
  { id: "llm-configs", path: "/llm-configs", labelKey: "navigation.llms" },
  { id: "rubric-prompts", path: "/rubric-prompts", labelKey: "navigation.rubricPrompts" },
  {
    id: "analysis-prompts",
    path: "/analysis-prompts",
    labelKey: "navigation.analysisPrompts"
  }
];

/** P4 Dashboard contributions; no Run, Report or Analysis facts are registered. */
export const resourceDashboardContributions: readonly ResourceDashboardContribution[] = [
  { id: "test-suites", labelKey: "resources.testSuites" },
  { id: "cases", labelKey: "resources.cases" },
  { id: "endpoint-configs", labelKey: "resources.endpointConfigs" },
  { id: "llm-configs", labelKey: "resources.llmConfigs" },
  { id: "rubric-prompts", labelKey: "resources.rubricPrompts" },
  { id: "analysis-prompts", labelKey: "resources.analysisPrompts" }
];

/** One small cursor page reduced to count-only facts. */
export interface CountCursorPage {
  /** Number of resources in this page. */
  readonly count: number;
  /** Next opaque cursor, or null at completion. */
  readonly next: string | null;
}

/** One abortable cursor page loader. */
export type CountCursorPageLoader = (
  cursor: string | null,
  signal: AbortSignal
) => Promise<CountCursorPage>;

/** Aggregate exact current counts while rejecting a broken cursor cycle. */
export async function countCursorResources(
  loadPage: CountCursorPageLoader,
  signal: AbortSignal
): Promise<number> {
  let cursor: string | null = null;
  let count = 0;
  const visited = new Set<string>();
  do {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    const page = await loadPage(cursor, signal);
    count += page.count;
    cursor = page.next;
    if (cursor !== null) {
      if (visited.has(cursor)) throw new Error("CLIENT_CURSOR_LOOP");
      visited.add(cursor);
    }
  } while (cursor !== null);
  return count;
}
