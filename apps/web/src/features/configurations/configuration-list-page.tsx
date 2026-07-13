import type { ConfigurationSummaryV1Schema } from "@cortex-eval/contracts/src/resource-api-contracts.ts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { Edit3, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useRef, useState, type ReactElement } from "react";
import type { z } from "zod";

import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert.tsx";
import { ApiClientError } from "../../lib/api-client.ts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "../../components/ui/alert-dialog.tsx";
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
import { formatMessage, message, type MessageKey } from "../../messages/messages.ts";
import { usePageLeaveBlocker } from "../../lib/use-page-leave-blocker.ts";
import {
  invalidateConfigurationDeletion,
  invalidateConfigurationMutation,
  resourceKeys,
  synchronizeConfigurationSnapshot,
  type ConfigurationKind,
  type ResourceApi
} from "../../lib/resource-api.ts";
import { ConfigurationEditor } from "./configuration-editor.tsx";

type ConfigurationSummary = z.infer<typeof ConfigurationSummaryV1Schema>;

interface ConfigurationDeleteConflict {
  /** Original local delete target label retained through the conflict. */
  readonly draftName: string;
  /** Latest server display name. */
  readonly serverName: string;
  /** Latest server Revision used for retry. */
  readonly serverRevision: number;
}

/** Configuration list page properties. */
export interface ConfigurationListPageProps {
  /** Boundary-validating resource API. */
  readonly api: ResourceApi;
  /** Resource family owned by the current closed route. */
  readonly kind: ConfigurationKind;
  /** Report writes and Revision decisions that must survive route changes. */
  readonly onLeaveBlockedChange?: (blocked: boolean) => void;
}

const PAGE_META: Readonly<
  Record<ConfigurationKind, { readonly title: MessageKey; readonly description: MessageKey }>
> = {
  ENDPOINT: { title: "config.endpoint.title", description: "config.endpoint.description" },
  LLM: { title: "config.llm.title", description: "config.llm.description" },
  LLM_RUBRIC_PROMPT: { title: "config.rubric.title", description: "config.rubric.description" },
  CASE_ANALYSIS_PROMPT: {
    title: "config.analysis.title",
    description: "config.analysis.description"
  }
};

