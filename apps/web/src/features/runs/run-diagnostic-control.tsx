import { useState, type ReactElement } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, LoaderCircle } from "lucide-react";
import { DIAGNOSTIC_STATUS_LABELS } from "@cortex-eval/contracts/src/diagnostic-report-contracts.ts";
import { Button } from "../../components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "../../components/ui/dialog.tsx";
import { Progress } from "../../components/ui/progress.tsx";
import { createResourceApi, type ResourceApi } from "../../lib/resource-api.ts";
import { diagnosticReportApi, type DiagnosticReportApi } from "../../lib/diagnostic-report-api.ts";
import { dashboardPages } from "./run-dashboard-model.ts";
import { RunDiagnosticDocument } from "./run-diagnostic-document.tsx";
import "./run-diagnostic.css";

const resources = createResourceApi();
const active = (value: { status: string } | undefined): boolean =>
  value?.status === "RUNNING" || value?.status === "QUEUED";
const preference = "cortex.diagnostic-model";
function preferred(): string {
  try {
    return localStorage.getItem(preference) ?? "";
  } catch {
    return "";
  }
}

/** One report entry; no second basic-report mode, no Prompt setup required. */
export function RunDiagnosticControl({
  runId,
  ready,
  defaultModelId,
  api = diagnosticReportApi,
  resourceApi = resources
}: {
  runId: string;
  ready: boolean;
  defaultModelId?: string | null;
  api?: DiagnosticReportApi;
  resourceApi?: ResourceApi;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [chosenModel, setChosenModel] = useState(preferred);
  const client = useQueryClient();
  const listKey = ["diagnostic-reports", runId];
  const history = useQuery({
    queryKey: listKey,
    queryFn: ({ signal }) => api.list(runId, signal),
    enabled: open,
    refetchInterval: (q) => (q.state.data?.some(active) ? 2000 : false),
    retry: false
  });
  const models = useQuery({
    queryKey: ["diagnostic-models"],
    enabled: open,
    retry: false,
    queryFn: ({ signal }) =>
      dashboardPages((cursor) =>
        resourceApi.listConfigurations("LLM", { cursor, limit: 100 }, signal)
      )
  });
  const modelId = models.data?.some((m) => m.id === chosenModel)
    ? chosenModel
    : models.data?.some((m) => m.id === defaultModelId)
      ? (defaultModelId ?? "")
      : (models.data?.[0]?.id ?? "");
  const selectedId = selected ?? history.data?.[0]?.id ?? null;
  const selectedSummary = history.data?.find((r) => r.id === selectedId);
  const detail = useQuery({
    queryKey: [
      "diagnostic-report",
      runId,
      selectedId,
      selectedSummary?.completedCases,
      selectedSummary?.status
    ],
    queryFn: ({ signal }) => {
      if (selectedId === null) throw new Error("DIAG_NOT_SELECTED");
      return api.get(runId, selectedId, signal);
    },
    enabled: open && selectedId !== null,
    retry: false
  });
  const busy = history.data?.some(active) ?? false;
  const start = useMutation({
    mutationFn: () => api.start(runId, modelId),
    onSuccess: async (report) => {
      setSelected(report.id);
      try {
        localStorage.setItem(preference, modelId);
      } catch {
        /* Optional preference only. */
      }
      await client.invalidateQueries({ queryKey: listKey });
    }
  });
  const cancel = useMutation({
    mutationFn: (id: string) => api.cancel(runId, id),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: listKey });
      await client.invalidateQueries({ queryKey: ["diagnostic-report", runId] });
    }
  });
  const report = detail.data;
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <FileText size={15} aria-hidden="true" />
        生成归因报告
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="diagnostic-dialog">
          <DialogHeader>
            <DialogTitle>评测归因报告</DialogTitle>
            <DialogDescription>
              复用已有模型，基于本次冻结结果与执行证据生成。可关闭窗口，后台继续。
            </DialogDescription>
          </DialogHeader>
          <div className="diagnostic-toolbar">
            <label>
              分析模型
              <select
                aria-label="报告分析模型"
                value={modelId}
                disabled={busy || start.isPending}
                onChange={(e) => setChosenModel(e.target.value)}
              >
                <option value="" disabled>
                  选择模型
                </option>
                {models.data?.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            <Button
              disabled={
                !ready ||
                !modelId ||
                busy ||
                start.isPending ||
                history.isPending ||
                history.isError
              }
              onClick={() => start.mutate()}
            >
              {start.isPending
                ? "提交中…"
                : busy
                  ? "后台生成中…"
                  : history.data?.length
                    ? "生成新版本"
                    : "生成报告"}
            </Button>
            {!!history.data?.length && (
              <label>
                历史版本
                <select
                  aria-label="报告版本"
                  value={selectedId ?? ""}
                  onChange={(e) => setSelected(e.target.value)}
                >
                  {history.data.map((r) => (
                    <option value={r.id} key={r.id}>
                      v{r.version} · {DIAGNOSTIC_STATUS_LABELS[r.status]} · {r.model.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {report?.snapshot && (
              <div className="diagnostic-exports">
                <Button asChild size="sm" variant="outline">
                  <a href={api.exportUrl(runId, report.id, "md")}>下载 Markdown</a>
                </Button>
                <Button asChild size="sm" variant="outline">
                  <a
                    href={api.exportUrl(runId, report.id, "html")}
                    target="_blank"
                    rel="noreferrer"
                  >
                    打印 / 保存 PDF
                  </a>
                </Button>
              </div>
            )}
          </div>
          <p className="diagnostic-boundary">
            模型仅接收平台已保存的证据，不会自动读取 Agent
            项目日志或源码。生成会向所选模型服务发送经凭据脱敏的业务内容。
          </p>
          {!ready && <p role="alert">完整评测结果尚未就绪，暂不能生成报告；已有报告仍可查看。</p>}
          {models.isError && (
            <p role="alert">
              模型列表读取失败。
              <Button variant="link" onClick={() => void models.refetch()}>
                重试模型列表
              </Button>
            </p>
          )}
          {models.isSuccess && !models.data.length && (
            <p role="alert">尚未配置模型，请先在「模型配置」中添加可用模型。</p>
          )}
          {history.isError && (
            <p role="alert">
              历史报告读取失败。
              <Button variant="link" onClick={() => void history.refetch()}>
                重试历史报告
              </Button>
            </p>
          )}
          {start.isError && (
            <p role="alert">
              无法开始生成，请检查结果是否完整、模型是否存在，或稍后重试。不会重新执行评测。
            </p>
          )}
          {cancel.isError && <p role="alert">取消失败，请刷新报告状态后重试。</p>}
          <div className="diagnostic-scroll">
            {detail.isError && (
              <p role="alert">
                报告读取失败。
                <Button variant="link" onClick={() => void detail.refetch()}>
                  重试读取报告
                </Button>
              </p>
            )}
            {selectedId && detail.isPending && <p role="status">正在读取报告…</p>}
            {!selectedId && !history.isPending && !history.isError && (
              <div className="diagnostic-empty">
                <FileText size={40} aria-hidden="true" />
                <h3>把评测结果整理成研发可用的报告</h3>
                <p>结论与范围 → 失败项 → 证据链 → 候选原因 → 修复与回归建议</p>
                <p>事实由平台计算，原因由模型解释；证据不足会明确标注。</p>
              </div>
            )}
            {report && (
              <>
                <div className="diagnostic-job" role="status">
                  <strong>
                    {active(report) && (
                      <LoaderCircle className="diagnostic-spinner" size={15} aria-hidden="true" />
                    )}
                    {DIAGNOSTIC_STATUS_LABELS[report.status]}
                  </strong>
                  <span>
                    {report.phase === "SNAPSHOT"
                      ? "正在整理冻结事实…"
                      : `已处理 ${report.completedCases} / ${report.totalCases} 个待关注 Case`}
                  </span>
                  {active(report) && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={cancel.isPending}
                      onClick={() => cancel.mutate(report.id)}
                    >
                      取消生成
                    </Button>
                  )}
                </div>
                {active(report) && report.totalCases > 0 && (
                  <Progress
                    aria-label="归因进度"
                    value={(report.completedCases / report.totalCases) * 100}
                  />
                )}
                {report.error && (
                  <p className="diagnostic-notice" role="alert">
                    {report.error}
                  </p>
                )}
                <RunDiagnosticDocument report={report} />
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
