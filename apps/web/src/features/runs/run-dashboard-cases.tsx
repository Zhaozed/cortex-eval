import { hasObservedCards, visualReviewRequired } from "./run-output-model.ts";
import { useState, type ReactElement } from "react";
import { Badge } from "../../components/ui/badge.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Progress } from "../../components/ui/progress.tsx";
import { Sheet } from "../../components/ui/sheet.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "../../components/ui/table.tsx";
import type { RunApi } from "../../lib/run-api.ts";
import { aggregateAssertionsByDimension, softFailureCount } from "../../lib/assertion-metric.ts";
import { message } from "../../messages/messages.ts";
import { RunCaseDrawer, type CaseTab } from "./run-case-drawer.tsx";
import { hasTrace, scenarioName } from "./run-evidence-model.ts";
import {
  evaluationState,
  manualOverride,
  executionState,
  resultBucket,
  type DashboardCase,
  type ResultBucket
} from "./run-dashboard-model.ts";

// A green verdict must not hide `【质量】` misses: they never veto, but they are still defects.
function softMisses(row: DashboardCase): number {
  return softFailureCount(row.evaluation?.assertions ?? []);
}

/** Compact Case list and local pagination; all evidence actions preserve the current filters. */
export function RunDashboardCases({
  api,
  runId,
  rows,
  bucket,
  onBucketChange,
  missing,
  onNavigate,
  canRerun
}: {
  readonly api: RunApi;
  readonly runId: string;
  readonly rows: readonly DashboardCase[];
  readonly bucket: ResultBucket | "ALL";
  readonly onBucketChange: (value: ResultBucket | "ALL") => void;
  readonly missing: number;
  readonly onNavigate: (path: string) => void;
  readonly canRerun: boolean;
}): ReactElement {
  const [search, setSearch] = useState("");
  const [scenario, setScenario] = useState("");
  const [execution, setExecution] = useState("");
  const [verdict, setVerdict] = useState("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get("case")
  );
  const selectedRow = rows.find((row) => row.caseKey === selected);
  const [tab, setTab] = useState<CaseTab>(() =>
    new URLSearchParams(window.location.search).get("tab") === "trace" ? "trace" : "result"
  );
  const openCase = (key: string, initialTab: CaseTab): void => {
    setSelected(key);
    setTab(initialTab);
  };
  // Dimension pass rates are counted per Assertion, never per Case (see SPEC §6).
  // 维度通过率按 Assertion 统计；只渲染 D1–D6，未分类断言不占用维度卡片。
  const dimensionRates = aggregateAssertionsByDimension(
    rows.flatMap((row) => row.evaluation?.assertions ?? [])
  ).filter((rate) => rate.dimension !== null);
  const dimensionAssertions = dimensionRates.reduce((total, rate) => total + rate.total, 0);
  const scenarios = [
    ...new Set(
      rows.flatMap((row) => (row.definition ? [row.definition.metadata.scenario_tag] : []))
    )
  ].sort();
  const filtered = rows.filter(
    (row) =>
      (bucket === "ALL" || resultBucket(row) === bucket) &&
      (scenario === "" || row.definition?.metadata.scenario_tag === scenario) &&
      (execution === "" || executionState(row) === execution) &&
      (verdict === "" || evaluationState(row) === verdict) &&
      `${row.caseKey} ${row.definition?.description ?? ""}`
        .toLowerCase()
        .includes(search.trim().toLowerCase())
  );
  const activePage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 20) - 1));
  const pageRows = filtered.slice(activePage * 20, activePage * 20 + 20);
  const reset = (): void => {
    setSearch("");
    setScenario("");
    setExecution("");
    setVerdict("");
    setPage(0);
    onBucketChange("ALL");
  };
  return (
    <section className="run-dashboard-cases" aria-labelledby="dashboard-cases-title">
      <div className="run-dashboard-section-heading">
        <h2 id="dashboard-cases-title">{message("rd.cases")}</h2>
        <span>
          {filtered.length} {message("rd.recordedCases")}
        </span>
      </div>
      <div className="run-dimension-rates">
        <div className="run-dimension-head">
          <h3>维度通过率（D1–D6）</h3>
          <span>按断言条数统计，不是按 case 数</span>
        </div>
        {dimensionAssertions === 0 ? (
          <p className="run-dimension-empty">
            本次 run 没有任何断言带 D1–D6 标记（旧套件的 metric
            名没有维度前缀），无法给出维度通过率。
          </p>
        ) : (
          <ul className="run-dimension-list">
            {dimensionRates.map((rate) => (
              <li
                className="run-dimension-row"
                key={rate.dimension ?? "UNMARKED"}
                data-level={rate.level}
              >
                <div className="run-dimension-card-head">
                  <span className="run-dimension-label" title={rate.label}>
                    {rate.label}
                  </span>
                  <strong className="run-dimension-value">
                    {rate.total === 0
                      ? "无断言"
                      : `${rate.percent}% · ${rate.pass}/${rate.total} 通过`}
                  </strong>
                </div>
                <Progress
                  className="run-dimension-bar"
                  value={rate.percent}
                  aria-label={`${rate.label} 断言通过率`}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="run-dashboard-filters">
        <Input
          aria-label={message("rd.search")}
          placeholder={message("rd.search")}
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(0);
          }}
        />
        <select
          aria-label={message("rd.scenario")}
          value={scenario}
          onChange={(event) => {
            setScenario(event.target.value);
            setPage(0);
          }}
        >
          <option value="">{message("rd.allScenarios")}</option>
          {scenarios.map((value) => (
            <option key={value} value={value}>
              {scenarioName(value)}
            </option>
          ))}
        </select>
        <select
          aria-label={message("rd.execution")}
          value={execution}
          onChange={(event) => {
            setExecution(event.target.value);
            setPage(0);
          }}
        >
          <option value="">{message("rd.allExecution")}</option>
          {(["COMPLETED", "TIMEOUT", "ERROR", "CANCELLED"] as const).map((value) => (
            <option key={value} value={value}>
              {message(`rd.exec.${value}`)}
            </option>
          ))}
        </select>
        <select
          aria-label={message("rd.verdict")}
          value={verdict}
          onChange={(event) => {
            setVerdict(event.target.value);
            setPage(0);
          }}
        >
          <option value="">{message("rd.allVerdicts")}</option>
          {(
            [
              "PASS",
              "FAIL",
              "EVALUATION_ERROR",
              "UNAVAILABLE",
              "PENDING",
              "REVIEW_PENDING"
            ] as const
          ).map((value) => (
            <option key={value} value={value}>
              {message(`rd.eval.${value}`)}
            </option>
          ))}
        </select>
        <Button size="sm" variant="ghost" onClick={reset}>
          {message("rd.reset")}
        </Button>
      </div>
      {bucket !== "ALL" && (
        <p className="run-dashboard-note">
          {message("rd.filteredBy")} {message(`rd.bucket.${bucket}`)}{" "}
          <Button
            size="sm"
            variant="link"
            onClick={() => {
              onBucketChange("ALL");
              setPage(0);
            }}
          >
            {message("rd.clear")}
          </Button>
        </p>
      )}
      <Table className="run-dashboard-table">
        <TableHeader>
          <TableRow>
            <TableHead>{message("rd.caseId")}</TableHead>
            <TableHead>{message("rd.description")}</TableHead>
            <TableHead>{message("rd.scenario")}</TableHead>
            <TableHead>{message("rd.execution")}</TableHead>
            <TableHead>{message("rd.verdict")}</TableHead>
            <TableHead>Trace</TableHead>
            <TableHead>A2UI</TableHead>
            <TableHead>{message("common.actions")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {pageRows.map((row) => (
            <TableRow key={row.caseKey}>
              <TableCell>{row.caseKey}</TableCell>
              <TableCell>{row.definition?.description ?? message("rd.notRecorded")}</TableCell>
              <TableCell title={row.definition?.metadata.scenario_tag}>
                {scenarioName(row.definition?.metadata.scenario_tag)}
              </TableCell>
              <TableCell>
                <Badge variant="outline" data-execution={executionState(row)}>
                  {message(`rd.exec.${executionState(row)}`)}
                </Badge>
              </TableCell>
              <TableCell>
                <Badge variant="outline" data-status={evaluationState(row)}>
                  {message(`rd.eval.${evaluationState(row)}`)}
                </Badge>
                {evaluationState(row) === "PASS" && softMisses(row) > 0 && (
                  <small
                    className="run-soft-miss"
                    title="质量项未达标不阻断 PASS 结论，逐项原因见「结果详情」"
                  >
                    {softMisses(row)} 项质量未达标
                  </small>
                )}
                {row.review?.history.length ? (
                  <small
                    className="run-human-mark"
                    data-override={manualOverride(row) ? "true" : undefined}
                    title="自动结果保留在详情中"
                  >
                    {manualOverride(row)
                      ? "人工覆盖"
                      : row.review.history.at(-1)?.kind === "CAPTURE"
                        ? "待复核"
                        : "人工复核"}
                  </small>
                ) : null}
              </TableCell>
              <TableCell>
                {hasTrace(row) ? (
                  <Button variant="link" size="sm" onClick={() => openCase(row.caseKey, "trace")}>
                    查看
                  </Button>
                ) : (
                  <span>未采集</span>
                )}
              </TableCell>
              <TableCell>
                <Button variant="link" size="sm" onClick={() => openCase(row.caseKey, "a2ui")}>
                  {hasObservedCards(row)
                    ? "查看卡片"
                    : visualReviewRequired(row)
                      ? "未采集到卡片"
                      : "无卡片记录"}
                </Button>
              </TableCell>
              <TableCell>
                <Button variant="link" size="sm" onClick={() => openCase(row.caseKey, "result")}>
                  {message("rd.details")}
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {filtered.length === 0 && <p className="empty-state">{message("rd.noMatches")}</p>}
      {missing > 0 && (
        <p className="run-dashboard-note">
          {missing} {message("rd.pendingRowsHelp")}
        </p>
      )}
      <div className="pagination-actions">
        <span>
          {activePage + 1} / {Math.max(1, Math.ceil(filtered.length / 20))}
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={activePage === 0}
          onClick={() => setPage(activePage - 1)}
        >
          {message("common.previous")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={(activePage + 1) * 20 >= filtered.length}
          onClick={() => setPage(activePage + 1)}
        >
          {message("common.next")}
        </Button>
      </div>
      <Sheet
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        {selectedRow && (
          <RunCaseDrawer
            key={selectedRow.caseKey}
            api={api}
            runId={runId}
            row={selectedRow}
            tab={tab}
            onTab={setTab}
            onNavigate={onNavigate}
            canRerun={canRerun}
            previous={
              filtered.findIndex((r) => r.caseKey === selected) > 0
                ? (): void =>
                    setSelected(
                      filtered[filtered.findIndex((r) => r.caseKey === selected) - 1]?.caseKey ??
                        null
                    )
                : undefined
            }
            next={
              filtered.findIndex((r) => r.caseKey === selected) < filtered.length - 1
                ? (): void =>
                    setSelected(
                      filtered[filtered.findIndex((r) => r.caseKey === selected) + 1]?.caseKey ??
                        null
                    )
                : undefined
            }
            onClose={() => setSelected(null)}
          />
        )}
      </Sheet>
    </section>
  );
}
