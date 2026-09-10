import { ArrowLeft } from "lucide-react";
import { returnFromRun } from "../../lib/return-navigation.ts";
import { RunRerunDialog } from "./run-rerun-dialog.tsx";
import { RunComparison } from "./run-comparison.tsx";
import { runReviewApi } from "../../lib/run-review-api.ts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactElement } from "react";
import { Alert, AlertTitle } from "../../components/ui/alert.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Progress } from "../../components/ui/progress.tsx";
import { ApiClientError } from "../../lib/api-client.ts";
import type { RunApi } from "../../lib/run-api.ts";
import { ImportedRunDashboard } from "./run-imported-dashboard.tsx";
import { RunAnalysisControl } from "./run-analysis-control.tsx";
import { message } from "../../messages/messages.ts";
import { RunTokenSummary } from "./run-token-summary.tsx";
import { RunDashboardCases } from "./run-dashboard-cases.tsx";
import {
  dashboardConfig,
  dashboardCounts,
  executionState,
  loadDashboardCases,
  safeEndpointLocation,
  type ResultBucket
} from "./run-dashboard-model.ts";
import {
  displayRunDate,
  runStageLabel,
  runStatusLabel,
  runMutationErrorMessage
} from "./run-ui.ts";

export interface RunDashboardPageProps {
  readonly api: RunApi;
  readonly runId: string;
  readonly onNavigate: (path: string) => void;
}

