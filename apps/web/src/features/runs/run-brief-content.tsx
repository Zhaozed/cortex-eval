import type { ReactElement } from "react";
import { BriefReplayOutputSchema } from "@cortex-eval/contracts/src/brief-evaluation-contracts.ts";
import { Badge } from "../../components/ui/badge.tsx";
import type { DashboardCase } from "./run-dashboard-model.ts";
import { EvidenceJson } from "./run-trace-panel.tsx";
import { object, payload, records, text } from "./run-evidence-model.ts";
import { briefRubricSummary } from "./run-output-model.ts";

type Semantic = NonNullable<NonNullable<DashboardCase["evaluation"]>["semanticEvaluation"]>;
type Decision = Semantic["result"]["decisions"][number];

/** Replay artifacts are generated content, not delivered messages or rendered card events. */
export function RunBriefContent({
  row,
  mode = "all"
}: {
  readonly row: DashboardCase;
  readonly mode?: "messages" | "cards" | "all";
}): ReactElement | null {
  const result = BriefReplayOutputSchema.safeParse(payload(row));
  if (!result.success) return null;
  const brief = result.data;
  return (
    <section className="run-result-panel brief-output-panel" aria-label="Brief 生成内容">
      {mode !== "cards" && (
        <>
          <div className="run-panel-heading">
            <h3>{brief.brief_type === "daily" ? "Daily" : "Meeting"} Brief · 生成内容</h3>
            <span className="brief-output-status">
              {brief.generation_status} · 展示 {brief.presentation_status} · LLM{" "}
              {brief.llm_called ? "已调用" : "未调用"} · 未向用户交付
            </span>
          </div>
          <div className="brief-output-doc">
            {(brief.output.text || "（空文本）")
              .split(/\n+/)
              .map((line, index) => (
                <p key={index}>{line}</p>
              ))}
          </div>
        </>
      )}
      {mode !== "messages" && (
        <>
          <h4>最终卡片（{brief.output.cards.length}）</h4>
          {brief.output.cards.map((card, index) => (
            <details key={index} open>
              <summary>卡片 {index + 1} · 结构化内容（非端侧渲染）</summary>
              <EvidenceJson value={card} />
            </details>
          ))}
        </>
      )}
      {mode !== "cards" && (
        <p className="run-muted brief-output-note">
          评分只针对以上最终内容；model_input / model_result 留在原始响应中用于定位裁剪或生成问题。
        </p>
      )}
    </section>
  );
}

/** Top verdict band for rubric runs: total score, PASS/FAIL and hard-fail count at a glance. */
export function RunBriefVerdict({ semantic }: { readonly semantic: Semantic }): ReactElement | null {
  const result = semantic.result;
  const rubric = briefRubricSummary(result);
  if (!rubric) return null;
  return (
    <section
      className="run-result-panel run-brief-verdict"
      data-status={result.passed ? "PASS" : "FAIL"}
      aria-label="Brief 评测结论"
    >
      <strong className="run-brief-verdict-score">
        总分 {rubric.total ?? "—"}/{rubric.maxTotal}
      </strong>
      <Badge variant="outline" data-status={result.passed ? "PASS" : "FAIL"}>
        {result.passed ? "PASS · 通过" : "FAIL · 未通过"}
      </Badge>
      <span>Hard Fail {rubric.hardFails.length} 项</span>
      {rubric.ratio !== null && (
        <span className="run-muted">得分率 {(rubric.ratio * 100).toFixed(1)}%</span>
      )}
    </section>
  );
}

function rubricDimensionLabel(decision: Decision): string {
  return decision.platformReason ?? decision.questionId.slice("brief.rubric.".length);
}

function rubricScore(decision: Decision): number | null {
  return typeof decision.value === "number" ? decision.value : null;
}

