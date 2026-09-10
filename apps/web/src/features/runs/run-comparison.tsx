import type { ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { PlatformRunDetail, RunApi } from "../../lib/run-api.ts";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription
} from "../../components/ui/sheet.tsx";
import { Button } from "../../components/ui/button.tsx";
import {
  dashboardPages,
  evaluationState,
  loadDashboardCases,
  type DashboardCase
} from "./run-dashboard-model.ts";
import { agentUsage } from "./run-evidence-model.ts";
import { message } from "../../messages/messages.ts";

export interface ComparedCase {
  key: string;
  kind: "SAME" | "CHANGED" | "ADDED" | "MISSING";
  before?: DashboardCase;
  after?: DashboardCase;
}
function definitionHash(row: DashboardCase): string | undefined {
  return (
    row.report?.definitionHash ??
    ("caseDefinitionHash" in row.rest ? row.rest.caseDefinitionHash : undefined)
  );
}
/** Stable Case key alone is not sufficient to claim a like-for-like comparison. */
export function compareCases(
  before: readonly DashboardCase[],
  after: readonly DashboardCase[]
): ComparedCase[] {
  const a = new Map(before.map((r) => [r.caseKey, r])),
    b = new Map(after.map((r) => [r.caseKey, r]));
  return [...new Set([...a.keys(), ...b.keys()])].map((key) => {
    const left = a.get(key),
      right = b.get(key);
    return {
      key,
      kind: !left
        ? "ADDED"
        : !right
          ? "MISSING"
          : definitionHash(left) && definitionHash(left) === definitionHash(right)
            ? "SAME"
            : "CHANGED",
      ...(left ? { before: left } : {}),
      ...(right ? { after: right } : {})
    };
  });
}
const diff = (before: number | null, after: number | null, unit = ""): string =>
  before === null || after === null
    ? "未采集"
    : `${before.toLocaleString()} → ${after.toLocaleString()} (${after - before > 0 ? "+" : ""}${(after - before).toLocaleString()}${unit})`;
