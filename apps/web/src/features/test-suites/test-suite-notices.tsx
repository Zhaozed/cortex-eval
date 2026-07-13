import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert.tsx";
import { Button } from "../../components/ui/button.tsx";
import type { ApiClientError } from "../../lib/api-client.ts";
import { formatMessage, message } from "../../messages/messages.ts";
import type { ReactElement } from "react";

/** Explicit local Draft and refetched server Snapshot for Suite metadata conflicts. */
export interface SuiteEditorConflict {
  /** User input that must survive a failed optimistic update. */
  readonly draft: { readonly name: string; readonly description: string };
  /** Latest server facts used for retry or deliberate replacement. */
  readonly serverSnapshot: {
    /** Latest server display name. */
    readonly name: string;
    /** Latest server description. */
    readonly description: string;
    /** Latest optimistic-concurrency token. */
    readonly revision: number;
  };
}

// Format only validated import error fields from the sanitized API boundary.
function importErrorDescription(error: ApiClientError): string {
  if (error.importIndex === null || error.caseKey === null) {
    return message("testSuites.importUnknownError");
  }
  if (error.fieldPath === null) {
    return formatMessage("testSuites.importItemErrorWithoutPath", {
      index: error.importIndex + 1,
      caseKey: error.caseKey,
      causeCode: error.causeCode ?? error.code
    });
  }
  return formatMessage("testSuites.importItemError", {
    index: error.importIndex + 1,
    caseKey: error.caseKey,
    path: error.fieldPath
  });
}

/** Sanitized batch-import failure shown inside the retained confirmation dialog. */
export function CaseImportErrorNotice({ error }: { readonly error: ApiClientError }): ReactElement {
  return (
    <Alert variant="destructive">
      <AlertTitle>{message("common.operationFailed")}</AlertTitle>
      <AlertDescription>{importErrorDescription(error)}</AlertDescription>
    </Alert>
  );
}

/** Explicit Suite Draft-versus-Snapshot conflict decision. */
export function SuiteConflictNotice({
  conflict,
  onRetry,
  onAccept,
  retryDisabled = false,
  acceptDisabled = false
}: {
  readonly conflict: SuiteEditorConflict;
  readonly onRetry: () => void;
  readonly onAccept: () => void;
  /** Whether current server facts prohibit or defer a retry. */
  readonly retryDisabled?: boolean;
  /** Whether a concurrent operation defers accepting the Snapshot. */
  readonly acceptDisabled?: boolean;
}): ReactElement {
  return (
    <Alert>
      <AlertTitle>
        <h3>{message("conflict.title")}</h3>
      </AlertTitle>
      <AlertDescription>
        <p>{message("conflict.description")}</p>
        <p>{formatMessage("conflict.localDraft", { description: conflict.draft.name })}</p>
        <p>
          {formatMessage("conflict.serverVersion", { description: conflict.serverSnapshot.name })}
        </p>
        <div className="conflict-actions">
          <Button type="button" disabled={retryDisabled} onClick={onRetry}>
            {message("conflict.retryLatest")}
          </Button>
          <Button type="button" variant="outline" disabled={acceptDisabled} onClick={onAccept}>
            {message("conflict.acceptServer")}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
