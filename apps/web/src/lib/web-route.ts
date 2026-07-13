/** P5 routes registered only after their resource or REST Run flows are closed. */
export type WebRoute =
  | { readonly kind: "DASHBOARD" }
  | { readonly kind: "RUN_LIST" }
  | { readonly kind: "RUN_DETAIL"; readonly runId: string }
  | { readonly kind: "TEST_SUITE_LIST" }
  | { readonly kind: "TEST_SUITE_DETAIL"; readonly suiteId: string }
  | { readonly kind: "ENDPOINT_CONFIG_LIST" }
  | { readonly kind: "LLM_CONFIG_LIST" }
  | { readonly kind: "RUBRIC_PROMPT_LIST" }
  | { readonly kind: "ANALYSIS_PROMPT_LIST" };

/** URL-backed Case list state that survives refresh. */
export interface CaseListUrlState {
  /** Case Key literal substring. */
  readonly caseKey: string;
  /** Description literal substring. */
  readonly description: string;
  /** Selected business modules with OR semantics. */
  readonly businessModules: readonly string[];
  /** Selected scenario tags with OR semantics. */
  readonly scenarioTags: readonly string[];
  /** Selected Assertion types with OR semantics. */
  readonly assertionTypes: readonly string[];
  /** Selected Metrics with OR semantics. */
  readonly metrics: readonly string[];
  /** Requested server page size. */
  readonly limit: number;
  /** Current opaque server cursor. */
  readonly cursor: string | null;
  /** Earlier page cursors in navigation order. */
  readonly before: readonly string[];
}

const DEFAULT_CASE_PAGE_SIZE = 50;

// Decode one safe path component without leaking malformed URL input.
function decodePathComponent(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length === 0 ? null : decoded;
  } catch {
    return null;
  }
}

/** Resolve one browser pathname without registering future Feature routes. */
export function resolveWebRoute(pathname: string): WebRoute | null {
  const normalized = pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
  if (normalized === "/") return { kind: "DASHBOARD" };
  if (normalized === "/runs") return { kind: "RUN_LIST" };
  const runMatch = /^\/runs\/([^/]+)$/.exec(normalized);
  if (runMatch?.[1] !== undefined) {
    const runId = decodePathComponent(runMatch[1]);
    return runId === null ? null : { kind: "RUN_DETAIL", runId };
  }
  if (normalized === "/test-suites") return { kind: "TEST_SUITE_LIST" };
  const suiteMatch = /^\/test-suites\/([^/]+)$/.exec(normalized);
  if (suiteMatch?.[1] !== undefined) {
    const suiteId = decodePathComponent(suiteMatch[1]);
    return suiteId === null ? null : { kind: "TEST_SUITE_DETAIL", suiteId };
  }
  if (normalized === "/endpoint-configs") return { kind: "ENDPOINT_CONFIG_LIST" };
  if (normalized === "/llm-configs") return { kind: "LLM_CONFIG_LIST" };
  if (normalized === "/rubric-prompts") return { kind: "RUBRIC_PROMPT_LIST" };
  if (normalized === "/analysis-prompts") return { kind: "ANALYSIS_PROMPT_LIST" };
  return null;
}

// Return trimmed nonempty repeated query values in source order.
function queryValues(search: URLSearchParams, name: string): readonly string[] {
  return search
    .getAll(name)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

// Parse a bounded page size or return the stable UI default.
function pageSize(value: string | null): number {
  if (value === null || !/^\d+$/.test(value)) return DEFAULT_CASE_PAGE_SIZE;
  const parsed = Number(value);
  return parsed >= 1 && parsed <= 200 ? parsed : DEFAULT_CASE_PAGE_SIZE;
}

/** Parse URL state at the dirty browser boundary. */
export function parseCaseListSearch(search: URLSearchParams): CaseListUrlState {
  const cursor = search.get("cursor")?.trim() ?? "";
  return {
    caseKey: search.get("caseKey") ?? "",
    description: search.get("description") ?? "",
    businessModules: queryValues(search, "businessModule"),
    scenarioTags: queryValues(search, "scenarioTag"),
    assertionTypes: queryValues(search, "assertionType"),
    metrics: queryValues(search, "metric"),
    limit: pageSize(search.get("limit")),
    cursor: cursor.length === 0 ? null : cursor,
    before: queryValues(search, "before")
  };
}

// Append one optional scalar URL value.
function appendScalar(search: URLSearchParams, name: string, value: string): void {
  if (value.length > 0) search.append(name, value);
}

// Append one repeated URL value list in stable source order.
function appendValues(search: URLSearchParams, name: string, values: readonly string[]): void {
  for (const value of values) appendScalar(search, name, value);
}

/** Serialize Case list state in one stable, refresh-safe order. */
export function buildCaseListSearch(state: CaseListUrlState): URLSearchParams {
  const search = new URLSearchParams();
  appendScalar(search, "caseKey", state.caseKey);
  appendScalar(search, "description", state.description);
  appendValues(search, "businessModule", state.businessModules);
  appendValues(search, "scenarioTag", state.scenarioTags);
  appendValues(search, "assertionType", state.assertionTypes);
  appendValues(search, "metric", state.metrics);
  search.append("limit", String(state.limit));
  if (state.cursor !== null) search.append("cursor", state.cursor);
  appendValues(search, "before", state.before);
  return search;
}
