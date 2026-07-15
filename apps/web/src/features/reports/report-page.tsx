import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Download, Filter, FlaskConical, RefreshCw } from "lucide-react";
import { useState, type ChangeEvent, type ReactElement } from "react";

import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import { Progress } from "../../components/ui/progress.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from "../../components/ui/sheet.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "../../components/ui/table.tsx";
import type {
  RunApi,
  RunReportCase,
  RunReportCasePageInput,
  RunReportOverview
} from "../../lib/run-api.ts";
import { message } from "../../messages/messages.ts";

/** Report page properties. */
export interface ReportPageProps {
  /** Boundary-validating Run API. */
  readonly api: RunApi;
  /** Route-owned platform or imported Run identity. */
  readonly runId: string;
  /** Explicit History navigation callback. */
  readonly onNavigate: (path: string) => void;
}

/** Editable comma-separated filter fields. */
interface ReportFilterDraft {
  /** REST status text. */
  readonly restStatus: string;
  /** Evaluation status text. */
  readonly evalStatus: string;
  /** Metric text. */
  readonly metrics: string;
  /** Business module text. */
  readonly businessModules: string;
  /** Scenario tag text. */
  readonly scenarioTags: string;
}

const EMPTY_FILTERS: ReportFilterDraft = {
  restStatus: "",
  evalStatus: "",
  metrics: "",
  businessModules: "",
  scenarioTags: ""
};

// Parse comma-separated exact values while discarding empty duplicates.
function commaValues(value: string): readonly string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    )
  ];
}

// Clean REST status input to the closed server query contract.
function restStatuses(value: string): readonly ("SUCCEEDED" | "ERROR")[] {
  return commaValues(value).filter(
    (item): item is "SUCCEEDED" | "ERROR" => item === "SUCCEEDED" || item === "ERROR"
  );
}

// Clean Evaluation status input to the closed server query contract.
function evalStatuses(
  value: string
): readonly ("PASS" | "FAIL" | "EVALUATION_ERROR" | "NOT_EVALUATED")[] {
  return commaValues(value).filter(
    (item): item is "PASS" | "FAIL" | "EVALUATION_ERROR" | "NOT_EVALUATED" =>
      item === "PASS" || item === "FAIL" || item === "EVALUATION_ERROR" || item === "NOT_EVALUATED"
  );
}

// Build one server query from a cleaned filter snapshot.
function reportCaseInput(
  runId: string,
  draft: ReportFilterDraft,
  cursor: string | null
): RunReportCasePageInput {
  return {
    runId,
    limit: 50,
    cursor,
    restStatus: restStatuses(draft.restStatus),
    evalStatus: evalStatuses(draft.evalStatus),
    metrics: commaValues(draft.metrics),
    businessModules: commaValues(draft.businessModules),
    scenarioTags: commaValues(draft.scenarioTags)
  };
}

// Render an exact stored Rate without manufacturing a zero for null denominators.
function rate(value: number | null): string {
  return value === null ? message("reports.rateUnavailable") : `${(value * 100).toFixed(1)}%`;
}

// Resolve one closed source label at the presentation boundary.
function sourceLabel(sourceType: RunReportOverview["sourceType"]): string {
  return sourceType === "PLATFORM" ? message("runs.platform") : message("runs.offlineImport");
}

// Resolve one closed artifact availability label.
function availabilityLabel(status: "PRESENT" | "MISSING" | "CORRUPTED"): string {
  if (status === "PRESENT") return message("reports.evidencePresent");
  if (status === "MISSING") return message("reports.evidenceMissing");
  return message("reports.evidenceCorrupted");
}

// Resolve one Case Raw Evidence label including intentional absence.
function rawEvidenceLabel(status: RunReportCase["rawEvidenceStatus"]): string {
  if (status === "ABSENT") return message("reports.evidenceAbsent");
  return availabilityLabel(status);
}

