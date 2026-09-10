import { useState, type ReactElement } from "react";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "../../components/ui/button.tsx";
import { createResourceApi, type ResourceApi } from "../../lib/resource-api.ts";
import type { RunApi } from "../../lib/run-api.ts";
import { dashboardPages } from "./run-dashboard-model.ts";

const resources = createResourceApi();

/** Explicit Run-wide action. Results remain attached to Case evidence, never a second page. */
export function RunAnalysisControl({
  api,
  runId,
  resourceApi = resources
}: {
  readonly api: RunApi;
  readonly runId: string;
  readonly resourceApi?: ResourceApi;
}): ReactElement {
  const client = useQueryClient();
  const busy = useIsMutating({ mutationKey: ["runs", "analysis-start", runId] }) > 0;
  const [modelId, setModelId] = useState("");
  const [promptId, setPromptId] = useState("");
  const [selector, setSelector] = useState<"failed" | "errors" | "all">("failed");
  const configurations = useQuery({
    queryKey: ["configurations", "run-analysis-options"],
    queryFn: async ({ signal }) => {
      const load = (kind: "LLM" | "CASE_ANALYSIS_PROMPT") =>
        dashboardPages((cursor) =>
          resourceApi.listConfigurations(kind, { cursor, limit: 100 }, signal)
        );
      const [models, prompts] = await Promise.all([load("LLM"), load("CASE_ANALYSIS_PROMPT")]);
      return { models, prompts };
    },
    retry: false
  });
  const start = useMutation({
    mutationKey: ["runs", "analysis-start", runId],
    mutationFn: () =>
      api.startAnalysis(
        runId,
        {
          analyzerConfigId: modelId,
          analysisPromptId: promptId,
          selector
        },
        new AbortController().signal
      ),
    onSettled: async () => {
      // Partial batches can leave useful evidence even when the request fails.
      await client.invalidateQueries({ queryKey: ["runs", "analysis", runId] });
    }
  });
  const valid =
    configurations.data?.models.some((item) => item.id === modelId) &&
    configurations.data.prompts.some((item) => item.id === promptId);
  return (
    <section className="run-analysis-control" aria-label="分析本次运行">
      <div className="run-analysis-control-heading">
        <strong>分析本次运行</strong>
        <span>批量分析所选问题，结果在 Case 执行链路中查看，不改变评测结论。</span>
      </div>
      {configurations.isPending ? (
        <p role="status">读取分析配置…</p>
      ) : configurations.isError ? (
        <p role="alert">
          分析配置读取失败。
          <Button size="sm" variant="link" onClick={() => void configurations.refetch()}>
            重试
          </Button>
        </p>
      ) : (
        <div className="run-analysis-control-fields">
          <label>
            分析模型
            <select
              value={modelId}
              disabled={busy}
              onChange={(event) => setModelId(event.target.value)}
            >
              <option value="">选择模型配置</option>
              {configurations.data.models.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            分析 Prompt
            <select
              value={promptId}
              disabled={busy}
              onChange={(event) => setPromptId(event.target.value)}
            >
              <option value="">选择分析 Prompt</option>
              {configurations.data.prompts.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            分析范围
            <select
              value={selector}
              disabled={busy}
              onChange={(event) => setSelector(event.target.value as typeof selector)}
            >
              <option value="failed">自动评测未通过</option>
              <option value="errors">评测异常</option>
              <option value="all">全部问题（未通过 + 评测异常）</option>
            </select>
          </label>
          <Button size="sm" disabled={!valid || busy} onClick={() => start.mutate()}>
            {busy ? "分析中…" : "开始分析"}
          </Button>
        </div>
      )}
      {configurations.data &&
        (!configurations.data.models.length || !configurations.data.prompts.length) && (
          <p className="run-muted">请先在配置中心添加模型配置和分析 Prompt。</p>
        )}
      {start.isError && (
        <p role="alert">分析请求失败，请检查模型配置或服务日志。已产生的分析记录会保留。</p>
      )}
      {start.data && (
        <p role="status">
          本批次 {start.data.selectedCount} 条 · 分析完成 {start.data.succeededCount} 条 · 分析异常{" "}
          {start.data.errorCount} 条
        </p>
      )}
    </section>
  );
}
