import { hasObservedCards, visualReviewRequired } from "./run-output-model.ts";
import { useState, type ReactElement } from "react";
import { Badge } from "../../components/ui/badge.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
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
import { message } from "../../messages/messages.ts";
import { RunCaseDrawer, type CaseTab } from "./run-case-drawer.tsx";
import { hasTrace, scenarioName } from "./run-evidence-model.ts";
import {
  evaluationState,
  executionState,
  resultBucket,
  type DashboardCase,
  type ResultBucket
} from "./run-dashboard-model.ts";

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
                {row.review?.history.length ? (
                  <small className="run-human-mark" title="自动结果保留在详情中">
                    {row.review.history.at(-1)?.kind === "CAPTURE" ? "待复核" : "人工复核"}
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
                      ? "查看 / 检查卡片"
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
