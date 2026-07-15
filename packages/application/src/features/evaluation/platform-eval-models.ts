import type {
  EvalAssertionHashFact,
  EvalDiffHashFact,
  EvalMetricHashFact
} from "@cortex-eval/domain/src/domain-hash-inputs.ts";

import type { ImportedTokenUsage, PromptfooRawEvidence } from "./promptfoo-result-importer.ts";

/** Reuse identity for one copied Evaluation result. */
export interface PlatformEvalReuseProvenance {
  /** Source result owner kind. */
  readonly sourceKind: "RUN" | "EXECUTION";
  /** Source Run or Execution identity. */
  readonly sourceId: string;
  /** Exact reused Eval Result hash. */
  readonly sourceResultHash: string;
}

/** Complete normalized Eval Case persisted by the platform. */
export interface PlatformEvalCaseResult {
  /** Owning platform Run. */
  readonly runId: string;
  /** Stable frozen Case key. */
  readonly caseKey: string;
  /** Stable frozen Case order. */
  readonly ordinal: number;
  /** Normalized Eval status. */
  readonly status: "PASS" | "FAIL" | "EVALUATION_ERROR" | "NOT_EVALUATED";
  /** Promptfoo aggregate outcome for observed results. */
  readonly promptfooSuccess: boolean | null;
  /** Promptfoo aggregate score for observed results. */
  readonly score: number | null;
  /** Promptfoo aggregate reason when present. */
  readonly reason: string | null;
  /** Structured Evaluation system error. */
  readonly evaluationError: { readonly code: string } | null;
  /** Ordered normalized Assertion results. */
  readonly assertions: readonly EvalAssertionHashFact[];
  /** Ordered JSON Schema explanation facts. */
  readonly diffs: readonly EvalDiffHashFact[];
  /** Deduplicated Metric results. */
  readonly metrics: readonly EvalMetricHashFact[];
  /** Promptfoo-observed latency. */
  readonly latencyMs: number | null;
  /** Promptfoo-observed grader token usage. */
  readonly tokenUsage: ImportedTokenUsage | null;
  /** Promptfoo-observed grader cost. */
  readonly cost: number | null;
  /** Immutable raw evidence reference. */
  readonly rawEvidence: PromptfooRawEvidence | null;
  /** Semantic normalized Eval result hash. */
  readonly evalResultHash: string;
  /** Hash binding frozen Case, REST and Eval facts. */
  readonly finalCaseResultHash: string;
  /** Reuse identity for copied results. */
  readonly provenance: PlatformEvalReuseProvenance | null;
  /** First durable persistence time. */
  readonly createdAt: string;
  /** Latest durable persistence time. */
  readonly updatedAt: string;
}

/** Stable Eval result page query. */
export interface PlatformEvalResultQuery {
  /** Owning platform Run. */
  readonly runId: string;
  /** Maximum returned items. */
  readonly limit: number;
  /** Last seen frozen Ordinal. */
  readonly afterOrdinal?: number | undefined;
}

/** Stable ordered Eval result page. */
export interface PlatformEvalResultPage {
  /** Ordered complete Eval facts. */
  readonly items: readonly PlatformEvalCaseResult[];
  /** Next exact Ordinal when another page exists. */
  readonly nextCursor: number | null;
}

/** Small post-commit Evaluation progress projection. */
export interface PlatformEvalProgress {
  /** Owning platform Run. */
  readonly runId: string;
  /** Next lifecycle status. */
  readonly status: "READY";
  /** Next pipeline stage. */
  readonly stage: "REPORT";
  /** Latest optimistic state token. */
  readonly lockRevision: number;
  /** Complete frozen Case count. */
  readonly evalCompletedCount: number;
  /** Durable Evaluation PASS count. */
  readonly evalPassCount: number;
  /** Durable Evaluation FAIL count. */
  readonly evalFailCount: number;
  /** Durable Evaluation system error count. */
  readonly evalErrorCount: number;
  /** Durable Not Evaluated count. */
  readonly evalNotEvaluatedCount: number;
  /** Frozen Evaluation invocation identity. */
  readonly evaluationContextHash: string;
  /** Complete Eval result-set identity. */
  readonly evaluationResultSetHash: string;
}
