import type { ReactElement } from "react";

import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert.tsx";
import { Button } from "../../components/ui/button.tsx";
import { formatMessage, message } from "../../messages/messages.ts";

/** Case operations whose local input must survive a Suite Revision conflict. */
export type CaseMutationConflictKind = "CREATE" | "COPY" | "DELETE" | "IMPORT";

/** Retry-or-discard state for a non-edit Case mutation with current remote facts. */
export interface RetryableCaseMutationConflict {
  /** Explicit recovery mode. */
  readonly recoveryState: "RETRYABLE";
  /** Operation owning the retained Dialog or Sheet. */
  readonly kind: CaseMutationConflictKind;
  /** Stable description of the retained local operation. */
  readonly draftLabel: string;
  /** Latest refetched aggregate Test Suite Revision. */
  readonly serverSuiteRevision: number;
  /** Retry with the refetched Suite and optional Case Revision. */
  readonly onRetry: () => void;
  /** Discard the retained operation and accept current server facts. */
  readonly onAccept: () => void;
}

/** Accept-only state when a conditional delete finds the remote Case already deleted. */
export interface DeletedCaseMutationConflict {
  /** Explicit recovery mode. */
  readonly recoveryState: "REMOTE_CASE_DELETED";
  /** Only deletion can converge on an already-deleted remote fact. */
  readonly kind: "DELETE";
  /** Stable description of the retained local operation. */
  readonly draftLabel: string;
  /** Latest refetched aggregate Test Suite Revision. */
  readonly serverSuiteRevision: number;
  /** Accept the already-deleted remote fact and close the retained operation. */
  readonly onAccept: () => void;
}

/** Explicit recovery decision for one non-edit Case mutation. */
export type CaseMutationConflict = RetryableCaseMutationConflict | DeletedCaseMutationConflict;

/** Accessible Draft-versus-Snapshot decision for Case mutations. */
export function CaseMutationConflictNotice({
  conflict,
  pending
}: {
  readonly conflict: CaseMutationConflict;
  /** Whether the retained operation is currently retrying. */
  readonly pending: boolean;
}): ReactElement {
  const remoteCaseDeleted = conflict.recoveryState === "REMOTE_CASE_DELETED";
  return (
    <Alert>
      <AlertTitle>
        <h3>
          {message(
            remoteCaseDeleted ? "caseMutation.remoteDeletedTitle" : "caseMutation.conflictTitle"
          )}
        </h3>
      </AlertTitle>
      <AlertDescription>
        <p>
          {message(
            remoteCaseDeleted
              ? "caseMutation.remoteDeletedDescription"
              : "caseMutation.conflictDescription"
          )}
        </p>
        <p>{formatMessage("caseMutation.localDraft", { description: conflict.draftLabel })}</p>
        <p>
          {formatMessage("caseMutation.serverRevision", {
            revision: conflict.serverSuiteRevision
          })}
        </p>
        <div className="conflict-actions">
          {remoteCaseDeleted ? null : (
            <Button type="button" disabled={pending} onClick={conflict.onRetry}>
              {message("conflict.retryLatest")}
            </Button>
          )}
          <Button type="button" variant="outline" disabled={pending} onClick={conflict.onAccept}>
            {message(remoteCaseDeleted ? "conflict.acceptDeleted" : "conflict.acceptServer")}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
