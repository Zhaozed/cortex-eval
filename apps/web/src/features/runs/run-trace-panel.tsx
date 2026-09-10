import { useRef, useState, type ReactElement } from "react";
import {
  ArrowDown,
  Braces,
  CircleAlert,
  Cpu,
  GitBranch,
  MessageSquare,
  Route,
  Wrench
} from "lucide-react";
import type { DashboardCase } from "./run-dashboard-model.ts";
import {
  agentUsage,
  callUsage,
  object,
  observable,
  payload,
  records,
  text,
  traceBranches,
  type TraceBranch
} from "./run-evidence-model.ts";
import {
  duration,
  relatedModelStep,
  recordedStage,
  traceModelId,
  traceStepId,
  uniqueModelCalls,
  toolTimings
} from "./run-call-model.ts";
import { TraceInspector, type TraceSelection } from "./run-trace-inspector.tsx";
import type { CurrentCaseAnalysis } from "../../lib/run-api.ts";
import { traceAnalysisOverlay } from "./run-trace-analysis-model.ts";
import { TraceAnalysisSummary } from "./run-trace-analysis-summary.tsx";
import { Button } from "../../components/ui/button.tsx";

export function EvidenceJson({ value }: { readonly value: unknown }): ReactElement {
  return <pre className="run-evidence-json">{JSON.stringify(observable(value), null, 2)}</pre>;
}
function EvidenceTree({
  branches,
  render
}: {
  readonly branches: readonly TraceBranch[];
  readonly render: (value: Record<string, unknown>, index: number) => ReactElement;
}): ReactElement {
  return (
    <>
      {branches.map((branch, index) => (
        <div key={index}>
          {render(branch.record, index)}
          {branch.children.length > 0 && (
            <div className="run-trace-children">
              <EvidenceTree branches={branch.children} render={render} />
            </div>
          )}
        </div>
      ))}
    </>
  );
}
const labels: Record<string, string> = {
  USER_INPUT: "用户输入",
  THINK: "Agent 动作",
  TOOL_CALL: "发起工具调用",
  TOOL_RESULT: "工具执行结果",
  TOOL_ERROR: "工具执行异常",
  ASSISTANT_REPLY: "用户回复"
};
function identifier(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}
/** Preserve observed order and explicit relationships; the inspector never invents missing spans. */
export function RunTracePanel({
  row,
  target,
  runId = "",
  analysis,
  analysisLoading,
  analysisError,
  onOpenAnalysis,
  onRefreshAnalysis
}: {
  readonly row: DashboardCase;
  readonly target?: string | null;
  readonly runId?: string;
  readonly analysis?: CurrentCaseAnalysis | null | undefined;
  readonly analysisLoading?: boolean | undefined;
  readonly analysisError?: boolean | undefined;
  readonly onOpenAnalysis?: () => void;
  readonly onRefreshAnalysis?: () => void;
}): ReactElement {
  const p = payload(row),
    calls = uniqueModelCalls(row),
    timeline = records(p.timeline);
  const workspace = useRef<HTMLElement>(null);
  const [selection, setSelection] = useState<TraceSelection | null>(null);
  const [errorIndex, setErrorIndex] = useState(0);
  // Per-request step indices reset across turns: never interleave distinct requests by index.
  const sorted =
    new Set(timeline.map((step) => identifier(step.req_id))).size <= 1 &&
    timeline.every((step) => typeof step.step_idx === "number" && Number.isFinite(step.step_idx))
      ? [...timeline].sort((a, b) => Number(a.step_idx) - Number(b.step_idx))
      : timeline;
  const links = new Map(calls.map((call) => [call, relatedModelStep(call, timeline)]));
  const detached = calls.filter((call) => !links.get(call));
  const usage = agentUsage([row]);
  const overlay = traceAnalysisOverlay(row, runId, analysis);
  const focusNode = (selector: string): void => {
    const nodes = Array.from(
      workspace.current?.querySelectorAll<HTMLButtonElement>(selector) ?? []
    );
    const next = nodes[errorIndex % Math.max(nodes.length, 1)];
    if (!next) return;
    let group = next.closest("details");
    while (group) {
      group.open = true;
      group = group.parentElement?.closest("details") ?? null;
    }
    next.click();
    next.scrollIntoView?.({ block: "center", behavior: "smooth" });
    next.focus({ preventScroll: true });
    setErrorIndex(errorIndex + 1);
  };
  const timings = toolTimings(row);
  const draw = (node: TraceSelection): ReactElement => {
    const Icon =
      node.kind === "模型"
        ? Cpu
        : node.kind === "工具"
          ? Wrench
          : node.kind === "路由"
            ? Route
            : node.kind === "消息"
              ? MessageSquare
              : GitBranch;
    return (
      <button
        type="button"
        id={node.id}
        key={node.id}
        className="run-flow-node"
        data-kind={node.kind}
        data-error={node.error}
        data-ai={overlay.byNode.has(node.id)}
        aria-pressed={(selection?.id ?? target) === node.id}
        onClick={() => setSelection(node)}
        onFocus={() => {
          if (target === node.id) setSelection(node);
        }}
      >
        <span className="run-flow-icon">
          <Icon size={18} />
        </span>
        <span className="run-flow-content">
          <span className="run-flow-title">
            {node.stage && <span className="run-flow-stage">{node.stage}</span>}
            {node.title}
            {node.error && <CircleAlert size={15} />}
            {overlay.byNode.has(node.id) && <span className="run-flow-ai-label">AI 关联</span>}
          </span>
          <span className="run-flow-summary">{node.summary}</span>
          {node.metrics && (
            <span className="run-flow-metrics">
              {node.metrics
                .filter((m) => !["输入", "输出"].includes(m.label))
                .map((m) => (
                  <span key={m.label}>
                    {m.label} <b>{m.value}</b>
                  </span>
                ))}
            </span>
          )}
        </span>
        <Braces size={16} className="run-flow-open" />
      </button>
    );
  };
  const modelNode = (call: Record<string, unknown>): ReactElement => {
    const usage = callUsage(call),
      tools = records(call.tool_calls)
        .map((v) => text(v.name))
        .filter(Boolean);
    const stage = recordedStage(call);
    return draw({
      id: traceModelId(call, calls.indexOf(call)),
      title: "模型调用",
      ...(stage ? { stage } : {}),
      kind: "模型",
      error: call.ok === false,
      summary: `${text(call.model) ?? "模型未记录"}${tools.length ? ` · 发起 ${tools.join("、")} 调用` : ""}${call.ok === false ? " · 调用异常" : ""}`,
      metrics: [
        { label: "耗时", value: duration(call.latency_ms) },
        { label: "Token", value: usage?.total.toLocaleString() ?? "未采集" },
        { label: "输入", value: usage?.input.toLocaleString() ?? "未采集" },
        { label: "输出", value: usage?.output.toLocaleString() ?? "未采集" }
      ],
      evidence: call
    });
  };
  const content = (
    <>
      <TraceAnalysisSummary
        analysis={analysis}
        overlay={overlay}
        loading={analysisLoading}
        loadError={analysisError}
        onOpen={onOpenAnalysis}
        onRefresh={onRefreshAnalysis}
      />
      {Object.keys(object(p.route)).length > 0 &&
        draw({
          id: "case-route",
          title: "路由记录",
          stage: "router",
          kind: "路由",
          summary: text(object(p.route).decision) ?? "路由决策未记录",
          error: false,
          evidence: p.route
        })}
      {timeline.length === 0 && (
        <p className="run-trace-notice">未采集步骤时间线；以下仅展示已有记录。</p>
      )}
      <EvidenceTree
        branches={traceBranches(sorted, "step_id", "parent_step_id")}
        render={(step) => {
          const body = object(step.payload),
            call = object(body.tool_call),
            result = object(body.tool_ret);
          const tool = text(call.name) ?? text(result.name),
            type = String(step.type);
          const stage = recordedStage(step) ?? recordedStage(body);
          const node = {
            id:
              identifier(step.step_id) !== null
                ? traceStepId(step)
                : `case-step-missing-${timeline.indexOf(step)}`,
            title: `${typeof step.step_idx === "number" ? `${step.step_idx}. ` : ""}${labels[type] ?? text(step.type) ?? "执行记录"}${tool ? ` · ${tool}` : ""}`,
            ...(stage ? { stage } : {}),
            kind: type.startsWith("TOOL") ? "工具" : type === "THINK" ? "动作" : "消息",
            error: type.includes("ERROR"),
            summary: [
              text(body.user_text) ??
                text(body.reply_text) ??
                (type === "TOOL_CALL"
                  ? "查看调用参数"
                  : type === "THINK"
                    ? ({ CALL_TOOL: "决策：调用工具", DONE: "决策：结束本轮任务" }[
                        String(body.action)
                      ] ?? "查看已保存的动作记录")
                    : "查看已保存的参数与结果"),
              identifier(step.parallel_group_id) !== null
                ? `并行组 ${identifier(step.parallel_group_id)}`
                : null,
              identifier(step.retry_of) !== null ? `重试来源 ${identifier(step.retry_of)}` : null
            ]
              .filter(Boolean)
              .join(" · "),
            metrics: [
              {
                label: "记录时间",
                value:
                  text(step.created_at) && Number.isFinite(Date.parse(String(step.created_at)))
                    ? new Date(String(step.created_at)).toLocaleTimeString("zh-CN", {
                        hour12: false
                      })
                    : "未采集"
              }
            ],
            evidence: step
          };
          return (
            <div className="run-flow-step">
              {draw(node)}
              <EvidenceTree
                branches={traceBranches(
                  calls.filter((call) => links.get(call) === step),
                  "call_id",
                  "parent_call_id"
                )}
                render={(call) => (
                  <div className="run-flow-linked">
                    <span className="run-flow-relation">关联模型调用</span>
                    {modelNode(call)}
                  </div>
                )}
              />
            </div>
          );
        }}
      />
      {records(p.tool_executions).length > 0 && (
        <details className="run-flow-group" open>
          <summary>
            <Wrench size={15} />
            实际工具执行
          </summary>
          <p className="run-trace-notice">独立执行证据，不将此分组位置当作发生时间。</p>
          {records(p.tool_executions).map((execution, i) =>
            draw({
              id: `case-tool-execution-${i}`,
              title: timings[i]?.name ?? "工具执行",
              kind: "工具",
              error: ["FAILED", "ERROR", "TIMEOUT", "TIMED_OUT"].includes(String(execution.status)),
              summary:
                execution.status === "SUCCEEDED"
                  ? "执行成功"
                  : (text(execution.status) ?? "状态未采集"),
              metrics: [
                { label: "耗时", value: duration(timings[i]?.durationMs) },
                { label: "结果记录", value: String(records(execution.terminals).length) }
              ],
              evidence: execution
            })
          )}
        </details>
      )}
      {detached.length > 0 && (
        <details className="run-flow-group" open>
          <summary>
            <Cpu size={15} />
            模型环节 · 未关联具体步骤
          </summary>
          <p className="run-trace-notice">
            按已记录环节标注，保留父子关系；与上方步骤的先后关系未记录，不作推断。
          </p>
          <EvidenceTree
            branches={traceBranches(detached, "call_id", "parent_call_id")}
            render={modelNode}
          />
        </details>
      )}
      <details className="run-flow-group" open>
        <summary>
          <Braces size={15} />
          补充证据
        </summary>
        {records(p.causal_events).length > 0 &&
          draw({
            id: "case-causal-events",
            title: "原始因果关系",
            kind: "证据",
            summary: `${records(p.causal_events).length} 条已记录关系`,
            error: false,
            evidence: p.causal_events
          })}
        {draw({
          id: "case-trace-coverage",
          title: "采集范围",
          kind: "证据",
          summary: "查看采集覆盖度与截断标记",
          error: false,
          evidence: p.coverage ?? "未记录"
        })}
      </details>
    </>
  );
  return (
    <section ref={workspace} className="run-trace-workspace" aria-label="执行链路工作台">
      <header className="run-trace-topbar">
        <div>
          <span className="run-eyebrow">EXECUTION TRACE</span>
          <h3>
            执行链路{" "}
            <span>
              {timeline.length} 步骤 · {calls.length} 次模型调用
            </span>
          </h3>
        </div>
        <div className="run-trace-actions">
          {overlay.byNode.size > 0 && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => focusNode(".run-flow-node[data-ai='true']")}
            >
              AI 关联 · {overlay.byNode.size}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={
              !timeline.some((s) => String(s.type).includes("ERROR")) &&
              !calls.some((c) => c.ok === false) &&
              !records(p.tool_executions).some((e) =>
                ["FAILED", "ERROR", "TIMEOUT", "TIMED_OUT"].includes(String(e.status))
              )
            }
            onClick={() => focusNode(".run-flow-node[data-error='true']")}
          >
            <CircleAlert size={14} />
            定位异常
          </Button>
        </div>
      </header>
      <div className="run-trace-usage" id="case-trace-usage" tabIndex={-1}>
        <span>
          执行耗时 <b>{duration(row.rest.durationMs)}</b>
        </span>
        <span>
          Agent Token <b>{usage.recorded ? usage.total.toLocaleString() : "未采集"}</b>
        </span>
        <span>
          输入 <b>{usage.recorded ? usage.input.toLocaleString() : "未采集"}</b> / 输出{" "}
          <b>{usage.recorded ? usage.output.toLocaleString() : "未采集"}</b>
        </span>
        {usage.recorded > 0 && !usage.complete && <small>统计不完整</small>}
        {"provenance" in row.rest && row.rest.provenance && <small>历史复用执行</small>}
      </div>
      <div className="run-trace-workspace-grid">
        <div className="run-flow-canvas">{content}</div>
        {selection ? (
          <TraceInspector
            key={selection.id}
            node={{ ...selection, analysisEvidence: overlay.byNode.get(selection.id) ?? [] }}
            onClose={() => setSelection(null)}
          />
        ) : (
          <aside className="run-trace-empty">
            <div>
              <Braces size={30} />
              <h3>点击节点，查看执行证据</h3>
              <p>
                参数、返回、模型用量在这里展开。
                <br />
                链路保持在左侧，不弹出层层窗口。
              </p>
              <span>
                <ArrowDown size={14} /> 沿记录顺序阅读 · 缺失关联不推断
              </span>
            </div>
          </aside>
        )}
      </div>
    </section>
  );
}
