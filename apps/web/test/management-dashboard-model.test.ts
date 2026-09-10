import { describe, expect, it } from "vitest";
import { attentionReason, scenarioResults } from "../src/features/dashboard/dashboard-model.ts";
import { dashboardCounts, type DashboardCase } from "../src/features/runs/run-dashboard-model.ts";
import { runReportCase } from "./run-test-fixture.ts";
import { reviewFixture } from "./run-case-drawer-fixture.ts";
function row(key: string, module = "todo"): DashboardCase {
  return {
    caseKey: key,
    ordinal: 0,
    rest: runReportCase.rest,
    evaluation: runReportCase.evaluation,
    definition: {
      ...runReportCase.definition,
      metadata: {
        ...runReportCase.definition.metadata,
        business_module: module,
        scenario_tag: "task-search"
      }
    },
    report: runReportCase
  };
}
describe("管理视图统计口径", () => {
  it("同名场景跨模块不合并，问题优先，数量守恒", () => {
    const failing = {
      ...row("failed"),
      evaluation: {
        ...runReportCase.evaluation,
        status: "FAIL" as const,
        score: 0,
        reason: "标题不一致",
        promptfooSuccess: false,
        evaluationError: null
      }
    };
    const rows = [row("passed", "other"), failing, { ...row("pending"), evaluation: undefined }];
    const groups = scenarioResults(rows);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ module: "todo", total: 2, counts: { FAIL: 1, PENDING: 1 } });
    expect(Object.values(dashboardCounts(3, rows)).reduce((a, b) => a + b, 0)).toBe(3);
    expect(attentionReason(failing)).toBe("标题不一致");
  });
  it("人工失败不展示自动通过的理由，人工通过不能覆盖自动失败", () => {
    const review = reviewFixture({
      history: [
        {
          revision: 1,
          at: "2026-09-09T00:00:00Z",
          kind: "DECISION",
          verdict: "FAIL",
          reviewer: "产品",
          rootCause: "PRODUCT",
          note: "卡片布局错误"
        }
      ]
    });
    const manualFailure = { ...row("manual"), review };
    expect(attentionReason(manualFailure)).toBe("人工复核未通过");
    const failed: DashboardCase = {
      ...manualFailure,
      review: {
        ...review,
        history: review.history.map((entry) => ({ ...entry, verdict: "PASS" as const }))
      },
      evaluation: {
        ...runReportCase.evaluation,
        status: "FAIL",
        score: 0,
        reason: "业务失败",
        promptfooSuccess: false,
        evaluationError: null
      }
    };
    expect(dashboardCounts(1, [failed]).FAIL).toBe(1);
  });
});
