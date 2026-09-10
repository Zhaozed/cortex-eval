import { visualReviewRequired } from "./run-output-model.ts";
import type { RunReview } from "@cortex-eval/contracts/src/run-review-contracts.ts";
import type {
  PlatformRunDetail,
  RunApi,
  RunCaseDetail,
  RunCasePage,
  RunEvalPage,
  RunReportCase
} from "../../lib/run-api.ts";

/** Mutually exclusive dashboard categories; execution faults take precedence, evidence remains intact. */
export type ResultBucket = "PASS" | "FAIL" | "ERROR" | "PENDING" | "CANCELLED";
/** One stored execution and its associated evaluation, never a current-suite projection. */
export interface DashboardCase {
  readonly review?: RunReview | undefined;
  readonly caseKey: string;
  readonly ordinal: number;
  readonly rest: RunCasePage["items"][number] | RunReportCase["rest"] | RunCaseDetail;
  readonly evaluation: RunEvalPage["items"][number]["result"] | undefined;
  readonly definition: RunCaseDetail["definition"] | undefined;
  readonly report: RunReportCase | undefined;
}
/** Read every cursor exactly once, never show a partial page as a complete aggregate. */
export async function dashboardPages<T>(
  load: (
    cursor: string | null
  ) => Promise<{ readonly items: readonly T[]; readonly nextCursor: string | null }>
): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await load(cursor);
    items.push(...page.items);
    cursor = page.nextCursor;
    if (cursor !== null) {
      if (seen.has(cursor)) throw new Error("RUN_CURSOR_CYCLE");
      seen.add(cursor);
    }
  } while (cursor !== null);
  return items;
}
/** Load only immutable records from this Run; pending definitions are not available in this API. */
export async function loadDashboardCases(
  api: RunApi,
  runId: string,
  hasReport: boolean,
  signal: AbortSignal
): Promise<DashboardCase[]> {
  if (hasReport) {
    const items = await dashboardPages((cursor) =>
      api.listReportCases(
        {
          runId,
          cursor,
          limit: 100,
          restStatus: [],
          evalStatus: [],
          metrics: [],
          businessModules: [],
          scenarioTags: []
        },
        signal
      )
    );
    return items.map((report) => ({
      caseKey: report.caseKey,
      ordinal: report.ordinal,
      rest: report.rest,
      evaluation: report.evaluation,
      definition: report.definition,
      report
    }));
  }
  const [executions, evaluations] = await Promise.all([
    dashboardPages((cursor) => api.listCases({ runId, cursor, limit: 100 }, signal)),
    dashboardPages((cursor) => api.listEvaluations({ runId, cursor, limit: 100 }, signal))
  ]);
  const byCase = new Map(evaluations.map((entry) => [entry.result.caseKey, entry.result]));
  const definitions = new Map<string, RunCaseDetail["definition"]>();
  const fullResults = new Map<string, RunCaseDetail>();
  // Existing endpoint has no summary metadata; bound local read concurrency until a DTO extension is justified.
  for (let offset = 0; offset < executions.length; offset += 8) {
    const details = await Promise.all(
      executions.slice(offset, offset + 8).map((rest) => api.getCase(runId, rest.caseKey, signal))
    );
    for (const detail of details) {
      definitions.set(detail.caseKey, detail.definition);
      fullResults.set(detail.caseKey, detail);
    }
  }
  return executions
    .map((rest) => ({
      caseKey: rest.caseKey,
      ordinal: rest.ordinal,
      rest: fullResults.get(rest.caseKey) ?? rest,
      evaluation: byCase.get(rest.caseKey),
      definition: definitions.get(rest.caseKey),
      report: undefined
    }))
    .sort((a, b) => a.ordinal - b.ordinal);
}
/** Execution status is not the business verdict. */
export function executionState(
  row: DashboardCase
): "COMPLETED" | "TIMEOUT" | "ERROR" | "CANCELLED" {
  if (row.rest.status === "SUCCEEDED") return "COMPLETED";
  const error = "errorType" in row.rest ? row.rest.errorType : row.rest.error.type;
  return error === "CANCELLED" ? "CANCELLED" : error === "TIMEOUT" ? "TIMEOUT" : "ERROR";
}
/** Preserve evaluation evidence even when execution itself failed. */
export function evaluationState(
  row: DashboardCase
): "PASS" | "FAIL" | "EVALUATION_ERROR" | "UNAVAILABLE" | "PENDING" | "REVIEW_PENDING" {
  const status = row.evaluation?.status;
  const manual = row.review?.history.at(-1);
  if (status === "PASS" && manual?.verdict === "FAIL") return "FAIL";
  if (status === "PASS" && visualReviewRequired(row)) {
    if (
      !row.review?.live?.available ||
      !manual?.rendererVersion ||
      manual.rendererVersion !== row.review.live.rendererVersion ||
      manual.kind !== "DECISION" ||
      manual.verdict !== "PASS"
    )
      return "REVIEW_PENDING";
  }
  if (status === "PASS" && manual?.verdict === "PENDING" && manual.kind === "DECISION")
    return "REVIEW_PENDING";
  if (status === "NOT_EVALUATED") return "UNAVAILABLE";
  if (status !== undefined) return status;
  return executionState(row) === "COMPLETED" ? "PENDING" : "UNAVAILABLE";
}
/** Shared by totals, filters and rows. */
export function resultBucket(row: DashboardCase): ResultBucket {
  const execution = executionState(row);
  if (execution === "CANCELLED") return "CANCELLED";
  if (execution !== "COMPLETED" || row.evaluation?.status === "EVALUATION_ERROR") return "ERROR";
  if (evaluationState(row) === "PASS") return "PASS";
  if (evaluationState(row) === "FAIL") return "FAIL";
  return "PENDING";
}
/** A full category partition, not a sum of overlapping execution/evaluation counters. */
export function dashboardCounts(
  total: number,
  rows: readonly DashboardCase[]
): Record<ResultBucket, number> {
  if (rows.length > total || new Set(rows.map((row) => row.caseKey)).size !== rows.length)
    throw new Error("RUN_CASE_COUNTS_INVALID");
  const counts = { PASS: 0, FAIL: 0, ERROR: 0, PENDING: total - rows.length, CANCELLED: 0 };
  for (const row of rows) counts[resultBucket(row)] += 1;
  return counts;
}
/** Only Judge grading usage is normalized today. Reused records are excluded from current-run consumption. */
export function judgeUsage(rows: readonly DashboardCase[]): {
  readonly input: number;
  readonly output: number;
  readonly total: number;
  readonly recorded: number;
  readonly expected: number;
  readonly reused: number;
} {
  const result = { input: 0, output: 0, total: 0, recorded: 0, expected: 0, reused: 0 };
  for (const row of rows) {
    const evaluation = row.evaluation;
    if (evaluation?.provenance) {
      result.reused += 1;
      continue;
    }
    if (!evaluation || evaluation.status === "NOT_EVALUATED") continue;
    result.expected += 1;
    if (evaluation.tokenUsage === null) continue;
    result.recorded += 1;
    result.input += evaluation.tokenUsage.inputTokens;
    result.output += evaluation.tokenUsage.outputTokens;
    result.total += evaluation.tokenUsage.totalTokens;
  }
  return result;
}
/** Explicit allowlist: no header values, credential references or arbitrary URL query values. */
export function dashboardConfig(run: PlatformRunDetail): object {
  return {
    endpoint: {
      name: run.endpoint.name,
      ...(run.endpoint.config.agentRevision
        ? { agentRevision: run.endpoint.config.agentRevision }
        : {}),
      configHash: run.endpoint.configHash,
      method: run.endpoint.config.method,
      timeoutMs: run.endpoint.config.timeoutMs,
      bodySelector: run.endpoint.config.bodySelector
    },
    evaluator: {
      name: run.evaluator.name,
      configHash: run.evaluator.configHash,
      provider: run.evaluator.config.providerType,
      model: run.evaluator.config.model,
      temperature: run.evaluator.config.temperature,
      topP: run.evaluator.config.topP,
      maxOutputTokens: run.evaluator.config.maxOutputTokens,
      thinkingLevel: run.evaluator.config.thinkingLevel,
      timeoutMs: run.evaluator.config.timeoutMs
    },
    rubricPrompts: run.rubricPrompts,
    runExecutionLimits: run.runExecutionLimits,
    runMode: run.runMode,
    promptfooVersion: run.promptfooVersion,
    contractVersions: run.contractVersions,
    runContextHash: run.runContextHash,
    suiteHash: run.suite.hash
  };
}
/** Strip all user info, query values and fragments before presenting a request location. */
export function safeEndpointLocation(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "—";
  }
}
