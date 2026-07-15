import { useQuery } from "@tanstack/react-query";
import { Database, RefreshCw } from "lucide-react";
import type { MouseEvent, ReactElement } from "react";

import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Progress } from "../../components/ui/progress.tsx";
import { countCursorResources, resourceDashboardContributions } from "../feature-registry.ts";
import { formatMessage, message, type MessageKey } from "../../messages/messages.ts";
import { resourceKeys, type ConfigurationKind, type ResourceApi } from "../../lib/resource-api.ts";
import { ApiClientError } from "../../lib/api-client.ts";
import type { PlatformRunPage, RunApi, RunReportOverview } from "../../lib/run-api.ts";
import { displayRunDate, runStageLabel, runStatusLabel } from "../runs/run-ui.ts";

/** Exact P4 resource counts displayed by Dashboard contributions. */
interface DashboardCounts {
  /** Current Test Suite count. */
  readonly "test-suites": number;
  /** Current Case count derived from Suite summaries. */
  readonly cases: number;
  /** Current Endpoint configuration count. */
  readonly "endpoint-configs": number;
  /** Current LLM configuration count. */
  readonly "llm-configs": number;
  /** Current Rubric Prompt count. */
  readonly "rubric-prompts": number;
  /** Current Analysis Prompt count. */
  readonly "analysis-prompts": number;
}

/** Dashboard page properties. */
export interface DashboardPageProps {
  /** Boundary-validating resource API. */
  readonly api: ResourceApi;
  /** Boundary-validating Run API. */
  readonly runApi: RunApi;
  /** Explicit History navigation callback. */
  readonly onNavigate: (path: string) => void;
}

// Read all Test Suite pages and aggregate their Case summary counts.
async function loadSuiteCounts(
  api: ResourceApi,
  signal: AbortSignal
): Promise<readonly [number, number]> {
  let suiteCount = 0;
  let caseCount = 0;
  await countCursorResources(async (cursor, pageSignal) => {
    const page = await api.listTestSuites({ limit: 200, cursor }, pageSignal);
    suiteCount += page.items.length;
    caseCount += page.items.reduce((sum, suite) => sum + suite.caseCount, 0);
    return { count: page.items.length, next: page.nextCursor };
  }, signal);
  return [suiteCount, caseCount];
}

// Read one complete Configuration family through its cursor pages.
function loadConfigurationCount(
  api: ResourceApi,
  kind: ConfigurationKind,
  signal: AbortSignal
): Promise<number> {
  return countCursorResources(async (cursor, pageSignal) => {
    const page = await api.listConfigurations(kind, { limit: 200, cursor }, pageSignal);
    return { count: page.items.length, next: page.nextCursor };
  }, signal);
}

// Load all P4 Dashboard contributions from current server facts.
async function loadDashboardCounts(
  api: ResourceApi,
  signal: AbortSignal
): Promise<DashboardCounts> {
  const [[suites, cases], endpoints, llms, rubrics, analysisPrompts] = await Promise.all([
    loadSuiteCounts(api, signal),
    loadConfigurationCount(api, "ENDPOINT", signal),
    loadConfigurationCount(api, "LLM", signal),
    loadConfigurationCount(api, "LLM_RUBRIC_PROMPT", signal),
    loadConfigurationCount(api, "CASE_ANALYSIS_PROMPT", signal)
  ]);
  return {
    "test-suites": suites,
    cases,
    "endpoint-configs": endpoints,
    "llm-configs": llms,
    "rubric-prompts": rubrics,
    "analysis-prompts": analysisPrompts
  };
}

