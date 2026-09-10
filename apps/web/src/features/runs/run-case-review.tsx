import type { ReactElement } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { RunReview } from "@cortex-eval/contracts/src/run-review-contracts.ts";
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
export function ReviewForm({
  review,
  visual = false,
  canApprove = true,
  rendererVersion
}: {
  readonly review: RunReview;
  readonly visual?: boolean;
  readonly canApprove?: boolean;
  readonly rendererVersion?: string | null;
}): ReactElement {
  const last = review.history.at(-1),
    client = useQueryClient();
  const staleApproval =
    visual &&
    last?.verdict === "PASS" &&
    (!last.rendererVersion || last.rendererVersion !== review.live?.rendererVersion);
  const [verdict, setVerdict] = useState<"PASS" | "FAIL" | "PENDING">(
    staleApproval ? "PENDING" : (last?.verdict ?? "PENDING")
  );
  const [cause, setCause] = useState<keyof typeof causeNames>(
    (last?.verdict === "FAIL" ? last.rootCause : "UNCLASSIFIED") as keyof typeof causeNames
  );
  const [note, setNote] = useState(last?.note ?? ""),
    [reviewer, setReviewer] = useState(last?.reviewer ?? "");
  const save = useMutation({
    mutationFn: () =>
      runReviewApi.save(review.runId, review.caseKey, {
        expectedRevision: review.revision,
        evidenceHash: review.evidenceHash,
        verdict,
        rootCause: verdict === "FAIL" ? cause : "UNCLASSIFIED",
        note,
        reviewer,
        ...(visual && rendererVersion ? { rendererVersion } : {})
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["run-reviews", review.runId] });
    }
  });
  return (
    <section className="run-review-form">
      <h3>{visual ? "视觉复核" : "人工复核"}</h3>
      <p className="run-muted">
        {visual
          ? "查看本 Case 的动态卡片后确认；更换执行记录或渲染版本需重新审核。"
          : "人工结论独立保留。"}
        人工通过不覆盖自动失败。
      </p>
      {visual && !canApprove && (
        <p className="run-output-warning">卡面尚未全部成功加载，请逐项查看后再确认视觉通过。</p>
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
            <option value="PASS" disabled={!canApprove}>
              {visual ? "通过" : "人工通过"}
            </option>
            <option value="FAIL">{visual ? "不通过" : "人工不通过"}</option>
          </select>
        </label>
        {verdict === "FAIL" && (
          <label>
            失败归因（选填）
            <select
              aria-label="失败归因（选填）"
              value={cause}
              onChange={(e) => setCause(e.target.value as typeof cause)}
            >
              {Object.entries(causeNames).map(([k, v]) => (
                <option key={k} value={k}>
                  {k === "UNCLASSIFIED" ? "暂不归因" : v}
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
        {verdict === "FAIL" ? "问题说明" : "备注（选填）"}
        <textarea
          aria-label={verdict === "FAIL" ? "问题说明" : "备注（选填）"}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          maxLength={4000}
          placeholder={
            verdict === "FAIL" ? "描述看到的问题即可，不要求判断技术原因" : "可补充审核依据"
          }
        />
      </label>
      <Button
        size="sm"
        disabled={save.isPending || !reviewer.trim() || (verdict === "PASS" && !canApprove)}
        onClick={() => save.mutate()}
      >
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
