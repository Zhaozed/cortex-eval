import { createHash, type Hash } from "node:crypto";

import { canonicalJson } from "@cortex-eval/domain/src/domain-canonical-hash.ts";
import { calculateRate } from "@cortex-eval/domain/src/domain-metrics.ts";

/** Stable owner of one immutable report version. */
export type ReportOwner =
  | { readonly kind: "RUN"; readonly id: string }
  | { readonly kind: "EXECUTION"; readonly id: string };

/** Case-level Metric fact already normalized by Evaluation. */
export interface ReportMetricFact {
  /** Stable Metric name. */
  readonly metric: string;
  /** Highest-priority status for this Case and Metric. */
  readonly status: "PASS" | "FAIL" | "ERROR" | "SKIPPED" | "NOT_EVALUATED";
}

/** Minimal REST identity needed by pure report reconciliation. */
export interface ReportRestFacts {
  /** Normalized REST status. */
  readonly status: "SUCCEEDED" | "ERROR";
  /** Semantic REST result hash. */
  readonly resultHash: string;
}

/** Minimal Evaluation identity needed by pure report reconciliation. */
export interface ReportEvaluationFacts {
  /** Normalized Evaluation status. */
  readonly status: "PASS" | "FAIL" | "EVALUATION_ERROR" | "NOT_EVALUATED";
  /** Semantic Evaluation result hash. */
  readonly evalResultHash: string;
  /** Hash binding the frozen Case, REST result and Evaluation result. */
  readonly finalCaseResultHash: string;
  /** Deduplicated Case Metric facts. */
  readonly metrics: readonly ReportMetricFact[];
}

/** One aligned Case identity supplied to the streaming report accumulator. */
export interface ReportCaseFacts {
  /** Stable Suite-local Case key. */
  readonly caseKey: string;
  /** Frozen zero-based Case order. */
  readonly ordinal: number;
  /** Complete REST identity projection. */
  readonly rest: ReportRestFacts;
  /** Complete Evaluation identity projection. */
  readonly evaluation: ReportEvaluationFacts;
}

/** Stable overall report counters and rates. */
export interface ReportSummary {
  /** Complete frozen Case count. */
  readonly total: number;
  /** Successful REST result count. */
  readonly restSucceeded: number;
  /** REST system-error count. */
  readonly restError: number;
  /** Evaluation PASS count. */
  readonly evalPass: number;
  /** Evaluation FAIL count. */
  readonly evalFail: number;
  /** Evaluation system-error count. */
  readonly evalError: number;
  /** Not Evaluated count. */
  readonly notEvaluated: number;
  /** PASS divided by all Cases. */
  readonly effectivePassRate: number | null;
  /** PASS divided by evaluated PASS plus FAIL. */
  readonly evaluatedPassRate: number | null;
  /** Evaluated PASS plus FAIL divided by all Cases. */
  readonly coverageRate: number | null;
}

/** Stable per-Metric counters and rate. */
export interface ReportMetricSummary {
  /** Stable Metric name. */
  readonly metric: string;
  /** PASS Case count. */
  readonly pass: number;
  /** FAIL Case count. */
  readonly fail: number;
  /** ERROR Case count. */
  readonly error: number;
  /** SKIPPED Case count. */
  readonly skipped: number;
  /** NOT_EVALUATED Case count. */
  readonly notEvaluated: number;
  /** PASS divided by PASS plus FAIL. */
  readonly passRate: number | null;
}

/** Final bounded facts produced after the complete Case stream is reconciled. */
export interface ReportAggregationResult {
  /** Stable overall report statistics. */
  readonly summary: ReportSummary;
  /** Stable Metric statistics sorted by Metric name. */
  readonly byMetric: readonly ReportMetricSummary[];
  /** Hash binding report owner, evaluation version, context and ordered Case facts. */
  readonly reportResultSetHash: string;
}

/** Immutable inputs shared by the complete report stream. */
export interface CreateReportAccumulatorInput {
  /** Immutable platform Run or offline Execution identity. */
  readonly owner: ReportOwner;
  /** Frozen Run context hash. */
  readonly runContextHash: string;
  /** Frozen Evaluation context hash. */
  readonly evaluationContextHash: string;
  /** Complete Evaluation result-set hash for this execution version. */
  readonly evaluationResultSetHash: string;
  /** Resolve the expected Case key without retaining the complete Case collection. */
  readonly expectedCaseKey: (ordinal: number) => string | null;
}