// Read the newest committed Report among the bounded newest Run facts.
async function loadLatestReport(
  api: RunApi,
  page: PlatformRunPage,
  signal: AbortSignal
): Promise<RunReportOverview | null> {
  const candidates = page.items.filter(
    (run) =>
      run.stage === "DONE" && (run.status === "COMPLETED" || run.status === "COMPLETED_WITH_ERRORS")
  );
  for (const run of candidates) {
    try {
      return await api.getReport(run.id, signal);
    } catch (error) {
      if (
        error instanceof ApiClientError &&
        (error.code === "RUN_STATE_CONFLICT" || error.code === "RUN_NOT_FOUND")
      ) {
        continue;
      }
      throw error;
    }
  }
  return null;
}

// Render an exact stored Rate without manufacturing a zero for an empty denominator.
function reportRate(value: number | null): string {
  return value === null ? message("reports.rateUnavailable") : `${(value * 100).toFixed(1)}%`;
}

// Route imported history directly to its Report while retaining platform Run detail.
function dashboardRunPath(run: PlatformRunPage["items"][number]): string {
  const id = encodeURIComponent(run.id);
  return run.sourceType === "OFFLINE_IMPORT" ? `/runs/${id}/report` : `/runs/${id}`;
}

/** Resource counts and recent platform Run facts registered through P5. */
export function DashboardPage({ api, runApi, onNavigate }: DashboardPageProps): ReactElement {
  const query = useQuery({
    queryKey: resourceKeys.dashboard(),
    queryFn: ({ signal }) => loadDashboardCounts(api, signal)
  });
  const runs = useQuery({
    queryKey: ["dashboard", "recent-runs"] as const,
    queryFn: ({ signal }) => runApi.listRuns({ limit: 50, cursor: null }, signal),
    refetchInterval: (current) =>
      current.state.data?.items.some((run) => run.status === "RUNNING") === true ? 1_000 : false
  });
  const latestReport = useQuery({
    queryKey: [
      "dashboard",
      "latest-report",
      runs.data?.items.map((run) => [run.id, run.status, run.stage, run.updatedAt]) ?? []
    ] as const,
    queryFn: ({ signal }) => {
      if (runs.data === undefined) return Promise.resolve(null);
      return loadLatestReport(runApi, runs.data, signal);
    },
    enabled: runs.data !== undefined
  });

  if (query.isPending) {
    return (
      <section className="page-stack" aria-busy="true">
        <header className="page-header">
          <p className="eyebrow">{message("dashboard.eyebrow")}</p>
          <h1>{message("dashboard.title")}</h1>
        </header>
        <div className="loading-panel">
          <span>{message("dashboard.loading")}</span>
          <Progress aria-label={message("dashboard.loading")} />
        </div>
      </section>
    );
  }

  if (query.isError) {
    return (
      <section className="page-stack">
        <header className="page-header">
          <p className="eyebrow">{message("dashboard.eyebrow")}</p>
          <h1>{message("dashboard.title")}</h1>
        </header>
        <Alert variant="destructive">
          <AlertTitle>{message("dashboard.errorTitle")}</AlertTitle>
          <AlertDescription>{message("dashboard.errorDescription")}</AlertDescription>
          <Button type="button" variant="outline" onClick={() => void query.refetch()}>
            <RefreshCw aria-hidden="true" />
            {message("dashboard.retry")}
          </Button>
        </Alert>
      </section>
    );
  }

  return (
    <section className="page-stack">
      <header className="page-header dashboard-header">
        <div>
          <p className="eyebrow">{message("dashboard.eyebrow")}</p>
          <h1>{message("dashboard.title")}</h1>
          <p>{message("dashboard.description")}</p>
        </div>
        <Database className="header-symbol" aria-hidden="true" />
      </header>
      <div className="resource-count-grid">
        {resourceDashboardContributions.map((contribution, index) => (
          <article className="count-card" key={contribution.id}>
            <div className="count-card-topline">
              <span>{String(index + 1).padStart(2, "0")}</span>
              <Badge variant="accent">{message("dashboard.current")}</Badge>
            </div>
            <strong data-testid={`count-${contribution.id}`}>
              {query.data[contribution.id as keyof DashboardCounts]}
            </strong>
            <h2>{message(contribution.labelKey as MessageKey)}</h2>
          </article>
        ))}
      </div>
      <section className="dashboard-runs" aria-labelledby="dashboard-report-heading">
        <div className="section-heading compact">
          <div>
            <p className="eyebrow">{message("dashboard.reportEyebrow")}</p>
            <h2 id="dashboard-report-heading">{message("dashboard.latestReport")}</h2>
          </div>
        </div>
        {latestReport.isPending && runs.data !== undefined ? (
          <Progress aria-label={message("dashboard.reportLoading")} />
        ) : null}
        {latestReport.isError ? (
          <Alert variant="destructive">
            <AlertTitle>{message("dashboard.reportError")}</AlertTitle>
          </Alert>
        ) : null}
        {latestReport.data === null ? (
          <p className="empty-state">{message("dashboard.reportEmpty")}</p>
        ) : null}
        {latestReport.data === undefined || latestReport.data === null ? null : (
          <div className="resource-count-grid report-summary-grid">
            <article className="count-card" data-testid="latest-report-effective-rate">
              <span>{message("reports.effectivePassRate")}</span>
              <strong>{reportRate(latestReport.data.summary.effectivePassRate)}</strong>
            </article>
            <article className="count-card" data-testid="latest-report-coverage-rate">
              <span>{message("reports.coverageRate")}</span>
              <strong>{reportRate(latestReport.data.summary.coverageRate)}</strong>
            </article>
            <article className="count-card" data-testid="latest-report-primary-metric">
              <span>
                {latestReport.data.byMetric[0]?.metric ?? message("dashboard.primaryMetricEmpty")}
              </span>
              <strong>{reportRate(latestReport.data.byMetric[0]?.passRate ?? null)}</strong>
            </article>
          </div>
        )}
      </section>
      <section className="dashboard-runs" aria-labelledby="dashboard-runs-heading">
        <div className="section-heading compact">
          <div>
            <p className="eyebrow">{message("dashboard.runsEyebrow")}</p>
            <h2 id="dashboard-runs-heading">{message("dashboard.recentRuns")}</h2>
          </div>
          <Badge variant="outline">{message("dashboard.allSources")}</Badge>
        </div>
        {runs.isPending ? <Progress aria-label={message("dashboard.runsLoading")} /> : null}
        {runs.isError ? (
          <Alert variant="destructive">
            <AlertTitle>{message("dashboard.runsError")}</AlertTitle>
            <Button type="button" variant="outline" onClick={() => void runs.refetch()}>
              <RefreshCw aria-hidden="true" />
              {message("dashboard.retry")}
            </Button>
          </Alert>
        ) : null}
        {runs.data?.items.length === 0 ? (
          <p className="empty-state">{message("dashboard.runsEmpty")}</p>
        ) : null}
        {runs.data === undefined || runs.data.items.length === 0 ? null : (
          <div className="dashboard-run-grid">
            {runs.data.items.slice(0, 5).map((run) => (
              <a
                key={run.id}
                href={dashboardRunPath(run)}
                className="dashboard-run-card"
                onClick={(event: MouseEvent<HTMLAnchorElement>) => {
                  event.preventDefault();
                  onNavigate(dashboardRunPath(run));
                }}
              >
                <div className="count-card-topline">
                  <span>{runStageLabel(run.stage)}</span>
                  <Badge variant="accent">{runStatusLabel(run.status)}</Badge>
                </div>
                <strong>{run.suiteName}</strong>
                <Badge variant="outline">
                  {run.sourceType === "PLATFORM"
                    ? message("runs.platform")
                    : message("runs.offlineImport")}
                </Badge>
                <span>
                  {formatMessage("runs.progressCount", {
                    completed: run.rest.completed,
                    total: run.rest.total
                  })}
                </span>
                <small>{displayRunDate(run.updatedAt)}</small>
              </a>
            ))}
          </div>
        )}
      </section>
    </section>
  );
}
