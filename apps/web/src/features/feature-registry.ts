/** One navigation capability registered by a closed Feature. */
export interface FeatureContribution {
  /** Stable internal Feature identity. */
  readonly id: string;
  /** Sidebar task group, independent of the resource route. */
  readonly group: "workspace" | "connections" | "rules";
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

/** Sidebar groups keep execution and configuration tasks distinct. */
export const NAVIGATION_GROUPS = [
  { id: "workspace", labelKey: "navigation.workspace" },
  { id: "connections", labelKey: "navigation.connections" },
  { id: "rules", labelKey: "navigation.rules" }
] as const;

/** Existing resource pages are directly accessible, without a configuration landing step. */
export const CURRENT_FEATURES: readonly FeatureContribution[] = [
  { id: "dashboard", group: "workspace", path: "/", labelKey: "navigation.dashboard" },
  { id: "runs", group: "workspace", path: "/runs", labelKey: "navigation.runs" },
  {
    id: "test-suites",
    group: "workspace",
    path: "/test-suites",
    labelKey: "navigation.testSuites"
  },
  {
    id: "endpoint-configs",
    group: "connections",
    path: "/endpoint-configs",
    labelKey: "navigation.endpoints"
  },
  { id: "llm-configs", group: "connections", path: "/llm-configs", labelKey: "navigation.llms" },
  {
    id: "rubric-prompts",
    group: "rules",
    path: "/rubric-prompts",
    labelKey: "navigation.rubricPrompts"
  },
  {
    id: "analysis-prompts",
    group: "rules",
    path: "/analysis-prompts",
    labelKey: "navigation.analysisPrompts"
  }
];

/** Resource-count Dashboard contributions retained alongside recent platform Runs. */
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
