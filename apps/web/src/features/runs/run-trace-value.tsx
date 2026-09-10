import { useState, type ReactElement } from "react";
import { Button } from "../../components/ui/button.tsx";
import { object } from "./run-evidence-model.ts";

/** Format the saved value, not a business interpretation of it. */
export function traceScalar(value: unknown): string {
  if (value === undefined) return "未记录";
  if (value === null) return "null";
  if (value === "") return '""';
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function isStructuredValue(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value))
    return (
      value.length > 8 || value.some((item: unknown) => item !== null && typeof item === "object")
    );
  return Object.keys(value).length > 0;
}

/** Schema-independent fallback: all keys/items are reachable, with bounded initial expansion. */
export function TraceValue({
  value,
  depth = 0
}: {
  readonly value: unknown;
  readonly depth?: number;
}): ReactElement {
  const [expanded, setExpanded] = useState(false);
  if (Array.isArray(value)) {
    if (value.length === 0)
      return (
        <span className="trace-value-scalar">
          [] <small>0 项</small>
        </span>
      );
    const primitives = value.every((item: unknown) => item === null || typeof item !== "object");
    if (primitives && value.length <= 8)
      return <span className="trace-value-scalar">{JSON.stringify(value)}</span>;
    const visible = expanded ? value : value.slice(0, 5);
    return (
      <div className="trace-value-list">
        <small>{value.length} 项</small>
        <ol role="list">
          {visible.map((item: unknown, index) => (
            <li key={index}>
              <div className="trace-value-item-heading">#{index + 1}</div>
              <TraceValue value={item} depth={depth + 1} />
            </li>
          ))}
        </ol>
        {value.length > 5 && (
          <Button size="sm" variant="ghost" onClick={() => setExpanded(!expanded)}>
            {expanded ? "收起列表" : `展开其余 ${value.length - 5} 项`}
          </Button>
        )}
      </div>
    );
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(object(value));
    if (!entries.length)
      return (
        <span className="trace-value-scalar">
          {"{}"} <small>0 字段</small>
        </span>
      );
    const fields = (
      <dl className="trace-value-fields">
        {entries.map(([key, item]) => (
          <div key={key} data-structured={isStructuredValue(item)}>
            <dt>{key}</dt>
            <dd>
              <TraceValue value={item} depth={depth + 1} />
            </dd>
          </div>
        ))}
      </dl>
    );
    if (depth > 3)
      return (
        <details className="trace-value-more">
          <summary>{entries.length} 字段</summary>
          {fields}
        </details>
      );
    return fields;
  }
  const content = traceScalar(value);
  return (
    <div className="trace-value-text">
      <span className="trace-value-scalar">
        {!expanded && content.length > 800 ? `${content.slice(0, 800)}…` : content}
      </span>
      {content.length > 800 && (
        <Button size="sm" variant="ghost" onClick={() => setExpanded(!expanded)}>
          {expanded ? "收起全文" : `展开全文 · ${content.length} 字符`}
        </Button>
      )}
    </div>
  );
}
