import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Play, RefreshCw, Square } from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";

import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import { Button } from "../../components/ui/button.tsx";
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
import type { RunApi } from "../../lib/run-api.ts";
import { formatMessage, message } from "../../messages/messages.ts";
import { displayRunDate, runStageLabel, runStatusLabel } from "./run-ui.ts";

/** Run detail page properties. */
export interface RunDetailPageProps {
  /** Boundary-validating Run API. */
  readonly api: RunApi;
  /** Route-owned platform Run identity. */
  readonly runId: string;
  /** Explicit History navigation callback. */
  readonly onNavigate: (path: string) => void;
}

// Refresh all consumers of a changed durable Run fact.
async function invalidateRunFacts(
  queryClient: ReturnType<typeof useQueryClient>,
  runId: string
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["runs", "detail", runId] }),
    queryClient.invalidateQueries({ queryKey: ["runs", "cases", runId] }),
    queryClient.invalidateQueries({ queryKey: ["runs", "list"] }),
    queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
    queryClient.invalidateQueries({ queryKey: ["test-suites", "list"] })
  ]);
}

/** Refresh-restorable platform Run detail and real REST Case results. */
export function RunDetailPage({ api, runId, onNavigate }: RunDetailPageProps): ReactElement {
  const [caseCursor, setCaseCursor] = useState<string | null>(null);
  const [caseHistory, setCaseHistory] = useState<readonly (string | null)[]>([]);
  const [selectedCaseKey, setSelectedCaseKey] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: ["runs", "detail", runId] as const,
    queryFn: ({ signal }) => api.getRun(runId, signal),
    refetchInterval: (query) => (query.state.data?.status === "RUNNING" ? 1_000 : false)
  });
  const cases = useQuery({
    queryKey: ["runs", "cases", runId, { cursor: caseCursor, limit: 20 }] as const,
    queryFn: ({ signal }) => api.listCases({ runId, limit: 20, cursor: caseCursor }, signal),
    refetchInterval: detail.data?.status === "RUNNING" ? 1_000 : false
  });
  const selectedCase = useQuery({
    queryKey: ["runs", "case", runId, selectedCaseKey] as const,
    queryFn: ({ signal }) => {
      if (selectedCaseKey === null) throw new Error("RUN_CASE_NOT_SELECTED");
      return api.getCase(runId, selectedCaseKey, signal);
    },
    enabled: selectedCaseKey !== null
  });
  const start = useMutation({
    mutationFn: (expectedRevision: number) =>
      api.start(runId, expectedRevision, new AbortController().signal),
    onSuccess: async () => invalidateRunFacts(queryClient, runId)
  });
  const cancel = useMutation({
    mutationFn: (expectedRevision: number) =>
      api.cancel(runId, expectedRevision, new AbortController().signal),
    onSuccess: async () => invalidateRunFacts(queryClient, runId)
  });

  useEffect(() => {
    if (detail.data?.status !== "RUNNING") return undefined;
    const refresh = (): void => {
      void invalidateRunFacts(queryClient, runId);
    };
    const subscription = api.subscribe(runId, refresh, refresh);
    return (): void => subscription.close();
  }, [api, detail.data?.status, queryClient, runId]);

  if (detail.isPending) {
    return <Progress aria-label={message("runs.detailLoading")} />;
  }
  if (detail.isError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>{message("runs.detailError")}</AlertTitle>
        <Button type="button" variant="outline" onClick={() => void detail.refetch()}>
          <RefreshCw aria-hidden="true" />
          {message("dashboard.retry")}
        </Button>
      </Alert>
    );
  }

  const run = detail.data;
  const progressPercent = run.rest.total === 0 ? 0 : (run.rest.completed / run.rest.total) * 100;
  const canStartRest = run.status === "READY" && run.stage === "REST";
  const canCancel = run.status === "RUNNING" && run.cancelRequestedAt === null;

  return (
    <section className="page-stack">
      <header className="page-header detail-header">
        <Button type="button" variant="outline" onClick={() => onNavigate("/runs")}>
          <ArrowLeft aria-hidden="true" />
          {message("runs.back")}
        </Button>
        <div>
          <p className="eyebrow">{message("runs.detailEyebrow")}</p>
          <h1>{run.suite.name}</h1>
          <p className="run-detail-id">{run.id}</p>
        </div>
        <div className="run-header-badges">
          <Badge variant="outline">{message("runs.platform")}</Badge>
          <Badge variant="accent">{runStatusLabel(run.status)}</Badge>
        </div>
      </header>

      <section className="run-stage-panel" aria-labelledby="run-rest-heading">
        <div className="section-heading compact">
          <div>
            <p className="eyebrow">{message("runs.currentStage")}</p>
            <h2 id="run-rest-heading">{runStageLabel(run.stage)}</h2>
          </div>
          <div className="editor-actions">
            {canStartRest ? (
              <Button
                type="button"
                disabled={start.isPending}
                onClick={() => start.mutate(run.lockRevision)}
              >
                <Play aria-hidden="true" />
                {start.isPending ? message("runs.starting") : message("runs.startRest")}
              </Button>
            ) : null}
            {canCancel ? (
              <Button
                type="button"
                variant="destructive"
                disabled={cancel.isPending}
                onClick={() => cancel.mutate(run.lockRevision)}
              >
                <Square aria-hidden="true" />
                {cancel.isPending ? message("runs.cancelling") : message("runs.cancel")}
              </Button>
            ) : null}
          </div>
        </div>
        <Progress value={progressPercent} aria-label={message("runs.progress")} />
        <div className="run-counter-grid">
          <article>
            <strong>{run.rest.total}</strong>
            <span>{message("runs.total")}</span>
          </article>
          <article>
            <strong>
              {formatMessage("runs.progressCount", {
                completed: run.rest.completed,
                total: run.rest.total
              })}
            </strong>
            <span>{message("runs.completed")}</span>
          </article>
          <article>
            <strong>{run.rest.succeeded}</strong>
            <span>{message("runs.succeeded")}</span>
          </article>
          <article>
            <strong>{run.rest.error}</strong>
            <span>{message("runs.errors")}</span>
          </article>
        </div>
      </section>

      {run.cancelRequestedAt !== null && run.status === "RUNNING" ? (
        <Alert>
          <AlertTitle>{message("runs.cancelRequestedTitle")}</AlertTitle>
          <AlertDescription>{message("runs.cancelRequestedDescription")}</AlertDescription>
        </Alert>
      ) : null}
      {run.status === "READY" && run.stage !== "REST" ? (
        <Alert>
          <AlertTitle>{message("runs.stageNotRegisteredTitle")}</AlertTitle>
          <AlertDescription>{message("runs.stageNotRegisteredDescription")}</AlertDescription>
        </Alert>
      ) : null}
      {run.errorCode !== null ? (
        <Alert variant="destructive">
          <AlertTitle>{message("runs.systemError")}</AlertTitle>
          <AlertDescription>{run.errorCode}</AlertDescription>
        </Alert>
      ) : null}
      {start.isError || cancel.isError ? (
        <Alert variant="destructive">
          <AlertTitle>{message("runs.mutationError")}</AlertTitle>
        </Alert>
      ) : null}

      <section className="data-panel" aria-labelledby="run-cases-heading">
        <div className="run-panel-heading">
          <div>
            <p className="eyebrow">{message("runs.realResults")}</p>
            <h2 id="run-cases-heading">{message("runs.caseResults")}</h2>
          </div>
        </div>
        {cases.isPending ? <Progress aria-label={message("runs.casesLoading")} /> : null}
        {cases.isError ? (
          <Alert variant="destructive">
            <AlertTitle>{message("runs.casesError")}</AlertTitle>
          </Alert>
        ) : null}
        {cases.data?.items.length === 0 ? (
          <p className="empty-state">{message("runs.noCaseResults")}</p>
        ) : null}
        {cases.data === undefined || cases.data.items.length === 0 ? null : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{message("caseList.caseId")}</TableHead>
                <TableHead>{message("runs.status")}</TableHead>
                <TableHead>{message("runs.httpStatus")}</TableHead>
                <TableHead>{message("runs.duration")}</TableHead>
                <TableHead>{message("common.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cases.data.items.map((item) => (
                <TableRow key={item.caseKey}>
                  <TableCell>{item.caseKey}</TableCell>
                  <TableCell>
                    <Badge variant={item.status === "SUCCEEDED" ? "default" : "accent"}>
                      {item.status === "SUCCEEDED"
                        ? message("runs.caseSucceeded")
                        : message("runs.caseError")}
                    </Badge>
                  </TableCell>
                  <TableCell>{item.httpStatus ?? message("runs.none")}</TableCell>
                  <TableCell>
                    {formatMessage("runs.durationValue", { duration: item.durationMs })}
                  </TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setSelectedCaseKey(item.caseKey)}
                    >
                      {formatMessage("runs.viewCase", { caseKey: item.caseKey })}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {cases.data === undefined ? null : (
          <div className="pagination-controls run-pagination">
            <Button
              type="button"
              variant="outline"
              disabled={caseHistory.length === 0}
              onClick={() => {
                setCaseCursor(caseHistory.at(-1) ?? null);
                setCaseHistory(caseHistory.slice(0, -1));
              }}
            >
              {message("common.previous")}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={cases.data.nextCursor === null}
              onClick={() => {
                setCaseHistory([...caseHistory, caseCursor]);
                setCaseCursor(cases.data.nextCursor);
              }}
            >
              {message("common.next")}
            </Button>
          </div>
        )}
      </section>

      <section className="run-frozen-grid" aria-label={message("runs.frozenInputs")}>
        <article>
          <span>{message("runs.endpoint")}</span>
          <strong>{run.endpoint.name}</strong>
          <small>{run.endpoint.config.urlTemplate}</small>
        </article>
        <article>
          <span>{message("runs.evaluator")}</span>
          <strong>{run.evaluator.name}</strong>
          <small>{run.evaluator.config.model}</small>
        </article>
        <article>
          <span>{message("runs.executionLimits")}</span>
          <strong>
            {formatMessage("runs.limitValue", {
              rest: run.runExecutionLimits.restConcurrency,
              eval: run.runExecutionLimits.evalConcurrency
            })}
          </strong>
          <small>{message("runs.frozen")}</small>
        </article>
        <article>
          <span>{message("runs.timestamps")}</span>
          <strong>{displayRunDate(run.updatedAt)}</strong>
          <small>{formatMessage("runs.revisionValue", { revision: run.lockRevision })}</small>
        </article>
      </section>

      <Sheet
        open={selectedCaseKey !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedCaseKey(null);
        }}
      >
        <SheetContent>
          <SheetHeader>
            <SheetTitle>
              {selectedCaseKey === null
                ? message("runs.caseResult")
                : formatMessage("runs.caseResultTitle", { caseKey: selectedCaseKey })}
            </SheetTitle>
            <SheetDescription>{message("runs.caseResultDescription")}</SheetDescription>
          </SheetHeader>
          {selectedCase.isPending ? <Progress aria-label={message("runs.caseLoading")} /> : null}
          {selectedCase.isError ? (
            <Alert variant="destructive">
              <AlertTitle>{message("runs.caseLoadError")}</AlertTitle>
            </Alert>
          ) : null}
          {selectedCase.data === undefined ? null : (
            <div className="run-case-detail">
              <div className="tag-list">
                <Badge>
                  {selectedCase.data.status === "SUCCEEDED"
                    ? message("runs.caseSucceeded")
                    : message("runs.caseError")}
                </Badge>
                <Badge variant="outline">
                  HTTP {selectedCase.data.httpStatus ?? message("runs.none")}
                </Badge>
              </div>
              <div>
                <strong>{message("runs.caseDefinition")}</strong>
                <pre>{JSON.stringify(selectedCase.data.definition, null, 2)}</pre>
              </div>
              <div>
                <strong>
                  {selectedCase.data.status === "SUCCEEDED"
                    ? message("runs.providerOutput")
                    : message("runs.restError")}
                </strong>
                <pre>
                  {JSON.stringify(
                    selectedCase.data.status === "SUCCEEDED"
                      ? selectedCase.data.providerOutput
                      : selectedCase.data.error,
                    null,
                    2
                  )}
                </pre>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </section>
  );
}