// Render one scalar summary card from an authoritative DTO value.
function SummaryCard({
  label,
  value
}: {
  readonly label: string;
  readonly value: string;
}): ReactElement {
  return (
    <article className="count-card report-summary-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

// Render a JSON contract value in a bounded readable preformatted block.
function JsonValue({ value }: { readonly value: unknown }): ReactElement {
  return <pre className="report-json-value">{JSON.stringify(value, null, 2)}</pre>;
}

// Render normalized Assertion and Diff facts without consulting Raw Evidence.
function ReportCaseDetail({ value }: { readonly value: RunReportCase }): ReactElement {
  return (
    <div className="form-stack">
      <div className="run-header-badges">
        <Badge variant="outline">{value.rest.status}</Badge>
        <Badge variant="accent">{value.evaluation.status}</Badge>
        <Badge variant="outline">{rawEvidenceLabel(value.rawEvidenceStatus)}</Badge>
      </div>
      <section aria-labelledby="report-assertions-heading">
        <h3 id="report-assertions-heading">{message("reports.assertions")}</h3>
        {value.evaluation.assertions.length === 0 ? (
          <p className="empty-state">{message("reports.noAssertions")}</p>
        ) : (
          <div className="report-detail-list">
            {value.evaluation.assertions.map((assertion) => (
              <article key={assertion.index} className="reference-panel">
                <div className="count-card-topline">
                  <strong>{assertion.type}</strong>
                  <Badge variant="accent">{assertion.status}</Badge>
                </div>
                <p>{assertion.metric}</p>
                <p>{assertion.reason ?? message("reports.reasonUnavailable")}</p>
              </article>
            ))}
          </div>
        )}
      </section>
      <section aria-labelledby="report-diffs-heading">
        <h3 id="report-diffs-heading">{message("reports.diffs")}</h3>
        {value.evaluation.diffs.length === 0 ? (
          <p className="empty-state">{message("reports.noDiffs")}</p>
        ) : (
          <div className="report-detail-list">
            {value.evaluation.diffs.map((diff, index) => (
              <article
                key={`${diff.assertionIndex}-${diff.schemaPath}-${index}`}
                className="reference-panel"
              >
                <strong>{diff.schemaPath}</strong>
                <p>{diff.instancePath || message("reports.rootPath")}</p>
                <p>{diff.keyword}</p>
                <p>{diff.reason}</p>
                <Label>{message("reports.expectedConstraint")}</Label>
                <JsonValue value={diff.expectedConstraint} />
                <Label>{message("reports.actualValue")}</Label>
                <JsonValue value={diff.actual} />
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/** Read-only complete Report page backed only by normalized DTOs. */
export function ReportPage({ api, runId, onNavigate }: ReportPageProps): ReactElement {
  const [draft, setDraft] = useState<ReportFilterDraft>(EMPTY_FILTERS);
  const [filters, setFilters] = useState<ReportFilterDraft>(EMPTY_FILTERS);
  const [cursor, setCursor] = useState<string | null>(null);
  const [history, setHistory] = useState<readonly (string | null)[]>([]);
  const [selectedCaseKey, setSelectedCaseKey] = useState<string | null>(null);
  const overview = useQuery({
    queryKey: ["runs", "report", runId] as const,
    queryFn: ({ signal }) => api.getReport(runId, signal)
  });
  const input = reportCaseInput(runId, filters, cursor);
  const cases = useQuery({
    queryKey: ["runs", "report", runId, "cases", input] as const,
    queryFn: ({ signal }) => api.listReportCases(input, signal)
  });
  const selectedCase = useQuery({
    queryKey: ["runs", "report", runId, "case", selectedCaseKey] as const,
    queryFn: ({ signal }) => {
      if (selectedCaseKey === null) throw new Error("REPORT_CASE_NOT_SELECTED");
      return api.getReportCase(runId, selectedCaseKey, signal);
    },
    enabled: selectedCaseKey !== null
  });

  if (overview.isPending) return <Progress aria-label={message("reports.loading")} />;
  if (overview.isError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>{message("reports.loadError")}</AlertTitle>
        <AlertDescription>{message("reports.loadErrorDescription")}</AlertDescription>
        <Button type="button" variant="outline" onClick={() => void overview.refetch()}>
          <RefreshCw aria-hidden="true" />
          {message("dashboard.retry")}
        </Button>
      </Alert>
    );
  }

  const report = overview.data;
  const change =
    (field: keyof ReportFilterDraft) =>
    (event: ChangeEvent<HTMLInputElement>): void =>
      setDraft((current) => ({ ...current, [field]: event.target.value }));
  const applyFilters = (): void => {
    setFilters(draft);
    setCursor(null);
    setHistory([]);
  };

  return (
    <section className="page-stack">
      <header className="page-header detail-header">
        <Button type="button" variant="outline" onClick={() => onNavigate("/runs")}>
          <ArrowLeft aria-hidden="true" />
          {message("runs.back")}
        </Button>
        <div>
          <p className="eyebrow">{message("reports.eyebrow")}</p>
          <h1>{message("reports.title")}</h1>
          <p className="run-detail-id">{runId}</p>
        </div>
        <div className="run-header-badges">
          <Badge variant="outline">{sourceLabel(report.sourceType)}</Badge>
          <Button
            type="button"
            variant="outline"
            onClick={() => onNavigate(`/runs/${encodeURIComponent(runId)}/analysis`)}
          >
            <FlaskConical aria-hidden="true" />
            {message("reports.analyzeFailedCases")}
          </Button>
          <Button asChild type="button" variant="outline">
            <a href={`/api/v1/runs/${encodeURIComponent(runId)}/report/export`}>
              <Download aria-hidden="true" />
              {message("reports.exportJson")}
            </a>
          </Button>
        </div>
      </header>

      <section aria-labelledby="report-summary-heading">
        <div className="section-heading compact">
          <h2 id="report-summary-heading">{message("reports.summary")}</h2>
        </div>
        <div className="resource-count-grid report-summary-grid">
          <SummaryCard
            label={message("reports.effectivePassRate")}
            value={rate(report.summary.effectivePassRate)}
          />
          <SummaryCard
            label={message("reports.evaluatedPassRate")}
            value={rate(report.summary.evaluatedPassRate)}
          />
          <SummaryCard
            label={message("reports.coverageRate")}
            value={rate(report.summary.coverageRate)}
          />
          <SummaryCard
            label={message("reports.evalError")}
            value={String(report.summary.evalError)}
          />
          <SummaryCard
            label={message("reports.notEvaluated")}
            value={String(report.summary.notEvaluated)}
          />
        </div>
      </section>

      <section className="data-panel" aria-labelledby="report-metrics-heading">
        <div className="section-heading compact">
          <h2 id="report-metrics-heading">{message("reports.byMetric")}</h2>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{message("reports.metric")}</TableHead>
              <TableHead>{message("reports.passRate")}</TableHead>
              <TableHead>PASS</TableHead>
              <TableHead>FAIL</TableHead>
              <TableHead>ERROR</TableHead>
              <TableHead>SKIPPED</TableHead>
              <TableHead>NOT_EVALUATED</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.byMetric.map((metric) => (
              <TableRow key={metric.metric}>
                <TableCell>{metric.metric}</TableCell>
                <TableCell>{rate(metric.passRate)}</TableCell>
                <TableCell>{metric.pass}</TableCell>
                <TableCell>{metric.fail}</TableCell>
                <TableCell>{metric.error}</TableCell>
                <TableCell>{metric.skipped}</TableCell>
                <TableCell>{metric.notEvaluated}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>

      <section className="reference-panel" aria-labelledby="report-context-heading">
        <h2 id="report-context-heading">{message("reports.context")}</h2>
        <p>{report.context.suite.name ?? message("reports.nameUnavailable")}</p>
        <p>{report.context.endpoint.name ?? message("reports.nameUnavailable")}</p>
        <p>{report.context.endpoint.config.urlTemplate}</p>
        <p>{report.context.evaluator.name ?? message("reports.nameUnavailable")}</p>
        <p>{report.context.evaluator.config.model}</p>
      </section>

      <section className="reference-panel" aria-labelledby="report-evidence-heading">
        <h2 id="report-evidence-heading">{message("reports.evidence")}</h2>
        {report.artifactAvailability.map((artifact) => (
          <div className="count-card-topline" key={`${artifact.kind}-${artifact.path}`}>
            <span>{artifact.kind}</span>
            <Badge variant="outline">{availabilityLabel(artifact.status)}</Badge>
          </div>
        ))}
      </section>

      <section className="data-panel" aria-labelledby="report-cases-heading">
        <div className="section-heading compact">
          <h2 id="report-cases-heading">{message("reports.cases")}</h2>
        </div>
        <div className="report-filter-grid">
          <Label>
            {message("reports.restStatus")}
            <Input value={draft.restStatus} onChange={change("restStatus")} />
          </Label>
          <Label>
            {message("reports.evalStatus")}
            <Input value={draft.evalStatus} onChange={change("evalStatus")} />
          </Label>
          <Label>
            {message("reports.metric")}
            <Input value={draft.metrics} onChange={change("metrics")} />
          </Label>
          <Label>
            {message("reports.businessModule")}
            <Input value={draft.businessModules} onChange={change("businessModules")} />
          </Label>
          <Label>
            {message("reports.scenarioTag")}
            <Input value={draft.scenarioTags} onChange={change("scenarioTags")} />
          </Label>
          <Button type="button" onClick={applyFilters}>
            <Filter aria-hidden="true" />
            {message("reports.applyFilters")}
          </Button>
        </div>
        {cases.isPending ? <Progress aria-label={message("reports.casesLoading")} /> : null}
        {cases.isError ? (
          <Alert variant="destructive">
            <AlertTitle>{message("reports.casesError")}</AlertTitle>
          </Alert>
        ) : null}
        {cases.data === undefined ? null : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{message("reports.caseKey")}</TableHead>
                  <TableHead>{message("reports.businessModule")}</TableHead>
                  <TableHead>{message("reports.scenarioTag")}</TableHead>
                  <TableHead>{message("reports.restStatus")}</TableHead>
                  <TableHead>{message("reports.evalStatus")}</TableHead>
                  <TableHead>{message("reports.evidence")}</TableHead>
                  <TableHead>{message("common.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cases.data.items.map((item) => (
                  <TableRow key={item.caseKey}>
                    <TableCell>{item.caseKey}</TableCell>
                    <TableCell>{item.definition.metadata.business_module}</TableCell>
                    <TableCell>{item.definition.metadata.scenario_tag}</TableCell>
                    <TableCell>{item.rest.status}</TableCell>
                    <TableCell>{item.evaluation.status}</TableCell>
                    <TableCell>{rawEvidenceLabel(item.rawEvidenceStatus)}</TableCell>
                    <TableCell>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setSelectedCaseKey(item.caseKey)}
                      >
                        {message("reports.viewCase")} {item.caseKey}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="pagination-actions">
              <Button
                type="button"
                variant="outline"
                disabled={history.length === 0}
                onClick={() => {
                  const previous = history.at(-1);
                  if (previous === undefined) return;
                  setHistory((current) => current.slice(0, -1));
                  setCursor(previous);
                }}
              >
                {message("common.previous")}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={cases.data.nextCursor === null}
                onClick={() => {
                  if (cases.data.nextCursor === null) return;
                  setHistory((current) => [...current, cursor]);
                  setCursor(cases.data.nextCursor);
                }}
              >
                {message("common.next")}
              </Button>
            </div>
          </>
        )}
      </section>

      <Sheet
        open={selectedCaseKey !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedCaseKey(null);
        }}
      >
        <SheetContent className="resource-sheet-content">
          <SheetHeader>
            <SheetTitle>
              {message("reports.caseTitle")} {selectedCaseKey ?? ""}
            </SheetTitle>
            <SheetDescription>{message("reports.caseDescription")}</SheetDescription>
          </SheetHeader>
          {selectedCase.isPending ? <Progress aria-label={message("reports.caseLoading")} /> : null}
          {selectedCase.isError ? (
            <Alert variant="destructive">
              <AlertTitle>{message("reports.caseError")}</AlertTitle>
            </Alert>
          ) : null}
          {selectedCase.data === undefined ? null : <ReportCaseDetail value={selectedCase.data} />}
        </SheetContent>
      </Sheet>
    </section>
  );
}
