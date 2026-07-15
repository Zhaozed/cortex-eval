import { AnalysisProposalV1Schema } from "@cortex-eval/contracts/src/analysis-contracts.ts";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  CheckCircle2,
  FlaskConical,
  RefreshCw,
  ShieldAlert,
  XCircle
} from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent, type ReactElement } from "react";

import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import { Progress } from "../../components/ui/progress.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "../../components/ui/select.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "../../components/ui/table.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { ApiClientError } from "../../lib/api-client.ts";
import type { CaseDetail, ResourceApi, TestSuiteDetail } from "../../lib/resource-api.ts";
import type {
  AcceptAnalysisInput,
  CurrentCaseAnalysis,
  RunApi,
  StartCaseAnalysisResult
} from "../../lib/run-api.ts";
import { formatMessage, message } from "../../messages/messages.ts";

/** Analysis workbench properties. */
export interface AnalysisPageProps {
  /** Strict Run and Analysis API boundary. */
  readonly api: RunApi;
  /** Current Configuration and Case resource boundary. */
  readonly resourceApi: ResourceApi;
  /** Immutable Run version selected by the route. */
  readonly runId: string;
  /** Explicit browser navigation callback. */
  readonly onNavigate: (path: string) => void;
}

// Read every Configuration choice without silently accepting a cursor cycle.
async function loadAllConfigurations(
  api: ResourceApi,
  kind: "LLM" | "CASE_ANALYSIS_PROMPT",
  signal: AbortSignal
): Promise<Awaited<ReturnType<ResourceApi["listConfigurations"]>>> {
  const items: Awaited<ReturnType<ResourceApi["listConfigurations"]>>["items"][number][] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await api.listConfigurations(kind, { limit: 100, cursor }, signal);
    items.push(...page.items);
    cursor = page.nextCursor;
    if (cursor !== null) {
      if (cursors.has(cursor)) throw new Error("CLIENT_CURSOR_LOOP");
      cursors.add(cursor);
    }
  } while (cursor !== null);
  return { items, nextCursor: null };
}

type Selector = "failed" | "errors" | "all";

// Map one Analysis selector to the exact Report Evaluation statuses it can consume.
function selectedStatuses(selector: Selector): readonly ("FAIL" | "EVALUATION_ERROR")[] {
  if (selector === "failed") return ["FAIL"];
  if (selector === "errors") return ["EVALUATION_ERROR"];
  return ["FAIL", "EVALUATION_ERROR"];
}

// Resolve a stable human label for one fixed Analysis classification.
function classificationLabel(
  classification: NonNullable<CurrentCaseAnalysis["output"]>["classification"]
): string {
  return message(`analysis.classification.${classification}`);
}

// Return whether a current query error means the Case simply has no Analysis yet.
function isAnalysisAbsent(error: Error | null): boolean {
  return error instanceof ApiClientError && error.code === "ANALYSIS_NOT_FOUND";
}

// Build the exact optimistic identities required to apply one Proposal.
function acceptanceInput(
  analysis: CurrentCaseAnalysis,
  suite: TestSuiteDetail,
  testCase: CaseDetail
): AcceptAnalysisInput {
  return {
    analysisId: analysis.id,
    expectedAnalysisRevision: analysis.revision,
    expectedFinalCaseResultHash: analysis.finalCaseResultHash,
    expectedAnalysisInputHash: analysis.analysisInputHash,
    expectedPromptHash: analysis.prompt.promptHash,
    expectedAnalyzerConfigHash: analysis.analyzer.configHash,
    suiteId: suite.id,
    expectedSuiteRevision: suite.revision,
    expectedCaseId: testCase.id,
    expectedCaseRevision: testCase.revision
  };
}

// Render one complete structured Evidence list without inferring facts from conclusions.
function EvidenceList({
  value
}: {
  readonly value: NonNullable<CurrentCaseAnalysis["output"]>["evidence"];
}): ReactElement {
  return (
    <div className="analysis-evidence-list">
      {value.map((evidence, index) => (
        <article
          className="analysis-evidence-card"
          key={`${evidence.source}-${evidence.fieldPath ?? "source"}-${index}`}
        >
          <div className="analysis-evidence-coordinate">
            <Badge variant="outline">{evidence.source}</Badge>
            <code>{evidence.fieldPath ?? message("analysis.wholeSource")}</code>
          </div>
          <p>{evidence.conclusion}</p>
        </article>
      ))}
    </div>
  );
}

