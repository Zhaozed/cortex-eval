import type { CaseDefinitionV1 } from "@cortex-eval/contracts/src/case-contracts.ts";
import type {
  CaseDetailV1Schema,
  CaseSummaryV1Schema
} from "@cortex-eval/contracts/src/resource-api-contracts.ts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Download, FileUp, Plus, RefreshCw, Settings } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import type { z } from "zod";

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
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport
} from "../../components/ui/toast.tsx";
import { formatMessage, message } from "../../messages/messages.ts";
import { ApiClientError } from "../../lib/api-client.ts";
import {
  createCaseConflict,
  createDeletedCaseConflict,
  type CaseEditorConflict
} from "../../lib/editor-conflict.ts";
import { usePageLeaveBlocker } from "../../lib/use-page-leave-blocker.ts";
import {
  invalidateCaseDeletion,
  invalidateCaseMutation,
  resourceKeys,
  synchronizeCaseListSnapshot,
  synchronizeCaseSnapshot,
  synchronizeTestSuiteSnapshot,
  type ResourceApi
} from "../../lib/resource-api.ts";
import { parseCaseListSearch } from "../../lib/web-route.ts";
import { loadCaseFilterOptions, EMPTY_CASE_FILTER_OPTIONS } from "./case-filter-options.ts";
import { CaseEditor, type CaseEditorExternalSaveError } from "./case-editor.tsx";
import { CaseCopyDialog } from "./case-copy-dialog.tsx";
import { CaseDeleteDialog } from "./case-delete-dialog.tsx";
import { CaseImportDialog } from "./case-import-dialog.tsx";
import {
  CaseMutationConflictNotice,
  type CaseMutationConflict
} from "./case-mutation-conflict-notice.tsx";
import { createDefaultCaseDefinition } from "./default-case-definition.ts";
import { TestSuiteCaseListPanel } from "./test-suite-case-list-panel.tsx";
import { TestSuiteDeleteControl } from "./test-suite-delete-control.tsx";
import { TestSuiteMetadataSheet } from "./test-suite-metadata-sheet.tsx";
import { useCaseMutationRecovery } from "./use-case-mutation-recovery.ts";
import { useTestSuiteMetadataEditor } from "./use-test-suite-metadata-editor.ts";

type CaseSummary = z.infer<typeof CaseSummaryV1Schema>;
type CaseDetail = z.infer<typeof CaseDetailV1Schema>;

interface CaseSaveRevisionFacts {
  /** Aggregate Test Suite Revision consumed by one edit. */
  readonly suiteRevision: number;
  /** Current Case Revision consumed by one edit. */
  readonly caseRevision: number;
}

/** One editor session freezing its Definition and optimistic-concurrency facts together. */
interface CaseEditorSession {
  /** Monotonic identity controlling only intentional editor reconstruction. */
  readonly sessionId: number;
  /** Suite-local Case identity owned by this session. */
  readonly caseKey: string;
  /** Definition confirmed by the detail read that opened this session. */
  readonly initialDefinition: CaseDefinitionV1;
  /** Suite Revision frozen when this session was established. */
  readonly suiteRevision: number;
  /** Case Revision paired with the confirmed Definition. */
  readonly caseRevision: number;
}

/** Test Suite detail page properties. */
export interface TestSuiteDetailPageProps {
  /** Boundary-validating resource API. */
  readonly api: ResourceApi;
  /** Current Test Suite identity from the validated route. */
  readonly suiteId: string;
  /** Explicit History navigation callback. */
  readonly onNavigate: (path: string) => void;
  /** Navigate only after one mutually exclusive write has committed. */
  readonly onCommittedNavigate?: (path: string) => void;
  /** Report writes and Revision decisions that must survive route changes. */
  readonly onLeaveBlockedChange?: (blocked: boolean) => void;
}

// Normalize an editor retry failure before it re-enters the retained editor.
function sanitizedCaseEditError(error: unknown): ApiClientError {
  return error instanceof ApiClientError ? error : new ApiClientError("CLIENT_REQUEST_FAILED");
}

