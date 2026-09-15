import { describe, expect, it } from "vitest";
import {
  formatRunDuration,
  runElapsedMs,
  runProgressSnapshot,
  runRemainingEstimateMs
} from "../src/features/runs/run-progress-model.ts";
import { runDetail } from "./run-test-fixture.ts";

const START = "2026-09-10T02:00:00.000Z";
const START_MS = Date.parse(START);

describe("runProgressSnapshot", () => {
  it("a queued Run sits on the execution stage at zero percent", () => {
    const snapshot = runProgressSnapshot(runDetail(), false);
    expect(snapshot).toMatchObject({
      activeIndex: 0,
      tone: "idle",
      stagePercent: 0,
      overallPercent: 0,
      cancelRequested: false
    });
    expect(snapshot.stages.map((stage) => stage.state)).toEqual([
      "ACTIVE",
      "PENDING",
      "PENDING",
      "PENDING"
    ]);
    expect(snapshot.headline).toBe("等待开始 · 执行");
  });

  it("measures the execution stage from persisted counters only", () => {
    const snapshot = runProgressSnapshot(
      runDetail({
        status: "RUNNING",
        stage: "REST",
        rest: { total: 4, completed: 1, succeeded: 1, error: 0 }
      }),
      false
    );
    expect(snapshot).toMatchObject({ tone: "running", stagePercent: 25, overallPercent: 6 });
    expect(snapshot.stages[0]).toMatchObject({ state: "ACTIVE", completed: 1, total: 4 });
    expect(snapshot.subline).toBe("阶段 1/4 · 1/4");
  });

  it("marks earlier stages done once the Run advances to evaluation", () => {
    const snapshot = runProgressSnapshot(
      runDetail({
        status: "RUNNING",
        stage: "EVALUATION",
        rest: { total: 3, completed: 3, succeeded: 2, error: 1 },
        evaluation: { total: 3, completed: 2, passed: 2, failed: 0, error: 0, notEvaluated: 1 }
      }),
      false
    );
    expect(snapshot.stages.map((stage) => stage.state)).toEqual([
      "DONE",
      "ACTIVE",
      "PENDING",
      "PENDING"
    ]);
    expect(snapshot.stages[0]).toMatchObject({ ratio: 1, detail: "3/3" });
    expect(snapshot.stagePercent).toBe(67);
    expect(snapshot.overallPercent).toBe(42);
  });

  it("treats both completed statuses as fully done", () => {
    for (const status of ["COMPLETED", "COMPLETED_WITH_ERRORS"] as const) {
      const snapshot = runProgressSnapshot(
        runDetail({
          status,
          stage: "DONE",
          rest: { total: 2, completed: 2, succeeded: 2, error: 0 },
          evaluation: { total: 2, completed: 2, passed: 2, failed: 0, error: 0, notEvaluated: 0 }
        }),
        true
      );
      expect(snapshot).toMatchObject({
        tone: status === "COMPLETED" ? "success" : "warning",
        activeIndex: 3,
        stagePercent: 100,
        overallPercent: 100,
        headline: "已完成"
      });
      expect(snapshot.stages.every((stage) => stage.state === "DONE")).toBe(true);
    }
  });

  it("freezes a failed Run on the stage it stopped at", () => {
    const snapshot = runProgressSnapshot(
      runDetail({
        status: "FAILED",
        stage: "REST",
        rest: { total: 3, completed: 1, succeeded: 0, error: 1 }
      }),
      false
    );
    expect(snapshot).toMatchObject({ tone: "danger", activeIndex: 0, overallPercent: 8 });
    expect(snapshot.stages.map((stage) => stage.state)).toEqual([
      "BLOCKED",
      "PENDING",
      "PENDING",
      "PENDING"
    ]);
    expect(snapshot.headline).toBe("执行失败 · 停在执行");
  });

  it("flags a cancel request without pretending the Run already stopped", () => {
    const snapshot = runProgressSnapshot(
      runDetail({
        status: "RUNNING",
        stage: "REST",
        cancelRequestedAt: START,
        rest: { total: 2, completed: 1, succeeded: 1, error: 0 }
      }),
      false
    );
    expect(snapshot).toMatchObject({ tone: "warning", cancelRequested: true });
    expect(snapshot.stages[0]?.state).toBe("ACTIVE");
  });

  it("credits the report stage from the stored report artifact", () => {
    const snapshot = runProgressSnapshot(
      runDetail({
        status: "RUNNING",
        stage: "REPORT",
        rest: { total: 1, completed: 1, succeeded: 1, error: 0 }
      }),
      true
    );
    expect(snapshot.stages[2]).toMatchObject({ state: "ACTIVE", ratio: 1, detail: "已完成" });
  });
});

describe("runElapsedMs", () => {
  it("is null before the Run ever started", () => {
    expect(runElapsedMs(runDetail(), START_MS + 60_000)).toBeNull();
  });

  it("counts up to now while running and stops at completedAt afterwards", () => {
    const running = runDetail({ status: "RUNNING", startedAt: START });
    expect(runElapsedMs(running, START_MS + 90_000)).toBe(90_000);
    const finished = { ...running, completedAt: "2026-09-10T02:00:30.000Z" };
    expect(runElapsedMs(finished, START_MS + 90_000)).toBe(30_000);
  });

  it("never reports a negative span", () => {
    expect(runElapsedMs(runDetail({ startedAt: START }), START_MS - 5_000)).toBe(0);
  });
});

describe("runRemainingEstimateMs", () => {
  it("extrapolates linearly from execution throughput", () => {
    const run = runDetail({
      status: "RUNNING",
      stage: "REST",
      startedAt: START,
      rest: { total: 4, completed: 1, succeeded: 1, error: 0 }
    });
    expect(runRemainingEstimateMs(run, START_MS + 60_000)).toBe(180_000);
  });

  it("refuses to guess outside the execution stage or without samples", () => {
    const running = runDetail({ status: "RUNNING", stage: "REST", startedAt: START });
    expect(runRemainingEstimateMs(running, START_MS + 60_000)).toBeNull();
    expect(
      runRemainingEstimateMs(
        runDetail({ status: "RUNNING", stage: "EVALUATION", startedAt: START }),
        START_MS + 60_000
      )
    ).toBeNull();
    expect(runRemainingEstimateMs(runDetail({ status: "READY" }), START_MS)).toBeNull();
    expect(
      runRemainingEstimateMs(
        runDetail({
          status: "RUNNING",
          startedAt: START,
          rest: { total: 2, completed: 2, succeeded: 2, error: 0 }
        }),
        START_MS + 60_000
      )
    ).toBeNull();
  });
});

describe("formatRunDuration", () => {
  it("pads clock segments and only shows hours when needed", () => {
    expect(formatRunDuration(0)).toBe("00:00");
    expect(formatRunDuration(9_999)).toBe("00:09");
    expect(formatRunDuration(65_000)).toBe("01:05");
    expect(formatRunDuration(3_725_000)).toBe("1:02:05");
    expect(formatRunDuration(-1_000)).toBe("00:00");
  });
});