/** Rubric mode: one row per dimension with a colored 0-2 score badge and collapsible quotes. */
function RunBriefRubricTable({
  rubric
}: {
  readonly rubric: NonNullable<ReturnType<typeof briefRubricSummary>>;
}): ReactElement {
  return (
    <div className="brief-table-scroll">
      <table className="brief-checklist brief-rubric">
        <thead>
          <tr>
            <th>维度</th>
            <th>得分</th>
            <th>裁判理由</th>
            <th>证据引文</th>
          </tr>
        </thead>
        <tbody>
          {rubric.dimensions.map((decision) => {
            const score = rubricScore(decision);
            return (
              <tr key={decision.questionId}>
                <td>
                  <p>{rubricDimensionLabel(decision)}</p>
                  <code>{decision.questionId.slice("brief.rubric.".length)}</code>
                  {decision.evidenceRefs.length > 0 && (
                    <p className="run-muted">
                      {decision.evidenceRefs.map((ref) => (
                        <code key={ref}>{ref} </code>
                      ))}
                    </p>
                  )}
                </td>
                <td>
                  <span className="brief-score-badge" data-score={score ?? "na"}>
                    {score === null ? "未记录" : `${score}/2`}
                  </span>
                </td>
                <td>
                  <p>{decision.reason ?? "未记录裁判理由。"}</p>
                </td>
                <td>
                  {decision.evidence.length > 0 ? (
                    <details>
                      <summary>引文 {decision.evidence.length} 条</summary>
                      {decision.evidence.map((quote, index) => (
                        <blockquote key={index}>{quote}</blockquote>
                      ))}
                    </details>
                  ) : (
                    <span className="run-muted">无</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const CHECK_LABELS: Readonly<Record<string, string>> = {
  "brief.structure": "结构检查",
  "brief.generation": "生成检查"
};

/** Reference-free rubric rendering; legacy P0/P1/P2 checklist results keep the original table. */
export function RunBriefEvaluation({ semantic }: { readonly semantic: Semantic }): ReactElement {
  const result = semantic.result;
  const rubric = briefRubricSummary(result);
  const judge =
    `${semantic.provider.startsWith("llm:") ? "LLM" : "JEV"} · ${semantic.model} · ` +
    semantic.planVersion;
  if (rubric) {
    return (
      <section className="run-result-panel brief-judge-panel" aria-label="Brief 裁判结论">
        <div className="run-panel-heading">
          <h3>
            Brief 裁判结论 · 总分 {rubric.total ?? "—"}/{rubric.maxTotal} ·{" "}
            {result.passed ? "通过" : "未通过"}
          </h3>
          <span className="brief-input-hint">{judge}</span>
        </div>
        <div className="brief-judge-body">
          <RunBriefRubricTable rubric={rubric} />
          <h4>硬性失败（Hard Fail）</h4>
          {rubric.hardFails.length > 0 ? (
            <div className="run-jev-failure-summary" role="alert">
              <ul>
                {rubric.hardFails.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="run-muted">无</p>
          )}
          {rubric.blockingNotes.length > 0 && (
            <ul className="run-brief-blocking-notes">
              {rubric.blockingNotes.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
          {rubric.checks.length > 0 && (
            <p className="run-muted">
              确定性检查：
              {rubric.checks
                .map(
                  (check) =>
                    `${CHECK_LABELS[check.questionId] ?? check.questionId}${
                      check.value === true ? "通过" : "未通过"
                    }`
                )
                .join(" · ")}
            </p>
          )}
          {result.warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
          <details>
            <summary>原始裁判 JSON</summary>
            <EvidenceJson value={result} />
          </details>
        </div>
      </section>
    );
  }
  const metrics = result.decisions.filter((d) => d.questionId.startsWith("brief.metric."));
  const checks = result.decisions.filter((d) => !d.questionId.startsWith("brief.metric."));
  return (
    <section className="run-result-panel" aria-label="Brief 原子评测">
      <h3>
        Brief 原子评测 · {(result.score * 100).toFixed(1)} 分 · {result.passed ? "通过" : "未通过"}
      </h3>
      <p>{judge}</p>
      <div className="run-jev-summary-grid">
        {metrics.map((d) => (
          <div key={d.questionId}>
            <span>
              {d.questionId.endsWith("noise")
                ? "噪音抑制"
                : `${d.questionId.split(".").at(-1) ?? ""} 命中率`}
            </span>
            <strong>{!d.applicable ? "不适用" : `${(Number(d.value) * 100).toFixed(1)}%`}</strong>
          </div>
        ))}
      </div>
      {result.blockingFailures.length > 0 && (
        <ul role="alert">
          {result.blockingFailures.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
      <div className="brief-table-scroll">
        <table className="brief-checklist">
          <thead>
            <tr>
              <th>断言 / 规则</th>
              <th>结果</th>
              <th>裁判理由与输出证据</th>
              <th>来源引用</th>
            </tr>
          </thead>
          <tbody>
            {checks.map((d) => (
              <tr key={d.questionId}>
                <td>
                  <code>{d.questionId}</code>
                  <p>{d.platformReason}</p>
                </td>
                <td>{d.value === true ? "通过" : "未通过"}</td>
                <td>
                  <p>{d.reason}</p>
                  {d.evidence.map((quote, i) => (
                    <blockquote key={i}>{quote}</blockquote>
                  ))}
                </td>
                <td>
                  {d.evidenceRefs.map((ref) => (
                    <p key={ref}>
                      <code>{ref}</code>
                    </p>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {result.warnings.map((warning) => (
        <p key={warning}>{warning}</p>
      ))}
      <details>
        <summary>完整裁判记录</summary>
        <EvidenceJson value={semantic} />
      </details>
    </section>
  );
}

function bundleScalar(value: unknown): string {
  if (Array.isArray(value)) return `${value.length} 条`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 1 && entries[0]) return bundleScalar(entries[0][1]);
    return `${entries.length} 个字段`;
  }
  return String(value);
}

const SNAPSHOT_LISTS = [
  { key: "memories", label: "记忆" },
  { key: "projects", label: "项目" },
  { key: "persons", label: "人物" }
] as const;

function BundleMaterialList({
  label,
  items
}: {
  readonly label: string;
  readonly items: readonly Record<string, unknown>[];
}): ReactElement {
  return (
    <section className="brief-material" aria-label={`材料 · ${label}`}>
      <h4>
        {label}
        <span className="brief-count">{items.length}</span>
      </h4>
      {items.length === 0 ? (
        <p className="run-muted">无</p>
      ) : (
        <ul className="brief-bundle-list">
          {items.map((item, index) => {
            const displayName = text(item.display_name);
            const meta = [
              text(item.domain),
              text(item.memory_kind),
              ...(displayName !== null && text(item.content) === null ? [text(item.person_id)] : [])
            ].filter((part): part is string => part !== null);
            const content =
              (
                text(item.content) ??
                text(item.name) ??
                text(item.title) ??
                displayName ??
                JSON.stringify(item)
              ).replaceAll("\\n", "\n");
            return (
              <li className="brief-bundle-item" key={index}>
                {meta.length > 0 && (
                  <span className="brief-bundle-meta">
                    {meta.map((part) => (
                      <code key={part}>{part}</code>
                    ))}
                  </span>
                )}
                <p>{content}</p>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Frozen input bundle, sectioned for review; raw model_input stays one click away. */
export function RunBriefInput({ row }: { readonly row: DashboardCase }): ReactElement | null {
  const bundle = object(object(row.definition?.vars.request_body).bundle);
  if (Object.keys(bundle).length === 0) return null;
  const context = object(bundle.context);
  const snapshot = object(object(bundle.material).snapshot);
  const modelInput = object(payload(row).model_input);
  const briefType = text(bundle.brief_type);
  return (
    <section className="run-result-panel brief-input-panel" aria-label="Brief 输入材料">
      <div className="run-panel-heading">
        <h3>输入材料 · {briefType === "meeting" ? "Meeting" : "Daily"} Brief</h3>
        <span className="brief-input-hint">喂给模型的冻结 bundle</span>
      </div>
      <div className="brief-input-body">
        {Object.keys(context).length > 0 && (
          <div className="brief-kv" role="group" aria-label="context">
            {Object.entries(context).map(([key, value]) => (
              <div className="brief-kv-item" key={key}>
                <span className="brief-kv-key">{key}</span>
                <span className="brief-kv-value">{bundleScalar(value)}</span>
              </div>
            ))}
          </div>
        )}
        {SNAPSHOT_LISTS.map(({ key, label }) => (
          <BundleMaterialList key={key} label={label} items={records(snapshot[key])} />
        ))}
        {Object.keys(modelInput).length > 0 && (
          <details>
            <summary>模型输入（system_prompt / messages）</summary>
            <EvidenceJson value={modelInput} />
          </details>
        )}
      </div>
    </section>
  );
}
