import type { ResourceApi } from "../../lib/resource-api.ts";

/** Exact distinct values from an unfiltered suite, not just the visible page. */
export interface CaseFilterOptions {
  readonly businessModules: readonly string[];
  readonly scenarioTags: readonly string[];
  readonly assertionTypes: readonly string[];
  readonly metrics: readonly string[];
}

export const EMPTY_CASE_FILTER_OPTIONS: CaseFilterOptions = {
  businessModules: [],
  scenarioTags: [],
  assertionTypes: [],
  metrics: []
};

/** Reuse the summary-only paginated API; abort and cursor errors never yield partial facets. */
export async function loadCaseFilterOptions(
  api: ResourceApi,
  suiteId: string,
  signal: AbortSignal
): Promise<CaseFilterOptions> {
  const modules = new Set<string>();
  const scenarios = new Set<string>();
  const types = new Set<string>();
  const metrics = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    signal.throwIfAborted();
    const page = await api.listCases(
      suiteId,
      {
        limit: 100,
        cursor,
        caseKey: "",
        description: "",
        businessModules: [],
        scenarioTags: [],
        assertionTypes: [],
        metrics: []
      },
      signal
    );
    for (const item of page.items) {
      modules.add(item.businessModule);
      scenarios.add(item.scenarioTag);
      item.assertionTypes.forEach((value) => types.add(value));
      item.metrics.forEach((value) => metrics.add(value));
    }
    cursor = page.nextCursor;
    if (cursor !== null) {
      if (cursors.has(cursor)) throw new Error("CASE_FILTER_CURSOR_REPEATED");
      cursors.add(cursor);
    }
  } while (cursor !== null);
  return {
    businessModules: [...modules].sort(),
    scenarioTags: [...scenarios].sort(),
    assertionTypes: [...types].sort(),
    metrics: [...metrics].sort()
  };
}
