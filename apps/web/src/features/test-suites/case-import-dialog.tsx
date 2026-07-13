import type { ReactElement } from "react";

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
import type { ApiClientError } from "../../lib/api-client.ts";
import { formatMessage, message } from "../../messages/messages.ts";
import {
  CaseMutationConflictNotice,
  type CaseMutationConflict
} from "./case-mutation-conflict-notice.tsx";
import { CaseImportErrorNotice } from "./test-suite-notices.tsx";

/** Bounded full-import confirmation properties. */
export interface CaseImportDialogProps {
  /** Selected JSON file, or null while closed. */
  readonly file: File | null;
  /** Current Case count replaced by a successful import. */
  readonly caseCount: number;
  /** Sanitized item failure retained after a failed import. */
  readonly error: ApiClientError | null;
  /** Current Suite Revision conflict decision. */
  readonly conflict: CaseMutationConflict | null;
  /** Whether one Case mutation is currently in flight. */
  readonly pending: boolean;
  /** Notify the detail page when visibility changes. */
  readonly onOpenChange: (open: boolean) => void;
  /** Confirm import of the selected file. */
  readonly onConfirm: (file: File) => void;
}

/** Full-import Dialog retaining file, item error and conflict decisions. */
export function CaseImportDialog({
  file,
  caseCount,
  error,
  conflict,
  pending,
  onOpenChange,
  onConfirm
}: CaseImportDialogProps): ReactElement {
  return (
    <AlertDialog open={file !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{message("testSuites.importTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {formatMessage("testSuites.importDescription", {
              filename: file?.name ?? "",
              count: caseCount
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error === null ? null : <CaseImportErrorNotice error={error} />}
        {conflict === null ? null : (
          <CaseMutationConflictNotice conflict={conflict} pending={pending} />
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending || conflict !== null}>
            {message("common.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={pending || conflict !== null}
            onClick={(event) => {
              event.preventDefault();
              if (file !== null) onConfirm(file);
            }}
          >
            {message("testSuites.importConfirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
