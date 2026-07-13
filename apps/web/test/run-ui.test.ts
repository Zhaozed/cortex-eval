import { describe, expect, it } from "vitest";

import { isRunTerminal, runStageLabel, runStatusLabel } from "../src/features/runs/run-ui.ts";

describe("Run UI 文案与终态", () => {
  it("覆盖全部持久化状态和阶段标签", () => {
    expect(
      [
        "READY",
        "RUNNING",
        "COMPLETED",
        "COMPLETED_WITH_ERRORS",
        "FAILED",
        "CANCELLED",
        "INTERRUPTED"
      ].map((status) => runStatusLabel(status as Parameters<typeof runStatusLabel>[0]))
    ).toEqual(["待执行", "运行中", "已完成", "完成但有错误", "系统失败", "已取消", "已中断"]);
    expect(
      ["REST", "EVALUATION", "REPORT", "DONE"].map((stage) =>
        runStageLabel(stage as Parameters<typeof runStageLabel>[0])
      )
    ).toEqual(["REST", "Evaluation", "Report", "已结束"]);
  });

  it("READY 和 RUNNING 不是终态，其余状态均为终态", () => {
    expect(isRunTerminal({ status: "READY" })).toBe(false);
    expect(isRunTerminal({ status: "RUNNING" })).toBe(false);
    expect(isRunTerminal({ status: "COMPLETED" })).toBe(true);
    expect(isRunTerminal({ status: "FAILED" })).toBe(true);
  });
});
