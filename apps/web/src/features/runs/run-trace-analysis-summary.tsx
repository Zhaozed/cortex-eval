import type { ReactElement } from "react";
import { Sparkles } from "lucide-react";
import type { CurrentCaseAnalysis } from "../../lib/run-api.ts";
import { Button } from "../../components/ui/button.tsx";
import { observable } from "./run-evidence-model.ts";
import type { TraceAnalysisOverlay } from "./run-trace-analysis-model.ts";

/** AI evidence is advisory, never an execution error or an automatic verdict. */
export function TraceAnalysisSummary({
  analysis,
  overlay,
  loading,
  loadError,
  onOpen,
  onRefresh
}: {
  readonly analysis?: CurrentCaseAnalysis | null | undefined;
  readonly overlay: TraceAnalysisOverlay;
  readonly loading?: boolean | undefined;
  readonly loadError?: boolean | undefined;
  readonly onOpen?: (() => void) | undefined;
  readonly onRefresh?: (() => void) | undefined;
}): ReactElement {
  const ready = overlay.state === "ready" && analysis?.output;
  const label = loading
    ? "读取中"
    : loadError
      ? "读取失败"
      : {
          absent: "尚未分析",
          stale: "历史分析 · 不标记当前链路",
          pending: "分析进行中",
          error: "分析调用异常",
          ready: overlay.byNode.size
            ? `${overlay.byNode.size} 个关联节点 · 待确认`
            : "未定位到具体节点"
        }[overlay.state];
  return (
    <section className="run-trace-analysis" aria-label="AI 辅助分析">
      <div className="run-trace-analysis-heading">
        <span>
          <Sparkles size={14} />
          <strong>AI 辅助分析</strong>
          <small>{label}</small>
        </span>
        <div>
          {onRefresh && (
            <Button size="sm" variant="ghost" disabled={loading} onClick={onRefresh}>
              刷新
            </Button>
          )}
          {onOpen && (
            <Button size="sm" variant="link" onClick={onOpen}>
              分析本次运行
            </Button>
          )}
        </div>
      </div>
      {ready && (
        <details>
          <summary>
            分析依据与建议
            {overlay.unlinked.length ? ` · ${overlay.unlinked.length} 项未关联节点` : ""}
          </summary>
          <p className="run-muted">
            橙色表示 AI 引用的相关证据，不等于已确认根因；不改变评测结论。
          </p>
          <p>{ready.explanation}</p>
          <p>
            <strong>建议：</strong>
            {ready.recommendedAction}
          </p>
          {overlay.unlinked.map((item, i) => (
            <div className="run-analysis-evidence" key={i}>
              <small>未定位 · {item.source}</small>
              <p>{item.conclusion}</p>
              <code>{item.fieldPath ?? "未提供字段路径"}</code>
            </div>
          ))}
          <details>
            <summary>原始分析 JSON</summary>
            <pre className="run-evidence-json">{JSON.stringify(observable(analysis), null, 2)}</pre>
          </details>
        </details>
      )}
      {overlay.state === "error" && !loadError && (
        <p className="run-muted">分析未成功，不代表 Agent 任务失败。{analysis?.errorCode}</p>
      )}
    </section>
  );
}
