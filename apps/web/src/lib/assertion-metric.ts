/**
 * Read-only parsing of Assertion `metric` names.
 *
 * The v2 naming convention is `【硬性】D2.3 写入次数上限｜create_event ≤ 1 次`:
 * the bracket prefix carries the scoring tier (a HARD gate vetoes the Case) and `D<layer>.<序号>`
 * carries the dimension used for grouping and aggregation. Legacy suites carry neither, so every
 * function here degrades to "未分类" instead of throwing or hiding the original text.
 */

/** One dimension layer of the v2 metric convention, in report order. */
export interface AssertionDimensionEntry {
  /** Stable layer id, for example `D5`. */
  readonly id: string;
  /** Human-readable layer title shown in grouping headers. */
  readonly label: string;
}

/** The six dimension layers declared by the evaluation spec. */
export const ASSERTION_DIMENSIONS: readonly AssertionDimensionEntry[] = [
  { id: "D1", label: "D1 意图与路由" },
  { id: "D2", label: "D2 工具编排" },
  { id: "D3", label: "D3 结果真实性" },
  { id: "D4", label: "D4 语音可播报性" },
  { id: "D5", label: "D5 视觉交互 / A2UI" },
  { id: "D6", label: "D6 安全与边界" }
];

/** Scoring tier carried by the metric prefix. */
export type AssertionTier = "HARD" | "SOFT" | "UNMARKED";

const TIER_LABELS: Readonly<Record<AssertionTier, string>> = {
  HARD: "硬性门禁",
  SOFT: "质量项",
  UNMARKED: "未分类"
};

/** Group title for metrics without a resolvable `D<layer>` marker. */
export const UNMARKED_DIMENSION_LABEL = "未分类（无 D1–D6 标记）";

/** One metric name split into the facts the UI colors, groups and aggregates on. */
export interface ParsedAssertionMetric {
  /** Scoring tier; `UNMARKED` when the prefix is absent or unrecognized. */
  readonly tier: AssertionTier;
  /** Badge text for the tier. */
  readonly tierLabel: string;
  /** Resolved dimension id, or null when the metric carries none. */
  readonly dimension: string | null;
  /** Dimension group title, including the unclassified fallback. */
  readonly dimensionLabel: string;
  /** Full sub-item code such as `D5.1`, or null. */
  readonly code: string | null;
  /** Short readable title, falling back to the original metric for legacy names. */
  readonly title: string;
  /** Text after `｜` describing what is actually checked; empty when absent. */
  readonly detail: string;
  /** Original metric string, never rewritten. */
  readonly raw: string;
}

const HARD_PREFIX = /^\s*[【[]\s*(?:硬性|hard)\s*[】\]]/i;
const SOFT_PREFIX = /^\s*[【[]\s*(?:质量|软性|soft)\s*[】\]]/i;
const DIMENSION_CODE = /^\s*(D[1-6](?:\.\d+)?)\s*(.*)$/i;
const DIMENSION_ONLY = /(^|[^A-Za-z0-9])D([1-6])(?![.\d])/;
const SEPARATOR = /｜|\|/;

// Resolve a candidate layer id against the declared list instead of trusting the raw capture.
function dimensionOf(value: string | undefined): string | null {
  const upper = value?.toUpperCase();
  return ASSERTION_DIMENSIONS.some((entry) => entry.id === upper) ? (upper ?? null) : null;
}

/** Parse one metric name; any input shape yields a renderable, non-throwing result. */
export function parseAssertionMetric(metric: unknown): ParsedAssertionMetric {
  const raw = typeof metric === "string" ? metric : "";
  const trimmed = raw.trim();
  const hard = HARD_PREFIX.exec(trimmed);
  const soft = hard === null ? SOFT_PREFIX.exec(trimmed) : null;
  const tier: AssertionTier = hard !== null ? "HARD" : soft !== null ? "SOFT" : "UNMARKED";
  const prefix = (hard ?? soft)?.[0] ?? "";
  const body = trimmed.slice(prefix.length).trim();
  const parts = body.split(SEPARATOR);
  const head = (parts[0] ?? body).trim();
  const detail = parts.length > 1 ? parts.slice(1).join("｜").trim() : "";
  const coded = DIMENSION_CODE.exec(head);
  const code = coded?.[1]?.toUpperCase() ?? null;
  const name = (coded?.[2] ?? "").trim();
  const bare = coded === null ? DIMENSION_ONLY.exec(head)?.[2] : undefined;
  const dimension = dimensionOf(code?.slice(0, 2)) ?? dimensionOf(bare);
  const label = ASSERTION_DIMENSIONS.find((entry) => entry.id === dimension)?.label;
  return {
    tier,
    tierLabel: TIER_LABELS[tier],
    dimension,
    dimensionLabel: label ?? UNMARKED_DIMENSION_LABEL,
    code,
    title:
      code !== null && name.length > 0
        ? `${code} ${name}`
        : head.length > 0
          ? head
          : trimmed.length > 0
            ? trimmed
            : "未命名断言",
    detail,
    raw: trimmed
  };
}

