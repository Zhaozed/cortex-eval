import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Plus, RefreshCw, Trash2 } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type MouseEvent,
  type ReactElement
} from "react";

import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Progress } from "../../components/ui/progress.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
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
import type { ResourceApi } from "../../lib/resource-api.ts";
import type {
  CreatePlatformRunInput,
  RunApi,
  RunPreflight,
  RunSelection
} from "../../lib/run-api.ts";
import { usePageLeaveBlocker } from "../../lib/use-page-leave-blocker.ts";
import { formatMessage, message } from "../../messages/messages.ts";
import { displayRunDate, runStageLabel, runStatusLabel } from "./run-ui.ts";

type SuiteSummary = Awaited<ReturnType<ResourceApi["listTestSuites"]>>["items"][number];
type ConfigurationSummary = Awaited<ReturnType<ResourceApi["listConfigurations"]>>["items"][number];

interface RunCreationOptions {
  /** Current Suites. */
  readonly suites: readonly SuiteSummary[];
  /** Current Endpoint configurations. */
  readonly endpoints: readonly ConfigurationSummary[];
  /** Current Evaluator-capable LLM configurations. */
  readonly evaluators: readonly ConfigurationSummary[];
}

interface PreflightFact {
  /** Exact selection used by this preflight. */
  readonly selectionKey: string;
  /** Exact request generation that produced this fact. */
  readonly generation: number;
  /** Validated server preflight facts. */
  readonly value: RunPreflight;
}

interface PreflightRequest {
  /** Selection to validate. */
  readonly selection: RunSelection;
  /** Monotonic request generation owned by this component. */
  readonly generation: number;
}

/** Run list page properties. */
export interface RunListPageProps {
  /** Boundary-validating Run API. */
  readonly api: RunApi;
  /** Boundary-validating current-resource API. */
  readonly resourceApi: ResourceApi;
  /** Explicit History navigation callback. */
  readonly onNavigate: (path: string) => void;
  /** Navigation callback that releases the completed write guard before leaving. */
  readonly onCommittedNavigate: (path: string) => void;
  /** Report a create request that must not be abandoned. */
  readonly onLeaveBlockedChange?: ((blocked: boolean) => void) | undefined;
}

// Read every current page without silently accepting a cursor cycle.
async function loadAllPages<Item>(
  load: (
    cursor: string | null
  ) => Promise<{ readonly items: readonly Item[]; readonly nextCursor: string | null }>
): Promise<readonly Item[]> {
  const items: Item[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await load(cursor);
    items.push(...page.items);
    cursor = page.nextCursor;
    if (cursor !== null) {
      if (cursors.has(cursor)) throw new Error("CLIENT_CURSOR_LOOP");
      cursors.add(cursor);
    }
  } while (cursor !== null);
  return items;
}

// Load all resource choices needed to freeze one new Run.
async function loadCreationOptions(
  api: ResourceApi,
  signal: AbortSignal
): Promise<RunCreationOptions> {
  const [suites, endpoints, evaluators] = await Promise.all([
    loadAllPages((cursor) => api.listTestSuites({ limit: 200, cursor }, signal)),
    loadAllPages((cursor) => api.listConfigurations("ENDPOINT", { limit: 200, cursor }, signal)),
    loadAllPages((cursor) => api.listConfigurations("LLM", { limit: 200, cursor }, signal))
  ]);
  return { suites, endpoints, evaluators };
}

// Produce one stable local key for invalidating an obsolete preflight.
function selectionKey(selection: RunSelection): string {
  return [selection.suiteId, selection.endpointConfigId, selection.evaluatorConfigId].join("\n");
}

// Route a complete imported Run directly to its normalized Report page.
function runPath(run: {
  readonly id: string;
  readonly sourceType: "PLATFORM" | "OFFLINE_IMPORT";
}): string {
  const encodedId = encodeURIComponent(run.id);
  return run.sourceType === "OFFLINE_IMPORT" ? `/runs/${encodedId}/report` : `/runs/${encodedId}`;
}

// Resolve one closed Run source label at the presentation boundary.
function runSourceLabel(sourceType: "PLATFORM" | "OFFLINE_IMPORT"): string {
  return sourceType === "PLATFORM" ? message("runs.platform") : message("runs.offlineImport");
}

