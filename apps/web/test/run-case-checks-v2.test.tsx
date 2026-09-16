// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { DashboardCase } from "../src/features/runs/run-dashboard-model.ts";
import { RunCaseChecks } from "../src/features/runs/run-case-checks.tsx";
import { RunDashboardCases } from "../src/features/runs/run-dashboard-cases.tsx";
import type { RunApi } from "../src/lib/run-api.ts";
import { evidenceRow } from "./run-case-drawer-fixture.ts";
import { runReportCase } from "./run-test-fixture.ts";

type Definition = NonNullable<DashboardCase["definition"]>;
type Evaluation = NonNullable<DashboardCase["evaluation"]>;
/** Only the graded variant carries per-item scores; ERROR/NOT_EVALUATED variants do not. */
type GradedEvaluation = Extract<Evaluation, { status: "PASS" | "FAIL" }>;
type AssertDefinition = Definition["assert"][number];
type AssertResult = Evaluation["assertions"][number];

const HASH = runReportCase.definitionHash;

function definition(...assertions: AssertDefinition[]): Definition {
  return { ...runReportCase.definition, assert: assertions };
}

function evaluation(status: "PASS" | "FAIL", ...assertions: AssertResult[]): GradedEvaluation {
  const base = runReportCase.evaluation;
  if (base.status !== "PASS" && base.status !== "FAIL") throw new Error("FIXTURE_NOT_GRADED");
  return { ...base, status, assertions };
}

function gate(index: number, metric: string, pass: boolean, reason: string): AssertResult {
  return {
    index,
    definitionHash: HASH,
    type: "equals",
    metric,
    weight: 20,
    status: pass ? "PASS" : "FAIL",
    score: pass ? 1 : 0,
    reason
  };
}

function quality(index: number, metric: string, pass: boolean, reason: string): AssertResult {
  return { ...gate(index, metric, pass, reason), weight: 1 };
}

/** Mount one Case's checks panel; `evidenceRow` supplies the required report/rest fields. */
function mount(row: DashboardCase): HTMLElement {
  render(<RunCaseChecks row={row} />);
  return screen.getByRole("region", { name: "验收检查" });
}

const D1 = "【硬性】D1.1 单意图单动作｜一句话只触发一个业务动作";
const D5 = "【硬性】D5.1 该出卡时必须出卡｜日程结果必须给 EVENT 卡，进度条不算";
const D4_LEN = "【质量】D4.7 语音长度｜闲聊 ≤2句 ≤40字";
const D4_ID = "【质量】D4.3 不泄露内部ID｜reply_text 不出现 ou_ 开头的人名替代";

describe("v2 断言可读性", () => {
  it("按 D1→D6 分组，组头拆硬性/质量，软性失败不被 PASS 掩盖", async () => {
    const checks = mount({
      ...evidenceRow({}),
      definition: definition(
        { type: "equals", metric: D1, value: true, weight: 20 },
        { type: "equals", metric: D5, value: true, weight: 20 },
        { type: "equals", metric: D4_LEN, value: true, weight: 1 },
        { type: "equals", metric: D4_ID, value: true, weight: 1 }
      ),
      evaluation: evaluation(
        "PASS",
        gate(0, D1, true, "D1.1 单意图单动作：只调用 search_docs 一次，无多余写操作"),
        gate(1, D5, true, "D5.1 出卡正确：a2ui_surfaces 含 EVENT 卡"),
        quality(2, D4_LEN, false, "D4.7 语音长度：reply_text 共 4 句 96 字，上限 2 句 40 字"),
        quality(3, D4_ID, false, 'D4.3 泄露内部ID：reply_text 出现 "ou_2196574b…"，应改说人名')
      )
    });
    expect(within(checks).getByText(/结论 PASS（通过）/)).toBeVisible();
    expect(within(checks).getByText("硬性 2/2 通过")).toBeVisible();
    expect(within(checks).getByText("质量 0/2 通过")).toBeVisible();
    expect(within(checks).getByText(/2 项质量未达标 · 不阻断 PASS/)).toBeVisible();
    expect(within(checks).getByText("失败项 top1")).toBeVisible();
    // 维度分组与组头计数
    expect(within(checks).getByRole("heading", { name: "D1 意图与路由" })).toBeVisible();
    expect(within(checks).getByRole("heading", { name: "D4 语音可播报性" })).toBeVisible();
    expect(within(checks).getByRole("heading", { name: "D5 视觉交互 / A2UI" })).toBeVisible();
    expect(
      within(checks).getByText(/本组 硬性 0\/0 通过 · 质量 0\/2 通过（质量未达标，不阻断结论）/)
    ).toBeVisible();
    // reason 全文直接显示，不截断
    expect(
      within(checks).getByText('D4.3 泄露内部ID：reply_text 出现 "ou_2196574b…"，应改说人名')
    ).toBeVisible();
    // 判据原文（｜后面）完整保留
    expect(within(checks).getAllByText(/闲聊 ≤2句 ≤40字/).length).toBeGreaterThan(0);
    // 失败项在前、通过项默认折叠；徽标区分硬性/质量（top1 那行也带一枚质量徽标）
    expect(within(checks).getByText("D4.7 语音长度｜闲聊 ≤2句 ≤40字")).toBeVisible();
    expect(within(checks).getAllByText("质量项").length).toBe(3);
    expect(within(checks).queryByText("硬性门禁")).toBeNull();
    await userEvent.click(within(checks).getByRole("button", { name: /展开 2 项已通过/ }));
    expect(within(checks).getAllByText("硬性门禁").length).toBe(2);
  });

  it("硬性失败时给出一票否决根因", () => {
    const checks = mount({
      ...evidenceRow({}),
      definition: definition(
        { type: "equals", metric: D5, value: true, weight: 20 },
        { type: "equals", metric: D4_LEN, value: true, weight: 1 }
      ),
      evaluation: evaluation(
        "FAIL",
        gate(0, D5, false, "D5.1 该出卡未出卡：期望 EVENT 日程卡，实际只有 infoChip"),
        quality(1, D4_LEN, true, "D4.7 语音长度：1 句 18 字，符合上限")
      )
    });
    expect(within(checks).getByText(/结论 FAIL（未通过）/)).toBeVisible();
    expect(within(checks).getByText(/一票否决项/)).toBeVisible();
    // 项名出现在「一票否决」和 D5 分组；top1 那行额外带层级徽标与判据原文
    expect(within(checks).getAllByText("D5.1 该出卡时必须出卡").length).toBe(2);
    expect(
      within(checks).getByText("D5.1 该出卡时必须出卡｜日程结果必须给 EVENT 卡，进度条不算")
    ).toBeVisible();
    expect(
      within(checks).getAllByText("D5.1 该出卡未出卡：期望 EVENT 日程卡，实际只有 infoChip").length
    ).toBe(3);
  });

  it("旧套件（无前缀、无 D 层）优雅降级到未分类分组", () => {
    const checks = mount({
      ...evidenceRow({}),
      definition: definition(
        { type: "is-json", metric: "is-json", weight: 1 },
        { type: "assert-set", metric: "assert-set", assert: [], weight: 1 }
      ),
      evaluation: evaluation(
        "PASS",
        { ...gate(0, "is-json", true, "输出是合法 JSON"), weight: 1 },
        { ...gate(1, "assert-set", true, "子断言全部通过"), weight: 1 }
      )
    });
    expect(within(checks).getByRole("heading", { name: /未分类/ })).toBeVisible();
    expect(within(checks).getAllByText("未分类").length).toBe(2);
    expect(within(checks).getByText(/未标记前缀 2 项/)).toBeVisible();
    expect(within(checks).getByText("is-json")).toBeVisible();
    expect(within(checks).queryByText(/一票否决项/)).toBeNull();
    expect(checks.querySelectorAll("details.run-check-item").length).toBe(2);
  });
});

