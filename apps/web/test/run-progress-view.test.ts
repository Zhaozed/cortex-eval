import { describe, expect, it } from "vitest";

import { selectRunProgressView } from "../src/features/runs/run-progress-view.ts";
import { runDetail } from "./run-test-fixture.ts";

describe("Run 进度视图", () => {
  it("DONE 且没有已提交 Evaluation 事实时展示 REST 计数", () => {
    const run = runDetail({
      status: "FAILED",
      stage: "DONE",
      rest: { total: 3, completed: 2, succeeded: 1, error: 1 }
    });

    expect(selectRunProgressView(run)).toMatchObject({ kind: "REST", completed: 2, error: 1 });
  });

  it("DONE 且已有完整 Evaluation 事实时展示 Evaluation 分类", () => {
    const run = runDetail({
      status: "COMPLETED_WITH_ERRORS",
      stage: "DONE",
      evaluation: {
        total: 3,
        completed: 3,
        passed: 1,
        failed: 1,
        error: 1,
        notEvaluated: 0
      }
    });

    expect(selectRunProgressView(run)).toMatchObject({
      kind: "EVALUATION",
      completed: 3,
      passed: 1,
      failed: 1,
      error: 1
    });
  });
});
