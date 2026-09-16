import { useState, type ReactElement } from "react";
import { manualOverride, type DashboardCase } from "./run-dashboard-model.ts";
import { Badge } from "../../components/ui/badge.tsx";
import { EvidenceJson } from "./run-trace-panel.tsx";
import {
  ASSERTION_DIMENSIONS,
  UNMARKED_DIMENSION_LABEL,
  parseAssertionMetric,
  summarizeAssertionTiers,
  type AssertionTierSummary,
  type ParsedAssertionMetric
} from "../../lib/assertion-metric.ts";

type AssertionDefinition = NonNullable<DashboardCase["definition"]>["assert"][number];
type AssertionResult = NonNullable<DashboardCase["evaluation"]>["assertions"][number];

/** Verdict tokens stay verbatim next to a plain-language gloss. */
const VERDICT_LABELS: Readonly<Record<string, string>> = {
  PASS: "PASS（通过）",
  FAIL: "FAIL（未通过）",
  EVALUATION_ERROR: "EVALUATION_ERROR（评测异常）",
  NOT_EVALUATED: "NOT_EVALUATED（未评测）"
};

/** One Assertion paired with its result, plus the readable facts parsed from its metric name. */
interface CheckItem {
  readonly index: number;
  readonly parsed: ParsedAssertionMetric;
  readonly passed: boolean;
  readonly failed: boolean;
  readonly stateLabel: string;
  readonly reason: string;
  readonly kind: string;
  readonly score: number | null | undefined;
  readonly resultStatus: AssertionResult["status"] | undefined;
  readonly expected: AssertionDefinition | undefined;
  readonly result: AssertionResult | undefined;
  readonly matches: readonly AssertionResult[];
}

/** Assertions grouped by dimension layer, failures first. */
interface CheckGroup {
  readonly key: string;
  readonly label: string;
  readonly items: readonly CheckItem[];
  readonly pass: number;
  /** Per-group tier counters, so a group header can split 硬性 from 质量. */
  readonly tiers: AssertionTierSummary;
  /** `FAIL` when a gate vetoed, `WARN` when only quality missed, else `PASS`. */
  readonly state: "PASS" | "WARN" | "FAIL";
}

// Failures lead, abnormal results follow, passes trail; the original index keeps ties stable.
function itemRank(item: CheckItem): number {
  return item.failed ? 0 : item.passed ? 2 : 1;
}

// One Assertion's effective outcome, so tier, dimension and group counters never disagree.
function outcomeStatus(item: CheckItem): string {
  return item.passed ? "PASS" : item.failed ? "FAIL" : (item.resultStatus ?? "UNRESOLVED");
}

// Report order of a dimension layer; unclassified always trails the six declared layers.
function dimensionRank(dimension: string | null): number {
  const index = ASSERTION_DIMENSIONS.findIndex((entry) => entry.id === dimension);
  return index === -1 ? ASSERTION_DIMENSIONS.length : index;
}

/** SPEC §6「失败项 top1」: a vetoed gate outranks a quality miss, then dimension, then order. */
function topFailureOf(items: readonly CheckItem[]): CheckItem | undefined {
  return items
    .filter((item) => !item.passed)
    .sort(
      (left, right) =>
        Number(right.parsed.tier === "HARD") - Number(left.parsed.tier === "HARD") ||
        itemRank(left) - itemRank(right) ||
        dimensionRank(left.parsed.dimension) - dimensionRank(right.parsed.dimension) ||
        left.index - right.index
    )[0];
}

