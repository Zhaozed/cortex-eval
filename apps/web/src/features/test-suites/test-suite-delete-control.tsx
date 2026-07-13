import type { QueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactElement } from "react";

import { Alert, AlertTitle } from "../../components/ui/alert.tsx";
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
import { Button } from "../../components/ui/button.tsx";
import { ApiClientError } from "../../lib/api-client.ts";
import {
  invalidateTestSuiteDeletion,
  synchronizeTestSuiteSnapshot,
  type ResourceApi
} from "../../lib/resource-api.ts";
import { usePageLeaveBlocker } from "../../lib/use-page-leave-blocker.ts";
import { formatMessage, message } from "../../messages/messages.ts";
import { SuiteConflictNotice, type SuiteEditorConflict } from "./test-suite-notices.tsx";

/** Current Test Suite facts required by conditional deletion. */
export interface DeletableTestSuite {
  /** Human-readable Test Suite name. */
  readonly name: string;
  /** Human-readable Test Suite description. */
  readonly description: string;
  /** Current aggregate Revision. */
  readonly revision: number;
}

/** One deletion confirmation bound to the Suite facts used before reading impact. */
interface TestSuiteDeletionConfirmation {
  /** Suite snapshot whose Revision protects this impact confirmation. */
  readonly suite: DeletableTestSuite;
  /** Server impact read after the Suite snapshot was frozen. */
  readonly impact: {
    /** Current number of child Cases. */
    readonly caseCount: number;
    /** Whether an active Run currently prevents deletion. */
    readonly activeRunReference: boolean;
  };
}

// Re-read lifecycle state after an asynchronous boundary without relying on stale control flow.
function recoveryStopped(
  controller: AbortController,
  mounted: { readonly current: boolean }
): boolean {
  return controller.signal.aborted || !mounted.current;
}

/** Test Suite deletion control properties. */
export interface TestSuiteDeleteControlProps {
  /** Boundary-validating resource API. */
  readonly api: ResourceApi;
  /** Shared TanStack Query cache. */
  readonly queryClient: QueryClient;
  /** Stable Test Suite identity. */
  readonly suiteId: string;
  /** Current visible Test Suite facts. */
  readonly suite: DeletableTestSuite;
  /** Whether another page write owns the mutation slot. */
  readonly disabled: boolean;
  /** Navigate after successful deletion. */
  readonly onDeleted: () => void;
  /** Report impact-read failure to the owning page. */
  readonly onFailureChange: (failed: boolean) => void;
  /** Report deletion writes and conflicts that block leaving the page. */
  readonly onLeaveBlockedChange?: (blocked: boolean) => void;
}

