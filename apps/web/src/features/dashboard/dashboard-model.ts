import type { PlatformRunPage, RunApi, RunReportOverview } from "../../lib/run-api.ts";
import {
  dashboardCounts,
  evaluationState,
  loadDashboardCases,
  resultBucket,
  type DashboardCase,
  type ResultBucket
} from "../runs/run-dashboard-model.ts";
import { scenarioName } from "../runs/run-evidence-model.ts";

export type DashboardRun = PlatformRunPage["items"][number];
export const RESULT_ORDER: readonly ResultBucket[] = [
  "PASS",
  "FAIL",
  "ERROR",
  "PENDING",
  "CANCELLED"
];
export const RESULT_LABELS: Record<ResultBucket, string> = {
  PASS: "通过",
  FAIL: "未通过",
  ERROR: "异常",
  PENDING: "待处理",
  CANCELLED: "已取消"
};

/** All run sources use the unified workspace. */
export function dashboardRunPath(run: DashboardRun): string {
  return `/runs/${encodeURIComponent(run.id)}`;
}
export function reportCandidates(runs: readonly DashboardRun[]): DashboardRun[] {
  return runs.filter(
    (run) =>
      run.stage === "DONE" && (run.status === "COMPLETED" || run.status === "COMPLETED_WITH_ERRORS")
  );
}
/** Never publish a partial report as a complete quality summary. */
export async function loadDashboardEvidence(
  api: RunApi,
  run: DashboardRun,
  signal: AbortSignal
): Promise<{ report: RunReportOverview; rows: DashboardCase[] }> {
  const [report, rows] = await Promise.all([
    api.getReport(run.id, signal),
    loadDashboardCases(api, run.id, true, signal)
  ]);
  if (
    report.runId !== run.id ||
    report.summary.total !== rows.length ||
    report.summary.total !== run.rest.total
  )
    throw new Error("DASHBOARD_REPORT_INCOMPLETE");
  dashboardCounts(report.summary.total, rows);
  return { report, rows };
}
export function scenarioKey(row: DashboardCase): string {
  return JSON.stringify([
    row.definition?.metadata.business_module ?? null,
    row.definition?.metadata.scenario_tag ?? null
  ]);
}
export interface ScenarioResult {
  readonly key: string;
  readonly module: string;
  readonly name: string;
  readonly total: number;
  readonly counts: Record<ResultBucket, number>;
}
/** Partition one frozen run only. No cross-suite or cross-run quality averaging. */
export function scenarioResults(rows: readonly DashboardCase[]): ScenarioResult[] {
  const groups = new Map<string, DashboardCase[]>();
  for (const row of rows) {
    const key = scenarioKey(row);
    const entries = groups.get(key);
    if (entries) entries.push(row);
    else groups.set(key, [row]);
  }
  return [...groups]
    .map(([key, entries]) => ({
      key,
      module:
        entries[0]?.definition?.metadata.business_module === "task"
          ? "待办任务"
          : (entries[0]?.definition?.metadata.business_module ?? "未记录"),
      name: scenarioName(entries[0]?.definition?.metadata.scenario_tag),
      total: entries.length,
      counts: dashboardCounts(entries.length, entries)
    }))
    .sort(
      (a, b) =>
        b.counts.FAIL + b.counts.ERROR - (a.counts.FAIL + a.counts.ERROR) ||
        b.counts.PENDING - a.counts.PENDING ||
        a.name.localeCompare(b.name, "zh-CN")
    );
}
/** Explain observed state, never generate a root cause. */
export function attentionReason(row: DashboardCase): string {
  if (resultBucket(row) === "CANCELLED") return "执行已取消";
  if (row.rest.status === "ERROR") return "执行异常 · 查看执行记录";
  const state = evaluationState(row);
  if (state === "REVIEW_PENDING") return "自动评测通过 · 等待人工复核";
  if (state === "EVALUATION_ERROR") return "评测异常 · 查看评测记录";
  if (state === "FAIL")
    return row.evaluation?.status === "PASS"
      ? "人工复核未通过"
      : (row.evaluation?.reason ?? "未通过 · 查看分项评测");
  return state === "UNAVAILABLE" ? "无法评测 · 需要核对证据" : "等待评测结果";
}