/** Cursor-paged current Configuration registry and typed edit Sheet. */
export function ConfigurationListPage({
  api,
  kind,
  onLeaveBlockedChange
}: ConfigurationListPageProps): ReactElement {
  const meta = PAGE_META[kind];
  const [cursor, setCursor] = useState<string | null>(null);
  const [history, setHistory] = useState<readonly (string | null)[]>([]);
  const [sheetMode, setSheetMode] = useState<"CLOSED" | "CREATE" | "EDIT">("CLOSED");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ConfigurationSummary | null>(null);
  const [deleteReferences, setDeleteReferences] = useState<
    readonly { readonly suiteId: string; readonly caseKey: string }[]
  >([]);
  const [deleteReferencesLoading, setDeleteReferencesLoading] = useState(false);
  const [deleteReferenceError, setDeleteReferenceError] = useState(false);
  const [deleteMutationError, setDeleteMutationError] = useState(false);
  const [deleteConflict, setDeleteConflict] = useState<ConfigurationDeleteConflict | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [editorBlocked, setEditorBlocked] = useState(false);
  const deletePendingRef = useRef(false);
  const referenceRequestRef = useRef<{
    readonly generation: number;
    readonly controller: AbortController | null;
  }>({ generation: 0, controller: null });
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: [...resourceKeys.configurationLists(kind), { cursor }] as const,
    queryFn: ({ signal }) => api.listConfigurations(kind, { limit: 50, cursor }, signal)
  });
  const detail = useQuery({
    queryKey:
      selectedId === null
        ? [...resourceKeys.configurationDetail(kind, "NONE"), "disabled"]
        : resourceKeys.configurationDetail(kind, selectedId),
    queryFn: ({ signal }) => api.getConfiguration(kind, selectedId ?? "", signal),
    enabled: selectedId !== null && sheetMode === "EDIT"
  });
  const references = useQuery({
    queryKey: ["configurations", "LLM_RUBRIC_PROMPT", selectedId, "references"] as const,
    queryFn: ({ signal }) => api.listRubricPromptReferences(selectedId ?? "", signal),
    enabled: kind === "LLM_RUBRIC_PROMPT" && selectedId !== null && sheetMode === "EDIT"
  });
  const rubricReferencesRequired =
    kind === "LLM_RUBRIC_PROMPT" && selectedId !== null && sheetMode === "EDIT";
  const leaveBlocked = editorBlocked || deletePending || deleteConflict !== null;
  usePageLeaveBlocker(leaveBlocked, onLeaveBlockedChange);

  // Read Rubric delete references for only the latest selected target.
  const openDeleteDialog = (target: ConfigurationSummary): void => {
    referenceRequestRef.current.controller?.abort();
    const generation = referenceRequestRef.current.generation + 1;
    const controller = new AbortController();
    referenceRequestRef.current = { generation, controller };
    setDeleteTarget(target);
    setDeleteReferences([]);
    setDeleteReferenceError(false);
    setDeleteMutationError(false);
    setDeleteConflict(null);
    if (kind !== "LLM_RUBRIC_PROMPT") {
      setDeleteReferencesLoading(false);
      return;
    }
    setDeleteReferencesLoading(true);
    void api
      .listRubricPromptReferences(target.id, controller.signal)
      .then((result) => {
        if (referenceRequestRef.current.generation !== generation) return;
        setDeleteReferences(result.items);
      })
      .catch(() => {
        if (referenceRequestRef.current.generation !== generation) return;
        setDeleteReferenceError(true);
      })
      .finally(() => {
        if (referenceRequestRef.current.generation === generation) {
          setDeleteReferencesLoading(false);
        }
      });
  };

  // Close one delete flow and invalidate any late reference response.
  const closeDeleteDialog = (): void => {
    referenceRequestRef.current.controller?.abort();
    referenceRequestRef.current = {
      generation: referenceRequestRef.current.generation + 1,
      controller: null
    };
    setDeleteTarget(null);
    setDeleteReferences([]);
    setDeleteReferencesLoading(false);
    setDeleteReferenceError(false);
    setDeleteMutationError(false);
    setDeleteConflict(null);
  };

  // Delete one configuration with repeatable Revision conflict recovery.
  const finishDelete = async (
    target: ConfigurationSummary,
    expectedRevision: number
  ): Promise<void> => {
    if (deletePendingRef.current) return;
    deletePendingRef.current = true;
    setDeletePending(true);
    setDeleteMutationError(false);
    try {
      await api.deleteConfiguration(
        kind,
        target.id,
        expectedRevision,
        new AbortController().signal
      );
      await invalidateConfigurationDeletion(queryClient, kind, target.id);
      closeDeleteDialog();
    } catch (error) {
      if (error instanceof ApiClientError && error.code === "RESOURCE_REVISION_CONFLICT") {
        try {
          const latest = await api.getConfiguration(kind, target.id, new AbortController().signal);
          synchronizeConfigurationSnapshot(queryClient, latest);
          setDeleteTarget({
            kind: latest.kind,
            id: latest.id,
            name: latest.name,
            revision: latest.revision,
            updatedAt: latest.updatedAt
          });
          setDeleteConflict({
            draftName: target.name,
            serverName: latest.name,
            serverRevision: latest.revision
          });
          return;
        } catch {
          setDeleteMutationError(true);
          return;
        }
      }
      setDeleteMutationError(true);
    } finally {
      deletePendingRef.current = false;
      setDeletePending(false);
    }
  };
  const columns: ColumnDef<ConfigurationSummary>[] = [
    { accessorKey: "name", header: message("config.name") },
    {
      accessorKey: "revision",
      header: message("config.revision"),
      cell: ({ row }): ReactElement => <Badge variant="outline">{row.original.revision}</Badge>
    },
    { accessorKey: "updatedAt", header: message("common.updatedAt") },
    {
      id: "actions",
      header: message("common.actions"),
      cell: ({ row }): ReactElement => (
        <div className="row-actions">
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label={formatMessage("config.edit", { name: row.original.name })}
            onClick={() => {
              setSelectedId(row.original.id);
              setSheetMode("EDIT");
            }}
          >
            <Edit3 aria-hidden="true" />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={formatMessage("config.delete", { name: row.original.name })}
            onClick={() => openDeleteDialog(row.original)}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        </div>
      )
    }
  ];
  const table = useReactTable({
    data: list.data?.items ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true
  });
  const closeSheet = (): void => {
    setSheetMode("CLOSED");
    setSelectedId(null);
  };

  if (list.isPending) return <Progress aria-label={message("config.loading")} />;
  if (list.isError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>{message("config.loadError")}</AlertTitle>
        <Button type="button" variant="outline" onClick={() => void list.refetch()}>
          <RefreshCw aria-hidden="true" />
          {message("dashboard.retry")}
        </Button>
      </Alert>
    );
  }

  const editingResource = sheetMode === "EDIT" && detail.data?.kind === kind ? detail.data : null;
  return (
    <section className="page-stack">
      <header className="page-header split-header">
        <div>
          <p className="eyebrow">{message("config.eyebrow")}</p>
          <h1>{message(meta.title)}</h1>
          <p>{message(meta.description)}</p>
        </div>
        <Button type="button" onClick={() => setSheetMode("CREATE")}>
          <Plus aria-hidden="true" />
          {formatMessage("config.new", { resource: message(meta.title) })}
        </Button>
      </header>
      <div className="data-panel">
        {list.data.items.length === 0 ? (
          <p className="empty-state">{message("config.empty")}</p>
        ) : (
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((group) => (
                <TableRow key={group.id}>
                  {group.headers.map((header) => (
                    <TableHead key={header.id}>
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
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
            const previous = history.at(-1) ?? null;
            setHistory(history.slice(0, -1));
            setCursor(previous);
          }}
        >
          {message("common.previous")}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={list.data.nextCursor === null}
          onClick={() => {
            setHistory([...history, cursor]);
            setCursor(list.data.nextCursor);
          }}
        >
          {message("common.next")}
        </Button>
      </div>
      <Sheet
        open={sheetMode !== "CLOSED"}
        onOpenChange={(open) => {
          if (!open && editorBlocked) return;
          if (!open) closeSheet();
        }}
      >
        <SheetContent className="w-[min(820px,94vw)]">
          <SheetHeader>
            <SheetTitle>
              {sheetMode === "CREATE"
                ? formatMessage("config.createTitle", { resource: message(meta.title) })
                : formatMessage("config.editTitle", {
                    name: detail.data?.name ?? message(meta.title)
                  })}
            </SheetTitle>
            <SheetDescription>{message("config.sheetDescription")}</SheetDescription>
          </SheetHeader>
          {sheetMode === "EDIT" && detail.isPending ? (
            <Progress aria-label={message("config.loading")} />
          ) : sheetMode === "EDIT" && detail.isError ? (
            <Alert variant="destructive">
              <AlertTitle>{message("config.detailLoadError")}</AlertTitle>
            </Alert>
          ) : rubricReferencesRequired && references.isPending ? (
            <div className="loading-panel">
              <span>{message("config.referencesLoading")}</span>
              <Progress aria-label={message("config.referencesLoading")} />
            </div>
          ) : rubricReferencesRequired && references.isError ? (
            <Alert variant="destructive">
              <AlertTitle>{message("config.referencesError")}</AlertTitle>
              <Button type="button" variant="outline" onClick={() => void references.refetch()}>
                {message("config.referencesRetry")}
              </Button>
            </Alert>
          ) : (
            <ConfigurationEditor
              key={editingResource?.id ?? `create-${kind}`}
              kind={kind}
              resource={editingResource}
              api={api}
              rubricReferences={references.data?.items ?? []}
              onLeaveBlockedChange={setEditorBlocked}
              onSnapshot={(resource) => synchronizeConfigurationSnapshot(queryClient, resource)}
              onSaved={async (resource) => {
                await invalidateConfigurationMutation(queryClient, kind, resource.id);
                closeSheet();
              }}
            />
          )}
        </SheetContent>
      </Sheet>
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deletePendingRef.current && deleteConflict === null) closeDeleteDialog();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {formatMessage("config.deleteTitle", { name: deleteTarget?.name ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteReferences.length === 0
                ? message("config.deleteDescription")
                : message("config.deleteReferenced")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteReferences.map((reference) => (
            <div className="reference-row" key={`${reference.suiteId}:${reference.caseKey}`}>
              <Badge variant="outline">{reference.caseKey}</Badge>
              <span>{reference.suiteId}</span>
            </div>
          ))}
          {deleteReferenceError ? (
            <Alert variant="destructive">
              <AlertTitle>{message("config.referencesError")}</AlertTitle>
              {deleteTarget === null ? null : (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => openDeleteDialog(deleteTarget)}
                >
                  {message("config.referencesRetry")}
                </Button>
              )}
            </Alert>
          ) : null}
          {deleteConflict === null ? null : (
            <Alert>
              <AlertTitle>
                <h3>{message("conflict.title")}</h3>
              </AlertTitle>
              <AlertDescription>
                <p>{message("conflict.description")}</p>
                <p>
                  {formatMessage("conflict.localDraft", {
                    description: deleteConflict.draftName
                  })}
                </p>
                <p>
                  {formatMessage("conflict.serverVersion", {
                    description: deleteConflict.serverName
                  })}
                </p>
                <div className="conflict-actions">
                  <Button
                    type="button"
                    disabled={deletePending}
                    onClick={() => {
                      if (deleteTarget === null) return;
                      const target = deleteTarget;
                      const revision = deleteConflict.serverRevision;
                      setDeleteConflict(null);
                      void finishDelete(target, revision);
                    }}
                  >
                    {message("conflict.retryLatest")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={deletePending}
                    onClick={closeDeleteDialog}
                  >
                    {message("conflict.acceptServer")}
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          )}
          {deleteMutationError ? (
            <Alert variant="destructive">
              <AlertTitle>{message("common.operationFailed")}</AlertTitle>
            </Alert>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletePending || deleteConflict !== null}>
              {message("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={
                deletePending ||
                deleteConflict !== null ||
                deleteReferencesLoading ||
                deleteReferences.length > 0 ||
                deleteReferenceError
              }
              onClick={(event) => {
                event.preventDefault();
                if (deleteTarget === null) return;
                void finishDelete(deleteTarget, deleteTarget.revision);
              }}
            >
              {message("common.confirmDelete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
