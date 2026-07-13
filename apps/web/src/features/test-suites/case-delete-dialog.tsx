import type { ReactElement } from "react";

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
import { formatMessage, message } from "../../messages/messages.ts";
import type { ApiClientError } from "../../lib/api-client.ts";
import {
  CaseMutationConflictNotice,
  type CaseMutationConflict
} from "./case-mutation-conflict-notice.tsx";

/** Case delete confirmation properties. */
export interface CaseDeleteDialogProps {
  /** Target Case identity, or null while closed. */
  readonly caseKey: string | null;
  /** Current dual-Revision conflict decision. */
  readonly conflict: CaseMutationConflict | null;
  /** Whether one Case mutation is currently in flight. */
  readonly pending: boolean;
  /** Sanitized non-Revision failure retained inside the Dialog. */
  readonly error: ApiClientError | null;
  /** Notify the detail page when visibility changes. */
  readonly onOpenChange: (open: boolean) => void;
  /** Confirm conditional deletion of the current target. */
  readonly onConfirm: () => void;
}

/** Case delete Dialog retaining its target through conflict recovery. */
export function CaseDeleteDialog({
  caseKey,
  conflict,
  pending,
  error,
  onOpenChange,
  onConfirm
}: CaseDeleteDialogProps): ReactElement {
  return (
    <AlertDialog open={caseKey !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {formatMessage("caseList.deleteTitle", { caseKey: caseKey ?? "" })}
          </AlertDialogTitle>
          <AlertDialogDescription>{message("caseList.deleteDescription")}</AlertDialogDescription>
        </AlertDialogHeader>
        {conflict === null ? null : (
          <CaseMutationConflictNotice conflict={conflict} pending={pending} />
        )}
        {error === null ? null : (
          <Alert variant="destructive">
            <AlertTitle>{message("common.operationFailed")}</AlertTitle>
          </Alert>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending || conflict !== null}>
            {message("common.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={pending || conflict !== null}
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
          >
            {message("common.confirmDelete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