/** Unified default Run dashboard, backed by frozen facts and existing stage operations only. */
export function RunDashboardPage({ api, runId, onNavigate }: RunDashboardPageProps): ReactElement {
  const client = useQueryClient();
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [rerunOpen, setRerunOpen] = useState(false);
  const [bucket, setBucket] = useState<ResultBucket | "ALL">("ALL");
  const [copyState, setCopyState] = useState<"idle" | "done" | "error">("idle");
  const detail = useQuery({
    queryKey: ["runs", "detail", runId],
    queryFn: ({ signal }) => api.getRun(runId, signal),
    retry: (count, error) =>
      !(error instanceof ApiClientError && error.code === "RUN_NOT_FOUND") && count < 1,
    refetchInterval: (query) => (runNeedsPolling(query.state.data) ? 1000 : false)
  });
  const run = detail.data;
  const reviews = useQuery({
    queryKey: ["run-reviews", runId, run?.lockRevision],
    queryFn: ({ signal }) => runReviewApi.list(runId, signal),
    enabled: run !== undefined,
    retry: false
  });
  const hasReport =
    run?.artifactAvailability.some(
      (artifact) => artifact.kind === "REPORT_JSON" && artifact.status === "PRESENT"
    ) ?? false;
  const cases = useQuery({
    queryKey: [
      "runs",
      "dashboard-cases",
      runId,
      hasReport,
      run?.rest.completed,
      run?.evaluation.completed
    ],
    queryFn: async ({ signal }) => {
      const rows = await loadDashboardCases(
        {
          ...api,
          getCase: (id, key, requestSignal) =>
            client.fetchQuery({
              queryKey: ["runs", "case", id, key],
              queryFn: () => api.getCase(id, key, requestSignal),
              staleTime: 0
            })
        },
        runId,
        hasReport,
        signal
      );
      if (!run) throw new Error("RUN_NOT_LOADED");
      if (hasReport && rows.length !== run.suite.caseCount)
        throw new Error("RUN_REPORT_CASES_INCOMPLETE");
      return { rows, counts: dashboardCounts(run.suite.caseCount, rows) };
    },
    enabled: run !== undefined,
    // A running pagination snapshot can lag counters; retry until the committed facts agree.
    refetchInterval: runNeedsPolling(run) ? 3000 : false
  });
  const operation = useMutation({
    mutationFn: async (action: "start" | "cancel" | "delete") => {
      if (!run) throw new Error("RUN_NOT_LOADED");
      const signal = new AbortController().signal;
      if (action === "delete") {
        await api.deleteRun(runId, signal);
        return { navigate: "/runs" };
      }
      // Progress commits advance the revision; fetch it at the moment of an explicit action.
      const current = await api.getRun(runId, signal);
      client.setQueryData(["runs", "detail", runId], current);
      if (action === "start") {
        // A fresh revision must not accidentally authorize a different automatic stage.
        if (
          current.status !== "READY" ||
          current.stage !== run.stage ||
          (current.runMode === "PIPELINE" && current.stage !== "REST")
        )
          return { navigate: null };
        await api.start(runId, current.lockRevision, signal);
      } else {
        if (current.status !== "RUNNING" || current.cancelRequestedAt !== null)
          return { navigate: null };
        try {
          await api.cancel(runId, current.lockRevision, signal);
        } catch (error) {
          if (!(error instanceof ApiClientError) || error.runStateReason !== "STATE_OR_REVISION")
            throw error;
          // Cancellation is idempotent user intent; retry once after a concurrent progress commit.
          const latest = await api.getRun(runId, signal);
          client.setQueryData(["runs", "detail", runId], latest);
          if (latest.status === "RUNNING" && latest.cancelRequestedAt === null)
            await api.cancel(runId, latest.lockRevision, signal);
        }
      }
      return { navigate: null };
    },
    onError: async () => {
      await client.invalidateQueries({ queryKey: ["runs", "detail", runId] });
    },
    onSuccess: async (result) => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ["runs"] }),
        client.invalidateQueries({ queryKey: ["dashboard"] }),
        client.invalidateQueries({ queryKey: ["test-suites"] })
      ]);
      if (result.navigate !== null) onNavigate(result.navigate);
    }
  });
  if (detail.isPending) return <Progress aria-label={message("runs.detailLoading")} />;
  if (
    detail.isError &&
    detail.error instanceof ApiClientError &&
    detail.error.code === "RUN_NOT_FOUND"
  )
    return <ImportedRunDashboard api={api} runId={runId} onNavigate={onNavigate} />;
  if (detail.isError || !run)
    return (
      <Alert variant="destructive">
        <AlertTitle>{message("runs.detailError")}</AlertTitle>
        <Button onClick={() => void detail.refetch()}>{message("dashboard.retry")}</Button>
      </Alert>
    );
  const terminal = run.status !== "READY" && run.status !== "RUNNING";
  const canRerun =
    terminal &&
    run.stage === "DONE" &&
    run.completedAt !== null &&
    run.rest.completed === run.rest.total;
  const canStart =
    run.status === "READY" &&
    run.stage !== "DONE" &&
    (run.runMode !== "PIPELINE" || run.stage === "REST");
  const rows = (cases.data?.rows ?? []).map((row) => {
    const review = reviews.data?.find((item) => item.caseKey === row.caseKey);
    return review ? { ...row, review } : row;
  });
  const counts = cases.data ? dashboardCounts(run.suite.caseCount, rows) : undefined;
  const syncing =
    !hasReport &&
    (rows.length !== run.rest.completed ||
      rows.filter((row) => row.evaluation !== undefined).length !== run.evaluation.completed);
  const totalsReady = cases.data !== undefined && !cases.isError && !syncing;
  const duration =
    run.startedAt === null
      ? message("rd.notApplicable")
      : run.completedAt === null
        ? run.status === "RUNNING"
          ? message("rd.inProgress")
          : message("rd.notRecorded")
        : `${Math.max(0, new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()) / 1000} s`;
  const copyId = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(run.id);
      setCopyState("done");
    } catch {
      setCopyState("error");
    }
  };
  return (
    <section className="run-dashboard">
      <header className="run-dashboard-header">
        <Button
          variant="link"
          size="sm"
          className="run-dashboard-back"
          onClick={() => returnFromRun(onNavigate)}
        >
          <ArrowLeft size={15} aria-hidden="true" />
          返回
        </Button>
        <div className="run-dashboard-title">
          <h1>{run.name ?? run.suite.name}</h1>
          <Badge variant="outline">
            {run.status === "READY" && runNeedsPolling(run)
              ? "等待自动继续"
              : runStatusLabel(run.status)}
          </Badge>
        </div>
        <div className="run-dashboard-actions">
          {canStart && (
            <Button
              size="sm"
              disabled={operation.isPending}
              onClick={() => operation.mutate("start")}
            >
              {message("rd.startStage")} · {runStageLabel(run.stage)}
            </Button>
          )}
          {run.status === "RUNNING" && (
            <Button
              size="sm"
              variant="destructive"
              disabled={operation.isPending || run.cancelRequestedAt !== null}
              onClick={() => operation.mutate("cancel")}
            >
              {run.cancelRequestedAt ? message("runs.cancelling") : message("rd.stop")}
            </Button>
          )}
          {canRerun && (
            <Button size="sm" disabled={operation.isPending} onClick={() => setRerunOpen(true)}>
              {message("rd.rerun")}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCompareOpen(true)}
            disabled={!totalsReady}
          >
            对比运行
          </Button>
          <details className="run-dashboard-more">
            <summary>{message("rd.more")}</summary>
            <div>
              {hasReport && (
                <Button asChild size="sm" variant="ghost">
                  <a href={`/api/v1/runs/${encodeURIComponent(runId)}/report/export`}>
                    {message("reports.exportJson")}
                  </a>
                </Button>
              )}
              {hasReport && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={(event) => {
                    setAnalysisOpen((open) => !open);
                    event.currentTarget.closest("details")?.removeAttribute("open");
                  }}
                >
                  {message("reports.analyzeFailedCases")}
                </Button>
              )}
              <Button
                size="sm"
                variant="destructive"
                disabled={runNeedsPolling(run) || operation.isPending}
                onClick={() => {
                  if (window.confirm(message("runs.deleteConfirm"))) operation.mutate("delete");
                }}
              >
                {message("runs.delete")}
              </Button>
            </div>
          </details>
        </div>
        {run.description && <p className="run-dashboard-description">{run.description}</p>}
        <p className="run-dashboard-meta">
          <span>测试集：{run.suite.name}</span> ·{" "}
          {run.startedAt ? displayRunDate(run.startedAt) : message("rd.notStarted")} ·{" "}
          {message("rd.duration")}: {duration} <span title={run.id}>Run {run.id.slice(0, 8)}…</span>{" "}
          <Button size="sm" variant="ghost" onClick={() => void copyId()}>
            {copyState === "done" ? message("rd.copied") : message("rd.copyId")}
          </Button>
          {copyState === "error" && (
            <span role="status">
              {message("rd.copyError")} {run.id}
            </span>
          )}
        </p>
      </header>
      {operation.isError && (
        <Alert variant="destructive">
          <AlertTitle>
            {runMutationErrorMessage(operation.error, message("rd.operationError"))}
          </AlertTitle>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              operation.reset();
              void detail.refetch();
            }}
          >
            {message("dashboard.retry")}
          </Button>
        </Alert>
      )}
      {run.errorCode && (
        <p role="alert" className="run-dashboard-note">
          {message("rd.runError")}: {run.errorCode}
        </p>
      )}
      <section className="run-dashboard-config" aria-label={message("rd.config")}>
        <div className="run-config-summary">
          <div>
            <span>Agent 入口</span>
            <strong>{run.endpoint.name}</strong>
          </div>
          <div>
            <span>Agent 分支 / 版本</span>
            <strong title={run.endpoint.config.agentRevision?.commit}>
              {run.endpoint.config.agentRevision
                ? `${run.endpoint.config.agentRevision.branch} / ${run.endpoint.config.agentRevision.commit.slice(0, 8)}`
                : "未记录"}
            </strong>
          </div>
          <div>
            <span>评测模型</span>
            <strong>{run.evaluator.config.model}</strong>
          </div>
        </div>
        <details>
          <summary className="run-dashboard-config-toggle">
            <span className="run-dashboard-config-link">{message("rd.fullConfig")}</span>
          </summary>
          <p>{message("rd.snapshotHelp")}</p>
          <p>
            {message("rd.endpoint")}: {run.endpoint.name} ·{" "}
            {safeEndpointLocation(run.endpoint.config.urlTemplate)}
          </p>
          <p>Judge: {run.evaluator.config.model}</p>
          <p>
            {message("rd.rubric")}:{" "}
            {run.rubricPrompts.length === 0
              ? message("rd.notApplicable")
              : run.rubricPrompts
                  .map((prompt) => `${prompt.name} / ${prompt.promptHash.slice(0, 12)}`)
                  .join(" · ")}
          </p>
          <pre className="report-json-value">{JSON.stringify(dashboardConfig(run), null, 2)}</pre>
        </details>
      </section>
      <section className="run-dashboard-results" aria-label={message("rd.summary")}>
        <div className="run-dashboard-counts">
          <button type="button" aria-pressed={bucket === "ALL"} onClick={() => setBucket("ALL")}>
            <span>{message("rd.totalCases")}</span>
            <strong>{run.suite.caseCount}</strong>
          </button>
          {(["PASS", "FAIL", "ERROR", "PENDING", "CANCELLED"] as const).map((key) => (
            <button
              type="button"
              key={key}
              data-bucket={key}
              aria-pressed={bucket === key}
              disabled={!totalsReady}
              onClick={() => setBucket(key)}
            >
              <span>{message(`rd.bucket.${key}`)}</span>
              <strong>{totalsReady ? counts?.[key] : "—"}</strong>
            </button>
          ))}
        </div>
        <div className="run-dashboard-progress">
          <span>
            {message("rd.executionProgress")} {run.rest.completed}/{run.rest.total}
          </span>
          <span>
            {message("rd.evaluationProgress")} {run.evaluation.completed}/{run.evaluation.total}
          </span>
          <details>
            <summary>{message("rd.statusHelp")}</summary>
            <p>{message("rd.partitionHelp")}</p>
            <p>{message("rd.progressHelp")}</p>
            {totalsReady && (
              <p>
                {message("rd.executionErrors")}:{" "}
                {rows.filter((row) => ["ERROR", "TIMEOUT"].includes(executionState(row))).length} ·{" "}
                {message("rd.evaluationErrors")}:{" "}
                {rows.filter((row) => row.evaluation?.status === "EVALUATION_ERROR").length}
              </p>
            )}
            <p>{message("rd.pendingHelp")}</p>
          </details>
        </div>
      </section>
      <RunTokenSummary rows={rows} ready={totalsReady} />
      {analysisOpen && <RunAnalysisControl api={api} runId={runId} />}
      {reviews.isError && (
        <p role="alert" className="run-muted">
          人工审核记录读取失败，当前仅展示自动结果。
        </p>
      )}
      {cases.isPending && <Progress aria-label={message("rd.loadingCases")} />}
      {cases.isError && (
        <Alert variant="destructive">
          <AlertTitle>{message("rd.caseError")}</AlertTitle>
          <Button size="sm" onClick={() => void cases.refetch()}>
            {message("dashboard.retry")}
          </Button>
        </Alert>
      )}
      {cases.data && !cases.isError && (
        <>
          {syncing && <p role="status">{message("rd.syncing")}</p>}
          <RunDashboardCases
            api={api}
            runId={runId}
            rows={rows}
            bucket={bucket}
            onBucketChange={setBucket}
            missing={Math.max(0, run.suite.caseCount - rows.length)}
            onNavigate={onNavigate}
            canRerun={canRerun}
          />
        </>
      )}
      {rerunOpen && (
        <RunRerunDialog
          api={api}
          run={run}
          onClose={() => setRerunOpen(false)}
          onNavigate={onNavigate}
        />
      )}
      <RunComparison
        api={api}
        run={run}
        rows={rows}
        open={compareOpen}
        onClose={() => setCompareOpen(false)}
      />
    </section>
  );
}

/** Pipeline handoffs are automatic, even during the brief READY stage transition. */
function runNeedsPolling(
  run: { status: string; runMode: string; stage: string } | undefined
): boolean {
  return (
    run?.status === "RUNNING" ||
    (run?.status === "READY" && run.runMode === "PIPELINE" && !["REST", "DONE"].includes(run.stage))
  );
}
