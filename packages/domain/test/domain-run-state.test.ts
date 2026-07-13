import { describe, expect, it } from "vitest";

import { transitionRunState, type RunState } from "../src/domain-run-state.ts";

describe("Run 状态机", () => {
  it("按 REST、Evaluation、Report 顺序收口", () => {
    const runningRest = transitionRunState(
      { status: "READY", stage: "REST", lockRevision: 0, cancelRequested: false },
      { type: "START_STAGE", expectedRevision: 0 }
    );
    expect(runningRest).toEqual({
      ok: true,
      state: { status: "RUNNING", stage: "REST", lockRevision: 1, cancelRequested: false }
    });
    expect(
      transitionRunState(
        { status: "RUNNING", stage: "REST", lockRevision: 1, cancelRequested: false },
        { type: "REST_COMMITTED", expectedRevision: 1 }
      )
    ).toEqual({
      ok: true,
      state: { status: "READY", stage: "EVALUATION", lockRevision: 2, cancelRequested: false }
    });
    expect(
      transitionRunState(
        { status: "RUNNING", stage: "EVALUATION", lockRevision: 3, cancelRequested: false },
        { type: "EVALUATION_COMMITTED", expectedRevision: 3 }
      )
    ).toEqual({
      ok: true,
      state: { status: "READY", stage: "REPORT", lockRevision: 4, cancelRequested: false }
    });
    expect(
      transitionRunState(
        { status: "RUNNING", stage: "REPORT", lockRevision: 5, cancelRequested: false },
        { type: "REPORT_COMMITTED", hasErrors: true, expectedRevision: 5 }
      )
    ).toEqual({
      ok: true,
      state: {
        status: "COMPLETED_WITH_ERRORS",
        stage: "DONE",
        lockRevision: 6,
        cancelRequested: false
      }
    });
  });

  it("终态和错位事件返回显式冲突", () => {
    expect(
      transitionRunState(
        { status: "COMPLETED", stage: "DONE", lockRevision: 7, cancelRequested: false },
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
        { status: "RUNNING", stage: "REST", lockRevision: 1, cancelRequested: false },
        { type: "EVALUATION_COMMITTED", expectedRevision: 1 }
      ).ok
    ).toBe(false);
    expect(
      transitionRunState(
        { status: "READY", stage: "REST", lockRevision: 2, cancelRequested: false },
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

  it("取消请求显式建模并永久阻断阶段提交", () => {
    const requested = transitionRunState(
      { status: "RUNNING", stage: "REST", lockRevision: 3, cancelRequested: false },
      { type: "REQUEST_CANCEL", expectedRevision: 3 }
    );
    expect(requested).toEqual({
      ok: true,
      state: { status: "RUNNING", stage: "REST", lockRevision: 4, cancelRequested: true }
    });
    expect(
      transitionRunState(
        { status: "RUNNING", stage: "REST", lockRevision: 4, cancelRequested: true },
        { type: "REST_COMMITTED", expectedRevision: 4 }
      ).ok
    ).toBe(false);
    expect(
      transitionRunState(
        { status: "RUNNING", stage: "REST", lockRevision: 4, cancelRequested: true },
        { type: "PROGRESS_RECORDED", expectedRevision: 4 }
      )
    ).toEqual({
      ok: true,
      state: { status: "RUNNING", stage: "REST", lockRevision: 5, cancelRequested: true }
    });
    expect(
      transitionRunState(
        { status: "RUNNING", stage: "REST", lockRevision: 5, cancelRequested: true },
        { type: "CANCEL_COMMITTED", expectedRevision: 5 }
      )
    ).toEqual({
      ok: true,
      state: { status: "CANCELLED", stage: "DONE", lockRevision: 6, cancelRequested: false }
    });
  });

  it("系统失败和恢复从两种 RUNNING 子状态收口", () => {
    expect(
      transitionRunState(
        { status: "RUNNING", stage: "REPORT", lockRevision: 4, cancelRequested: false },
        { type: "FAIL", expectedRevision: 4 }
      )
    ).toEqual({
      ok: true,
      state: { status: "FAILED", stage: "DONE", lockRevision: 5, cancelRequested: false }
    });
    expect(
      transitionRunState(
        { status: "RUNNING", stage: "REST", lockRevision: 5, cancelRequested: true },
        { type: "INTERRUPT", expectedRevision: 5 }
      )
    ).toEqual({
      ok: true,
      state: { status: "INTERRUPTED", stage: "DONE", lockRevision: 6, cancelRequested: false }
    });
  });

  it("转换入口拒绝非法 Status/Stage 和 Revision", () => {
    const invalidStates = [
      { status: "READY", stage: "DONE", lockRevision: 1, cancelRequested: false },
      { status: "COMPLETED", stage: "REST", lockRevision: 1, cancelRequested: false },
      { status: "READY", stage: "REST", lockRevision: -1, cancelRequested: false },
      { status: "RUNNING", stage: "REST", lockRevision: 1.5, cancelRequested: false },
      { status: "READY", stage: "REST", lockRevision: 1, cancelRequested: true },
      { status: "COMPLETED", stage: "DONE", lockRevision: 1, cancelRequested: true }
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
