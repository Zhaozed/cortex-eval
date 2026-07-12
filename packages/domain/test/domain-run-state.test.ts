import { describe, expect, it } from "vitest";

import { transitionRunState, type RunState } from "../src/domain-run-state.ts";

describe("Run 状态机", () => {
  it("按 REST、Evaluation、Report 顺序收口", () => {
    const runningRest = transitionRunState(
      { status: "READY", stage: "REST", lockRevision: 0 },
      { type: "START_STAGE", expectedRevision: 0 }
    );
    expect(runningRest).toEqual({
      ok: true,
      state: { status: "RUNNING", stage: "REST", lockRevision: 1 }
    });
    expect(
      transitionRunState(
        { status: "RUNNING", stage: "REST", lockRevision: 1 },
        { type: "REST_COMMITTED", expectedRevision: 1 }
      )
    ).toEqual({
      ok: true,
      state: { status: "READY", stage: "EVALUATION", lockRevision: 2 }
    });
    expect(
      transitionRunState(
        { status: "RUNNING", stage: "EVALUATION", lockRevision: 3 },
        { type: "EVALUATION_COMMITTED", expectedRevision: 3 }
      )
    ).toEqual({ ok: true, state: { status: "READY", stage: "REPORT", lockRevision: 4 } });
    expect(
      transitionRunState(
        { status: "RUNNING", stage: "REPORT", lockRevision: 5 },
        { type: "REPORT_COMMITTED", hasErrors: true, expectedRevision: 5 }
      )
    ).toEqual({
      ok: true,
      state: { status: "COMPLETED_WITH_ERRORS", stage: "DONE", lockRevision: 6 }
    });
  });

  it("终态和错位事件返回显式冲突", () => {
    expect(
      transitionRunState(
        { status: "COMPLETED", stage: "DONE", lockRevision: 7 },
        { type: "START_STAGE", expectedRevision: 7 }
      )
    ).toEqual({
      ok: false,
      error: {
        code: "RUN_STATE_CONFLICT",
        status: "COMPLETED",
        stage: "DONE",
        event: "START_STAGE",
        actualRevision: 7,
        expectedRevision: 7
      }
    });
    expect(
      transitionRunState(
        { status: "RUNNING", stage: "REST", lockRevision: 1 },
        { type: "EVALUATION_COMMITTED", expectedRevision: 1 }
      ).ok
    ).toBe(false);
    expect(
      transitionRunState(
        { status: "READY", stage: "REST", lockRevision: 2 },
        { type: "START_STAGE", expectedRevision: 1 }
      )
    ).toEqual({
      ok: false,
      error: {
        code: "RUN_STATE_CONFLICT",
        status: "READY",
        stage: "REST",
        event: "START_STAGE",
        actualRevision: 2,
        expectedRevision: 1
      }
    });
  });

  it("取消、系统失败和恢复只从 RUNNING 收口", () => {
    expect(
      transitionRunState(
        { status: "RUNNING", stage: "EVALUATION", lockRevision: 3 },
        { type: "CANCEL", expectedRevision: 3 }
      )
    ).toEqual({ ok: true, state: { status: "CANCELLED", stage: "DONE", lockRevision: 4 } });
    expect(
      transitionRunState(
        { status: "RUNNING", stage: "REPORT", lockRevision: 4 },
        { type: "FAIL", expectedRevision: 4 }
      )
    ).toEqual({ ok: true, state: { status: "FAILED", stage: "DONE", lockRevision: 5 } });
    expect(
      transitionRunState(
        { status: "RUNNING", stage: "REST", lockRevision: 5 },
        { type: "INTERRUPT", expectedRevision: 5 }
      )
    ).toEqual({ ok: true, state: { status: "INTERRUPTED", stage: "DONE", lockRevision: 6 } });
  });

  it("转换入口拒绝非法 Status/Stage 和 Revision", () => {
    const invalidStates = [
      { status: "READY", stage: "DONE", lockRevision: 1 },
      { status: "COMPLETED", stage: "REST", lockRevision: 1 },
      { status: "READY", stage: "REST", lockRevision: -1 },
      { status: "RUNNING", stage: "REST", lockRevision: 1.5 }
    ] as unknown as RunState[];
    for (const state of invalidStates) {
      expect(
        transitionRunState(state, {
          type: "START_STAGE",
          expectedRevision: state.lockRevision
        }).ok
      ).toBe(false);
    }
  });
});
