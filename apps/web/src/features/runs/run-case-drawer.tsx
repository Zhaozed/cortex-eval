import { RunAnalysisControl } from "./run-analysis-control.tsx";
import type { ReactElement } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import {
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription
} from "../../components/ui/sheet.tsx";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../../components/ui/tabs.tsx";
import { ApiClientError } from "../../lib/api-client.ts";
import type { RunApi } from "../../lib/run-api.ts";
import { runReviewApi } from "../../lib/run-review-api.ts";
import { evaluationState, type DashboardCase } from "./run-dashboard-model.ts";
import { agentUsage, object, userText } from "./run-evidence-model.ts";
import { EvidenceJson, RunTracePanel } from "./run-trace-panel.tsx";
import { ReviewForm } from "./run-case-review.tsx";
import { RunCaseChecks } from "./run-case-checks.tsx";
import { RunCaseOutput } from "./run-case-output.tsx";
import { RunCaseUsage } from "./run-case-usage.tsx";
import { visualReviewRequired } from "./run-output-model.ts";
import { message } from "../../messages/messages.ts";
/** a2ui is a deep-link intent into the result pane, not a third tab. */
export type CaseTab = "result" | "trace" | "a2ui";

export function RunCaseDrawer({
  api,
  runId,
  row,
  tab,
  onTab,
  previous,
  next,
  onClose,
  onNavigate,
  canRerun
}: {
  readonly api: RunApi;
  readonly runId: string;
  readonly row: DashboardCase;
  readonly tab: CaseTab;
  readonly onTab: (tab: CaseTab) => void;
  readonly previous: (() => void) | undefined;
  readonly next: (() => void) | undefined;
  readonly onClose: () => void;
  readonly onNavigate: (path: string) => void;
  readonly canRerun: boolean;
}): ReactElement {
  const [wide, setWide] = useState(false);
  const [confirm, setConfirm] = useState<"rerun" | "reeval" | null>(null);
  const detail = useQuery({
    queryKey: ["runs", "case", runId, row.caseKey],
    queryFn: ({ signal }) => api.getCase(runId, row.caseKey, signal),
    enabled: row.report === undefined
  });
  const review = useQuery({
    queryKey: ["run-reviews", runId, row.caseKey],
    queryFn: ({ signal }) => runReviewApi.get(runId, row.caseKey, signal),
    retry: false
  });
  const fullRow: DashboardCase = {
    ...(detail.data ? { ...row, rest: detail.data, definition: detail.data.definition } : row),
    review: review.data ?? row.review
  };
  const analysis = useQuery({
    queryKey: ["runs", "analysis", runId, row.caseKey],
    queryFn: ({ signal }) => api.getAnalysis(runId, row.caseKey, signal),
    enabled:
      tab === "trace" &&
      !!fullRow.evaluation?.finalCaseResultHash &&
      ["FAIL", "EVALUATION_ERROR"].includes(fullRow.evaluation.status),
    retry: false,
    refetchInterval: (query) =>
      ["PENDING", "RUNNING"].includes(query.state.data?.status ?? "") ? 4000 : false
  });
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const [traceTarget, setTraceTarget] = useState<string | null>(null);
  useEffect(() => {
    const target = tab === "a2ui" ? "case-a2ui-evidence" : tab === "trace" ? traceTarget : null;
    if (!target) return;
    const frame = requestAnimationFrame(() => {
      const element = document.getElementById(target);
      let group = element?.closest("details");
      while (group) {
        group.open = true;
        group = group.parentElement?.closest("details") ?? null;
      }
      if (element && typeof element.scrollIntoView === "function")
        element.scrollIntoView({ block: tab === "a2ui" ? "start" : "center" });
      element?.focus({ preventScroll: true });
    });
    return (): void => cancelAnimationFrame(frame);
  }, [tab, traceTarget, review.data]);
  const runAgain = useMutation({
    mutationFn: async (onlyEval: boolean) => {
      if (!api.createCaseRerun) throw new Error("UNAVAILABLE");
      return api.createCaseRerun(runId, row.caseKey, onlyEval, new AbortController().signal);
    },
    onSuccess: (result) => onNavigate(`/runs/${encodeURIComponent(result.runId)}`)
  });
  const definition = fullRow.definition,
    evaluation = fullRow.evaluation,
    usage = agentUsage([fullRow]);
  return (
    <SheetContent className={`run-case-drawer${wide ? " run-case-drawer-wide" : ""}`}>
      <SheetHeader>
        <SheetTitle>
          {row.caseKey}{" "}
          <Badge variant="outline" data-status={evaluationState(fullRow)}>
            {message(`rd.eval.${evaluationState(fullRow)}`)}
          </Badge>
        </SheetTitle>
        <SheetDescription>{definition?.description ?? "描述未记录"}</SheetDescription>
      </SheetHeader>
      <div className="run-case-toolbar">
        <span className="run-case-top-usage">
          执行耗时 {`${(fullRow.rest.durationMs / 1000).toFixed(2)} s`}
          <small>
            Agent {usage.recorded ? usage.total.toLocaleString() : "未采集"}
            {usage.recorded > 0 && !usage.complete ? "（部分）" : ""} · Judge{" "}
            {evaluation?.tokenUsage?.totalTokens.toLocaleString() ?? "未采集"} Token
          </small>
        </span>
        <Button size="sm" variant="ghost" onClick={() => setWide(!wide)}>
          {wide ? "还原宽度" : "全宽查看"}
        </Button>
        <Button size="sm" variant="outline" disabled={!previous} onClick={previous}>
          上一条
        </Button>
        <Button size="sm" variant="outline" disabled={!next} onClick={next}>
          下一条
        </Button>
        {canRerun && api.createCaseRerun && (
          <>
            <Button size="sm" variant="outline" onClick={() => setConfirm("rerun")}>
              重跑 Case
            </Button>
            {row.rest.status === "SUCCEEDED" && (
              <Button size="sm" variant="outline" onClick={() => setConfirm("reeval")}>
                仅重新评测
              </Button>
            )}
          </>
        )}
        <Button size="sm" variant="ghost" onClick={onClose}>
          关闭
        </Button>
      </div>
      {confirm && (
        <section className="run-action-confirm">
          <strong>{confirm === "reeval" ? "仅重新评测保存的证据" : "新建单 Case 运行"}</strong>
          <p>
            {confirm === "reeval"
              ? "复用该 Case 的输入、输出和 Trace，不再请求 Agent；评测会调用已配置的评测模型。"
              : "平台没有自动初始化或清理业务数据。执行前请确认测试账号、可写范围和已有数据；写入类 Case 可能重复创建资源。"}{" "}
            将新建运行，原记录不变。创建后还需点击开始执行。
          </p>
          <Button
            size="sm"
            disabled={runAgain.isPending}
            onClick={() => runAgain.mutate(confirm === "reeval")}
          >
            确认创建
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
            取消
          </Button>
          {runAgain.isError && <p role="alert">创建失败，请检查源 Run 是否完整或刷新重试。</p>}
        </section>
      )}
      <Tabs
        className="run-case-tabs"
        value={tab === "a2ui" ? "result" : tab}
        onValueChange={(value) => onTab(value as CaseTab)}
      >
        <TabsList>
          <TabsTrigger value="result">结果详情</TabsTrigger>
          <TabsTrigger value="trace">执行链路</TabsTrigger>
        </TabsList>
        <TabsContent value="result" className="run-case-tab">
          {detail.isError && <p role="alert">执行证据读取失败。</p>}
          <section className="run-case-input">
            <h3>用户输入</h3>
            <p className="run-readable">{userText(fullRow) ?? "未记录可读输入，请展开原始请求"}</p>
            <details>
              <summary>前置条件 / 测试数据</summary>
              <p className="run-muted">保存的 Case 请求条件，不代表环境已自动准备。</p>
              <EvidenceJson
                value={{
                  time: object(definition?.vars.request_body).time,
                  timezone: object(definition?.vars.request_body).timezone,
                  task: definition?.vars.task,
                  metadata: definition?.metadata,
                  preconditions: object(definition?.vars.request_body).preconditions ?? "未记录"
                }}
              />
            </details>
          </section>
          <div className="run-case-results-grid">
            <RunCaseChecks row={fullRow} />
            <RunCaseOutput
              key={`${row.caseKey}-${fullRow.review?.revision ?? 0}`}
              mode="messages"
              row={fullRow}
              review={fullRow.review}
              reviewError={review.isError}
            />
          </div>
          <RunCaseOutput
            key={`cards-${row.caseKey}-${fullRow.review?.revision ?? 0}`}
            mode="cards"
            row={fullRow}
            review={fullRow.review}
            reviewError={review.isError}
          />
          <RunCaseUsage
            row={fullRow}
            onTrace={(target) => {
              setTraceTarget(target);
              onTab("trace");
            }}
          />
          {fullRow.review && !visualReviewRequired(fullRow) && (
            <details className="run-case-manual">
              <summary>
                人工复核 / 归因备注
                {fullRow.review.history.at(-1)?.kind === "DECISION" ? " · 已有记录" : ""}
              </summary>
              <ReviewForm
                key={`${row.caseKey}-${fullRow.review.revision}`}
                review={fullRow.review}
              />
            </details>
          )}
          <details className="run-case-raw">
            <summary>原始请求 / 响应 / HTTP 状态</summary>
            <EvidenceJson
              value={{ request: definition?.vars.request_body, rest: fullRow.rest, evaluation }}
            />
          </details>
        </TabsContent>
        <TabsContent value="trace" className="run-case-tab run-trace-tab">
          {analysisOpen && <RunAnalysisControl api={api} runId={runId} />}
          <RunTracePanel
            key={`${row.caseKey}-${fullRow.evaluation?.finalCaseResultHash ?? "pending"}`}
            row={fullRow}
            target={traceTarget}
            runId={runId}
            analysis={analysis.data}
            analysisLoading={analysis.isFetching}
            analysisError={
              analysis.isError &&
              !(
                analysis.error instanceof ApiClientError &&
                analysis.error.code === "ANALYSIS_NOT_FOUND"
              )
            }
            onRefreshAnalysis={() => {
              void analysis.refetch();
            }}
            {...(row.report ? { onOpenAnalysis: () => setAnalysisOpen((open) => !open) } : {})}
          />
        </TabsContent>
      </Tabs>
    </SheetContent>
  );
}
