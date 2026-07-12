/** Component-level Metric state. */
export type MetricStatus = "FAIL" | "ERROR" | "PASS" | "SKIPPED" | "NOT_EVALUATED";

/** One Case contribution before deduplication. */
export interface MetricContribution {
  /** Stable Case key. */
  caseKey: string;
  /** Metric name. */
  metric: string;
  /** Component state. */
  status: MetricStatus;
}

/** Aggregated per-Metric counts. */
export interface MetricSummary {
  /** Metric name. */
  metric: string;
  /** PASS Case count. */
  pass: number;
  /** FAIL Case count. */
  fail: number;
  /** ERROR Case count. */
  error: number;
  /** SKIPPED Case count. */
  skipped: number;
  /** NOT_EVALUATED Case count. */
  notEvaluated: number;
  /** PASS / (PASS + FAIL), or null when unobserved. */
  passRate: number | null;
}

const STATUS_PRIORITY: Readonly<Record<MetricStatus, number>> = {
  FAIL: 5,
  ERROR: 4,
  PASS: 3,
  SKIPPED: 2,
  NOT_EVALUATED: 1
};

/** Calculate a Rate without inventing zero for an empty denominator. */
export function calculateRate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/** Deduplicate per Case and aggregate Metric states deterministically. */
export function aggregateMetrics(contributions: readonly MetricContribution[]): MetricSummary[] {
  const deduplicated = new Map<string, MetricContribution>();
  for (const contribution of contributions) {
    const key = `${contribution.metric}\u0000${contribution.caseKey}`;
    const existing = deduplicated.get(key);
    if (
      existing === undefined ||
      STATUS_PRIORITY[contribution.status] > STATUS_PRIORITY[existing.status]
    ) {
      deduplicated.set(key, contribution);
    }
  }
  const summaries = new Map<string, Omit<MetricSummary, "passRate">>();
  for (const contribution of deduplicated.values()) {
    const summary = summaries.get(contribution.metric) ?? {
      metric: contribution.metric,
      pass: 0,
      fail: 0,
      error: 0,
      skipped: 0,
      notEvaluated: 0
    };
    if (contribution.status === "PASS") summary.pass += 1;
    if (contribution.status === "FAIL") summary.fail += 1;
    if (contribution.status === "ERROR") summary.error += 1;
    if (contribution.status === "SKIPPED") summary.skipped += 1;
    if (contribution.status === "NOT_EVALUATED") summary.notEvaluated += 1;
    summaries.set(contribution.metric, summary);
  }
  return [...summaries.values()]
    .sort((left, right) => left.metric.localeCompare(right.metric))
    .map((summary) => ({
      ...summary,
      passRate: calculateRate(summary.pass, summary.pass + summary.fail)
    }));
}
