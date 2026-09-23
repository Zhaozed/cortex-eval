// @vitest-environment jsdom
import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { JevMetrics, RunSemanticEvaluation } from "../src/features/runs/run-jev-evaluation.tsx";
import type { DashboardCase } from "../src/features/runs/run-dashboard-model.ts";

type Evaluation = NonNullable<DashboardCase["evaluation"]>;
type Semantic = NonNullable<Evaluation["semanticEvaluation"]>;
const semantic: Semantic = {
  provider: "jev-http",
  model: "jev-latest",
  planVersion: "cortex.semantic-evaluation-contract.v1",
  result: {
    contractVersion: "cortex.semantic-evaluation-contract.v1",
    passed: true,
    score: 0.5,
    blockingFailures: [],
    warnings: [],
    decisions: [
      {
        questionId: "routing.correct",
        kind: "BOOLEAN",
        value: true,
        applicable: true,
        verdict: "PASS",
        blocking: true,
        question: "是否路由到飞书任务？",
        platformReason: "&#x4A;EV 判定路由正确；list\\_tasks",
        evidence: ["Trace 路由: tasks"],
        evidenceRefs: ["trace.router"]
      },
      {
        questionId: "response.clean",
        kind: "BOOLEAN",
        value: false,
        applicable: true,
        verdict: "FAIL",
        blocking: false,
        evidence: [],
        evidenceRefs: []
      },
      {
        questionId: "tool-use.recovery",
        kind: "BOOLEAN",
        value: false,
        applicable: false,
        verdict: "NA",
        evidence: [],
        evidenceRefs: []
      },
      {
        questionId: "quality",
        kind: "SCORE",
        value: 4,
        applicable: true,
        evidence: [],
        evidenceRefs: []
      }
    ]
  }
};
function evaluation(value: Semantic): Evaluation {
  // Only semanticEvaluation is consumed by this component.
  return { semanticEvaluation: value } as Evaluation;
}

describe("JEV readable result", () => {
  it("shows all per-item verdicts by default, including nonblocking FAIL, N/A and historical unknown", () => {
    const { container } = render(<RunSemanticEvaluation evaluation={evaluation(semantic)} />);
    expect(screen.getByText("PASS · 总体通过")).toBeVisible();
    expect(screen.getByText("1/3 检查项通过")).toBeVisible();
    for (const label of ["PASS · 通过", "FAIL · 未通过", "N/A · 不适用", "待确认", "路由是否正确"])
      expect(screen.getByText(label)).toBeVisible();
    expect(screen.getByText("非阻断项")).toBeVisible();
    expect(screen.getByText("JEV 判定路由正确；list_tasks")).toBeVisible();
    const card = container.querySelector(".run-jev-check");
    if (!(card instanceof HTMLElement)) throw new Error("card missing");
    fireEvent.click(within(card).getByText("判定标准与证据"));
    expect(screen.getByText("是否路由到飞书任务？")).toBeVisible();
    expect(screen.getByText("Trace 路由: tasks")).toBeVisible();
  });

  it("renders measured JEV latency and usage, preserving zero output", () => {
    render(
      <JevMetrics
        semantic={{
          ...semantic,
          metrics: {
            durationMs: 1251,
            requestCount: 1,
            inputTokens: 11256,
            outputTokens: 0,
            usageComplete: true
          }
        }}
      />
    );
    expect(screen.getByText("1.25 秒")).toBeVisible();
    expect(screen.getAllByText("11,256")).toHaveLength(2);
    expect(screen.getByText("0")).toBeVisible();
    expect(screen.getByText(/耗时不含 Agent 执行/)).toBeVisible();
  });

  it("does not manufacture historical costs or a complete total from partial usage", () => {
    const { rerender } = render(<JevMetrics semantic={semantic} />);
    expect(screen.getAllByText("未记录")).toHaveLength(4);
    rerender(
      <JevMetrics
        semantic={{
          ...semantic,
          metrics: { durationMs: 10, requestCount: 2, inputTokens: 100, usageComplete: false }
        }}
      />
    );
    expect(screen.getByText(/Token 统计不完整/)).toBeVisible();
    expect(screen.getAllByText("未记录")).toHaveLength(2);
    expect(screen.getByText("已知 Token 合计")).toBeVisible();
  });
});
