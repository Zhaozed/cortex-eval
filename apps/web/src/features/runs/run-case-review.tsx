import type { ReactElement } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { RunReview } from "@cortex-eval/contracts/src/run-review-contracts.ts";
import type { DashboardCase } from "./run-dashboard-model.ts";
import { runReviewApi } from "../../lib/run-review-api.ts";
import { Button } from "../../components/ui/button.tsx";
export const causeNames = {
  UNCLASSIFIED: "未分类",
  PRODUCT: "产品缺陷",
  CASE: "Case / 预期错误",
  ENVIRONMENT: "环境 / 数据问题",
  EVALUATOR: "评测工具问题",
  EVIDENCE: "证据不足"
} as const;
const autoStatusNames: Readonly<Record<string, string | undefined>> = {
  PASS: "通过",
  FAIL: "未通过",
  EVALUATION_ERROR: "评测异常",
  NOT_EVALUATED: "无法评测",
  PENDING: "待评测",
  RUNNING: "评测中"
};
export function ReviewForm({
  review,
  visual = false,
  rendererVersion,
  autoStatus
}: {
  readonly review: RunReview;
  readonly visual?: boolean;
  readonly rendererVersion?: string | null;
  readonly autoStatus?: NonNullable<DashboardCase["evaluation"]>["status"] | undefined;
}): ReactElement {
  const last = review.history.at(-1),
    client = useQueryClient();
  // A saved human verdict is never silently reset: it stays until the reviewer changes it.
  const [verdict, setVerdict] = useState<"PASS" | "FAIL" | "PENDING">(last?.verdict ?? "PENDING");
  const [cause, setCause] = useState<keyof typeof causeNames>(
    (last?.kind === "DECISION" && last.rootCause in causeNames
      ? last.rootCause
      : "UNCLASSIFIED") as keyof typeof causeNames
  );
  const [note, setNote] = useState(last?.note ?? ""),
    [reviewer, setReviewer] = useState(last?.reviewer ?? "");
  // Overturning automation is allowed, but it must stay attributable and written down.
  const override = verdict === "PASS" && autoStatus !== undefined && autoStatus !== "PASS",
    showCause = verdict === "FAIL" || override,
    causeLabel = override ? "覆盖归因（必填）" : "失败归因（选填）",
    noteLabel = override ? "覆盖说明（必填）" : verdict === "FAIL" ? "问题说明" : "备注（选填）";
  const save = useMutation({
    mutationFn: () =>
      runReviewApi.save(review.runId, review.caseKey, {
        expectedRevision: review.revision,
        evidenceHash: review.evidenceHash,
        verdict,
        rootCause: verdict === "FAIL" || override ? cause : "UNCLASSIFIED",
        note,
        reviewer,
        ...(visual && rendererVersion ? { rendererVersion } : {})
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["run-reviews", review.runId] });
    }
  });
  const blocked =
    save.isPending ||
    !reviewer.trim() ||
    (override && cause === "UNCLASSIFIED") ||
    ((override || cause !== "UNCLASSIFIED") && !note.trim());
  return (
    <section className="run-review-form">
      <h3>{visual ? "视觉复核" : "人工复核"}</h3>
      <p className="run-muted">
        {visual
          ? "结合动态卡片与执行链路判断；卡片未全部加载也可以直接给结论。"
          : "人工结论独立保留。"}
        人工结论为最终结论，可覆盖自动评测；自动结果原样保留，覆盖需填写归因与说明。
      </p>
      {override && (
        <p className="run-output-warning" role="alert">
          自动结论：{autoStatusNames[autoStatus] ?? "非通过"}
          。人工通过将覆盖它，请选择覆盖归因并填写说明；覆盖记录会连同审核人一起留痕。
        </p>
      )}
      <div className="run-review-fields" data-verdict={verdict}>
        <label>
          {visual ? "视觉复核结论" : "人工结论"}
          <select
            aria-label={visual ? "视觉复核结论" : "人工结论"}
            value={verdict}
            onChange={(e) => {
              const next = e.target.value as typeof verdict;
              setVerdict(next);
              if (next !== "FAIL") setCause("UNCLASSIFIED");
            }}
          >
            <option value="PENDING">待复核</option>
            <option value="PASS">{visual ? "通过" : "人工通过"}</option>
            <option value="FAIL">{visual ? "不通过" : "人工不通过"}</option>
          </select>
        </label>
        {showCause && (
          <label>
            {causeLabel}
            <select
              aria-label={causeLabel}
              value={cause}
              onChange={(e) => setCause(e.target.value as typeof cause)}
            >
              {Object.entries(causeNames).map(([k, v]) => (
                <option key={k} value={k}>
                  {k === "UNCLASSIFIED" ? (override ? "请选择归因" : "暂不归因") : v}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          审核人
          <input
            value={reviewer}
            maxLength={100}
            onChange={(e) => setReviewer(e.target.value)}
            placeholder="填写姓名"
          />
        </label>
      </div>
      <label>
        {noteLabel}
        <textarea
          aria-label={noteLabel}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          maxLength={4000}
          placeholder={
            override
              ? "说明为什么自动结论不成立，例如链路正确但判定规则或环境不符合预期"
              : verdict === "FAIL"
                ? "描述看到的问题即可，不要求判断技术原因"
                : "可补充审核依据"
          }
        />
      </label>
      <Button size="sm" disabled={blocked} onClick={() => save.mutate()}>
        保存复核
      </Button>
      {save.isError && <p role="alert">保存失败，记录可能已更新。请关闭后重新打开再试。</p>}
      {save.isSuccess && <span role="status"> 已保存</span>}
      {review.history.length > 0 && (
        <details>
          <summary>审核历史 · {review.history.length}</summary>
          {[...review.history].reverse().map((event) => (
            <article key={event.revision}>
              <p>
                {new Date(event.at).toLocaleString("zh-CN")} · {event.reviewer || "历史记录"} ·{" "}
                {event.verdict === "PASS"
                  ? "人工通过"
                  : event.verdict === "FAIL"
                    ? "人工不通过"
                    : "待复核"}
              </p>
              {event.rootCause !== "UNCLASSIFIED" && (
                <p>
                  当时归因：
                  {Object.entries(causeNames).find(([key]) => key === event.rootCause)?.[1] ??
                    event.rootCause}
                </p>
              )}
              <p>{event.note || "无备注"}</p>
            </article>
          ))}
        </details>
      )}
    </section>
  );
}