/** Impact-aware Test Suite deletion with repeatable Revision recovery. */
export function TestSuiteDeleteControl({
  api,
  queryClient,
  suiteId,
  suite,
  disabled,
  onDeleted,
  onFailureChange,
  onLeaveBlockedChange
}: TestSuiteDeleteControlProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<TestSuiteDeletionConfirmation | null>(null);
  const [conflict, setConflict] = useState<SuiteEditorConflict | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [pending, setPending] = useState(false);
  const [deleteError, setDeleteError] = useState(false);
  const pendingRef = useRef(false);
  const preparingRef = useRef(false);
  const mountedRef = useRef(true);
  const impactAbortRef = useRef<AbortController | null>(null);
  const recoveryAbortRef = useRef<AbortController | null>(null);
  usePageLeaveBlocker(preparing || pending || conflict !== null, onLeaveBlockedChange);

  useEffect(() => {
    mountedRef.current = true;
    return (): void => {
      mountedRef.current = false;
      impactAbortRef.current?.abort();
      recoveryAbortRef.current?.abort();
    };
  }, []);

  // Read current deletion impact before exposing the irreversible action.
  const openDialog = async (): Promise<void> => {
    if (disabled || preparingRef.current || pendingRef.current) return;
    const suiteSnapshot = suite;
    preparingRef.current = true;
    setPreparing(true);
    setConfirmation(null);
    const controller = new AbortController();
    impactAbortRef.current = controller;
    try {
      const latestImpact = await api.getTestSuiteImpact(suiteId, controller.signal);
      if (controller.signal.aborted || !mountedRef.current) return;
      setConfirmation({ suite: suiteSnapshot, impact: latestImpact });
      setConflict(null);
      setDeleteError(false);
      setOpen(true);
      onFailureChange(false);
    } catch {
      if (!controller.signal.aborted && mountedRef.current) onFailureChange(true);
    } finally {
      if (impactAbortRef.current === controller) impactAbortRef.current = null;
      preparingRef.current = false;
      if (mountedRef.current) setPreparing(false);
    }
  };

  // Delete with one in-flight request and refresh facts after every conflict.
  const finishDeletion = async (): Promise<void> => {
    const currentConfirmation = confirmation;
    if (pendingRef.current || currentConfirmation === null) return;
    pendingRef.current = true;
    setPending(true);
    setDeleteError(false);
    try {
      await api.deleteTestSuite(
        suiteId,
        currentConfirmation.suite.revision,
        new AbortController().signal
      );
      await invalidateTestSuiteDeletion(queryClient, suiteId);
      if (!mountedRef.current) return;
      setConfirmation(null);
      setOpen(false);
      onDeleted();
    } catch (error) {
      if (!mountedRef.current) return;
      if (error instanceof ApiClientError && error.code === "RESOURCE_REVISION_CONFLICT") {
        const recoveryController = new AbortController();
        recoveryAbortRef.current = recoveryController;
        try {
          const latestSuite = await api.getTestSuite(suiteId, recoveryController.signal);
          if (recoveryStopped(recoveryController, mountedRef)) return;
          const latestImpact = await api.getTestSuiteImpact(suiteId, recoveryController.signal);
          if (recoveryStopped(recoveryController, mountedRef)) return;
          const latestConfirmation: TestSuiteDeletionConfirmation = {
            suite: {
              name: latestSuite.name,
              description: latestSuite.description,
              revision: latestSuite.revision
            },
            impact: latestImpact
          };
          setConfirmation(latestConfirmation);
          synchronizeTestSuiteSnapshot(queryClient, latestSuite);
          setConflict({
            draft: {
              name: currentConfirmation.suite.name,
              description: currentConfirmation.suite.description
            },
            serverSnapshot: {
              name: latestSuite.name,
              description: latestSuite.description,
              revision: latestSuite.revision
            }
          });
          return;
        } catch {
          if (recoveryStopped(recoveryController, mountedRef)) return;
          setDeleteError(true);
          return;
        } finally {
          if (recoveryAbortRef.current === recoveryController) {
            recoveryAbortRef.current = null;
          }
        }
      }
      setDeleteError(true);
    } finally {
      pendingRef.current = false;
      if (mountedRef.current) setPending(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        disabled={disabled || preparing || pending || conflict !== null}
        onClick={() => void openDialog()}
      >
        <Trash2 aria-hidden="true" />
        {message("testSuites.delete")}
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (pendingRef.current || conflict !== null) return;
          setOpen(nextOpen);
          if (!nextOpen) {
            setConfirmation(null);
            setConflict(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{message("testSuites.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmation?.impact.activeRunReference === true
                ? message("testSuites.activeRunBlocked")
                : formatMessage("testSuites.deleteDescription", {
                    count: confirmation?.impact.caseCount ?? 0
                  })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {conflict === null ? null : (
            <SuiteConflictNotice
              conflict={conflict}
              retryDisabled={pending || confirmation?.impact.activeRunReference === true}
              onRetry={() => {
                setConflict(null);
                void finishDeletion();
              }}
              onAccept={() => {
                setConfirmation(null);
                setConflict(null);
                setOpen(false);
              }}
            />
          )}
          {deleteError ? (
            <Alert variant="destructive">
              <AlertTitle>{message("common.operationFailed")}</AlertTitle>
            </Alert>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending || conflict !== null}>
              {message("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={
                pending || conflict !== null || confirmation?.impact.activeRunReference !== false
              }
              onClick={(event) => {
                event.preventDefault();
                void finishDeletion();
              }}
            >
              {message("common.confirmDelete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
