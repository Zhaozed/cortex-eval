import { describe, expect, it } from "vitest";
import { evaluationFailureDiagnostic } from "../src/features/evaluation/evaluation-failure-diagnostic.ts";

describe("评测故障安全诊断", () => {
  it("保留已知故障和进程退出码，不泄漏上下文和任意异常", () => {
    expect(
      evaluationFailureDiagnostic(
        new Error("PROMPTFOO_PROCESS_EXIT:1", {
          cause: new Error("PROVIDER_REQUEST_FAILED")
        })
      )
    ).toBe("PROMPTFOO_PROCESS_EXIT:1 → PROVIDER_REQUEST_FAILED");
    expect(
      evaluationFailureDiagnostic(new Error("PROMPTFOO_IMPORT_CASE_MISSING:private-input"))
    ).toBe("PROMPTFOO_IMPORT_CASE_MISSING");
    expect(
      evaluationFailureDiagnostic(new Error("Authorization: Bearer secret; prompt=private"))
    ).toBe("UNKNOWN_EVALUATION_ERROR");
  });
  it("识别结果落盘失败", () => {
    expect(evaluationFailureDiagnostic(new Error("ARTIFACT_WRITE_FAILED"))).toBe(
      "ARTIFACT_WRITE_FAILED"
    );
  });
  it("循环 cause 不会阻塞错误记录", () => {
    const error = new Error("EVALUATOR_SECRET_MISSING");
    error.cause = error;
    expect(evaluationFailureDiagnostic(error)).toBe("EVALUATOR_SECRET_MISSING");
  });
});
