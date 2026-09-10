import { useEffect, useState, type ReactElement } from "react";
import type { ResourceApi, CaseImportPreview } from "../../lib/resource-api.ts";
import { Button } from "../../components/ui/button.tsx";

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
import { ApiClientError } from "../../lib/api-client.ts";
import { formatMessage, message } from "../../messages/messages.ts";
import {
  CaseMutationConflictNotice,
  type CaseMutationConflict
} from "./case-mutation-conflict-notice.tsx";
import { CaseImportErrorNotice } from "./test-suite-notices.tsx";

/** Bounded full-import confirmation properties. */
export interface CaseImportDialogProps {
  readonly api: ResourceApi;
  readonly suiteId: string;
  readonly revision: number;
  readonly onRefreshSuite: () => void;

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
  readonly onConfirm: (file: File, revision: number) => void;
}

/** Full-import Dialog retaining file, item error and conflict decisions. */
export function CaseImportDialog({
  api,
  suiteId,
  revision,
  onRefreshSuite,
  file,
  caseCount,
  error,
  conflict,
  pending,
  onOpenChange,
  onConfirm
}: CaseImportDialogProps): ReactElement {
  const [attempt, setAttempt] = useState(0);
  const [check, setCheck] = useState<{
    file: File;
    revision: number;
    result?: CaseImportPreview;
    error?: ApiClientError;
  } | null>(null);
  useEffect(() => {
    if (!file) {
      setCheck(null);
      return;
    }
    const controller = new AbortController();
    setCheck(null);
    void api.previewCases(suiteId, revision, file, controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) setCheck({ file, revision, result });
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setCheck({
            file,
            revision,
            error:
              error instanceof ApiClientError ? error : new ApiClientError("CLIENT_REQUEST_FAILED")
          });
      }
    );
    return (): void => controller.abort();
  }, [api, suiteId, revision, file, attempt]);
  const current = check?.file === file && check.revision === revision ? check : null;
  const result = current?.result;
  const checking = file !== null && current === null;
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
        <section
          className="import-preflight"
          aria-label="导入预检"
          aria-live="polite"
          aria-busy={checking}
        >
          {checking && <p>正在校验文件、断言规则与 Rubric 引用，尚未写入…</p>}
          {result && (
            <>
              <dl className="import-impact-grid">
                {(
                  [
                    ["新增", result.preview.added],
                    ["修改", result.preview.modified],
                    ["移除", result.preview.removed],
                    ["未变化", result.preview.unchanged]
                  ] as const
                ).map(([label, count]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{count}</dd>
                  </div>
                ))}
              </dl>
              <p>
                导入后共 {result.count} 个 Case。
                {result.preview.reordered > 0
                  ? `另有 ${result.preview.reordered} 个 Case 的顺序变化。`
                  : ""}
              </p>
              {result.preview.removed > 0 && (
                <p className="import-removal-warning">
                  将移除 {result.preview.removed} 个现有 Case；历史运行记录保留。
                </p>
              )}
              <p className="muted">
                预检通过仅代表配置可接受，不代表业务验收通过；未调用 Agent 或评分模型。
              </p>
            </>
          )}
          {current?.error && (
            <>
              <CaseImportErrorNotice error={current.error} />
              <Button
                variant="outline"
                onClick={() => {
                  onRefreshSuite();
                  setAttempt((value) => value + 1);
                }}
              >
                重新预检
              </Button>
            </>
          )}
        </section>
        {error === null ? null : <CaseImportErrorNotice error={error} />}
        {conflict === null ? null : (
          <CaseMutationConflictNotice conflict={conflict} pending={pending} />
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending || conflict !== null}>
            {message("common.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={pending || conflict !== null || !result}
            onClick={(event) => {
              event.preventDefault();
              if (file !== null && result) onConfirm(file, result.suite.revision);
            }}
          >
            {message("testSuites.importConfirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
