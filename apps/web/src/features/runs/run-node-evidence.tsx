import type { ReactElement } from "react";
import { object } from "./run-evidence-model.ts";
import { TraceValue } from "./run-trace-value.tsx";

const metadata = new Set([
  "req_id",
  "step_id",
  "step_idx",
  "task_id",
  "call_id",
  "created_at",
  "updated_at",
  "related_step_id",
  "parent_step_id",
  "parent_call_id",
  "parallel_group_id",
  "retry_of",
  "latency_ms",
  "token_usage"
]);
const priority = [
  "stage",
  "component",
  "task",
  "model",
  "ok",
  "status",
  "decision",
  "action",
  "error",
  "error_message",
  "user_text",
  "input",
  "messages",
  "request_messages",
  "request",
  "tool_calls",
  "output",
  "reply_text",
  "response",
  "result"
];

/** Project the trace envelope, not a particular Case or tool's business schema. */
export function NodeEvidence({ value }: { readonly value: unknown }): ReactElement {
  const record = object(value);
  if (!Object.keys(record).length)
    return (
      <section className="trace-key-section">
        <TraceValue value={value} />
      </section>
    );
  const main = Object.entries(record).filter(([key]) => !metadata.has(key) && key !== "payload");
  const rank = (key: string): number =>
    priority.includes(key) ? priority.indexOf(key) : priority.length;
  main.sort(([a], [b]) => rank(a) - rank(b));
  const meta = Object.fromEntries(Object.entries(record).filter(([key]) => metadata.has(key)));
  return (
    <div className="trace-node-evidence">
      {Object.hasOwn(record, "payload") && (
        <section className="trace-key-section" aria-label="payload">
          <TraceValue value={record.payload} />
        </section>
      )}
      {main.length > 0 && (
        <section className="trace-key-section">
          <TraceValue value={Object.fromEntries(main)} />
        </section>
      )}
      {Object.keys(meta).length > 0 && (
        <details
          className="trace-value-more"
          open={!main.length && !Object.hasOwn(record, "payload")}
        >
          <summary>记录元数据 · {Object.keys(meta).length}</summary>
          <TraceValue value={meta} />
        </details>
      )}
    </div>
  );
}
