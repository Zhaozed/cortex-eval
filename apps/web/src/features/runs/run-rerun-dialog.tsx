import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactElement } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription
} from "../../components/ui/sheet.tsx";
import { Button } from "../../components/ui/button.tsx";
import type { RunApi, PlatformRunDetail } from "../../lib/run-api.ts";
import { RunMetadataFields } from "./run-metadata-fields.tsx";

/** Edit labels before freezing a new Run, never mutate the source. */
export function RunRerunDialog({
  api,
  run,
  onClose,
  onNavigate
}: {
  readonly api: RunApi;
  readonly run: PlatformRunDetail;
  readonly onClose: () => void;
  readonly onNavigate: (path: string) => void;
}): ReactElement {
  const [name, setName] = useState((run.name ?? run.suite.name).slice(0, 120));
  const [description, setDescription] = useState(run.description ?? "");
  const client = useQueryClient();
  const create = useMutation({
    mutationFn: () =>
      api.createRerun(run.id, "FORCE", new AbortController().signal, {
        name: name.trim(),
        description: description.trim()
      }),
    onSuccess: async (result) => {
      await client.invalidateQueries({ queryKey: ["runs"] });
      onClose();
      onNavigate(`/runs/${encodeURIComponent(result.runId)}`);
    }
  });
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open && !create.isPending) onClose();
      }}
    >
      <SheetContent className="run-rerun-sheet">
        <SheetHeader>
          <SheetTitle>再次运行</SheetTitle>
          <SheetDescription>
            沿用原运行的冻结配置和 Case，创建新的运行，原结果保持不变。
          </SheetDescription>
        </SheetHeader>
        <form
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim() && !create.isPending) create.mutate();
          }}
        >
          <fieldset className="editor-fieldset" disabled={create.isPending}>
            <p className="run-muted">测试集：{run.suite.name}</p>
            <RunMetadataFields
              name={name}
              description={description}
              onName={setName}
              onDescription={setDescription}
            />
            <p className="run-muted">
              创建后需手动开始。平台不会自动初始化或清理业务数据；写入类 Case
              执行前请确认账号与副作用范围。
            </p>
          </fieldset>
          {create.isError && <p role="alert">创建失败，请检查运行状态或输入后重试。</p>}
          <div className="run-rerun-actions">
            <Button type="button" variant="outline" disabled={create.isPending} onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={create.isPending || !name.trim()}>
              {create.isPending ? "正在创建…" : "创建运行"}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
