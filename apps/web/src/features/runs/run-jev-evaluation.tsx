import { useState, type ReactElement } from "react";
import type { DashboardCase } from "./run-dashboard-model.ts";
import { Badge } from "../../components/ui/badge.tsx";
import { EvidenceJson } from "./run-trace-panel.tsx";
import { isBriefSemanticEvaluation } from "./run-output-model.ts";

const JEV_DIMENSION_LABELS: Readonly<Record<string, string>> = {
  "task-outcome": "任务结果",
  routing: "路由",
  "tool-use": "工具使用与编排",
  timeliness: "时效性",
  a2ui: "A2UI 展示",
  response: "最终回复",
  safety: "安全性",
  "state-consistency": "状态一致性",
  recovery: "失败恢复"
};

const JEV_QUESTION_LABELS: Readonly<Record<string, string>> = {
  "task-outcome.completed": "任务是否完成",
  "routing.correct": "路由是否正确",
  "tool-use.need": "是否需要工具",
  "tool-use.plan": "工具编排是否正确",
  "tool-use.recovery": "失败恢复是否正确",
  "timeliness.quality": "整体时效性",
  "a2ui.choice": "A2UI 卡片选择是否正确",
  "a2ui.timing": "A2UI 出现时机是否正确",
  "response.correct": "最终回复是否正确",
  "response.clean": "回复是否干净",
  "safety.compliant": "安全性是否合规"
};

type SemanticEvaluation = NonNullable<
  NonNullable<DashboardCase["evaluation"]>["semanticEvaluation"]
>;
type JevDecision = SemanticEvaluation["result"]["decisions"][number];

function jevQuestionLabel(questionId: string): string {
  return JEV_QUESTION_LABELS[questionId] ?? questionId;
}

function jevDimensionLabel(questionId: string): string {
  const dimension = questionId.split(".")[0] ?? questionId;
  return JEV_DIMENSION_LABELS[dimension] ?? dimension;
}

type Verdict = "PASS" | "FAIL" | "NA" | "UNKNOWN";
const verdictLabels: Record<Verdict, string> = {
  PASS: "PASS · 通过",
  FAIL: "FAIL · 未通过",
  NA: "N/A · 不适用",
  UNKNOWN: "待确认"
};

/** Historical score/choice results have no saved threshold; never invent a PASS. */
function verdict(decision: JevDecision, failures: readonly string[]): Verdict {
  if (!decision.applicable) return "NA";
  if (decision.verdict) return decision.verdict;
  if (failures.some((failure) => failure.startsWith(`${decision.questionId}:`))) return "FAIL";
  if (decision.kind === "BOOLEAN" && typeof decision.value === "boolean")
    return decision.value ? "PASS" : "FAIL";
  return "UNKNOWN";
}

/** Decode copy/export escapes as text only, never HTML. */
function readable(text: string): string {
  return text
    .replace(/&#(x[\da-f]+|\d+);/gi, (match, code: string) => {
      const point = code[0]?.toLowerCase() === "x" ? parseInt(code.slice(1), 16) : Number(code);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
    })
    .replace(/\\([_*])/g, "$1");
}