/** Pair by immutable assertion index; never match descriptions or silently drop missing results. */
export function RunCaseChecks({ row }: { readonly row: DashboardCase }): ReactElement {
  const definitions = row.definition?.assert ?? [],
    evaluation = row.evaluation;
  const results = evaluation?.assertions ?? [];
  const indices = [...new Set([...definitions.map((_, i) => i), ...results.map((r) => r.index)])];
  const items: CheckItem[] = indices.map((index) => {
    const expected = definitions[index],
      matches = results.filter((r) => r.index === index),
      result = matches.length === 1 ? matches[0] : undefined,
      paired = expected !== undefined && matches.length === 1;
    const stateLabel = !expected
      ? "缺少预期定义"
      : matches.length > 1
        ? "评测记录冲突"
        : result?.status === "PASS"
          ? "通过"
          : result?.status === "FAIL"
            ? "未通过"
            : result
              ? "评测异常"
              : evaluation
                ? "缺少分项结果"
                : "待评测";
    return {
      index,
      parsed: parseAssertionMetric(expected?.metric ?? result?.metric ?? `验收项 ${index + 1}`),
      passed: paired && result?.status === "PASS",
      failed: paired && result?.status === "FAIL",
      stateLabel,
      reason:
        result?.reason ??
        (matches.length > 1
          ? "同一断言存在多个结果，不能可靠配对。"
          : evaluation
            ? "未记录该项判断依据。"
            : "尚未执行评测。"),
      kind: (expected?.type ?? result?.type) === "llm-rubric" ? "模型评分" : "规则断言",
      score: result?.score,
      resultStatus: result?.status,
      expected,
      result,
      matches
    };
  });
  const passed = items.filter((item) => item.passed).length,
    failed = items.filter((item) => item.failed).length,
    unresolved = items.length - passed - failed;
  const tiers = summarizeAssertionTiers(
    items.map((item) => ({ tier: item.parsed.tier, status: outcomeStatus(item) }))
  );
  const hardFailures = items.filter((item) => item.parsed.tier === "HARD" && item.failed);
  const softFailures = items.filter((item) => item.parsed.tier === "SOFT" && item.failed);
  const topFailure = topFailureOf(items);
  const verdict = evaluation?.status;
  const groups: CheckGroup[] = [
    ...ASSERTION_DIMENSIONS.map((entry) => ({
      key: entry.id,
      label: entry.label,
      items: items.filter((item) => item.parsed.dimension === entry.id)
    })),
    {
      key: "UNMARKED",
      label: UNMARKED_DIMENSION_LABEL,
      items: items.filter((item) => item.parsed.dimension === null)
    }
  ]
    .filter((group) => group.items.length > 0)
    .map((group) => {
      const sorted = [...group.items].sort(
        (left, right) => itemRank(left) - itemRank(right) || left.index - right.index
      );
      const groupTiers = summarizeAssertionTiers(
        sorted.map((item) => ({ tier: item.parsed.tier, status: outcomeStatus(item) }))
      );
      return {
        ...group,
        items: sorted,
        pass: sorted.filter((item) => item.passed).length,
        tiers: groupTiers,
        state:
          groupTiers.hard.fail > 0 ||
          sorted.some((item) => item.parsed.tier !== "SOFT" && item.failed)
            ? "FAIL"
            : sorted.every((item) => item.passed)
              ? "PASS"
              : "WARN"
      } satisfies CheckGroup;
    });
  // Passing items stay expanded while nothing failed, and fold away as soon as a failure exists.
  const [folded, setFolded] = useState<boolean | null>(null);
  const showPassed = folded ?? failed + unresolved === 0;
  return (
    <section className="run-result-panel run-check-panel" aria-label="验收检查">
      <div className="run-panel-heading">
        <h3>验收检查</h3>
        <span>
          {passed} 通过 · {failed} 未通过{unresolved > 0 ? ` · ${unresolved} 待处理 / 异常` : ""}
        </span>
      </div>
      <div className="run-verdict-bar" data-verdict={verdict ?? "PENDING"}>
        <div className="run-verdict-line">
          <strong className="run-verdict-label">
            结论 {VERDICT_LABELS[verdict ?? ""] ?? "待评测"}
          </strong>
          {tiers.marked ? (
            <>
              <span className="run-verdict-count" data-tier="HARD">
                硬性 {tiers.hard.pass}/{tiers.hard.total} 通过
              </span>
              <span
                className="run-verdict-count"
                data-tier="SOFT"
                data-missed={softFailures.length > 0 ? "true" : undefined}
              >
                质量 {tiers.soft.pass}/{tiers.soft.total} 通过
              </span>
            </>
          ) : (
            <span className="run-verdict-count">
              未标记前缀 {tiers.unmarked.total} 项（旧套件 metric
              名没有【硬性】/【质量】，无法分层）
            </span>
          )}
          {tiers.marked && tiers.unmarked.total > 0 && (
            <span className="run-verdict-count">未标记前缀 {tiers.unmarked.total} 项</span>
          )}
          {verdict === "PASS" && softFailures.length > 0 && (
            <span className="run-verdict-softwarn" role="status">
              {softFailures.length} 项质量未达标 · 不阻断 PASS，逐项见下
            </span>
          )}
        </div>
        {topFailure && (
          <div className="run-verdict-top1">
            <span className="run-verdict-top1-head">失败项 top1</span>
            <span className="run-verdict-top1-name">
              <Badge className="run-check-tier" data-tier={topFailure.parsed.tier}>
                {topFailure.parsed.tierLabel}
              </Badge>
              <span>
                {topFailure.parsed.title}
                {topFailure.parsed.detail !== "" ? `｜${topFailure.parsed.detail}` : ""}
              </span>
            </span>
            <p className="run-check-reason" data-state={topFailure.failed ? "FAIL" : "OTHER"}>
              {topFailure.reason}
            </p>
          </div>
        )}
      </div>
      {hardFailures.length > 0 && (
        <div className="run-check-veto" role="alert">
          <p className="run-check-veto-head">一票否决项：以下硬性门禁失败，直接导致结论 FAIL</p>
          <ol>
            {hardFailures.map((item) => (
              <li key={item.index}>
                <span className="run-check-veto-name">{item.parsed.title}</span>
                <p className="run-check-reason" data-state="FAIL">
                  {item.reason}
                </p>
              </li>
            ))}
          </ol>
        </div>
      )}
      {verdict === "FAIL" && hardFailures.length === 0 && (
        <p className="run-check-veto-empty">
          结论 FAIL，但没有【硬性】项失败：可能是断言未使用【硬性】/【质量】前缀，或加权得分低于
          Case 阈值
          {row.definition ? ` ${row.definition.threshold}` : "（阈值未记录）"}。
        </p>
      )}
      {evaluation && (
        <p className="run-check-overall">
          自动结论：
          {evaluation.status === "PASS"
            ? "通过"
            : evaluation.status === "FAIL"
              ? "未通过"
              : evaluation.status === "EVALUATION_ERROR"
                ? "评测异常"
                : "无法评测"}{" "}
          · 原始自动结果保留
        </p>
      )}
      {evaluation && manualOverride(row) && (
        <p className="run-check-overall" data-manual-override="true">
          人工复核为最终结论，已覆盖自动结论；归因与说明见复核记录。
        </p>
      )}
      {items.length === 0 && <p className="run-muted">未记录验收项</p>}
      {passed > 0 && (
        <button
          type="button"
          className="run-check-toggle"
          aria-expanded={showPassed}
          onClick={() => setFolded(!showPassed)}
        >
          {showPassed ? `折叠 ${passed} 项已通过` : `展开 ${passed} 项已通过`}
        </button>
      )}
      {groups.map((group) => {
        const visible = group.items.filter((item) => showPassed || !item.passed);
        return (
          <section className="run-check-group" key={group.key} data-dimension={group.key}>
            <div className="run-check-group-head">
              <h4>{group.label}</h4>
              <span data-state={group.state}>
                {group.tiers.marked
                  ? `本组 硬性 ${group.tiers.hard.pass}/${group.tiers.hard.total} 通过 · 质量 ${group.tiers.soft.pass}/${group.tiers.soft.total} 通过${
                      group.tiers.unmarked.total > 0
                        ? ` · 未标记 ${group.tiers.unmarked.total} 项`
                        : ""
                    }`
                  : `本组 ${group.pass}/${group.items.length} 通过`}
                {group.state === "WARN" ? "（质量未达标，不阻断结论）" : ""}
              </span>
            </div>
            {visible.map((item) => (
              <details
                key={item.index}
                className="run-check-item"
                open={!item.passed}
                data-status={item.resultStatus}
                data-tier={item.parsed.tier}
              >
                <summary>
                  <span className="run-check-title">
                    <Badge className="run-check-tier" data-tier={item.parsed.tier}>
                      {item.parsed.tierLabel}
                    </Badge>
                    <span className="run-check-name">{item.parsed.title}</span>
                    {item.parsed.detail !== "" && (
                      <span className="run-check-detail">{item.parsed.detail}</span>
                    )}
                  </span>
                  <Badge variant="outline" data-status={item.resultStatus}>
                    {item.stateLabel}
                  </Badge>
                </summary>
                <div className="run-check-body">
                  <p className="run-muted">
                    {item.kind}
                    {item.score !== undefined && item.score !== null
                      ? ` · 得分 ${item.score}`
                      : ""}{" "}
                    · {item.parsed.tierLabel} · {item.parsed.dimensionLabel}
                    {item.parsed.code === null && item.parsed.raw !== "" && (
                      <> · metric 原文：{item.parsed.raw}</>
                    )}
                  </p>
                  <p
                    className="run-check-reason"
                    data-state={item.failed ? "FAIL" : item.passed ? "PASS" : "OTHER"}
                  >
                    {item.reason}
                  </p>
                  {!item.expected && <p role="alert">缺少对应的预期定义，不能确认评测配置。</p>}
                  <details>
                    <summary>原始 JSON（断言定义与分项结果）</summary>
                    <EvidenceJson
                      value={{
                        expected: item.expected ?? "未记录",
                        result: item.result ?? item.matches
                      }}
                    />
                  </details>
                </div>
              </details>
            ))}
            {visible.length === 0 && (
              <p className="run-check-group-empty">
                本维度 {group.items.length} 项全部通过，已折叠。
              </p>
            )}
          </section>
        );
      })}
      {evaluation !== undefined && (evaluation.reason ?? evaluation.evaluationError) && (
        <details className="run-check-engine" open={evaluation.status === "EVALUATION_ERROR"}>
          <summary>总体评分 / 评测器说明</summary>
          <p>{evaluation.reason ?? evaluation.evaluationError?.code}</p>
        </details>
      )}
    </section>
  );
}