interface MutableMetricSummary {
  metric: string;
  pass: number;
  fail: number;
  error: number;
  skipped: number;
  notEvaluated: number;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

// Validate one lowercase SHA-256 fact.
function isSha256(value: string): boolean {
  return SHA256_PATTERN.test(value);
}

// Create an empty mutable Metric bucket owned only by one accumulator.
function emptyMetricSummary(metric: string): MutableMetricSummary {
  return { metric, pass: 0, fail: 0, error: 0, skipped: 0, notEvaluated: 0 };
}

/** Incrementally hashes ordered Case identities without retaining a per-Case array. */
class OrderedReportResultSetHasher {
  /** Incremental SHA-256 state over canonical report identity JSON. */
  readonly #hash: Hash;
  /** Next required zero-based Ordinal. */
  #nextOrdinal = 0;
  /** Whether the digest has already been finalized. */
  #finished = false;

  /** Start the canonical result-set object with its ordered Case array. */
  public constructor() {
    this.#hash = createHash("sha256");
    this.#hash.update('{"cases":[', "utf8");
  }

  /** Append one already-reconciled Case identity in exact frozen order. */
  public add(value: ReportCaseFacts): void {
    if (this.#finished || value.ordinal !== this.#nextOrdinal) {
      throw new Error("REPORT_CASE_ALIGNMENT");
    }
    if (this.#nextOrdinal > 0) this.#hash.update(",", "utf8");
    this.#hash.update(
      canonicalJson({
        caseKey: value.caseKey,
        evalResultHash: value.evaluation.evalResultHash,
        finalCaseResultHash: value.evaluation.finalCaseResultHash,
        ordinal: value.ordinal,
        restResultHash: value.rest.resultHash
      }),
      "utf8"
    );
    this.#nextOrdinal += 1;
  }

  /** Finalize the canonical report identity exactly once. */
  public finish(input: CreateReportAccumulatorInput): string {
    if (this.#finished) throw new Error("REPORT_ALREADY_FINISHED");
    this.#finished = true;
    this.#hash.update(
      `],"contractVersion":"cortex.report-result-set.v1",` +
        `"evaluationContextHash":${JSON.stringify(input.evaluationContextHash)},` +
        `"evaluationResultSetHash":${JSON.stringify(input.evaluationResultSetHash)},` +
        `"owner":${canonicalJson(input.owner)},` +
        `"runContextHash":${JSON.stringify(input.runContextHash)}}`,
      "utf8"
    );
    return this.#hash.digest("hex");
  }
}

/** Stateful, bounded-memory report reconciliation and aggregation boundary. */
export class ReportAccumulator {
  /** Immutable report-wide identity facts. */
  readonly #input: CreateReportAccumulatorInput;
  /** Incremental ordered result-set hasher. */
  readonly #hasher = new OrderedReportResultSetHasher();
  /** Compact counters grouped only by Metric name. */
  readonly #metricSummaries = new Map<string, MutableMetricSummary>();
  /** Next required frozen Ordinal. */
  #nextOrdinal = 0;
  /** Successful REST result count. */
  #restSucceeded = 0;
  /** REST system-error count. */
  #restError = 0;
  /** Evaluation PASS count. */
  #evalPass = 0;
  /** Evaluation FAIL count. */
  #evalFail = 0;
  /** Evaluation system-error count. */
  #evalError = 0;
  /** Not Evaluated count. */
  #notEvaluated = 0;
  /** Whether the accumulator has already been finalized. */
  #finished = false;

  /** Create one accumulator after validating all report-wide identities. */
  public constructor(input: CreateReportAccumulatorInput) {
    if (
      input.owner.id.trim() === "" ||
      !isSha256(input.runContextHash) ||
      !isSha256(input.evaluationContextHash) ||
      !isSha256(input.evaluationResultSetHash)
    ) {
      throw new Error("REPORT_IDENTITY_INVALID");
    }
    this.#input = input;
  }

