import type { ReactElement } from "react";
import { object, text } from "./run-evidence-model.ts";
import { NodeEvidence } from "./run-node-evidence.tsx";
import { TraceValue, traceScalar } from "./run-trace-value.tsx";

function firstField(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  return keys.find((name) => Object.hasOwn(record, name));
}

function CallEvidence({
  value,
  index
}: {
  readonly value: unknown;
  readonly index: number;
}): ReactElement {
  const call = object(value),
    fn = object(call.function);
  const name = text(call.name) ?? text(call.tool_name) ?? text(fn.name);
  const argKey = firstField(call, ["param", "arguments", "args_json", "args"]);
  const args = argKey === undefined ? fn.arguments : call[argKey];
  const used = new Set(["name", "tool_name", ...(argKey ? [argKey] : [])]);
  // Keep non-selected aliases and transport metadata available, including the original function wrapper.
  const extra = Object.fromEntries(Object.entries(call).filter(([key]) => !used.has(key)));
  return (
    <section className="trace-key-section trace-tool-call" aria-label={`调用参数 ${index + 1}`}>
      <div className="trace-tool-heading">
        <span>Tool calling:</span>
        <strong>{name ?? "未记录"}</strong>
      </div>
      <div className="trace-tool-arguments">
        <h4>Arguments{argKey ? <small>{argKey}</small> : null}</h4>
        <TraceValue value={args} />
      </div>
      {Object.keys(extra).length > 0 && (
        <details className="trace-value-more">
          <summary>调用元数据 · {Object.keys(extra).length}</summary>
          <TraceValue value={extra} />
        </details>
      )}
    </section>
  );
}

function ResultEvidence({
  value,
  index,
  error = false
}: {
  readonly value: unknown;
  readonly index: number;
  readonly error?: boolean;
}): ReactElement {
  const terminal = object(value);
  const wrapped = terminal.tool_result ?? terminal.tool_ret;
  const record = object(wrapped ?? value);
  const failed =
    error ||
    ["ERROR", "TOOL_ERROR"].includes(String(terminal.type)) ||
    ["FAILED", "ERROR", "TIMEOUT", "TIMED_OUT"].includes(String(record.status)) ||
    record.success === false;
  const key = firstField(record, ["result", "output", "data"]);
  const remainder = Object.fromEntries(
    Object.entries(record).filter(
      ([k]) => !["name", "tool_name", "status", ...(key ? [key] : [])].includes(k)
    )
  );
  const outer =
    wrapped === undefined
      ? {}
      : Object.fromEntries(
          Object.entries(terminal).filter(([k]) => !["tool_result", "tool_ret", "type"].includes(k))
        );
  return (
    <section className="trace-key-section" data-error={failed} aria-label={`工具返回 ${index + 1}`}>
      <div className="trace-tool-heading">
        <span>{failed ? "Tool error:" : "Tool result:"}</span>
        <strong>{text(record.name) ?? text(record.tool_name) ?? "未记录"}</strong>
      </div>
      <p className="trace-tool-status">
        status: <span>{record.status === undefined ? "未记录" : traceScalar(record.status)}</span>
      </p>
      {key !== undefined ? (
        <div className="trace-tool-arguments">
          <h4>{key}</h4>
          <TraceValue value={record[key]} />
        </div>
      ) : (
        !failed && <p className="run-muted">result: 未记录</p>
      )}
      {Object.keys(remainder).length > 0 && <TraceValue value={remainder} />}
      {Object.keys(outer).length > 0 && <TraceValue value={outer} />}
    </section>
  );
}

/** Inputs are filtered observable records; no tool-name dictionary or business-specific projection. */
export function ToolEvidence({ value }: { readonly value: unknown }): ReactElement {
  const record = object(value),
    body = object(record.payload);
  const calls: unknown[] = Array.isArray(record.calls)
    ? record.calls
    : body.tool_call !== undefined
      ? [body.tool_call]
      : [];
  const terminals: unknown[] = Array.isArray(record.terminals)
    ? record.terminals
    : body.tool_ret !== undefined
      ? [body.tool_ret]
      : body.tool_result !== undefined
        ? [body.tool_result]
        : record.type === "TOOL_ERROR"
          ? [body]
          : [];
  if (!calls.length && !terminals.length) return <NodeEvidence value={value} />;
  const extraBody = Object.fromEntries(
    Object.entries(body).filter(([key]) => !["tool_call", "tool_ret", "tool_result"].includes(key))
  );
  return (
    <div className="trace-node-evidence">
      {record.status !== undefined && (
        <p className="trace-tool-status">
          status: <span>{traceScalar(record.status)}</span>
        </p>
      )}
      {calls.map((call, index) => (
        <CallEvidence key={index} value={call} index={index} />
      ))}
      {terminals.map((terminal, index) => (
        <ResultEvidence
          key={index}
          value={terminal}
          index={index}
          error={record.type === "TOOL_ERROR"}
        />
      ))}
      {Object.keys(extraBody).length > 0 && record.type !== "TOOL_ERROR" && (
        <TraceValue value={extraBody} />
      )}
      {record.type !== "TOOL_CALL" && !terminals.length && (
        <p className="run-muted">result: 未记录</p>
      )}
    </div>
  );
}
