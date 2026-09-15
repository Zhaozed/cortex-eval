import { describe, expect, it } from "vitest";

import { assertionExecutionErrorReason } from "../src/features/evaluation/promptfoo-assertion-error.ts";

// Bridge 失败会以「稳定码｜已脱敏细节」写回 reason，操作者必须能看出是平台/上游问题。
function graderComponent(reason: string): Record<string, unknown> {
  return { pass: false, score: 0, reason, metadata: { graderError: true } };
}

describe("评分器执行失败的操作者可见原因", () => {
  it("保留上游限流的状态码与厂商码", () => {
    expect(
      assertionExecutionErrorReason(
        graderComponent(
          "PROVIDER_REQUEST_FAILED｜HTTP 429 Throttling.BurstRate Requests throttling triggered."
        )
      )
    ).toBe(
      "评测模型调用或评分响应异常（PROVIDER_REQUEST_FAILED：HTTP 429 Throttling.BurstRate Requests throttling triggered.）；不是 Agent 质量不通过。"
    );
  });

  it("没有细节时只保留稳定码", () => {
    expect(assertionExecutionErrorReason(graderComponent("EVALUATOR_TIMEOUT"))).toBe(
      "评测模型调用或评分响应异常（EVALUATOR_TIMEOUT）；不是 Agent 质量不通过。"
    );
  });

  it("未知码只保留平台结论，不编造上游细节", () => {
    expect(assertionExecutionErrorReason(graderComponent("SOMETHING_ELSE｜detail"))).toBe(
      "评测模型调用或评分响应异常；不是 Agent 质量不通过。"
    );
  });

  it("细节超长被截断，非评分器异常走脚本异常文案", () => {
    const long = assertionExecutionErrorReason(
      graderComponent(`PROVIDER_REQUEST_FAILED｜${"x".repeat(400)}`)
    );
    expect(long).toContain("…）；不是 Agent 质量不通过。");
    expect(long.length).toBeLessThanOrEqual(240);
    expect(long).toContain("x".repeat(180));
    expect(long).not.toContain("x".repeat(181));

    expect(
      assertionExecutionErrorReason({
        pass: false,
        score: 0,
        reason: "Custom function threw error: boom"
      })
    ).toBe("断言脚本执行异常，请检查脚本语法和运行环境。");
  });
});
