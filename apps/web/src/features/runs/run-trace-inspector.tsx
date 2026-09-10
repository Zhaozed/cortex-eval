import { useState, type ReactElement } from "react";
import { Braces, Check, Copy, X } from "lucide-react";
import { Button } from "../../components/ui/button.tsx";
import type { TraceAnalysisEvidence } from "./run-trace-analysis-model.ts";
import { observable } from "./run-evidence-model.ts";
import { NodeEvidence } from "./run-node-evidence.tsx";
import { ToolEvidence } from "./run-tool-evidence.tsx";

export interface TraceSelection {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly summary: string;
  readonly stage?: string;
  readonly error: boolean;
  readonly evidence: unknown;
  readonly analysisEvidence?: readonly TraceAnalysisEvidence[];
  readonly metrics?: readonly { label: string; value: string }[];
}

function JsonBranch({
  name,
  value,
  depth = 0
}: {
  readonly name: string;
  readonly value: unknown;
  readonly depth?: number;
}): ReactElement {
  const [expanded, setExpanded] = useState(depth < 1);
  if (value !== null && typeof value === "object") {
    const priority = [
      "payload",
      "messages",
      "request_messages",
      "request",
      "request_body",
      "input",
      "system_prompt",
      "tool_call",
      "tool_calls",
      "tool_ret",
      "arguments",
      "output",
      "response",
      "response_body",
      "result",
      "error_message",
      "token_usage"
    ];
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => {
      if (depth > 0) return 0;
      return (
        (!priority.includes(a) ? priority.length : priority.indexOf(a)) -
        (!priority.includes(b) ? priority.length : priority.indexOf(b))
      );
    });
    return (
      <details
        className="run-json-branch"
        open={expanded}
        onToggle={(e) => setExpanded(e.currentTarget.open)}
      >
        <summary>
          <span className="run-json-key">{name}</span>
          <span className="run-json-type">
            {Array.isArray(value)
              ? `Array · ${entries.length} 项`
              : `Object · ${entries.length} 字段`}
          </span>
        </summary>
        <div>
          {expanded &&
            (entries.length ? (
              entries.map(([key, item]) => (
                <JsonBranch key={key} name={key} value={item} depth={depth + 1} />
              ))
            ) : (
              <span className="run-muted">{Array.isArray(value) ? "[]" : "{}"}</span>
            ))}
        </div>
      </details>
    );
  }
  if (typeof value === "string" && value.length > 240)
    return (
      <details
        className="run-json-branch"
        open={expanded}
        onToggle={(e) => setExpanded(e.currentTarget.open)}
      >
        <summary>
          <span className="run-json-key">{name}</span>
          <span className="run-json-type">
            String · {value.length.toLocaleString()} 字符 · 展开全文
          </span>
        </summary>
        {expanded && (
          <div className="run-json-value">
            <pre data-type="string">{value}</pre>
          </div>
        )}
      </details>
    );
  return (
    <div className="run-json-value">
      <span className="run-json-key">{name}</span>
      <pre data-type={typeof value}>
        {typeof value === "string" ? value : value === undefined ? "未记录" : JSON.stringify(value)}
      </pre>
    </div>
  );
}

export function TraceInspector({
  node,
  onClose
}: {
  readonly node: TraceSelection;
  readonly onClose: () => void;
}): ReactElement {
  const [view, setView] = useState<"summary" | "raw" | "tree">("summary");
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const value = observable(node.evidence);
  const json = value === undefined ? "未记录" : JSON.stringify(value, null, 2);
  const copyEvidence = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setCopyError(false);
    } catch {
      setCopyError(true);
    }
  };
  return (
    <aside className="run-trace-inspector" aria-label="节点证据" data-error={node.error}>
      <header className="run-inspector-header">
        <div>
          <span className="run-eyebrow">
            节点证据 · {node.kind}
            {node.stage ? ` · ${node.stage}` : ""}
          </span>
          <h3>{node.title}</h3>
        </div>
        <Button size="sm" variant="ghost" aria-label="关闭节点详情" onClick={onClose}>
          <X size={16} />
        </Button>
      </header>
      <div className="run-inspector-views" role="group" aria-label="证据展示方式">
        <div>
          {
            <Button
              size="sm"
              variant="ghost"
              aria-pressed={view === "summary"}
              onClick={() => setView("summary")}
            >
              关键信息
            </Button>
          }
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={view === "raw"}
            onClick={() => setView("raw")}
          >
            <Braces size={14} />
            原始 JSON
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={view === "tree"}
            onClick={() => setView("tree")}
          >
            结构视图
          </Button>
        </div>
        <Button
          size="sm"
          variant="ghost"
          aria-label="复制节点 JSON"
          onClick={() => {
            void copyEvidence();
          }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? "已复制" : "复制 JSON"}
        </Button>
      </div>
      <div className="run-inspector-body">
        {copyError && <p role="alert">复制失败，请在原始 JSON 中手动选择复制。</p>}
        {node.metrics && (
          <dl className="run-node-metrics">
            {node.metrics.map((m) => (
              <div key={m.label} data-time={m.label === "记录时间"}>
                <dt>{m.label}</dt>
                <dd>{m.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {!!node.analysisEvidence?.length && (
          <section className="run-node-ai-evidence">
            <strong>AI 关联证据 · 待确认</strong>
            {node.analysisEvidence.map((item, i) => (
              <div key={i}>
                <p>{item.conclusion}</p>
                <code>{item.fieldPath}</code>
              </div>
            ))}
            <small>相关证据不等于确定根因，评测结论保持不变。</small>
          </section>
        )}
        {view === "summary" &&
          (node.kind === "工具" ? <ToolEvidence value={value} /> : <NodeEvidence value={value} />)}
        {view === "raw" && <pre className="run-inspector-raw">{json}</pre>}
        {view === "tree" && (
          <div className="run-json-tree">
            <JsonBranch name="record" value={value} />
          </div>
        )}
        <p className="run-muted">
          仅展示已保存的可观测记录；内部思维字段不展示。缺失字段不代表该步骤没有发生。
        </p>
      </div>
    </aside>
  );
}
