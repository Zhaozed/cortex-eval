import type { ReactElement } from "react";
import type { DashboardCase } from "./run-dashboard-model.ts";
import { Badge } from "../../components/ui/badge.tsx";
import { EvidenceJson } from "./run-trace-panel.tsx";

/** Pair by immutable assertion index; never match descriptions or silently drop missing results. */
export function RunCaseChecks({ row }: { readonly row: DashboardCase }): ReactElement {
  const definitions = row.definition?.assert ?? [],
    evaluation = row.evaluation;
  const results = evaluation?.assertions ?? [];
  const indices = [...new Set([...definitions.map((_, i) => i), ...results.map((r) => r.index)])];
  const count = (status: "PASS" | "FAIL"): number =>
    indices.filter((i) => {
      const matches = results.filter((r) => r.index === i);
      return definitions[i] !== undefined && matches.length === 1 && matches[0]?.status === status;
    }).length;
  const passed = count("PASS"),
    failed = count("FAIL"),
    unresolved = indices.length - passed - failed;
  return (
    <section className="run-result-panel run-check-panel" aria-label="验收检查">
      <div className="run-panel-heading">
        <h3>验收检查</h3>
        <span>
          {passed} 通过 · {failed} 未通过{unresolved > 0 ? ` · ${unresolved} 待处理 / 异常` : ""}
        </span>
      </div>
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
      {indices.length === 0 && <p className="run-muted">未记录验收项</p>}
      {indices.map((index) => {
        const expected = definitions[index],
          matches = results.filter((r) => r.index === index);
        const result = matches.length === 1 ? matches[0] : undefined;
        const status = !expected
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
        const reason =
            result?.reason ??
            (matches.length > 1
              ? "同一断言存在多个结果，不能可靠配对。"
              : evaluation
                ? "未记录该项判断依据。"
                : "尚未执行评测。"),
          type = expected?.type ?? result?.type;
        return (
          <details
            key={index}
            className="run-check-item"
            open={status !== "通过"}
            data-status={result?.status}
          >
            <summary>
              <span>{expected?.metric ?? result?.metric ?? `验收项 ${index + 1}`}</span>
              <Badge variant="outline" data-status={result?.status}>
                {status}
              </Badge>
            </summary>
            <div className="run-check-body">
              <p className="run-muted">
                {type === "llm-rubric" ? "模型评分" : "规则断言"}
                {result?.score !== undefined && result.score !== null
                  ? ` · 得分 ${result.score}`
                  : ""}
              </p>
              <p>{reason.length > 180 ? `${reason.slice(0, 180)}…` : reason}</p>
              {!expected && <p role="alert">缺少对应的预期定义，不能确认评测配置。</p>}
              <details>
                <summary>约束与完整判断依据</summary>
                <p className="run-readable">{reason}</p>
                <EvidenceJson
                  value={{ expected: expected ?? "未记录", result: result ?? matches }}
                />
              </details>
            </div>
          </details>
        );
      })}
      {(evaluation?.reason ?? evaluation?.evaluationError) && (
        <details className="run-check-engine" open={evaluation.status === "EVALUATION_ERROR"}>
          <summary>总体评分 / 评测器说明</summary>
          <p>{evaluation.reason ?? evaluation.evaluationError?.code}</p>
        </details>
      )}
    </section>
  );
}