function agentTokens(row: DashboardCase): number | null {
  const v = agentUsage([row]);
  return v.recorded > 0 ? v.total : null;
}
function config(run: PlatformRunDetail): Record<string, string> {
  return {
    "Agent 入口": run.endpoint.name,
    "Agent 分支 / 版本": run.endpoint.config.agentRevision
      ? `${run.endpoint.config.agentRevision.branch} / ${run.endpoint.config.agentRevision.commit}`
      : "未记录",
    测试集: run.suite.name,
    评测模型: run.evaluator.config.model,
    "Endpoint 配置快照": run.endpoint.configHash,
    评测配置快照: run.evaluator.configHash,
    "Rubric 内容快照":
      run.rubricPrompts
        .map((p) => `${p.promptKey}: ${p.promptHash}`)
        .sort()
        .join("\n") || "不适用",
    执行参数: JSON.stringify(run.runExecutionLimits)
  };
}
export function RunComparison({
  api,
  run,
  rows,
  open,
  onClose
}: {
  readonly api: RunApi;
  readonly run: PlatformRunDetail;
  readonly rows: readonly DashboardCase[];
  readonly open: boolean;
  readonly onClose: () => void;
}): ReactElement {
  const [target, setTarget] = useState("");
  const runs = useQuery({
    queryKey: ["runs", "compare-options"],
    queryFn: ({ signal }) =>
      dashboardPages((cursor) => api.listRuns({ limit: 100, cursor }, signal)),
    enabled: open
  });
  const detail = useQuery({
    queryKey: ["runs", "detail", target],
    queryFn: ({ signal }) => api.getRun(target, signal),
    enabled: open && target !== ""
  });
  const other = detail.data;
  const cases = useQuery({
    queryKey: ["runs", "comparison-cases", target],
    queryFn: ({ signal }) =>
      loadDashboardCases(
        api,
        target,
        other?.artifactAvailability.some(
          (a) => a.kind === "REPORT_JSON" && a.status === "PRESENT"
        ) ?? false,
        signal
      ),
    enabled: open && other !== undefined
  });
  const comparable =
    other !== undefined &&
    cases.data?.length === other.suite.caseCount &&
    rows.length === run.suite.caseCount;
  const comparison = comparable ? compareCases(cases.data ?? [], rows) : [];
  const beforeConfig = other ? config(other) : {},
    afterConfig = config(run);
  return (
    <Sheet
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <SheetContent className="run-compare-drawer">
        <SheetHeader>
          <SheetTitle>对比运行</SheetTitle>
          <SheetDescription>
            基准运行 → 当前运行。只对内容一致的 Case 比较结果与用量。
          </SheetDescription>
        </SheetHeader>
        <label className="run-compare-picker">
          选择基准运行
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">请选择运行</option>
            {runs.data
              ?.filter((r) => r.id !== run.id && r.stage === "DONE")
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name ?? r.suiteName} · {new Date(r.createdAt).toLocaleString("zh-CN")} ·{" "}
                  {r.id.slice(0, 8)}
                </option>
              ))}
          </select>
        </label>
        {(runs.isError || detail.isError || cases.isError) && (
          <p role="alert">对比记录读取失败，请重试。</p>
        )}
        {target && cases.isPending && <p>正在读取基准运行…</p>}
        {other && cases.data && !comparable && (
          <p role="alert">运行记录尚不完整，暂不进行对比，避免将未执行 Case 误算为缺失。</p>
        )}
        {other && cases.data && comparable && (
          <>
            <p className="run-muted">
              {other.name ?? other.suite.name} → {run.name ?? run.suite.name}
            </p>
            <details className="run-compare-config-details">
              <summary>
                配置差异 ·{" "}
                {
                  Object.entries(afterConfig).filter(([key, value]) => value !== beforeConfig[key])
                    .length
                }{" "}
                项变化
              </summary>
              <table className="run-compare-config">
                <thead>
                  <tr>
                    <th>配置</th>
                    <th>基准运行</th>
                    <th>当前运行</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(afterConfig).map(([key, value]) => (
                    <tr key={key} data-changed={value !== beforeConfig[key]}>
                      <td>{key}</td>
                      <td>{beforeConfig[key]}</td>
                      <td>{value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
            <p className="run-muted">
              {comparison.filter((c) => c.kind === "SAME").length} 条可对齐 ·{" "}
              {comparison.filter((c) => c.kind === "CHANGED").length} 条内容变化 ·{" "}
              {comparison.filter((c) => c.kind === "ADDED").length} 条新增 ·{" "}
              {comparison.filter((c) => c.kind === "MISSING").length} 条缺失
            </p>
            <p className="run-muted">
              以下比较自动评测证据；人工审核不混入自动结果。Token
              为已记录用量，部分历史记录可能不完整。执行耗时不包含评测耗时。
            </p>
            <p className="run-comparison-outcomes">
              改善{" "}
              {
                comparison.filter(
                  (c) =>
                    c.kind === "SAME" &&
                    c.before?.evaluation?.status === "FAIL" &&
                    c.after?.evaluation?.status === "PASS"
                ).length
              }{" "}
              · 退化{" "}
              {
                comparison.filter(
                  (c) =>
                    c.kind === "SAME" &&
                    c.before?.evaluation?.status === "PASS" &&
                    c.after?.evaluation?.status === "FAIL"
                ).length
              }
              <span className="run-muted">（仅比较通过 / 未通过之间的变化）</span>
            </p>
            <div className="run-compare-table">
              <table>
                <thead>
                  <tr>
                    <th>Case / 描述</th>
                    <th>可比性</th>
                    <th>自动结论</th>
                    <th>耗时 ms</th>
                    <th>Agent Token</th>
                    <th>评测 Token</th>
                  </tr>
                </thead>
                <tbody>
                  {comparison.map((c) => (
                    <tr key={c.key}>
                      <td>
                        <strong>{c.key}</strong>
                        <p>
                          {c.after?.definition?.description ?? c.before?.definition?.description}
                        </p>
                      </td>
                      <td>
                        {
                          {
                            SAME: "内容一致",
                            CHANGED: "内容已变化",
                            ADDED: "新增",
                            MISSING: "缺失"
                          }[c.kind]
                        }
                      </td>
                      {c.kind === "SAME" && c.before && c.after ? (
                        <>
                          <td>
                            {message(
                              `rd.eval.${evaluationState({ ...c.before, review: undefined })}`
                            )}{" "}
                            →{" "}
                            {message(
                              `rd.eval.${evaluationState({ ...c.after, review: undefined })}`
                            )}
                          </td>
                          <td>{diff(c.before.rest.durationMs, c.after.rest.durationMs)}</td>
                          <td>{diff(agentTokens(c.before), agentTokens(c.after))}</td>
                          <td>
                            {diff(
                              c.before.evaluation?.tokenUsage?.totalTokens ?? null,
                              c.after.evaluation?.tokenUsage?.totalTokens ?? null
                            )}
                          </td>
                        </>
                      ) : (
                        <td colSpan={4}>不纳入同条件结果比较</td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <Button variant="outline" onClick={onClose}>
          关闭对比
        </Button>
      </SheetContent>
    </Sheet>
  );
}