/** Current Test Suite metadata, filters, cursor-paged Cases and edit Sheet. */
export function TestSuiteDetailPage({
  api,
  suiteId,
  onNavigate,
  onCommittedNavigate,
  onLeaveBlockedChange
}: TestSuiteDetailPageProps): ReactElement {
  const [listState, setListState] = useState(() =>
    parseCaseListSearch(new URLSearchParams(window.location.search))
  );
  const [editingCaseKey, setEditingCaseKey] = useState<string | null>(null);
  const [createDefinition, setCreateDefinition] = useState<CaseDefinitionV1 | null>(null);
  const [createCaseError, setCreateCaseError] = useState<ApiClientError | null>(null);
  const [copyTarget, setCopyTarget] = useState<CaseSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CaseSummary | null>(null);
  const [copyError, setCopyError] = useState<ApiClientError | null>(null);
  const [deleteCaseError, setDeleteCaseError] = useState<ApiClientError | null>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [operationError, setOperationError] = useState(false);
  const [importError, setImportError] = useState<ApiClientError | null>(null);
  const [toastOpen, setToastOpen] = useState(false);
  const [editError, setEditError] = useState(false);
  const [caseEditorSession, setCaseEditorSession] = useState<CaseEditorSession | null>(null);
  const [caseConflict, setCaseConflict] = useState<CaseEditorConflict | null>(null);
  const [caseConflictDetail, setCaseConflictDetail] = useState<CaseDetail | null>(null);
  const [caseEditPending, setCaseEditPending] = useState(false);
  const [caseEditExternalError, setCaseEditExternalError] =
    useState<CaseEditorExternalSaveError | null>(null);
  const [suiteDeleteBlocked, setSuiteDeleteBlocked] = useState(false);
  const importInput = useRef<HTMLInputElement>(null);
  const caseEditPendingRef = useRef(false);
  const caseEditorSessionSequence = useRef(0);
  const caseEditErrorSequence = useRef(0);
  const queryClient = useQueryClient();
  const caseMutations = useCaseMutationRecovery({
    api,
    queryClient,
    suiteId,
    onFailureChange: setOperationError,
    onSuccess: () => setToastOpen(true)
  });
  const caseMutationConflict: CaseMutationConflict | null = caseMutations.conflict;
  const suite = useQuery({
    queryKey: resourceKeys.testSuiteDetail(suiteId),
    queryFn: ({ signal }) => api.getTestSuite(suiteId, signal)
  });
  const suiteEditor = useTestSuiteMetadataEditor({
    api,
    suiteId,
    suite: suite.data ?? null,
    onSaved: () => setToastOpen(true)
  });
  const cases = useQuery({
    queryKey: [...resourceKeys.caseLists(suiteId), listState] as const,
    queryFn: ({ signal }) =>
      api.listCases(
        suiteId,
        {
          limit: listState.limit,
          cursor: listState.cursor,
          caseKey: listState.caseKey,
          description: listState.description,
          businessModules: listState.businessModules,
          scenarioTags: listState.scenarioTags,
          assertionTypes: listState.assertionTypes,
          metrics: listState.metrics
        },
        signal
      )
  });
  const caseOptions = useQuery({
    queryKey: ["case-filter-options", suiteId, suite.data?.revision],
    enabled: suite.data !== undefined,
    queryFn: ({ signal }) => loadCaseFilterOptions(api, suiteId, signal)
  });
  // Stable row actions prevent asynchronous facet loads from remounting a pressed button.
  const openCaseEditor = useCallback((resource: CaseSummary): void => {
    setEditError(false);
    setCaseEditExternalError(null);
    setCaseEditorSession(null);
    setCaseConflict(null);
    setCaseConflictDetail(null);
    setEditingCaseKey(resource.caseKey);
  }, []);
  const openCaseCopy = useCallback((resource: CaseSummary): void => {
    setCopyError(null);
    setCopyTarget(resource);
  }, []);
  const openCaseDelete = useCallback((resource: CaseSummary): void => {
    setDeleteCaseError(null);
    setDeleteTarget(resource);
  }, []);
  const remoteCaseDeleted = caseConflict?.remoteState === "REMOTE_CASE_DELETED";
  const caseDetail = useQuery({
    queryKey:
      editingCaseKey === null
        ? [...resourceKeys.caseDetail(suiteId, "NONE"), "disabled"]
        : resourceKeys.caseDetail(suiteId, editingCaseKey),
    queryFn: ({ signal }) => api.getCase(suiteId, editingCaseKey ?? "", signal),
    enabled: editingCaseKey !== null && !remoteCaseDeleted,
    staleTime: 0,
    refetchOnMount: "always"
  });

  // Open an editor only from this session's completed, identity-matched detail read.
  useEffect(() => {
    if (editingCaseKey === null || caseConflict !== null) return;
    if (caseDetail.fetchStatus !== "idle" || !caseDetail.isSuccess) return;
    const detail = caseDetail.data;
    const suiteSnapshot = suite.data;
    if (detail.caseKey !== editingCaseKey || suiteSnapshot === undefined) return;

    setCaseEditorSession((current) => {
      if (current?.caseKey === editingCaseKey) return current;
      caseEditorSessionSequence.current += 1;
      return {
        sessionId: caseEditorSessionSequence.current,
        caseKey: editingCaseKey,
        initialDefinition: structuredClone(detail.definition),
        suiteRevision: suiteSnapshot.revision,
        caseRevision: detail.revision
      };
    });
  }, [
    caseConflict,
    caseDetail.data,
    caseDetail.fetchStatus,
    caseDetail.isSuccess,
    editingCaseKey,
    suite.data
  ]);

  // Disable the detail query before removing its stale cache and refreshing aggregates.
  useEffect(() => {
    if (!remoteCaseDeleted || editingCaseKey === null) return;
    void invalidateCaseDeletion(queryClient, suiteId, editingCaseKey).catch(() => {
      setEditError(true);
    });
  }, [editingCaseKey, queryClient, remoteCaseDeleted, suiteId]);
  const activeCaseEditorSession =
    caseEditorSession?.caseKey === editingCaseKey ? caseEditorSession : null;
  const caseDetailLoading =
    activeCaseEditorSession === null && caseDetail.fetchStatus === "fetching";
  const caseDetailLoadFailed =
    activeCaseEditorSession === null &&
    !caseDetailLoading &&
    (caseDetail.isError || caseDetail.isRefetchError);
  const otherWriteBlocked =
    suiteEditor.pending ||
    suiteEditor.conflict !== null ||
    caseEditPending ||
    caseConflict !== null ||
    caseMutations.pending ||
    caseMutationConflict !== null;
  const leaveBlocked = otherWriteBlocked || suiteDeleteBlocked;
  usePageLeaveBlocker(leaveBlocked, onLeaveBlockedChange);

  // Persist one Case Draft with both current optimistic-concurrency tokens.
  const saveCase = async (
    definition: CaseDefinitionV1,
    revisionFacts?: CaseSaveRevisionFacts
  ): Promise<void> => {
    if (caseEditPendingRef.current) return;
    const session = caseEditorSession;
    if (editingCaseKey === null || session?.caseKey !== editingCaseKey) return;
    const caseKey = editingCaseKey;
    caseEditPendingRef.current = true;
    setCaseEditPending(true);
    try {
      await api.updateCase(
        suiteId,
        caseKey,
        {
          expectedSuiteRevision: revisionFacts?.suiteRevision ?? session.suiteRevision,
          expectedCaseRevision: revisionFacts?.caseRevision ?? session.caseRevision,
          definition
        },
        new AbortController().signal
      );
      await invalidateCaseMutation(queryClient, suiteId, caseKey);
      setCaseEditorSession(null);
      setEditingCaseKey(null);
    } catch (error) {
      if (error instanceof ApiClientError && error.code === "RESOURCE_REVISION_CONFLICT") {
        try {
          const latestSuite = await api.getTestSuite(suiteId, new AbortController().signal);
          synchronizeTestSuiteSnapshot(queryClient, latestSuite);
          let latestCase: CaseDetail;
          try {
            latestCase = await api.getCase(suiteId, caseKey, new AbortController().signal);
          } catch (refreshError) {
            const deletedRemotely =
              refreshError instanceof ApiClientError && refreshError.code === "CASE_NOT_FOUND";
            if (!deletedRemotely) throw refreshError;

            setCaseConflictDetail(null);
            setCaseConflict(
              createDeletedCaseConflict({
                draft: definition,
                serverSuiteRevision: latestSuite.revision
              })
            );
            setEditError(false);
            return;
          }
          synchronizeCaseListSnapshot(queryClient, latestCase);
          setCaseConflictDetail(latestCase);
          setCaseConflict(
            createCaseConflict({
              draft: definition,
              serverCase: {
                definition: latestCase.definition,
                revision: latestCase.revision
              },
              serverSuiteRevision: latestSuite.revision
            })
          );
          setEditError(false);
          return;
        } catch {
          setEditError(true);
          return;
        }
      }
      setEditError(true);
      throw error;
    } finally {
      caseEditPendingRef.current = false;
      setCaseEditPending(false);
    }
  };

  // Export current Cases only after the complete JSON response validates.
  const exportCases = async (): Promise<void> => {
    try {
      const exported = await api.exportCases(suiteId, new AbortController().signal);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(exported, null, 2)], { type: "application/json" })
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "cases.json";
      anchor.click();
      URL.revokeObjectURL(url);
      setToastOpen(true);
    } catch {
      setOperationError(true);
    }
  };

  // Clear both React and native file-input state so the same file can be selected again.
  const clearImportSelection = (): void => {
    setImportFile(null);
    setImportError(null);
    if (importInput.current !== null) importInput.current.value = "";
  };

  if (suite.isPending || cases.isPending) {
    return (
      <section className="page-stack" aria-busy="true">
        <Progress aria-label={message("caseList.loading")} />
      </section>
    );
  }
  if (suite.isError || cases.isError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>{message("caseList.loadError")}</AlertTitle>
        <Button
          type="button"
          variant="outline"
          onClick={() => void Promise.all([suite.refetch(), cases.refetch()])}
        >
          <RefreshCw aria-hidden="true" />
          {message("dashboard.retry")}
        </Button>
      </Alert>
    );
  }

  return (
    <section className="page-stack management-page suite-detail-page">
      <header className="page-header detail-header">
        <Button type="button" size="sm" variant="ghost" onClick={() => onNavigate("/test-suites")}>
          <ArrowLeft aria-hidden="true" />
          {message("testSuites.back")}
        </Button>
        <div>
          <p className="eyebrow">
            {formatMessage("testSuites.revisionEyebrow", { revision: suite.data.revision })}
          </p>
          <h1>{suite.data.name}</h1>
          <p>{suite.data.description}</p>
        </div>
        <Badge variant="outline">
          {formatMessage("testSuites.caseCountBadge", { count: suite.data.caseCount })}
        </Badge>
      </header>
      <div className="resource-toolbar">
        <Button
          type="button"
          disabled={suiteDeleteBlocked}
          onClick={() => {
            setCreateCaseError(null);
            setCreateDefinition(createDefaultCaseDefinition());
          }}
        >
          <Plus aria-hidden="true" />
          {message("caseList.create")}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={suiteDeleteBlocked}
          onClick={() => importInput.current?.click()}
        >
          <FileUp aria-hidden="true" />
          {message("testSuites.import")}
        </Button>
        <input
          ref={importInput}
          className="sr-only"
          type="file"
          accept="application/json,application/x-ndjson,.json,.jsonl"
          aria-label={message("testSuites.import")}
          disabled={suiteDeleteBlocked}
          onChange={(event) => {
            setImportError(null);
            setImportFile(event.currentTarget.files?.[0] ?? null);
          }}
        />
        <Button type="button" variant="outline" onClick={() => void exportCases()}>
          <Download aria-hidden="true" />
          {message("testSuites.export")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={suiteDeleteBlocked}
          onClick={suiteEditor.openEditor}
        >
          <Settings aria-hidden="true" />
          {message("testSuites.edit")}
        </Button>
        <TestSuiteDeleteControl
          api={api}
          queryClient={queryClient}
          suiteId={suiteId}
          suite={suite.data}
          disabled={otherWriteBlocked}
          onDeleted={() => {
            if (otherWriteBlocked) {
              setOperationError(true);
              return;
            }
            (onCommittedNavigate ?? onNavigate)("/test-suites");
          }}
          onFailureChange={setOperationError}
          onLeaveBlockedChange={setSuiteDeleteBlocked}
        />
      </div>
      {operationError ? (
        <Alert variant="destructive">
          <AlertTitle>{message("common.operationFailed")}</AlertTitle>
        </Alert>
      ) : null}
      {caseOptions.isError ? (
        <div className="inline-notice" role="alert">
          筛选选项加载失败，未展示不完整选项。
          <Button type="button" variant="outline" onClick={() => void caseOptions.refetch()}>
            重试
          </Button>
        </div>
      ) : null}
      {caseOptions.isPending ? <p role="status">正在加载整个测试集的筛选选项…</p> : null}
      <TestSuiteCaseListPanel
        filterOptions={caseOptions.data ?? EMPTY_CASE_FILTER_OPTIONS}
        listState={listState}
        items={cases.data.items}
        nextCursor={cases.data.nextCursor}
        mutationDisabled={suiteDeleteBlocked}
        onListStateChange={setListState}
        onEdit={openCaseEditor}
        onCopy={openCaseCopy}
        onDelete={openCaseDelete}
      />
      <Sheet
        open={editingCaseKey !== null}
        onOpenChange={(open) => {
          if (!open && (caseEditPendingRef.current || caseConflict !== null)) return;
          if (!open) {
            setEditingCaseKey(null);
            setCaseEditorSession(null);
            setCaseEditExternalError(null);
            setCaseConflict(null);
            setCaseConflictDetail(null);
          }
        }}
      >
        <SheetContent className="w-[min(880px,94vw)] management-sheet">
          <SheetHeader>
            <SheetTitle>
              {formatMessage("caseList.editTitle", { caseKey: editingCaseKey ?? "" })}
            </SheetTitle>
            <SheetDescription>{message("caseList.editDescription")}</SheetDescription>
          </SheetHeader>
          {caseConflict?.remoteState === "REMOTE_CASE_DELETED" ? (
            <Alert>
              <AlertTitle>
                <h3>{message("caseMutation.remoteDeletedTitle")}</h3>
              </AlertTitle>
              <AlertDescription>
                <p>{message("conflict.remoteDeletedDescription")}</p>
                <p>
                  {formatMessage("conflict.localDraft", {
                    description: caseConflict.draft.description
                  })}
                </p>
                <p>
                  {formatMessage("caseMutation.serverRevision", {
                    revision: caseConflict.serverSuiteRevision
                  })}
                </p>
                <div className="conflict-actions">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setEditingCaseKey(null);
                      setCaseEditorSession(null);
                      setCaseEditExternalError(null);
                      setCaseConflict(null);
                      setCaseConflictDetail(null);
                      setEditError(false);
                    }}
                  >
                    {message("conflict.acceptDeleted")}
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          ) : null}
          {!remoteCaseDeleted && activeCaseEditorSession === null ? (
            caseDetailLoadFailed ? (
              <Alert variant="destructive">
                <AlertTitle>{message("caseList.editLoadError")}</AlertTitle>
                <AlertDescription>
                  <Button type="button" variant="outline" onClick={() => void caseDetail.refetch()}>
                    <RefreshCw aria-hidden="true" />
                    {message("dashboard.retry")}
                  </Button>
                </AlertDescription>
              </Alert>
            ) : (
              <Progress aria-label={message("caseList.loading")} />
            )
          ) : null}
          {activeCaseEditorSession === null ? null : (
            <>
              {editError ? (
                <Alert variant="destructive">
                  <AlertTitle>{message("caseList.saveError")}</AlertTitle>
                  <AlertDescription>{message("caseList.editDescription")}</AlertDescription>
                </Alert>
              ) : null}
              {caseConflict?.remoteState !== "PRESENT" ? null : (
                <Alert>
                  <AlertTitle>
                    <h3>{message("conflict.title")}</h3>
                  </AlertTitle>
                  <AlertDescription>
                    <p>{message("conflict.description")}</p>
                    <p>
                      {formatMessage("conflict.localDraft", {
                        description: caseConflict.draft.description
                      })}
                    </p>
                    <p>
                      {formatMessage("conflict.serverVersion", {
                        description: caseConflict.serverCase.definition.description
                      })}
                    </p>
                    <div className="conflict-actions">
                      <Button
                        type="button"
                        disabled={caseEditPending}
                        onClick={() => {
                          const draft = caseConflict.draft;
                          const facts = {
                            suiteRevision: caseConflict.serverSuiteRevision,
                            caseRevision: caseConflict.serverCase.revision
                          };
                          setCaseConflict(null);
                          setCaseConflictDetail(null);
                          setCaseEditExternalError(null);
                          void saveCase(draft, facts).catch((error: unknown) => {
                            caseEditErrorSequence.current += 1;
                            setCaseEditExternalError({
                              eventId: caseEditErrorSequence.current,
                              error: sanitizedCaseEditError(error)
                            });
                          });
                        }}
                      >
                        {message("conflict.retryLatest")}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={caseEditPending}
                        onClick={() => {
                          if (caseConflictDetail === null) return;
                          const serverDetail = caseConflictDetail;
                          caseEditorSessionSequence.current += 1;
                          synchronizeCaseSnapshot(queryClient, serverDetail);
                          setCaseEditorSession({
                            sessionId: caseEditorSessionSequence.current,
                            caseKey: serverDetail.caseKey,
                            initialDefinition: structuredClone(serverDetail.definition),
                            suiteRevision: caseConflict.serverSuiteRevision,
                            caseRevision: serverDetail.revision
                          });
                          setCaseEditExternalError(null);
                          setCaseConflict(null);
                          setCaseConflictDetail(null);
                        }}
                      >
                        {message("conflict.acceptServer")}
                      </Button>
                    </div>
                  </AlertDescription>
                </Alert>
              )}
              <CaseEditor
                key={`case-editor-${activeCaseEditorSession.sessionId}`}
                options={caseOptions.data}
                initialDefinition={activeCaseEditorSession.initialDefinition}
                disabled={caseConflict !== null || caseEditPending}
                externalSaveError={caseEditExternalError}
                onExternalSaveErrorHandled={(eventId) => {
                  setCaseEditExternalError((current) =>
                    current?.eventId === eventId ? null : current
                  );
                }}
                onSave={saveCase}
              />
            </>
          )}
        </SheetContent>
      </Sheet>
      <Sheet
        open={createDefinition !== null}
        onOpenChange={(open) => {
          if (!open && (caseMutations.pending || caseMutationConflict?.kind === "CREATE")) {
            return;
          }
          if (!open) {
            setCreateDefinition(null);
            setCreateCaseError(null);
            if (caseMutationConflict?.kind === "CREATE") caseMutations.clearConflict();
          }
        }}
      >
        <SheetContent className="w-[min(880px,94vw)] management-sheet">
          <SheetHeader>
            <SheetTitle>{message("caseList.createTitle")}</SheetTitle>
            <SheetDescription>{message("caseList.createDescription")}</SheetDescription>
          </SheetHeader>
          {caseMutationConflict?.kind === "CREATE" ? (
            <CaseMutationConflictNotice
              conflict={caseMutationConflict}
              pending={caseMutations.pending}
            />
          ) : null}
          {createCaseError === null ? null : (
            <Alert variant="destructive">
              <AlertTitle>{message("common.operationFailed")}</AlertTitle>
            </Alert>
          )}
          {createDefinition === null ? null : (
            <CaseEditor
              options={caseOptions.data}
              creating
              initialDefinition={createDefinition}
              disabled={caseMutations.pending || caseMutationConflict?.kind === "CREATE"}
              onSave={async (definition) => {
                setCreateCaseError(null);
                const outcome = await caseMutations.finish(
                  definition.metadata.case_id,
                  async (facts) =>
                    api.createCase(
                      suiteId,
                      { expectedSuiteRevision: facts.suiteRevision, definition },
                      new AbortController().signal
                    ),
                  {
                    kind: "CREATE",
                    draftLabel: definition.metadata.case_id,
                    caseKey: null,
                    close: () => setCreateDefinition(null),
                    onRetryFailure: (error) => setCreateCaseError(error)
                  },
                  { suiteRevision: suite.data.revision, caseRevision: null }
                );
                if (outcome.ok || outcome.revisionConflict || outcome.skipped) return;
                throw outcome.error;
              }}
            />
          )}
        </SheetContent>
      </Sheet>
      <TestSuiteMetadataSheet
        open={suiteEditor.open}
        onOpenChange={suiteEditor.onOpenChange}
        form={suiteEditor.form}
        conflict={suiteEditor.conflict}
        pending={suiteEditor.pending}
        error={suiteEditor.error}
        onSave={suiteEditor.save}
        onRetry={suiteEditor.retry}
        onAccept={suiteEditor.accept}
      />
      <CaseCopyDialog
        sourceCaseKey={copyTarget?.caseKey ?? null}
        pending={caseMutations.pending}
        error={copyError}
        onOpenChange={(open) => {
          if (!open && (caseMutations.pending || caseMutationConflict?.kind === "COPY")) return;
          if (!open) {
            setCopyTarget(null);
            setCopyError(null);
            if (caseMutationConflict?.kind === "COPY") caseMutations.clearConflict();
          }
        }}
        conflict={caseMutationConflict?.kind === "COPY" ? caseMutationConflict : null}
        onCopy={async (newCaseKey) => {
          if (copyTarget === null) return false;
          setCopyError(null);
          const outcome = await caseMutations.finish(
            newCaseKey,
            async (facts) =>
              api.copyCase(
                suiteId,
                copyTarget.caseKey,
                { expectedSuiteRevision: facts.suiteRevision, newCaseKey },
                new AbortController().signal
              ),
            {
              kind: "COPY",
              draftLabel: newCaseKey,
              caseKey: null,
              close: () => setCopyTarget(null),
              onRetryFailure: (error) => setCopyError(error)
            },
            { suiteRevision: suite.data.revision, caseRevision: null }
          );
          if (!outcome.ok && !outcome.revisionConflict && !outcome.skipped) {
            setCopyError(outcome.error);
          }
          return outcome.ok;
        }}
      />
      <CaseDeleteDialog
        caseKey={deleteTarget?.caseKey ?? null}
        pending={caseMutations.pending}
        error={deleteCaseError}
        conflict={caseMutationConflict?.kind === "DELETE" ? caseMutationConflict : null}
        onOpenChange={(open) => {
          if (!open && (caseMutations.pending || caseMutationConflict?.kind === "DELETE")) return;
          if (!open) {
            setDeleteTarget(null);
            setDeleteCaseError(null);
            if (caseMutationConflict?.kind === "DELETE") caseMutations.clearConflict();
          }
        }}
        onConfirm={() => {
          if (deleteTarget === null) return;
          setDeleteCaseError(null);
          const target = deleteTarget;
          void caseMutations
            .finish(
              target.caseKey,
              async (facts) =>
                api.deleteCase(
                  suiteId,
                  target.caseKey,
                  facts.suiteRevision,
                  facts.caseRevision ?? target.revision,
                  new AbortController().signal
                ),
              {
                kind: "DELETE",
                draftLabel: target.caseKey,
                caseKey: target.caseKey,
                close: () => setDeleteTarget(null),
                onRetryFailure: (error, latestFacts) => {
                  setDeleteTarget((current) =>
                    current?.caseKey === target.caseKey && latestFacts.caseRevision !== null
                      ? { ...current, revision: latestFacts.caseRevision }
                      : current
                  );
                  setDeleteCaseError(error);
                }
              },
              { suiteRevision: suite.data.revision, caseRevision: target.revision }
            )
            .then((outcome) => {
              if (!outcome.ok && !outcome.revisionConflict && !outcome.skipped) {
                setDeleteCaseError(outcome.error);
              }
            });
        }}
      />
      <CaseImportDialog
        api={api}
        suiteId={suiteId}
        revision={suite.data.revision}
        onRefreshSuite={() => {
          void suite.refetch();
        }}
        file={importFile}
        pending={caseMutations.pending}
        caseCount={suite.data.caseCount}
        error={importError}
        conflict={caseMutationConflict?.kind === "IMPORT" ? caseMutationConflict : null}
        onOpenChange={(open) => {
          if (!open && (caseMutations.pending || caseMutationConflict?.kind === "IMPORT")) return;
          if (!open) {
            clearImportSelection();
            if (caseMutationConflict?.kind === "IMPORT") caseMutations.clearConflict();
          }
        }}
        onConfirm={(file, previewRevision) => {
          setImportError(null);
          void caseMutations
            .finish(
              "IMPORT",
              async (facts) =>
                api.importCases(suiteId, facts.suiteRevision, file, new AbortController().signal),
              {
                kind: "IMPORT",
                draftLabel: file.name,
                caseKey: null,
                close: clearImportSelection,
                onRetryFailure: (error) => setImportError(error)
              },
              { suiteRevision: previewRevision, caseRevision: null }
            )
            .then((outcome) => {
              if (!outcome.ok && !outcome.revisionConflict && !outcome.skipped) {
                setImportError(outcome.error);
              }
            });
        }}
      />
      <ToastProvider>
        <Toast open={toastOpen} onOpenChange={setToastOpen}>
          <div>
            <ToastTitle>{message("common.operationSuccess")}</ToastTitle>
            <ToastDescription>{suite.data.name}</ToastDescription>
          </div>
          <ToastClose />
        </Toast>
        <ToastViewport />
      </ToastProvider>
    </section>
  );
}