/** Cursor-paged recent platform Runs with preflight-gated creation. */
export function RunListPage({
  api,
  resourceApi,
  onNavigate,
  onCommittedNavigate,
  onLeaveBlockedChange
}: RunListPageProps): ReactElement {
  const [cursor, setCursor] = useState<string | null>(null);
  const [history, setHistory] = useState<readonly (string | null)[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [suiteId, setSuiteId] = useState("");
  const [endpointConfigId, setEndpointConfigId] = useState("");
  const [evaluatorConfigId, setEvaluatorConfigId] = useState("");
  const [runMode, setRunMode] = useState<"STAGED" | "PIPELINE">("STAGED");
  const [restConcurrency, setRestConcurrency] = useState(4);
  const [evalConcurrency, setEvalConcurrency] = useState(2);
  const [preflightFact, setPreflightFact] = useState<PreflightFact | null>(null);
  const createPending = useRef(false);
  const preflightController = useRef<AbortController | null>(null);
  const preflightGeneration = useRef(0);
  const selectionKeyReference = useRef<string | null>(null);
  const queryClient = useQueryClient();
  const page = useQuery({
    queryKey: ["runs", "list", { cursor, limit: 50 }] as const,
    queryFn: ({ signal }) => api.listRuns({ limit: 50, cursor }, signal),
    // Live-refresh while any listed Run is executing so the operator sees progress.
    refetchInterval: (current) =>
      current.state.data?.items.some((run) => run.status === "RUNNING") === true ? 1_000 : false
  });
  const options = useQuery({
    queryKey: ["runs", "creation-options"] as const,
    queryFn: ({ signal }) => loadCreationOptions(resourceApi, signal)
  });
  const selection = useMemo<RunSelection | null>(() => {
    if (suiteId === "" || endpointConfigId === "" || evaluatorConfigId === "") return null;
    return { suiteId, endpointConfigId, evaluatorConfigId };
  }, [endpointConfigId, evaluatorConfigId, suiteId]);
  const currentSelectionKey = selection === null ? null : selectionKey(selection);
  selectionKeyReference.current = currentSelectionKey;
  const preflight = useMutation({
    mutationFn: (request: PreflightRequest) => {
      preflightController.current?.abort();
      const controller = new AbortController();
      preflightController.current = controller;
      return api.preflight(request.selection, controller.signal);
    },
    onSuccess: (value, request) => {
      if (request.generation !== preflightGeneration.current) return;
      const selectedKey = selectionKey(request.selection);
      if (selectedKey !== selectionKeyReference.current) return;
      setPreflightFact({ selectionKey: selectedKey, generation: request.generation, value });
      setRestConcurrency(value.defaultRunExecutionLimits.restConcurrency);
      setEvalConcurrency(value.defaultRunExecutionLimits.evalConcurrency);
    }
  });
  const create = useMutation({
    mutationFn: (input: CreatePlatformRunInput) => api.create(input, new AbortController().signal),
    onSuccess: async (run) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["runs"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
        queryClient.invalidateQueries({ queryKey: ["test-suites", "list"] })
      ]);
      setCreateOpen(false);
      onCommittedNavigate(`/runs/${encodeURIComponent(run.id)}`);
    }
  });
  const remove = useMutation({
    mutationFn: (runId: string) => api.deleteRun(runId, new AbortController().signal),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["runs"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] })
      ]);
    }
  });
  usePageLeaveBlocker(create.isPending, onLeaveBlockedChange);
  useEffect(
    () => (): void => {
      preflightGeneration.current += 1;
      preflightController.current?.abort();
    },
    []
  );

  const clearPreflight = (): void => {
    preflightGeneration.current += 1;
    preflightController.current?.abort();
    preflightController.current = null;
    setPreflightFact(null);
    preflight.reset();
    create.reset();
  };
  const changeSelection =
    (setValue: (value: string) => void) =>
    (event: ChangeEvent<HTMLSelectElement>): void => {
      setValue(event.target.value);
      clearPreflight();
    };
  // Invalidate prior facts before starting one new preflight generation.
  const startPreflight = (): void => {
    if (selection === null) return;
    preflightGeneration.current += 1;
    setPreflightFact(null);
    create.reset();
    preflight.mutate({ selection, generation: preflightGeneration.current });
  };
  const submitCreate = async (): Promise<void> => {
    if (
      createPending.current ||
      selection === null ||
      currentSelectionKey === null ||
      preflightFact?.selectionKey !== currentSelectionKey ||
      preflightFact.generation !== preflightGeneration.current ||
      preflight.isPending ||
      preflight.isError
    ) {
      return;
    }
    createPending.current = true;
    try {
      await create.mutateAsync({
        ...selection,
        runMode,
        runExecutionLimits: {
          contractVersion: "cortex.run-execution-limits.v1",
          restConcurrency,
          evalConcurrency
        }
      });
    } catch {
      // The mutation renders its stable boundary error without closing the creation Sheet.
    } finally {
      createPending.current = false;
    }
  };

  if (page.isPending) {
    return <Progress aria-label={message("runs.loading")} />;
  }
  if (page.isError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>{message("runs.loadError")}</AlertTitle>
        <Button type="button" variant="outline" onClick={() => void page.refetch()}>
          <RefreshCw aria-hidden="true" />
          {message("dashboard.retry")}
        </Button>
      </Alert>
    );
  }

  return (
    <section className="page-stack">
      <header className="page-header split-header">
        <div>
          <p className="eyebrow">{message("runs.eyebrow")}</p>
          <h1>{message("runs.title")}</h1>
          <p>{message("runs.description")}</p>
        </div>
        <Button type="button" onClick={() => setCreateOpen(true)}>
          <Plus aria-hidden="true" />
          {message("runs.create")}
        </Button>
      </header>
      <div className="data-panel">
        {page.data.items.length === 0 ? (
          <p className="empty-state">{message("runs.empty")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{message("runs.runId")}</TableHead>
                <TableHead>{message("runs.suite")}</TableHead>
                <TableHead>{message("runs.sourceType")}</TableHead>
                <TableHead>{message("runs.stage")}</TableHead>
                <TableHead>{message("runs.status")}</TableHead>
                <TableHead>{message("runs.progress")}</TableHead>
                <TableHead>{message("common.updatedAt")}</TableHead>
                <TableHead>{message("runs.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.data.items.map((run) => (
                <TableRow key={run.id}>
                  <TableCell>
                    <a
                      className="resource-link run-id-link"
                      href={runPath(run)}
                      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
                        event.preventDefault();
                        onNavigate(runPath(run));
                      }}
                    >
                      {run.id}
                    </a>
                  </TableCell>
                  <TableCell>{run.suiteName}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{runSourceLabel(run.sourceType)}</Badge>
                  </TableCell>
                  <TableCell>{runStageLabel(run.stage)}</TableCell>
                  <TableCell>
                    <Badge variant="accent">{runStatusLabel(run.status)}</Badge>
                  </TableCell>
                  <TableCell>
                    {formatMessage("runs.progressCount", {
                      completed: run.rest.completed,
                      total: run.rest.total
                    })}
                  </TableCell>
                  <TableCell>{displayRunDate(run.updatedAt)}</TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={run.status === "RUNNING" || remove.isPending}
                      title={
                        run.status === "RUNNING"
                          ? message("runs.deleteRunningBlocked")
                          : message("runs.delete")
                      }
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        if (!window.confirm(message("runs.deleteConfirm"))) return;
                        remove.mutate(run.id);
                      }}
                    >
                      <Trash2 aria-hidden="true" />
                      {remove.isPending && remove.variables === run.id
                        ? message("runs.deleting")
                        : message("runs.delete")}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
      <div className="pagination-controls">
        <Button
          type="button"
          variant="outline"
          disabled={history.length === 0}
          onClick={() => {
            setCursor(history.at(-1) ?? null);
            setHistory(history.slice(0, -1));
          }}
        >
          {message("common.previous")}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={page.data.nextCursor === null}
          onClick={() => {
            setHistory([...history, cursor]);
            setCursor(page.data.nextCursor);
          }}
        >
          {message("common.next")}
        </Button>
      </div>
      <Sheet
        open={createOpen}
        onOpenChange={(open) => {
          if (!open && create.isPending) return;
          setCreateOpen(open);
        }}
      >
        <SheetContent className="run-create-sheet">
          <SheetHeader>
            <SheetTitle>{message("runs.createTitle")}</SheetTitle>
            <SheetDescription>{message("runs.createDescription")}</SheetDescription>
          </SheetHeader>
          {options.isPending ? <Progress aria-label={message("runs.optionsLoading")} /> : null}
          {options.isError ? (
            <Alert variant="destructive">
              <AlertTitle>{message("runs.optionsError")}</AlertTitle>
            </Alert>
          ) : null}
          {options.data === undefined ? null : (
            <form
              className="form-stack"
              onSubmit={(event) => {
                event.preventDefault();
                void submitCreate();
              }}
            >
              <fieldset className="editor-fieldset" disabled={create.isPending}>
                <label className="run-field">
                  <span>{message("runs.suite")}</span>
                  <select
                    aria-label={message("runs.suite")}
                    value={suiteId}
                    onChange={changeSelection(setSuiteId)}
                  >
                    <option value="">{message("runs.selectPlaceholder")}</option>
                    {options.data.suites.map((suite) => (
                      <option key={suite.id} value={suite.id}>
                        {suite.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="run-field">
                  <span>{message("runs.endpoint")}</span>
                  <select
                    aria-label={message("runs.endpoint")}
                    value={endpointConfigId}
                    onChange={changeSelection(setEndpointConfigId)}
                  >
                    <option value="">{message("runs.selectPlaceholder")}</option>
                    {options.data.endpoints.map((endpoint) => (
                      <option key={endpoint.id} value={endpoint.id}>
                        {endpoint.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="run-field">
                  <span>{message("runs.evaluator")}</span>
                  <select
                    aria-label={message("runs.evaluator")}
                    value={evaluatorConfigId}
                    onChange={changeSelection(setEvaluatorConfigId)}
                  >
                    <option value="">{message("runs.selectPlaceholder")}</option>
                    {options.data.evaluators.map((evaluator) => (
                      <option key={evaluator.id} value={evaluator.id}>
                        {evaluator.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="run-field">
                  <span>{message("runs.mode")}</span>
                  <select
                    aria-label={message("runs.mode")}
                    value={runMode}
                    onChange={(event) =>
                      setRunMode(event.target.value === "PIPELINE" ? "PIPELINE" : "STAGED")
                    }
                  >
                    <option value="STAGED">{message("runs.modeStaged")}</option>
                    <option value="PIPELINE">{message("runs.modePipeline")}</option>
                  </select>
                </label>
                <Button
                  type="button"
                  variant="outline"
                  disabled={selection === null || preflight.isPending}
                  onClick={startPreflight}
                >
                  <Activity aria-hidden="true" />
                  {preflight.isPending ? message("runs.preflighting") : message("runs.preflight")}
                </Button>
              </fieldset>
              {preflight.isError ? (
                <Alert variant="destructive">
                  <AlertTitle>{message("runs.preflightError")}</AlertTitle>
                </Alert>
              ) : null}
              {preflightFact?.selectionKey === currentSelectionKey &&
              preflightFact.generation === preflightGeneration.current &&
              !preflight.isPending &&
              !preflight.isError ? (
                <section className="run-preflight" aria-label={message("runs.preflightFacts")}>
                  <div className="run-fact-grid">
                    <article>
                      <strong>
                        {formatMessage("runs.caseCountValue", {
                          count: preflightFact.value.caseCount
                        })}
                      </strong>
                      <span>{message("runs.caseCount")}</span>
                    </article>
                    <article>
                      <strong>{preflightFact.value.endpointTimeoutMs}</strong>
                      <span>{message("runs.timeoutMs")}</span>
                    </article>
                  </div>
                  <div>
                    <strong>{message("runs.rubricDependencies")}</strong>
                    <p>{preflightFact.value.rubricPromptKeys.join(", ") || message("runs.none")}</p>
                  </div>
                  <div>
                    <strong>{message("runs.restEnv")}</strong>
                    <p>
                      {preflightFact.value.requiredEnvKeys.REST.join(", ") || message("runs.none")}
                    </p>
                  </div>
                  <div>
                    <strong>{message("runs.evalEnv")}</strong>
                    <p>
                      {preflightFact.value.requiredEnvKeys.EVALUATION.join(", ") ||
                        message("runs.none")}
                    </p>
                  </div>
                  <div className="field-grid">
                    <label className="run-field">
                      <span>{message("runs.restConcurrency")}</span>
                      <Input
                        aria-label={message("runs.restConcurrency")}
                        type="number"
                        min={1}
                        max={64}
                        value={restConcurrency}
                        onChange={(event) => setRestConcurrency(Number(event.target.value))}
                      />
                    </label>
                    <label className="run-field">
                      <span>{message("runs.evalConcurrency")}</span>
                      <Input
                        aria-label={message("runs.evalConcurrency")}
                        type="number"
                        min={1}
                        max={16}
                        value={evalConcurrency}
                        onChange={(event) => setEvalConcurrency(Number(event.target.value))}
                      />
                    </label>
                  </div>
                </section>
              ) : null}
              {create.isError ? (
                <Alert variant="destructive">
                  <AlertTitle>{message("runs.createError")}</AlertTitle>
                  <AlertDescription>{message("common.operationFailed")}</AlertDescription>
                </Alert>
              ) : null}
              <SheetFooter>
                <Button
                  type="submit"
                  disabled={
                    preflightFact?.selectionKey !== currentSelectionKey ||
                    preflightFact.generation !== preflightGeneration.current ||
                    preflight.isPending ||
                    preflight.isError ||
                    restConcurrency < 1 ||
                    restConcurrency > 64 ||
                    evalConcurrency < 1 ||
                    evalConcurrency > 16 ||
                    create.isPending
                  }
                >
                  {create.isPending ? message("runs.creating") : message("runs.createSubmit")}
                </Button>
              </SheetFooter>
            </form>
          )}
        </SheetContent>
      </Sheet>
    </section>
  );
}