function JevCheck({
  decision,
  status
}: {
  readonly decision: JevDecision;
  readonly status: Verdict;
}): ReactElement {
  const [open, setOpen] = useState(status === "FAIL");
  const platform = decision.platformReason ?? decision.reason;
  const providerEvidence = decision.evidence.filter((item) => item.startsWith("JEV evidence:"));
  const platformEvidence = decision.evidence.filter((item) => !item.startsWith("JEV evidence:"));
  return (
    <article className="run-jev-check" data-status={status}>
      <div className="run-jev-check-heading">
        <div>
          <span className="run-jev-dimension">{jevDimensionLabel(decision.questionId)}</span>
          <h4>{jevQuestionLabel(decision.questionId)}</h4>
        </div>
        <div className="run-jev-check-badges">
          <span className="run-muted">
            {decision.blocking === undefined
              ? "阻断规则未记录"
              : decision.blocking
                ? "阻断项"
                : "非阻断项"}
          </span>
          <Badge variant="outline" data-status={status}>
            {verdictLabels[status]}
          </Badge>
        </div>
      </div>
      <p className="run-jev-check-explanation">
        <strong>{status === "NA" ? "适用性说明：" : "平台规则说明："}</strong>
        {platform ? readable(platform) : "未记录说明，请查看 JEV 回答与证据。"}
      </p>
      <details open={open} className="run-jev-check-detail">
        <summary
          onClick={(event) => {
            event.preventDefault();
            setOpen(!open);
          }}
        >
          判定标准与证据
        </summary>
        <div className="run-jev-check-columns">
          <section>
            <h5>判定标准</h5>
            <p>
              {decision.question
                ? readable(decision.question)
                : "历史记录未保存判断题，请结合该次冻结的用例规范查看。"}
            </p>
            <p className="run-muted">
              {decision.kind === "BOOLEAN"
                ? "通过条件：JEV 回答为 true（是）。"
                : decision.passThreshold !== undefined
                  ? `通过条件：归一化得分 ≥ ${decision.passThreshold}。`
                  : "历史记录未保存通过阈值。"}
            </p>
            <h5>JEV 回答</h5>
            <p>
              返回值：<code>{String(decision.value)}</code>
            </p>
            {decision.probability !== undefined && (
              <p>JEV 判断为“是”的概率：{Math.round(decision.probability * 100)}%</p>
            )}
            {decision.confidence !== undefined && (
              <p>模型返回的 confidence：{Math.round(decision.confidence * 100)}%</p>
            )}
            <p>
              <strong>JEV 返回原因：</strong>
              {decision.providerReason
                ? readable(decision.providerReason)
                : "未记录文字原因；不以平台说明冒充模型原话。"}
            </p>
            {providerEvidence.length > 0 && (
              <ul>
                {providerEvidence.map((item, i) => (
                  <li key={i}>{readable(item)}</li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <h5>平台提取的 Trace / 规范证据</h5>
            {platformEvidence.length ? (
              <ul>
                {platformEvidence.map((item, i) => (
                  <li key={i}>{readable(item)}</li>
                ))}
              </ul>
            ) : (
              <p className="run-muted">未记录可读证据。模型判定不等于事实已被独立验证。</p>
            )}
            {decision.evidenceRefs.length > 0 && (
              <details>
                <summary>证据位置（{decision.evidenceRefs.length}）</summary>
                <ul>
                  {decision.evidenceRefs.map((ref, i) => (
                    <li key={i}>
                      <code>{ref}</code>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>
        </div>
        <details className="run-jev-raw">
          <summary>技术详情 / 原始回答</summary>
          <p>
            检查项 ID：<code>{decision.questionId}</code>
          </p>
          <EvidenceJson
            value={
              decision.providerResponse ?? {
                value: decision.value,
                reason: decision.providerReason ?? null
              }
            }
          />
        </details>
      </details>
    </article>
  );
}

export function JevMetrics({ semantic }: { readonly semantic: SemanticEvaluation }): ReactElement {
  const metrics = semantic.metrics;
  const tokens = (value: number | undefined): string =>
    value === undefined ? "未记录" : value.toLocaleString("en-US");
  const total =
    metrics?.inputTokens !== undefined && metrics.outputTokens !== undefined
      ? metrics.inputTokens + metrics.outputTokens
      : undefined;
  return (
    <>
      <div className="run-jev-summary-grid run-jev-metrics">
        <div>
          <span>JEV 评测耗时</span>
          <strong>{metrics ? `${(metrics.durationMs / 1000).toFixed(2)} 秒` : "未记录"}</strong>
        </div>
        <div>
          <span>输入 Token</span>
          <strong>{tokens(metrics?.inputTokens)}</strong>
        </div>
        <div>
          <span>输出 Token</span>
          <strong>{tokens(metrics?.outputTokens)}</strong>
        </div>
        <div>
          <span>{metrics && !metrics.usageComplete ? "已知 Token 合计" : "Token 合计"}</span>
          <strong>{tokens(total)}</strong>
        </div>
      </div>
      <p className="run-muted run-jev-meter-note">
        {metrics
          ? `本次评测 ${metrics.requestCount} 次请求；${metrics.usageComplete ? "Token 来自接口实际返回。" : "Token 统计不完整，未返回的用量不计为 0。"}`
          : "历史记录未采集 JEV 耗时与 Token，无法回填。"}{" "}
        耗时不含 Agent 执行；Token 不含 Agent 消耗。
      </p>
    </>
  );
}

export function RunSemanticEvaluation({
  evaluation
}: {
  readonly evaluation: NonNullable<DashboardCase["evaluation"]>;
}): ReactElement | null {
  const [open, setOpen] = useState(true);
  const semantic = evaluation.semanticEvaluation;
  if (!semantic) return null;
  // Brief 裁判结论随输出流展示（结论带 → 输出 → 裁判 → 输入材料），这里只留评测用量。
  if (isBriefSemanticEvaluation(semantic)) return <JevMetrics semantic={semantic} />;
  const { result } = semantic;
  const checks = result.decisions.map((decision) => ({
    decision,
    status: verdict(decision, result.blockingFailures)
  }));
  const count = (status: Verdict): number =>
    checks.filter((check) => check.status === status).length;
  return (
    <details className="run-jev-panel" open={open}>
      <summary
        className="run-jev-panel-summary"
        onClick={(event) => {
          event.preventDefault();
          setOpen(!open);
        }}
      >
        <span className="run-jev-panel-title">
          <strong>JEV 语义评测</strong>
          <span>{semantic.model}</span>
        </span>
        <span className="run-jev-panel-meta">
          <span>
            {count("PASS")}/{checks.length - count("NA")} 检查项通过
          </span>
          <Badge variant="outline" data-status={result.passed ? "PASS" : "FAIL"}>
            {result.passed ? "PASS · 总体通过" : "FAIL · 总体未通过"}
          </Badge>
        </span>
      </summary>
      <div className="run-jev-panel-body">
        <JevMetrics semantic={semantic} />
        <div className="run-jev-overview">
          <strong>逐项判定</strong>
          <span>
            {count("PASS")} 通过 · {count("FAIL")} 未通过 · {count("NA")} 不适用
            {count("UNKNOWN") ? ` · ${count("UNKNOWN")} 待确认` : ""}
          </span>
        </div>
        <p className="run-muted">
          总体结果由阻断项决定，非阻断项失败不会被隐藏。不适用项不计入通过数。平台规则说明不是额外模型生成的解释。
        </p>
        <div className="run-jev-check-list">
          {checks.map(({ decision, status }) => (
            <JevCheck key={decision.questionId} decision={decision} status={status} />
          ))}
        </div>
        {result.blockingFailures
          .filter(
            (failure) =>
              !checks.some(({ decision }) => failure.startsWith(`${decision.questionId}:`))
          )
          .map((failure) => (
            <p role="alert" key={failure}>
              {readable(failure)}
            </p>
          ))}
        {(result.warnings.length > 0 || !checks.length) && (
          <details className="run-jev-section">
            <summary>评测器警告 / 异常</summary>
            {checks.length === 0 && <p>JEV 没有返回检查项，不能据此认为所有检查都通过。</p>}
            <ul>
              {result.warnings.map((warning, i) => (
                <li key={i}>{readable(warning)}</li>
              ))}
            </ul>
          </details>
        )}
        <details className="run-jev-raw">
          <summary>评测配置与完整记录</summary>
          <p>
            评测器：{semantic.provider} · 计划版本：{semantic.planVersion} · 聚合得分：
            {Math.round(result.score * 100)}%
          </p>
          <EvidenceJson value={semantic} />
        </details>
      </div>
    </details>
  );
}