/** One Assertion outcome as recorded by the evaluator. */
export interface AssertionOutcome {
  /** Metric name of the executed Assertion. */
  readonly metric: string;
  /** Recorded status; only `PASS` counts as passed. */
  readonly status: string;
}

/** Pass counters for one tier or dimension bucket. */
export interface AssertionBucketCount {
  /** Every Assertion in the bucket, including abnormal ones. */
  readonly total: number;
  /** Assertions with status `PASS`. */
  readonly pass: number;
  /** Assertions with status `FAIL`. */
  readonly fail: number;
  /** Error, skipped, conflicting or missing results. */
  readonly other: number;
}

const EMPTY_BUCKET: AssertionBucketCount = { total: 0, pass: 0, fail: 0, other: 0 };

// Fold one outcome into an immutable bucket counter.
function addOutcome(bucket: AssertionBucketCount, status: string): AssertionBucketCount {
  return {
    total: bucket.total + 1,
    pass: bucket.pass + (status === "PASS" ? 1 : 0),
    fail: bucket.fail + (status === "FAIL" ? 1 : 0),
    other: bucket.other + (status === "PASS" || status === "FAIL" ? 0 : 1)
  };
}

/** Tier totals for a set of outcomes; `marked` is false for suites without tier prefixes. */
export interface AssertionTierSummary {
  /** `【硬性】` gates that veto the Case verdict. */
  readonly hard: AssertionBucketCount;
  /** `【质量】` scored items that never veto. */
  readonly soft: AssertionBucketCount;
  /** Metrics without a recognizable prefix. */
  readonly unmarked: AssertionBucketCount;
  /** True when at least one metric carries a tier prefix. */
  readonly marked: boolean;
}

/** Count outcomes per scoring tier. */
export function summarizeAssertionTiers(
  outcomes: readonly { readonly tier: AssertionTier; readonly status: string }[]
): AssertionTierSummary {
  let hard = EMPTY_BUCKET;
  let soft = EMPTY_BUCKET;
  let unmarked = EMPTY_BUCKET;
  for (const outcome of outcomes) {
    if (outcome.tier === "HARD") hard = addOutcome(hard, outcome.status);
    else if (outcome.tier === "SOFT") soft = addOutcome(soft, outcome.status);
    else unmarked = addOutcome(unmarked, outcome.status);
  }
  return { hard, soft, unmarked, marked: hard.total + soft.total > 0 };
}

/** Count distinct metric names per tier, as projected into the Case list. */
export function countMetricsByTier(metrics: readonly unknown[]): {
  readonly hard: number;
  readonly soft: number;
  readonly unmarked: number;
  readonly total: number;
} {
  let hard = 0;
  let soft = 0;
  let unmarked = 0;
  for (const metric of metrics) {
    const tier = parseAssertionMetric(metric).tier;
    if (tier === "HARD") hard += 1;
    else if (tier === "SOFT") soft += 1;
    else unmarked += 1;
  }
  return { hard, soft, unmarked, total: metrics.length };
}

/** One stored Assertion definition; only the fields the collector reads are typed. */
interface AssertNodeLike {
  readonly metric?: unknown;
  readonly assert?: readonly unknown[];
}

/**
 * Collect every metric name in a Case Definition `assert` tree.
 * `assert-set` nodes nest children under `assert`; any unexpected shape is skipped rather than
 * throwing, because this only feeds display counters.
 */
export function collectAssertMetrics(assert: readonly unknown[]): string[] {
  const metrics: string[] = [];
  const visit = (nodes: readonly unknown[]): void => {
    for (const node of nodes) {
      if (typeof node !== "object" || node === null) continue;
      const value = node as AssertNodeLike;
      if (typeof value.metric === "string" && value.metric.trim() !== "")
        metrics.push(value.metric);
      if (Array.isArray(value.assert)) visit(value.assert);
    }
  };
  visit(assert);
  return metrics;
}

/**
 * Count `【质量】` misses, which never veto a Case verdict.
 * A PASS Case with quality misses must still surface them instead of hiding behind a green total.
 */
export function softFailureCount(assertions: readonly AssertionOutcome[]): number {
  return summarizeAssertionTiers(
    assertions.map((assertion) => ({
      tier: parseAssertionMetric(assertion.metric).tier,
      status: assertion.status
    }))
  ).soft.fail;
}

