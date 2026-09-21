import { useEffect, useState, type ReactElement } from "react";
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

/** Assertions grouped by dimension layer; failed items are summarized in the verdict card. */
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

/** Shared assertion card used by both passed items and the failure list in the verdict card. */
function RunCheckItem({
  item,
  variant
}: {
  readonly item: CheckItem;
  readonly variant: "passed" | "issue";
}): ReactElement {
  // Every assertion starts collapsed. The verdict card still keeps the failure reason in the
  // shared body, but users open it on demand instead of getting a pre-expanded card.
  const [open, setOpen] = useState(false);

  return (
    <details
      className={`run-check-item${variant === "issue" ? " run-check-item-issue" : ""}`}
      open={open}
      data-status={item.resultStatus}
      data-tier={item.parsed.tier}
    >
      <summary
        onClick={(event) => {
          event.preventDefault();
          setOpen((current) => !current);
        }}
      >
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
          {item.score !== undefined && item.score !== null ? ` · 得分 ${item.score}` : ""} ·{" "}
          {item.parsed.tierLabel} · {item.parsed.dimensionLabel}
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
  );
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
  const issueItems = items.filter((item) => !item.passed);
  const verdict = evaluation?.status;
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  useEffect(() => setOpenGroups({}), [row.caseKey]);
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
  // Failed/unresolved items are summarized once in the verdict card. Each dimension is an
  // independently collapsible group; all groups start closed so the drawer stays compact.
  return (
    <section className="run-result-panel run-check-panel" aria-label="验收检查">
      <div className="run-panel-heading">
        <h3>验收检查</h3>
        <div className="run-check-heading-actions">
          <span>
            {passed} 通过 · {failed} 未通过{unresolved > 0 ? ` · ${unresolved} 待处理 / 异常` : ""}
          </span>
        </div>
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
        {issueItems.length > 0 && (
          <div className="run-verdict-issues" role={verdict === "FAIL" ? "alert" : undefined}>
            <div className="run-verdict-issues-head">
              <strong>
                {hardFailures.length > 0
                  ? "未通过项 · 硬性门禁失败，直接导致 FAIL"
                  : verdict === "FAIL"
                    ? "未通过项"
                    : "需关注项"}
              </strong>
              <span>{issueItems.length} 项</span>
            </div>
            <ul>
              {issueItems.map((item) => (
                <li key={item.index} className="run-verdict-issue" data-status={item.resultStatus}>
                  <RunCheckItem item={item} variant="issue" />
                </li>
              ))}
            </ul>
          </div>
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
      </div>
      {items.length === 0 && <p className="run-muted">未记录验收项</p>}
      {groups.map((group) => {
        const visible = group.items.filter((item) => item.passed);
        const issueCount = group.items.filter((item) => !item.passed).length;
        const open = openGroups[group.key] === true;
        return (
          <details
            className="run-check-group"
            key={group.key}
            data-dimension={group.key}
            open={open}
          >
            <summary
              className="run-check-group-head"
              onClick={(event) => {
                event.preventDefault();
                setOpenGroups((current) => ({ ...current, [group.key]: !open }));
              }}
            >
              <span className="run-check-group-title">
                <h4>{group.label}</h4>
              </span>
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
            </summary>
            {open && (
              <div className="run-check-group-content">
                {visible.map((item) => (
                  <RunCheckItem key={item.index} item={item} variant="passed" />
                ))}
                {issueCount > 0 && (
                  <p className="run-check-group-empty run-check-group-issues">
                    {issueCount} 项未通过，详情已在上方结论卡列出。
                  </p>
                )}
                {visible.length === 0 && issueCount === 0 && (
                  <p className="run-check-group-empty">本维度暂无可展示的验收项。</p>
                )}
              </div>
            )}
          </details>
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