  /** Reconcile and aggregate one Case without retaining its large payload. */
  public add(value: ReportCaseFacts): void {
    if (this.#finished) throw new Error("REPORT_ALREADY_FINISHED");
    if (
      value.ordinal !== this.#nextOrdinal ||
      this.#input.expectedCaseKey(value.ordinal) !== value.caseKey ||
      !isSha256(value.rest.resultHash) ||
      !isSha256(value.evaluation.evalResultHash) ||
      !isSha256(value.evaluation.finalCaseResultHash)
    ) {
      throw new Error("REPORT_CASE_ALIGNMENT");
    }
    const restFailed = value.rest.status === "ERROR";
    const notEvaluated = value.evaluation.status === "NOT_EVALUATED";
    if (restFailed !== notEvaluated) {
      throw new Error("REPORT_RECONCILIATION_FAILED");
    }

    this.#addMetrics(value.evaluation.metrics);
    this.#addCounters(value);
    this.#hasher.add(value);
    this.#nextOrdinal += 1;
  }

  /** Finalize the complete report after proving that no frozen Case is missing. */
  public finish(): ReportAggregationResult {
    if (this.#finished) throw new Error("REPORT_ALREADY_FINISHED");
    if (this.#nextOrdinal === 0 || this.#input.expectedCaseKey(this.#nextOrdinal) !== null) {
      throw new Error("REPORT_CASE_ALIGNMENT");
    }
    this.#finished = true;
    const total = this.#nextOrdinal;
    const evaluated = this.#evalPass + this.#evalFail;
    return {
      summary: {
        total,
        restSucceeded: this.#restSucceeded,
        restError: this.#restError,
        evalPass: this.#evalPass,
        evalFail: this.#evalFail,
        evalError: this.#evalError,
        notEvaluated: this.#notEvaluated,
        effectivePassRate: calculateRate(this.#evalPass, total),
        evaluatedPassRate: calculateRate(this.#evalPass, evaluated),
        coverageRate: calculateRate(evaluated, total)
      },
      byMetric: this.#buildMetricSummaries(),
      reportResultSetHash: this.#hasher.finish(this.#input)
    };
  }

  // Validate Case-level uniqueness before updating compact Metric counters.
  #addMetrics(metrics: readonly ReportMetricFact[]): void {
    const seen = new Set<string>();
    for (const item of metrics) {
      if (item.metric.trim() === "" || seen.has(item.metric)) {
        throw new Error("REPORT_METRIC_DUPLICATE");
      }
      seen.add(item.metric);
      const summary = this.#metricSummaries.get(item.metric) ?? emptyMetricSummary(item.metric);
      if (item.status === "PASS") summary.pass += 1;
      if (item.status === "FAIL") summary.fail += 1;
      if (item.status === "ERROR") summary.error += 1;
      if (item.status === "SKIPPED") summary.skipped += 1;
      if (item.status === "NOT_EVALUATED") summary.notEvaluated += 1;
      this.#metricSummaries.set(item.metric, summary);
    }
  }

  // Update the seven report-wide counters from one reconciled Case.
  #addCounters(value: ReportCaseFacts): void {
    if (value.rest.status === "SUCCEEDED") this.#restSucceeded += 1;
    if (value.rest.status === "ERROR") this.#restError += 1;
    if (value.evaluation.status === "PASS") this.#evalPass += 1;
    if (value.evaluation.status === "FAIL") this.#evalFail += 1;
    if (value.evaluation.status === "EVALUATION_ERROR") this.#evalError += 1;
    if (value.evaluation.status === "NOT_EVALUATED") this.#notEvaluated += 1;
  }

  // Freeze stable alphabetic Metric summaries with empty denominators kept null.
  #buildMetricSummaries(): ReportMetricSummary[] {
    return [...this.#metricSummaries.values()]
      .sort((left, right) => left.metric.localeCompare(right.metric))
      .map((item) => ({
        ...item,
        passRate: calculateRate(item.pass, item.pass + item.fail)
      }));
  }
}

/** Create one validated bounded-memory report accumulator. */
export function createReportAccumulator(input: CreateReportAccumulatorInput): ReportAccumulator {
  return new ReportAccumulator(input);
}