describe("run 列表的维度通过率区块", () => {
  function mountCases(rows: readonly DashboardCase[]): HTMLElement {
    render(
      <RunDashboardCases
        api={{} as unknown as RunApi}
        runId="run-v2"
        rows={rows}
        bucket="ALL"
        onBucketChange={() => undefined}
        missing={0}
        onNavigate={() => undefined}
        canRerun={false}
      />
    );
    const block = screen.getByText("维度通过率（D1–D6）").closest("div.run-dimension-rates");
    if (!(block instanceof HTMLElement)) throw new Error("DIMENSION_BLOCK_MISSING");
    return block;
  }

  it("按断言条数给出 D1–D6 通过率，并给 PASS 但带质量缺陷的 case 挂黄角标", () => {
    const block = mountCases([
      {
        ...evidenceRow({}),
        definition: definition(
          { type: "equals", metric: D5, value: true, weight: 20 },
          { type: "equals", metric: D4_LEN, value: true, weight: 1 },
          { type: "equals", metric: D4_ID, value: true, weight: 1 }
        ),
        evaluation: evaluation(
          "PASS",
          gate(0, D5, true, "D5.1 出卡正确：a2ui_surfaces 含 EVENT 卡"),
          quality(1, D4_LEN, false, "D4.7 语音长度：reply_text 共 3 句 62 字，超过上限"),
          quality(2, D4_ID, true, "D4.3 未泄露内部 ID")
        )
      }
    ]);
    expect(within(block).getByText("按断言条数统计，不是按 case 数")).toBeVisible();
    expect(within(block).getByText("D4 语音可播报性")).toBeVisible();
    expect(within(block).getByText("50% · 1/2 通过")).toBeVisible();
    expect(within(block).getByText("100% · 1/1 通过")).toBeVisible();
    // D1/D2/D3/D6 本次没有断言，四行都显示「无断言」而不是 0%
    expect(within(block).getAllByText("无断言").length).toBe(4);
    // PASS 结论旁边必须挂质量缺陷角标，不能被绿色掩盖
    expect(screen.getByText("1 项质量未达标")).toBeVisible();
  });

  it("整批 case 都没有 D 层标记时给出说明，而不是空白区块", () => {
    const block = mountCases([
      {
        ...evidenceRow({}),
        definition: definition({ type: "is-json", metric: "is-json", weight: 1 }),
        evaluation: evaluation("PASS", { ...gate(0, "is-json", true, "合法 JSON"), weight: 1 })
      }
    ]);
    expect(within(block).getByText(/没有任何断言带 D1–D6 标记/)).toBeVisible();
    expect(within(block).queryByText("D1 意图与路由")).toBeNull();
  });
});
