import { lazy, Suspense, useState, type ReactElement } from "react";
import { ArrowRight, Check, CheckCheck, CircleAlert, Clock3, ListChecks, X } from "lucide-react";
import { Button } from "../../components/ui/button.tsx";
import { Sheet } from "../../components/ui/sheet.tsx";
import { Progress } from "../../components/ui/progress.tsx";
import type { RunApi, RunReportOverview } from "../../lib/run-api.ts";
import {
  dashboardCounts,
  evaluationState,
  resultBucket,
  type DashboardCase,
  type ResultBucket
} from "../runs/run-dashboard-model.ts";
import type { CaseTab } from "../runs/run-case-drawer.tsx";
import {
  attentionReason,
  dashboardRunPath,
  RESULT_LABELS,
  RESULT_ORDER,
  scenarioKey,
  scenarioResults,
  type DashboardRun
} from "./dashboard-model.ts";

const RunCaseDrawer = lazy(async () => ({
  default: (await import("../runs/run-case-drawer.tsx")).RunCaseDrawer
}));

/** Management drill-down reuses the existing evidence drawer and final-verdict mapping. */
export function DashboardResults({
  run,
  report,
  rows,
  api,
  onNavigate
}: {
  readonly run: DashboardRun;
  readonly report: RunReportOverview;
  readonly rows: readonly DashboardCase[];
  readonly api: RunApi;
  readonly onNavigate: (path: string) => void;
}): ReactElement {
  const [filter, setFilter] = useState<ResultBucket | "ATTENTION" | "ISSUES" | "ALL">("ATTENTION");
  const [scenario, setScenario] = useState<string | null>(null);
  const [limit, setLimit] = useState(6);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<CaseTab>("result");
  const counts = dashboardCounts(report.summary.total, rows);
  const groups = scenarioResults(rows);
  const reviewPending = rows.filter(
    (row) => evaluationState(row) === "REVIEW_PENDING" && resultBucket(row) === "PENDING"
  ).length;
  const total = report.summary.total;
  const outstanding = counts.FAIL + counts.ERROR;
  const allPassed = total > 0 && counts.PASS === total;
  const filtered = rows.filter(
    (row) =>
      (scenario === null || scenarioKey(row) === scenario) &&
      (filter === "ALL" ||
        (filter === "ATTENTION"
          ? resultBucket(row) !== "PASS"
          : filter === "ISSUES"
            ? ["FAIL", "ERROR"].includes(resultBucket(row))
            : resultBucket(row) === filter))
  );
  const activeRow = rows.find((row) => row.caseKey === selected);
  const activeIndex = filtered.findIndex((row) => row.caseKey === selected);
  const chooseFilter = (value: typeof filter): void => {
    setFilter(value);
    setLimit(6);
  };
  const chooseMetric = (value: typeof filter): void => {
    setScenario(null);
    chooseFilter(value);
  };
  const openCase = (row: DashboardCase): void => {
    if (run.sourceType === "OFFLINE_IMPORT") {
      onNavigate(dashboardRunPath(run));
      return;
    }
    setSelected(row.caseKey);
    setTab("result");
  };
  return (
    <>
      <div className="quality-metrics" aria-label="所选运行验收指标">
        <button
          className="quality-metric"
          aria-pressed={filter === "ALL"}
          onClick={() => chooseMetric("ALL")}
        >
          <span>
            <ListChecks size={16} aria-hidden="true" />
            验收范围
          </span>
          <strong>
            {total}
            <small>条 Case</small>
          </strong>
          <p>{groups.length} 个业务场景 · 本次运行</p>
        </button>
        <button
          className="quality-metric quality-metric-pass"
          aria-pressed={filter === "PASS"}
          onClick={() => chooseMetric("PASS")}
        >
          <span>
            <CheckCheck size={16} aria-hidden="true" />
            已确认通过
          </span>
          <strong data-testid="quality-pass-count">
            {counts.PASS}
            <small>/ {total}</small>
          </strong>
          <p>
            {total === 0 ? "通过率不适用" : `通过率 ${((counts.PASS / total) * 100).toFixed(1)}%`} ·
            含必要人工复核
          </p>
        </button>
        <button
          className="quality-metric quality-metric-risk"
          aria-pressed={filter === "ISSUES"}
          onClick={() => chooseMetric("ISSUES")}
        >
          <span>
            <CircleAlert size={16} aria-hidden="true" />
            未通过 / 异常
          </span>
          <strong>
            {outstanding}
            <small>条待关注</small>
          </strong>
          <p>
            未通过 {counts.FAIL} · 异常 {counts.ERROR}
          </p>
        </button>
        <button
          className="quality-metric quality-metric-pending"
          aria-pressed={filter === "PENDING"}
          onClick={() => chooseMetric("PENDING")}
        >
          <span>
            <Clock3 size={16} aria-hidden="true" />
            待处理
          </span>
          <strong data-testid="quality-pending-count">
            {counts.PENDING}
            <small>条 Case</small>
          </strong>
          <p>
            待人工复核 {reviewPending} · 其他 {counts.PENDING - reviewPending}
          </p>
        </button>
      </div>
      <section className="quality-outcome quality-panel" aria-label="验收结论分布">
        <div className="quality-outcome-heading">
          <div className={`quality-outcome-symbol ${allPassed ? "is-clear" : ""}`}>
            {allPassed ? <Check size={19} /> : <ListChecks size={19} />}
          </div>
          <div>
            <h2>
              {allPassed
                ? "所选运行全部通过"
                : outstanding > 0
                  ? `${outstanding} 条未通过或异常，需继续排查`
                  : counts.PENDING > 0
                    ? "验收尚未完成，仍有待处理项"
                    : counts.CANCELLED > 0
                      ? "存在取消的 Case，验收未完成"
                      : "本次运行无 Case"}
            </h2>
            <p>
              {allPassed
                ? "仅代表本次测试范围，不等同于发布批准。"
                : "执行完成不等于验收通过；自动失败不会被人工通过覆盖。"}
            </p>
          </div>
        </div>
        <div
          className="quality-distribution"
          role="img"
          aria-label={RESULT_ORDER.map((key) => `${RESULT_LABELS[key]} ${counts[key]}`).join("，")}
        >
          {RESULT_ORDER.map((key) =>
            counts[key] > 0 ? (
              <span
                key={key}
                className={`quality-segment is-${key.toLowerCase()}`}
                style={{ width: `${(counts[key] / total) * 100}%` }}
              />
            ) : null
          )}
        </div>
        <div className="quality-legend">
          {RESULT_ORDER.map((key) => (
            <button key={key} onClick={() => chooseFilter(key)} aria-pressed={filter === key}>
              <i className={`is-${key.toLowerCase()}`} />
              {RESULT_LABELS[key]}
              <b>{counts[key]}</b>
            </button>
          ))}
          <details className="quality-method">
            <summary>统计口径</summary>
            <p>
              以上为所选运行全部 {total} 条 Case
              的互斥分类，包含当前人工复核。异常包括执行异常和评测异常；待处理包括未评测、无法评测和待复核。已取消单列，不计入通过。
              {run.sourceType === "OFFLINE_IMPORT" && "离线导入未关联平台人工复核记录。"}
            </p>
          </details>
        </div>
      </section>
      <div className="quality-analysis-grid">
        <section
          className="quality-panel quality-scenarios"
          aria-labelledby="quality-scenarios-heading"
        >
          <div className="quality-panel-heading">
            <div>
              <h2 id="quality-scenarios-heading">业务场景表现</h2>
              <p>问题较多的场景优先 · 点击场景筛选右侧 Case</p>
            </div>
            <span className="quality-count-tag">{groups.length} 个场景</span>
          </div>
          <div className="quality-table-scroll quality-scenario-scroll">
            <table className="quality-table">
              <thead>
                <tr>
                  <th>业务场景</th>
                  <th>通过 / 总数</th>
                  <th>未通过</th>
                  <th>异常</th>
                  <th>待处理</th>
                  <th>取消</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => (
                  <tr key={group.key} className={scenario === group.key ? "is-selected" : ""}>
                    <td>
                      <button
                        className="quality-scenario-button"
                        onClick={() => {
                          setScenario(scenario === group.key ? null : group.key);
                          chooseFilter("ALL");
                        }}
                        aria-pressed={scenario === group.key}
                      >
                        {group.name}
                      </button>
                      <small>{group.module}</small>
                      <div className="quality-mini-bar" aria-hidden="true">
                        {RESULT_ORDER.map((key) =>
                          group.counts[key] > 0 ? (
                            <i
                              key={key}
                              className={`is-${key.toLowerCase()}`}
                              style={{ width: `${(group.counts[key] / group.total) * 100}%` }}
                            />
                          ) : null
                        )}
                      </div>
                    </td>
                    <td>
                      <b>{group.counts.PASS}</b>
                      <span className="quality-subtle"> / {group.total}</span>
                    </td>
                    <td className={group.counts.FAIL ? "quality-number-fail" : "quality-subtle"}>
                      {group.counts.FAIL}
                    </td>
                    <td className={group.counts.ERROR ? "quality-number-error" : "quality-subtle"}>
                      {group.counts.ERROR}
                    </td>
                    <td>{group.counts.PENDING}</td>
                    <td className="quality-subtle">{group.counts.CANCELLED}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {groups.length === 0 && <p className="quality-empty-text">暂无场景记录</p>}
          <footer className="quality-panel-footer">
            按本次 Case 快照分组，不使用当前测试集覆盖历史。
          </footer>
        </section>
        <section
          className="quality-panel quality-attention"
          aria-labelledby="quality-attention-heading"
        >
          <div className="quality-panel-heading">
            <div>
              <h2 id="quality-attention-heading">
                {filter === "ATTENTION" ? "待关注 Case" : "Case 清单"}
                <span className="quality-count-tag">{filtered.length}</span>
              </h2>
              <p>只展示记录中的结论，根因以人工核查为准</p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => onNavigate(dashboardRunPath(run))}>
              完整结果
              <ArrowRight aria-hidden="true" />
            </Button>
          </div>
          <div className="quality-filters">
            <select
              aria-label="关注结论筛选"
              value={filter}
              onChange={(event) => chooseFilter(event.target.value as typeof filter)}
            >
              <option value="ATTENTION">全部待关注</option>
              <option value="ALL">全部 Case</option>
              <option value="ISSUES">未通过 / 异常</option>
              {RESULT_ORDER.map((key) => (
                <option key={key} value={key}>
                  {RESULT_LABELS[key]}
                </option>
              ))}
            </select>
            {scenario !== null && (
              <button className="quality-filter-chip" onClick={() => setScenario(null)}>
                {groups.find((group) => group.key === scenario)?.name}
                <X size={12} aria-label="取消场景筛选" />
              </button>
            )}
          </div>
          <div className="quality-attention-list">
            {filtered.slice(0, limit).map((row) => (
              <button
                key={row.caseKey}
                className="quality-attention-item"
                onClick={() => openCase(row)}
              >
                <div>
                  <span className={`quality-result-pill is-${resultBucket(row).toLowerCase()}`}>
                    {evaluationState(row) === "REVIEW_PENDING" && resultBucket(row) === "PENDING"
                      ? "待复核"
                      : RESULT_LABELS[resultBucket(row)]}
                  </span>
                  <small>{row.caseKey}</small>
                  <ArrowRight size={14} aria-hidden="true" />
                </div>
                <strong>{row.definition?.description ?? row.caseKey}</strong>
                <p>
                  {resultBucket(row) === "PASS" ? "已通过所需评测与复核" : attentionReason(row)}
                </p>
              </button>
            ))}
          </div>
          {filtered.length === 0 && (
            <div className="quality-attention-empty">
              <CheckCheck size={25} aria-hidden="true" />
              <strong>
                {filter === "ATTENTION" && allPassed ? "本次没有待关注项" : "当前筛选下没有 Case"}
              </strong>
              <p>{allPassed ? "可进入完整运行查看评测依据。" : "尝试切换结论或取消场景筛选。"}</p>
            </div>
          )}
          {filtered.length > limit && (
            <Button
              variant="ghost"
              size="sm"
              className="quality-load-more"
              onClick={() => setLimit(limit + 6)}
            >
              再显示 {Math.min(6, filtered.length - limit)} 条
            </Button>
          )}
        </section>
      </div>
      <Sheet
        open={activeRow !== undefined}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        {activeRow && (
          <Suspense fallback={<Progress aria-label="读取 Case 详情" />}>
            <RunCaseDrawer
              api={api}
              runId={run.id}
              row={activeRow}
              tab={tab}
              onTab={setTab}
              previous={
                activeIndex > 0
                  ? (): void => setSelected(filtered[activeIndex - 1]?.caseKey ?? null)
                  : undefined
              }
              next={
                activeIndex >= 0 && activeIndex < filtered.length - 1
                  ? (): void => setSelected(filtered[activeIndex + 1]?.caseKey ?? null)
                  : undefined
              }
              onClose={() => setSelected(null)}
              onNavigate={onNavigate}
              canRerun={false}
            />
          </Suspense>
        )}
      </Sheet>
    </>
  );
}
