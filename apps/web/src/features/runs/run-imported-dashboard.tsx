import { useState, type ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { Button } from "../../components/ui/button.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import { Progress } from "../../components/ui/progress.tsx";
import { returnFromRun } from "../../lib/return-navigation.ts";
import { runReviewApi } from "../../lib/run-review-api.ts";
import { message } from "../../messages/messages.ts";
import { RunDashboardCases } from "./run-dashboard-cases.tsx";
import { RunTokenSummary } from "./run-token-summary.tsx";
import { RunAnalysisControl } from "./run-analysis-control.tsx";
import {
  dashboardCounts,
  loadDashboardCases,
  safeEndpointLocation,
  type ResultBucket
} from "./run-dashboard-model.ts";
import { displayRunDate } from "./run-ui.ts";
import type { RunDashboardPageProps } from "./run-dashboard-page.tsx";

/** Report-backed variant of the same workspace; imported records have no platform execution config. */
export function ImportedRunDashboard({
  api,
  runId,
  onNavigate
}: RunDashboardPageProps): ReactElement {
  const [bucket, setBucket] = useState<ResultBucket | "ALL">("ALL");
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const report = useQuery({
    queryKey: ["runs", "report", runId],
    queryFn: ({ signal }) => api.getReport(runId, signal),
    retry: false
  });
  const cases = useQuery({
    queryKey: ["runs", "dashboard-cases", runId, "imported"],
    queryFn: async ({ signal }) => {
      const rows = await loadDashboardCases(api, runId, true, signal);
      if (rows.length !== report.data?.summary.total)
        throw new Error("RUN_REPORT_CASES_INCOMPLETE");
      return rows;
    },
    enabled: !!report.data,
    retry: false
  });
  const reviews = useQuery({
    queryKey: ["run-reviews", runId],
    queryFn: ({ signal }) => runReviewApi.list(runId, signal),
    enabled: !!report.data,
    retry: false
  });
  if (report.isPending) return <Progress aria-label="读取运行" />;
  if (!report.data || report.isError)
    return (
      <section className="run-dashboard">
        <Button variant="link" onClick={() => returnFromRun(onNavigate)}>
          返回
        </Button>
        <p role="alert">运行读取失败或记录不存在。</p>
        <Button onClick={() => void report.refetch()}>重试</Button>
      </section>
    );
  const { context, summary } = report.data;
  const revision = context.endpoint.config.agentRevision;
  const rows = (cases.data ?? []).map((row) => {
    const review = reviews.data?.find((item) => item.caseKey === row.caseKey);
    return review ? { ...row, review } : row;
  });
  const ready = !!cases.data && !cases.isError;
  const counts = dashboardCounts(summary.total, rows);
  return (
    <section className="run-dashboard">
      <header className="run-dashboard-header">
        <Button
          variant="link"
          size="sm"
          className="run-dashboard-back"
          onClick={() => returnFromRun(onNavigate)}
        >
          <ArrowLeft size={15} />
          返回
        </Button>
        <div className="run-dashboard-title">
          <h1>{context.suite.name ?? "离线导入运行"}</h1>
          <Badge variant="outline">离线导入</Badge>
        </div>
        <div className="run-dashboard-actions">
          <details className="run-dashboard-more">
            <summary>更多</summary>
            <div>
              <Button asChild size="sm" variant="ghost">
                <a href={`/api/v1/runs/${encodeURIComponent(runId)}/report/export`}>
                  {message("reports.exportJson")}
                </a>
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={(event) => {
                  setAnalysisOpen((open) => !open);
                  event.currentTarget.closest("details")?.removeAttribute("open");
                }}
              >
                AI 辅助分析
              </Button>
            </div>
          </details>
        </div>
        <p className="run-muted">
          完成时间 {displayRunDate(report.data.completedAt)} · 总耗时：未记录
        </p>
      </header>
      <section className="run-dashboard-config" aria-label="运行配置摘要">
        <div className="run-config-summary">
          <div>
            <span>测试集</span>
            <strong>{context.suite.name ?? "未记录"}</strong>
          </div>
          <div>
            <span>Agent 分支 / 版本</span>
            <strong title={revision?.commit}>
              {revision ? `${revision.branch} / ${revision.commit.slice(0, 8)}` : "未记录"}
            </strong>
          </div>
          <div>
            <span>评测模型</span>
            <strong>{context.evaluator.config.model}</strong>
          </div>
        </div>
        <details>
          <summary className="run-dashboard-config-toggle">
            <span className="run-dashboard-config-link">展开完整配置</span>
          </summary>
          <p className="run-muted">导入记录的配置快照；平台启动、停止与重跑不适用。</p>
          <p>请求入口：{safeEndpointLocation(context.endpoint.config.urlTemplate)}</p>
          <pre className="report-json-value">
            {JSON.stringify(
              {
                runId,
                endpoint: {
                  name: context.endpoint.name,
                  method: context.endpoint.config.method,
                  timeoutMs: context.endpoint.config.timeoutMs,
                  agentRevision: revision
                },
                evaluator: {
                  name: context.evaluator.name,
                  model: context.evaluator.config.model,
                  temperature: context.evaluator.config.temperature,
                  maxOutputTokens: context.evaluator.config.maxOutputTokens,
                  timeoutMs: context.evaluator.config.timeoutMs
                },
                rubricPrompts: context.rubricPrompts,
                runExecutionLimits: context.runExecutionLimits,
                promptfooVersion: context.promptfooVersion
              },
              null,
              2
            )}
          </pre>
        </details>
      </section>
      <section className="run-dashboard-results" aria-label="结果概览">
        <div className="run-dashboard-counts">
          <button type="button" aria-pressed={bucket === "ALL"} onClick={() => setBucket("ALL")}>
            <span>Case 总数</span>
            <strong>{summary.total}</strong>
          </button>
          {(["PASS", "FAIL", "ERROR", "PENDING", "CANCELLED"] as const).map((key) => (
            <button
              type="button"
              key={key}
              data-bucket={key}
              aria-pressed={bucket === key}
              disabled={!ready}
              onClick={() => setBucket(key)}
            >
              <span>{message(`rd.bucket.${key}`)}</span>
              <strong>{ready ? counts[key] : "—"}</strong>
            </button>
          ))}
        </div>
      </section>
      <RunTokenSummary rows={rows} ready={ready} />
      {analysisOpen && <RunAnalysisControl api={api} runId={runId} />}
      {reviews.isError && (
        <p role="alert" className="run-muted">
          人工审核记录读取失败，当前仅展示自动结果。
        </p>
      )}
      {cases.isPending && <Progress aria-label="读取 Case" />}
      {cases.isError && (
        <p role="alert">
          Case 记录读取失败。
          <Button size="sm" variant="link" onClick={() => void cases.refetch()}>
            重试
          </Button>
        </p>
      )}
      {ready && (
        <RunDashboardCases
          api={api}
          runId={runId}
          rows={rows}
          bucket={bucket}
          onBucketChange={setBucket}
          missing={0}
          onNavigate={onNavigate}
          canRerun={false}
        />
      )}
    </section>
  );
}
