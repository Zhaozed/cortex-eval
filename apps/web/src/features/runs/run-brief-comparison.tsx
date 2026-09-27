import type { ReactElement } from "react";
import type { DashboardCase } from "./run-dashboard-model.ts";

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  return value === undefined ? "undefined" : JSON.stringify(value);
}

/** Compare actual frozen evidence, not Case hashes that also include Rubric. Missing evidence fails closed. */
export function sameBriefEvidence(before: DashboardCase, after: DashboardCase): boolean {
  return (
    !!before.definition?.semanticEvaluation?.brief &&
    !!after.definition?.semanticEvaluation?.brief &&
    before.rest.status === "SUCCEEDED" &&
    after.rest.status === "SUCCEEDED" &&
    "providerOutput" in before.rest &&
    "providerOutput" in after.rest &&
    stable(before.definition.vars.request_body) === stable(after.definition.vars.request_body) &&
    stable(before.rest.providerOutput) === stable(after.rest.providerOutput)
  );
}

/** Raw per-dimension scores and failure reasons, never reinterpret a changed rubric as quality improvement. */
export function BriefJudgeComparison({
  before,
  after
}: {
  readonly before: DashboardCase;
  readonly after: DashboardCase;
}): ReactElement {
  const left = before.evaluation?.semanticEvaluation?.result;
  const right = after.evaluation?.semanticEvaluation?.result;
  const a = new Map(
    left?.decisions
      .filter((d) => d.questionId.startsWith("brief.rubric."))
      .map((d) => [d.questionId, d])
  );
  const b = new Map(
    right?.decisions
      .filter((d) => d.questionId.startsWith("brief.rubric."))
      .map((d) => [d.questionId, d])
  );
  const keys = [...new Set([...a.keys(), ...b.keys()])];
  const total = (row: typeof left): string =>
    String(row?.decisions.find((d) => d.questionId === "brief.metric.total")?.value ?? "未记录");
  return (
    <details>
      <summary>
        裁判差异：总分 {total(left)} → {total(right)}
      </summary>
      <p>
        同一输入与输出；分数变化是裁判差异，不代表 Brief
        生成质量改善。规则不同的同名维度也需分别解释。
      </p>
      <table>
        <thead>
          <tr>
            <th>维度</th>
            <th>基准</th>
            <th>当前</th>
          </tr>
        </thead>
        <tbody>
          {keys.map((key) => (
            <tr key={key}>
              <td>{key.replace("brief.rubric.", "")}</td>
              <td>
                {String(a.get(key)?.value ?? "未评分")}
                <p>{a.get(key)?.reason}</p>
              </td>
              <td>
                {String(b.get(key)?.value ?? "未评分")}
                <p>{b.get(key)?.reason}</p>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        基准阻断项：
        {left?.blockingFailures.length ? left.blockingFailures.join("；") : "无 / 未记录"}
      </p>
      <p>
        当前阻断项：
        {right?.blockingFailures.length ? right.blockingFailures.join("；") : "无 / 未记录"}
      </p>
      <details>
        <summary>基准 Judge prompt / Rubric 快照</summary>
        <pre>{JSON.stringify(before.definition?.semanticEvaluation, null, 2)}</pre>
      </details>
      <details>
        <summary>当前 Judge prompt / Rubric 快照</summary>
        <pre>{JSON.stringify(after.definition?.semanticEvaluation, null, 2)}</pre>
      </details>
    </details>
  );
}
