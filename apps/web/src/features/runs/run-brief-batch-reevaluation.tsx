import { useMutation } from "@tanstack/react-query";
import type { ReactElement } from "react";
import type { BriefReevaluationOptions } from "@cortex-eval/contracts/src/run-api-contracts.ts";
import type { DashboardCase } from "./run-dashboard-model.ts";
import type { RunApi } from "../../lib/run-api.ts";
import { BriefReevaluationForm } from "./run-brief-reevaluation.tsx";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription
} from "../../components/ui/sheet.tsx";

export function BriefBatchReevaluation({
  api,
  runId,
  rows,
  sourceModel,
  open,
  onClose,
  onNavigate
}: {
  readonly api: RunApi;
  readonly runId: string;
  readonly rows: readonly DashboardCase[];
  readonly sourceModel?: string | undefined;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onNavigate: (path: string) => void;
}): ReactElement | null {
  const mutation = useMutation({
    mutationFn: ({ options, name }: { options: BriefReevaluationOptions; name: string }) => {
      if (!api.createBriefReevaluation) throw new Error("UNAVAILABLE");
      return api.createBriefReevaluation(runId, options, new AbortController().signal, name);
    },
    onSuccess: (result) => {
      onClose();
      onNavigate(`/runs/${encodeURIComponent(result.runId)}`);
    }
  });
  const contract = rows[0]?.definition?.semanticEvaluation;
  if (!contract?.brief) return null;
  return (
    <Sheet
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <SheetContent className="brief-calibration-sheet">
        <SheetHeader>
          <SheetTitle>新建裁判版本</SheetTitle>
          <SheetDescription>
            固定样本，只评裁判。更换模型、Prompt 或 Rubric，比较评分差异。
          </SheetDescription>
        </SheetHeader>
        {open && (
          <BriefReevaluationForm
            key={runId}
            batch
            sampleCount={rows.length}
            sourceRunId={runId}
            sourceModel={sourceModel}
            profile={contract.brief}
            evaluatorPrompt={contract.evaluatorPrompt}
            pending={mutation.isPending}
            failed={mutation.isError}
            onCancel={onClose}
            onSubmit={(options, name) => mutation.mutate({ options, name })}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}
