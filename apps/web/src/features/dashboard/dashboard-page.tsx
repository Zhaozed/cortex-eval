import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Layers3, RefreshCw } from "lucide-react";
import { useState, type ReactElement } from "react";
import { Alert, AlertTitle } from "../../components/ui/alert.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Progress } from "../../components/ui/progress.tsx";
import { resourceKeys, type ResourceApi } from "../../lib/resource-api.ts";
import type { RunApi } from "../../lib/run-api.ts";
import { runReviewApi } from "../../lib/run-review-api.ts";
import { countCursorResources } from "../feature-registry.ts";
import { displayRunDate, runStatusLabel } from "../runs/run-ui.ts";
import { DashboardResults } from "./dashboard-results.tsx";
import { dashboardRunPath, loadDashboardEvidence, reportCandidates } from "./dashboard-model.ts";

export interface DashboardPageProps {
  readonly api: ResourceApi;
  readonly runApi: RunApi;
  readonly onNavigate: (path: string) => void;
}

/** Management overview: real acceptance evidence first, editable configuration counts omitted. */
export function DashboardPage({ api, runApi, onNavigate }: DashboardPageProps): ReactElement {
  const [selection, setSelection] = useState<string | null>(null);
  const inventory = useQuery({
    queryKey: resourceKeys.dashboard(),
    queryFn: async ({ signal }) => {
      let cases = 0;
      const suites = await countCursorResources(async (cursor, requestSignal) => {
        const page = await api.listTestSuites({ limit: 200, cursor }, requestSignal);
        cases += page.items.reduce((sum, suite) => sum + suite.caseCount, 0);
        return { count: page.items.length, next: page.nextCursor };
      }, signal);
      return { suites, cases };
    }
  });
  const runs = useQuery({
    queryKey: ["dashboard", "recent-runs"],
    queryFn: ({ signal }) => runApi.listRuns({ limit: 50, cursor: null }, signal),
    refetchInterval: (query) =>
      query.state.data?.items.some((run) => run.status === "RUNNING") ? 3000 : false
  });
  const candidates = reportCandidates(runs.data?.items ?? []);
  const selected = candidates.find((run) => run.id === selection) ?? candidates[0];
  const evidence = useQuery({
    queryKey: ["dashboard", "acceptance", selected?.id, selected?.updatedAt],
    queryFn: ({ signal }) => {
      if (!selected) throw new Error("DASHBOARD_RUN_UNSELECTED");
      return loadDashboardEvidence(runApi, selected, signal);
    },
    enabled: selected !== undefined,
    retry: false
  });
  const reviews = useQuery({
    queryKey: ["run-reviews", selected?.id],
    queryFn: ({ signal }) => {
      if (!selected) throw new Error("DASHBOARD_RUN_UNSELECTED");
      return runReviewApi.list(selected.id, signal);
    },
    enabled: selected?.sourceType === "PLATFORM",
    retry: false
  });
  const refresh = (): void => {
    void runs.refetch();
    void inventory.refetch();
    if (selected) void evidence.refetch();
    if (selected?.sourceType === "PLATFORM") void reviews.refetch();
  };
  const reviewReady = selected?.sourceType !== "PLATFORM" || reviews.isSuccess;
  const rows = evidence.data?.rows.map((row) => ({
    ...row,
    review: reviews.data?.find((review) => review.caseKey === row.caseKey)
  }));
  const busy = runs.isFetching || evidence.isFetching || reviews.isFetching || inventory.isFetching;
  return (
    <section className="quality-dashboard">
      <header className="quality-header">
        <div>
          <p className="quality-eyebrow">CORTEX / EVALUATION</p>
          <h1>评测仪表盘</h1>
          <p>看清验收进展，把注意力留给还没解决的问题。</p>
        </div>
        <div className="quality-header-actions">
          <Button variant="outline" size="sm" onClick={refresh} disabled={busy}>
            <RefreshCw aria-hidden="true" />
            刷新
          </Button>
          <Button size="sm" onClick={() => onNavigate("/runs")}>
            运行工作台
            <ArrowRight aria-hidden="true" />
          </Button>
        </div>
      </header>
      <div className="quality-inventory">
        <Layers3 size={14} aria-hidden="true" />
        {inventory.data && !inventory.isError ? (
          <span>
            测试资产 <b data-testid="count-test-suites">{inventory.data.suites}</b> 个测试集 <i />{" "}
            <b data-testid="count-cases">{inventory.data.cases}</b> 条 Case
          </span>
        ) : (
          <span>{inventory.isError ? "测试资产数量暂不可用" : "正在读取测试资产…"}</span>
        )}
      </div>
      {runs.isError ? (
        <Alert variant="destructive">
          <AlertTitle>运行记录读取失败，请刷新重试。</AlertTitle>
        </Alert>
      ) : null}
      {runs.isPending ? <Progress aria-label="读取运行记录" /> : null}
      {selected && !runs.isError ? (
        <>
          <section className="quality-scope" aria-label="统计范围">
            <div className="quality-scope-description">
              <div className="quality-kicker">
                <span className="quality-dot" />
                运行验收概览{" "}
                <span className="quality-subtle">
                  {selection === selected.id ? "已选运行" : "最近完成"}
                </span>
              </div>
              <h2>{selected.name ?? selected.suiteName}</h2>
              <p>{selected.description?.trim() ? selected.description : "未填写运行目的"}</p>
              <div className="quality-scope-meta">
                <span>测试集 · {selected.suiteName}</span>
                <span>{displayRunDate(selected.createdAt)}</span>
                {selected.sourceType === "OFFLINE_IMPORT" && <span>离线导入</span>}
              </div>
            </div>
            <div className="quality-scope-control">
              <label htmlFor="quality-run-select">切换统计运行</label>
              <select
                id="quality-run-select"
                value={selected.id}
                onChange={(event) => setSelection(event.target.value)}
              >
                {candidates.map((run) => (
                  <option key={run.id} value={run.id}>
                    {run.name ?? run.suiteName} · {displayRunDate(run.createdAt)}
                  </option>
                ))}
              </select>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onNavigate(dashboardRunPath(selected))}
              >
                查看完整运行
                <ArrowRight aria-hidden="true" />
              </Button>
            </div>
          </section>
          {evidence.isError || (selected.sourceType === "PLATFORM" && reviews.isError) ? (
            <Alert variant="destructive">
              <AlertTitle>
                {evidence.isError
                  ? "完整评测证据读取失败，暂不展示验收统计。"
                  : "人工复核记录读取失败，暂不展示最终结论。"}
              </AlertTitle>
              <Button size="sm" variant="outline" onClick={refresh}>
                重新读取
              </Button>
            </Alert>
          ) : evidence.isPending || !reviewReady ? (
            <Progress aria-label="读取验收证据" />
          ) : rows ? (
            <DashboardResults
              key={selected.id}
              run={selected}
              report={evidence.data.report}
              rows={rows}
              api={runApi}
              onNavigate={onNavigate}
            />
          ) : null}
        </>
      ) : runs.isSuccess ? (
        <section className="quality-panel quality-empty">
          <Layers3 aria-hidden="true" />
          <h2>还没有可展示的完整评测</h2>
          <p>完成一次评测后，这里会展示场景结果和待处理问题。运行结束不代表验收通过。</p>
          <Button size="sm" onClick={() => onNavigate("/runs")}>
            前往运行工作台
            <ArrowRight aria-hidden="true" />
          </Button>
        </section>
      ) : null}
      <section className="quality-panel quality-recent" aria-labelledby="quality-recent-heading">
        <div className="quality-panel-heading">
          <div>
            <h2 id="quality-recent-heading">近期运行</h2>
            <p>执行进展与自动评测结果；人工复核见运行详情</p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => onNavigate("/runs")}>
            全部运行
            <ArrowRight aria-hidden="true" />
          </Button>
        </div>
        {runs.data && !runs.isError ? (
          <>
            <div className="quality-table-scroll">
              <table className="quality-table">
                <thead>
                  <tr>
                    <th>运行 / 测试目的</th>
                    <th>测试集</th>
                    <th>运行状态</th>
                    <th>执行 / 评测进度</th>
                    <th>自动通过 / 未通过 / 评测异常</th>
                    <th>创建时间</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.data.items.slice(0, 6).map((run) => (
                    <tr key={run.id}>
                      <td>
                        <a
                          href={dashboardRunPath(run)}
                          onClick={(event) => {
                            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
                              return;
                            event.preventDefault();
                            onNavigate(dashboardRunPath(run));
                          }}
                        >
                          {run.name ?? run.suiteName}
                          <ArrowRight size={13} aria-hidden="true" />
                        </a>
                        <span className="quality-cell-description">
                          {run.description?.trim() ? run.description : "未填写运行目的"}
                        </span>
                      </td>
                      <td>{run.suiteName}</td>
                      <td>
                        <span
                          className={`quality-run-status ${run.status === "RUNNING" ? "is-running" : run.status === "FAILED" || run.status === "COMPLETED_WITH_ERRORS" ? "is-error" : ""}`}
                        >
                          {runStatusLabel(run.status)}
                        </span>
                        {run.sourceType === "OFFLINE_IMPORT" && <small>离线导入</small>}
                      </td>
                      <td>
                        <span>
                          执行 {run.rest.completed}/{run.rest.total}
                        </span>
                        <small>
                          评测 {run.evaluation.completed}/{run.evaluation.total}
                        </small>
                      </td>
                      <td>
                        {run.evaluation.completed === 0 ? (
                          <span className="quality-subtle">待评测</span>
                        ) : (
                          <span className="quality-auto-counts">
                            <b>{run.evaluation.passed}</b> / <b>{run.evaluation.failed}</b> /{" "}
                            <b>{run.evaluation.error}</b>
                          </span>
                        )}
                      </td>
                      <td className="quality-date">{displayRunDate(run.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {runs.data.items.length === 0 && <p className="quality-empty-text">暂无运行记录</p>}
            <footer className="quality-panel-footer">
              显示最近 {Math.min(6, runs.data.items.length)} 条运行 · 概览可选择最近 50
              条记录中已完成的评测
            </footer>
          </>
        ) : (
          <p className="quality-empty-text">{runs.isError ? "运行记录暂不可用" : "正在读取…"}</p>
        )}
      </section>
    </section>
  );
}