/** One dimension pass rate computed per Assertion, never per Case. */
export interface DimensionRate extends AssertionBucketCount {
  /** Dimension id, or null for the unclassified bucket. */
  readonly dimension: string | null;
  /** Dimension group title. */
  readonly label: string;
  /** Rounded pass percentage, 0 when the bucket is empty. */
  readonly percent: number;
  /** Bar coloring hint; `none` means this Run asserted nothing in the dimension. */
  readonly level: "none" | "low" | "mid" | "high";
}

// Map a pass percentage onto the three coloring buckets used by the progress bar.
function rateLevel(total: number, percent: number): DimensionRate["level"] {
  if (total === 0) return "none";
  if (percent >= 90) return "high";
  return percent >= 60 ? "mid" : "low";
}

/**
 * Aggregate Assertion outcomes into `D1…D6` plus one unclassified bucket.
 * All six dimensions are always returned so an untested dimension stays visible as `无断言`.
 */
export function aggregateAssertionsByDimension(
  assertions: readonly AssertionOutcome[]
): DimensionRate[] {
  const buckets = new Map<string, AssertionBucketCount>();
  let unmarked = EMPTY_BUCKET;
  for (const assertion of assertions) {
    const parsed = parseAssertionMetric(assertion.metric);
    if (parsed.dimension === null) {
      unmarked = addOutcome(unmarked, assertion.status);
      continue;
    }
    buckets.set(
      parsed.dimension,
      addOutcome(buckets.get(parsed.dimension) ?? EMPTY_BUCKET, assertion.status)
    );
  }
  const rates = ASSERTION_DIMENSIONS.map((entry) => {
    const bucket = buckets.get(entry.id) ?? EMPTY_BUCKET;
    const percent = bucket.total === 0 ? 0 : Math.round((bucket.pass / bucket.total) * 100);
    return {
      dimension: entry.id,
      label: entry.label,
      ...bucket,
      percent,
      level: rateLevel(bucket.total, percent)
    } satisfies DimensionRate;
  });
  if (unmarked.total === 0) return rates;
  const percent = Math.round((unmarked.pass / unmarked.total) * 100);
  return [
    ...rates,
    {
      dimension: null,
      label: UNMARKED_DIMENSION_LABEL,
      ...unmarked,
      percent,
      level: rateLevel(unmarked.total, percent)
    }
  ];
}

/** One Case domain of the v2 suite, derived from the Case ID prefix. */
export interface CaseDomain {
  /** Prefix such as `FS2-C`. */
  readonly code: string;
  /** Chinese domain name. */
  readonly label: string;
}

/** The seven v2 Case domains and their ID prefixes. */
export const CASE_DOMAINS: readonly CaseDomain[] = [
  { code: "FS2-D", label: "飞书文档" },
  { code: "FS2-M", label: "飞书消息与人" },
  { code: "FS2-C", label: "飞书日历与会议室" },
  { code: "FS2-X", label: "组合链路" },
  { code: "FS2-V", label: "语音播报专项" },
  { code: "FS2-A", label: "A2UI 视觉专项" },
  { code: "FS2-S", label: "安全与边界" }
];

// 真实 Case ID 形如 `FS2-D01-01`（域字母后紧跟数字），所以只排除「后面还是字母」的情况；
// 早先写成 (?![A-Za-z0-9]) 会把所有真实 ID 判成「无法归域」，UI 域列全是 —。
const CASE_DOMAIN_PREFIX = /^(FS2-[DMCXVAS])(?![A-Za-z])/i;

/** Read the domain from a Case ID; null when the ID predates the v2 naming. */
export function caseDomain(caseKey: unknown): CaseDomain | null {
  if (typeof caseKey !== "string") return null;
  const prefix = CASE_DOMAIN_PREFIX.exec(caseKey.trim())?.[1]?.toUpperCase();
  return CASE_DOMAINS.find((entry) => entry.code === prefix) ?? null;
}

/**
 * Count user rounds in a stored request body.
 * Multi-turn Cases carry `conversation`, single-turn Cases carry `text`; anything else is unknown.
 */
export function caseTurnCount(requestBody: unknown): number | null {
  if (typeof requestBody !== "object" || requestBody === null) return null;
  const body = requestBody as Record<string, unknown>;
  const conversation = body.conversation;
  if (Array.isArray(conversation) && conversation.length > 0) {
    const users = conversation.filter(
      (turn) =>
        typeof turn === "object" &&
        turn !== null &&
        (turn as Record<string, unknown>).role === "user"
    );
    return users.length > 0 ? users.length : conversation.length;
  }
  return typeof body.text === "string" && body.text.trim().length > 0 ? 1 : null;
}