// Render the current immutable Analysis version and optional Proposal decision controls.
function AnalysisResultPanel({
  analysis,
  suite,
  testCase,
  proposalText,
  preservedProposalText,
  proposalError,
  mutationError,
  proposalDraftPreserved,
  decisionPending,
  onProposalTextChange,
  onReject,
  onAccept,
  onEditAndAccept
}: {
  readonly analysis: CurrentCaseAnalysis;
  readonly suite: TestSuiteDetail | undefined;
  readonly testCase: CaseDetail | undefined;
  readonly proposalText: string;
  readonly preservedProposalText: string;
  readonly proposalError: string | null;
  readonly mutationError: string | null;
  readonly proposalDraftPreserved: boolean;
  readonly decisionPending: boolean;
  readonly onProposalTextChange: (value: string) => void;
  readonly onReject: () => void;
  readonly onAccept: () => void;
  readonly onEditAndAccept: () => void;
}): ReactElement {
  const output = analysis.output;
  const proposal = output?.proposal ?? null;
  const pendingProposal = proposal !== null && analysis.decision === "PENDING";
  const canApply = suite !== undefined && testCase !== undefined;
  return (
    <div className="analysis-result-stack">
      <section className="analysis-version-strip" aria-label={message("analysis.versionIdentity")}>
        <div>
          <span>{message("analysis.revision")}</span>
          <strong>r{analysis.revision}</strong>
        </div>
        <div>
          <span>{message("analysis.status")}</span>
          <Badge variant="accent">{analysis.status}</Badge>
        </div>
        <div>
          <span>{message("analysis.model")}</span>
          <strong>{analysis.analyzer.model}</strong>
        </div>
      </section>

      {analysis.status === "ERROR" ? (
        <Alert variant="destructive">
          <ShieldAlert aria-hidden="true" />
          <AlertTitle>{message("analysis.caseError")}</AlertTitle>
          <AlertDescription>{analysis.errorMessage ?? analysis.errorCode}</AlertDescription>
        </Alert>
      ) : null}

      {output === null ? (
        <p className="empty-state">{message("analysis.resultPending")}</p>
      ) : (
        <>
          <section className="analysis-verdict" aria-labelledby="analysis-verdict-heading">
            <div>
              <p className="eyebrow">{message("analysis.verdict")}</p>
              <h3 id="analysis-verdict-heading">{classificationLabel(output.classification)}</h3>
            </div>
            <strong className="analysis-confidence">
              {Math.round(output.confidence * 100)}% · {message("analysis.selfAssessed")}
            </strong>
          </section>
          <section aria-labelledby="analysis-evidence-heading">
            <h3 id="analysis-evidence-heading">{message("analysis.structuredEvidence")}</h3>
            <EvidenceList value={output.evidence} />
          </section>
          <div className="analysis-narrative-grid">
            <section>
              <h3>{message("analysis.explanation")}</h3>
              <p>{output.explanation}</p>
            </section>
            <section>
              <h3>{message("analysis.recommendedAction")}</h3>
              <p>{output.recommendedAction}</p>
            </section>
          </div>
        </>
      )}

      {proposal === null ? (
        <section className="reference-panel">
          <h3>{message("analysis.noProposal")}</h3>
        </section>
      ) : (
        <section className="analysis-proposal" aria-labelledby="analysis-proposal-heading">
          <div className="section-heading compact">
            <div>
              <p className="eyebrow">{message("analysis.proposalEyebrow")}</p>
              <h3 id="analysis-proposal-heading">{proposal.action}</h3>
            </div>
            <div className="analysis-evidence-coordinate">
              <Badge variant="outline">{analysis.decision}</Badge>
              <Badge variant="outline">{analysis.applyStatus}</Badge>
            </div>
          </div>
          {analysis.applyStatus === "APPLIED" ? (
            <Alert>
              <CheckCircle2 aria-hidden="true" />
              <AlertTitle>{message("analysis.proposalApplied")}</AlertTitle>
            </Alert>
          ) : null}
          {analysis.decision === "REJECTED" ? (
            <Alert>
              <XCircle aria-hidden="true" />
              <AlertTitle>{message("analysis.proposalRejected")}</AlertTitle>
            </Alert>
          ) : null}
          {analysis.applyStatus === "CONFLICT" ? (
            <Alert variant="destructive">
              <AlertTitle>{message("analysis.proposalConflict")}</AlertTitle>
            </Alert>
          ) : null}
          {pendingProposal ? (
            <>
              <Label htmlFor="analysis-proposal-json">{message("analysis.editProposal")}</Label>
              <Textarea
                id="analysis-proposal-json"
                value={proposalText}
                onChange={(event) => onProposalTextChange(event.target.value)}
                aria-invalid={proposalError !== null}
              />
              {proposalError === null ? null : <p className="form-error">{proposalError}</p>}
              {mutationError === null || proposalDraftPreserved ? null : (
                <Alert variant="destructive">
                  <AlertTitle>{mutationError}</AlertTitle>
                </Alert>
              )}
              {!canApply ? (
                <p className="form-error">{message("analysis.currentCaseUnavailable")}</p>
              ) : null}
              <div className="analysis-decision-actions">
                <Button
                  type="button"
                  variant="outline"
                  disabled={decisionPending}
                  onClick={onReject}
                >
                  {message("analysis.rejectProposal")}
                </Button>
                <Button type="button" disabled={decisionPending || !canApply} onClick={onAccept}>
                  {message("analysis.acceptProposal")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={decisionPending || !canApply}
                  onClick={onEditAndAccept}
                >
                  {message("analysis.editAndAccept")}
                </Button>
              </div>
            </>
          ) : null}
        </section>
      )}

      {proposalDraftPreserved ? (
        <section className="analysis-proposal">
          <h3>{message("analysis.preservedProposalDraft")}</h3>
          <Label htmlFor="analysis-preserved-proposal-json">
            {message("analysis.preservedProposalDraft")}
          </Label>
          <Textarea id="analysis-preserved-proposal-json" value={preservedProposalText} disabled />
          {mutationError === null ? null : (
            <Alert variant="destructive">
              <AlertTitle>{mutationError}</AlertTitle>
            </Alert>
          )}
        </section>
      ) : null}
    </div>
  );
}

/** Platform and imported Report Analysis workbench. */
export function AnalysisPage({
  api,
  resourceApi,
  runId,
  onNavigate
}: AnalysisPageProps): ReactElement {
  const queryClient = useQueryClient();
  const [selector, setSelector] = useState<Selector>("failed");
  const [analyzerId, setAnalyzerId] = useState("");
  const [promptId, setPromptId] = useState("");
  const [concurrency, setConcurrency] = useState("1");
  const [selectedCaseKey, setSelectedCaseKey] = useState<string | null>(null);
  const [proposalText, setProposalText] = useState("");
  const [proposalError, setProposalError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [proposalDraftPreserved, setProposalDraftPreserved] = useState(false);
  const preservedDraft = useRef<{ readonly caseKey: string; readonly text: string } | null>(null);

  const overview = useQuery({
    queryKey: ["runs", "report", runId] as const,
    queryFn: ({ signal }) => api.getReport(runId, signal)
  });
  const analyzers = useQuery({
    queryKey: ["configurations", "LLM", "analysis"] as const,
    queryFn: ({ signal }) => loadAllConfigurations(resourceApi, "LLM", signal)
  });
  const prompts = useQuery({
    queryKey: ["configurations", "CASE_ANALYSIS_PROMPT", "analysis"] as const,
    queryFn: ({ signal }) => loadAllConfigurations(resourceApi, "CASE_ANALYSIS_PROMPT", signal)
  });
  const cases = useInfiniteQuery({
    queryKey: ["runs", "analysis", runId, "cases", selector] as const,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api.listReportCases(
        {
          runId,
          limit: 200,
          cursor: pageParam,
          restStatus: [],
          evalStatus: selectedStatuses(selector),
          metrics: [],
          businessModules: [],
          scenarioTags: []
        },
        signal
      ),
    getNextPageParam: (lastPage, _allPages, _lastPageParam, allPageParams) => {
      const nextCursor = lastPage.nextCursor;
      if (nextCursor === null || allPageParams.includes(nextCursor)) return undefined;
      return nextCursor;
    }
  });
  const visibleCases = cases.data?.pages.flatMap((page) => page.items) ?? [];
  const effectiveAnalyzerId = analyzerId === "" ? (analyzers.data?.items[0]?.id ?? "") : analyzerId;
  const effectivePromptId = promptId === "" ? (prompts.data?.items[0]?.id ?? "") : promptId;
  const analysisKey = ["runs", "analysis", runId, selectedCaseKey] as const;
  const currentAnalysis = useQuery({
    queryKey: analysisKey,
    queryFn: ({ signal }) => {
      if (selectedCaseKey === null) throw new Error("ANALYSIS_CASE_NOT_SELECTED");
      return api.getAnalysis(runId, selectedCaseKey, signal);
    },
    enabled: selectedCaseKey !== null,
    retry: false
  });
  const suiteId = overview.data?.context.suite.sourceId ?? null;
  const currentSuite = useQuery({
    queryKey: ["test-suites", suiteId, "analysis-apply"] as const,
    queryFn: ({ signal }) => {
      if (suiteId === null) throw new Error("ANALYSIS_SUITE_NOT_SELECTED");
      return resourceApi.getTestSuite(suiteId, signal);
    },
    enabled: suiteId !== null && currentAnalysis.data?.output?.proposal !== null,
    retry: false
  });
  const currentCase = useQuery({
    queryKey: ["test-suites", suiteId, "cases", selectedCaseKey, "analysis-apply"] as const,
    queryFn: ({ signal }) => {
      if (suiteId === null || selectedCaseKey === null) {
        throw new Error("ANALYSIS_CASE_NOT_SELECTED");
      }
      return resourceApi.getCase(suiteId, selectedCaseKey, signal);
    },
    enabled:
      suiteId !== null &&
      selectedCaseKey !== null &&
      currentAnalysis.data?.output?.proposal !== null,
    retry: false
  });

  useEffect(() => {
    const analysis = currentAnalysis.data;
    if (analysis === undefined) return;
    const preserved = preservedDraft.current;
    setProposalDraftPreserved(preserved?.caseKey === analysis.caseKey);
    const proposal = analysis.output?.proposal;
    if (proposal === undefined || proposal === null) {
      setProposalText("");
      setProposalError(null);
      return;
    }
    setProposalText(JSON.stringify(proposal, null, 2));
    setProposalError(null);
  }, [currentAnalysis.data?.id, currentAnalysis.data?.revision]);

  const start = useMutation({
    mutationFn: () =>
      api.startAnalysis(
        runId,
        {
          analyzerConfigId: effectiveAnalyzerId,
          analysisPromptId: effectivePromptId,
          selector,
          analysisExecutionLimits: {
            contractVersion: "cortex.analysis-execution-limits.v1",
            analysisConcurrency: Number(concurrency)
          }
        },
        new AbortController().signal
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["runs", "analysis", runId] });
    }
  });

  const updateCurrent = (value: CurrentCaseAnalysis): void => {
    preservedDraft.current = null;
    setProposalDraftPreserved(false);
    queryClient.setQueryData(["runs", "analysis", runId, value.caseKey], value);
    setMutationError(null);
  };
  const reject = useMutation({
    mutationFn: (analysis: CurrentCaseAnalysis) =>
      api.rejectAnalysis(
        runId,
        analysis.caseKey,
        { analysisId: analysis.id, expectedAnalysisRevision: analysis.revision },
        new AbortController().signal
      ),
    onSuccess: updateCurrent,
    onError: async () => {
      setMutationError(message("analysis.decisionConflict"));
      await currentAnalysis.refetch();
    }
  });
  const accept = useMutation({
    mutationFn: (input: {
      readonly analysis: CurrentCaseAnalysis;
      readonly body: AcceptAnalysisInput;
    }) =>
      api.acceptAnalysis(runId, input.analysis.caseKey, input.body, new AbortController().signal),
    onSuccess: updateCurrent,
    onError: async () => {
      setMutationError(message("analysis.decisionConflict"));
      await currentAnalysis.refetch();
    }
  });
  const editAndAccept = useMutation({
    mutationFn: (input: {
      readonly analysis: CurrentCaseAnalysis;
      readonly body: AcceptAnalysisInput;
      readonly editedProposal: ReturnType<typeof AnalysisProposalV1Schema.parse>;
      readonly draftText: string;
    }) =>
      api.editAndAcceptAnalysis(
        runId,
        input.analysis.caseKey,
        { ...input.body, editedProposal: input.editedProposal },
        new AbortController().signal
      ),
    onSuccess: updateCurrent,
    onError: async (_error, input) => {
      preservedDraft.current = { caseKey: input.analysis.caseKey, text: input.draftText };
      setProposalText(input.draftText);
      setProposalDraftPreserved(true);
      setMutationError(message("analysis.applyConflictPreserved"));
      await currentAnalysis.refetch();
    }
  });

  if (overview.isPending) return <Progress aria-label={message("analysis.loading")} />;
  if (overview.isError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>{message("analysis.loadError")}</AlertTitle>
        <Button type="button" variant="outline" onClick={() => void overview.refetch()}>
          <RefreshCw aria-hidden="true" />
          {message("dashboard.retry")}
        </Button>
      </Alert>
    );
  }

  const startReady =
    effectiveAnalyzerId !== "" &&
    effectivePromptId !== "" &&
    Number.isInteger(Number(concurrency)) &&
    Number(concurrency) >= 1 &&
    Number(concurrency) <= 8;
  const decisionPending = reject.isPending || accept.isPending || editAndAccept.isPending;
  const apply = (): { analysis: CurrentCaseAnalysis; body: AcceptAnalysisInput } | null => {
    if (
      currentAnalysis.data === undefined ||
      currentSuite.data === undefined ||
      currentCase.data === undefined
    ) {
      return null;
    }
    return {
      analysis: currentAnalysis.data,
      body: acceptanceInput(currentAnalysis.data, currentSuite.data, currentCase.data)
    };
  };
  const submitEdit = (): void => {
    const target = apply();
    if (target === null) return;
    let dirty: unknown;
    try {
      dirty = JSON.parse(proposalText) as unknown;
    } catch {
      setProposalError(message("analysis.proposalInvalid"));
      return;
    }
    const parsed = AnalysisProposalV1Schema.safeParse(dirty);
    if (!parsed.success) {
      setProposalError(message("analysis.proposalInvalid"));
      return;
    }
    setProposalError(null);
    setMutationError(null);
    editAndAccept.mutate({ ...target, editedProposal: parsed.data, draftText: proposalText });
  };

  return (
    <section className="page-stack analysis-workbench">
      <header className="page-header detail-header analysis-header">
        <Button
          type="button"
          variant="outline"
          onClick={() => onNavigate(`/runs/${encodeURIComponent(runId)}/report`)}
        >
          <ArrowLeft aria-hidden="true" />
          {message("analysis.backToReport")}
        </Button>
        <div>
          <p className="eyebrow">{message("analysis.eyebrow")}</p>
          <h1>{message("analysis.title")}</h1>
          <p className="run-detail-id">{runId}</p>
        </div>
        <Badge variant="outline">{overview.data.sourceType}</Badge>
      </header>

      <section className="analysis-launch-panel" aria-labelledby="analysis-launch-heading">
        <div className="section-heading compact">
          <div>
            <p className="eyebrow">{message("analysis.launchEyebrow")}</p>
            <h2 id="analysis-launch-heading">{message("analysis.launchTitle")}</h2>
          </div>
          <FlaskConical aria-hidden="true" />
        </div>
        <div className="analysis-launch-grid">
          <Label>
            {message("analysis.selector")}
            <Select value={selector} onValueChange={(value: Selector) => setSelector(value)}>
              <SelectTrigger aria-label={message("analysis.selector")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="failed">{message("analysis.selectorFailed")}</SelectItem>
                <SelectItem value="errors">{message("analysis.selectorErrors")}</SelectItem>
                <SelectItem value="all">{message("analysis.selectorAll")}</SelectItem>
              </SelectContent>
            </Select>
          </Label>
          <Label>
            {message("analysis.analyzer")}
            <Select value={effectiveAnalyzerId} onValueChange={setAnalyzerId}>
              <SelectTrigger aria-label={message("analysis.analyzer")}>
                <SelectValue placeholder={message("analysis.selectAnalyzer")} />
              </SelectTrigger>
              <SelectContent>
                {(analyzers.data?.items ?? []).map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Label>
          <Label>
            {message("analysis.prompt")}
            <Select value={effectivePromptId} onValueChange={setPromptId}>
              <SelectTrigger aria-label={message("analysis.prompt")}>
                <SelectValue placeholder={message("analysis.selectPrompt")} />
              </SelectTrigger>
              <SelectContent>
                {(prompts.data?.items ?? []).map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Label>
          <Label>
            {message("analysis.concurrency")}
            <Input
              type="number"
              min={1}
              max={8}
              value={concurrency}
              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                setConcurrency(event.target.value)
              }
            />
          </Label>
          <Button
            type="button"
            disabled={!startReady || start.isPending}
            onClick={() => start.mutate()}
          >
            {message("analysis.start")}
          </Button>
        </div>
        {start.data === undefined ? null : <AnalysisStartSummary value={start.data} />}
        {start.isError ? (
          <Alert variant="destructive">
            <AlertTitle>{message("analysis.startError")}</AlertTitle>
          </Alert>
        ) : null}
      </section>

      <div className="analysis-workbench-grid">
        <section
          className="data-panel analysis-case-index"
          aria-labelledby="analysis-cases-heading"
        >
          <div className="section-heading compact">
            <h2 id="analysis-cases-heading">{message("analysis.cases")}</h2>
            <Badge variant="outline">{visibleCases.length}</Badge>
          </div>
          {cases.isPending ? <Progress aria-label={message("analysis.casesLoading")} /> : null}
          {cases.isError ? (
            <Alert variant="destructive">
              <AlertTitle>{message("analysis.casesError")}</AlertTitle>
            </Alert>
          ) : null}
          {cases.data === undefined ? null : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{message("reports.caseKey")}</TableHead>
                    <TableHead>{message("reports.evalStatus")}</TableHead>
                    <TableHead>{message("common.actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleCases.map((item) => (
                    <TableRow key={item.caseKey} data-selected={item.caseKey === selectedCaseKey}>
                      <TableCell>{item.caseKey}</TableCell>
                      <TableCell>
                        <Badge variant="accent">{item.evaluation.status}</Badge>
                      </TableCell>
                      <TableCell>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => {
                            if (item.caseKey !== selectedCaseKey) {
                              preservedDraft.current = null;
                              setProposalDraftPreserved(false);
                              setMutationError(null);
                            }
                            setSelectedCaseKey(item.caseKey);
                          }}
                        >
                          {message("analysis.viewCase")} {item.caseKey}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {cases.hasNextPage ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={cases.isFetchingNextPage}
                  onClick={() => void cases.fetchNextPage()}
                >
                  {cases.isFetchingNextPage
                    ? message("analysis.casesLoadingMore")
                    : message("analysis.loadMoreCases")}
                </Button>
              ) : null}
            </>
          )}
        </section>

        <section className="analysis-detail-panel" aria-labelledby="analysis-detail-heading">
          <div className="section-heading compact">
            <div>
              <p className="eyebrow">{message("analysis.currentVersion")}</p>
              <h2 id="analysis-detail-heading">
                {selectedCaseKey ?? message("analysis.selectCase")}
              </h2>
            </div>
          </div>
          {selectedCaseKey === null ? (
            <p className="empty-state">{message("analysis.selectCaseDescription")}</p>
          ) : null}
          {currentAnalysis.isPending ? (
            <Progress aria-label={message("analysis.currentLoading")} />
          ) : null}
          {isAnalysisAbsent(currentAnalysis.error) ? (
            <p className="empty-state">{message("analysis.notAnalyzed")}</p>
          ) : null}
          {currentAnalysis.isError && !isAnalysisAbsent(currentAnalysis.error) ? (
            <Alert variant="destructive">
              <AlertTitle>{message("analysis.currentError")}</AlertTitle>
            </Alert>
          ) : null}
          {currentAnalysis.data === undefined ? null : (
            <AnalysisResultPanel
              analysis={currentAnalysis.data}
              suite={currentSuite.data}
              testCase={currentCase.data}
              proposalText={proposalText}
              preservedProposalText={preservedDraft.current?.text ?? ""}
              proposalError={proposalError}
              mutationError={mutationError}
              proposalDraftPreserved={proposalDraftPreserved}
              decisionPending={decisionPending}
              onProposalTextChange={(value) => {
                setProposalText(value);
                setProposalError(null);
              }}
              onReject={() => {
                setMutationError(null);
                reject.mutate(currentAnalysis.data);
              }}
              onAccept={() => {
                const target = apply();
                if (target === null) return;
                setMutationError(null);
                accept.mutate(target);
              }}
              onEditAndAccept={submitEdit}
            />
          )}
        </section>
      </div>
    </section>
  );
}

// Render exact server batch counters without inferring unreported outcomes.
function AnalysisStartSummary({
  value
}: {
  readonly value: StartCaseAnalysisResult;
}): ReactElement {
  return (
    <Alert>
      <CheckCircle2 aria-hidden="true" />
      <AlertTitle>{message("analysis.startComplete")}</AlertTitle>
      <AlertDescription>
        {formatMessage("analysis.startSummary", {
          selected: value.selectedCount,
          succeeded: value.succeededCount,
          error: value.errorCount
        })}
      </AlertDescription>
    </Alert>
  );
}
