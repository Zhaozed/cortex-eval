import { describe, expect, it } from "vitest";

import {
  EvaluatorBridgeCapabilityV1Schema,
  EvaluatorBridgeCapabilityV2Schema,
  EvaluatorBridgeRequestV1Schema,
  EvaluatorBridgeRequestV2Schema,
  EvaluatorBridgeResponseV1Schema,
  EvaluatorBridgeResponseV2Schema,
  ProviderCapabilityErrorV1Schema
} from "../src/evaluator-bridge-contracts.ts";

const ID = "018f1e2d-3c4b-7abc-8def-0123456789ab";
const HASH = "c".repeat(64);
const TIME = "2026-07-13T01:02:03.004Z";

describe("Evaluator Bridge v1", () => {
  it("Capability 仅绑定一次调用、一个身份和冻结 Evaluator", () => {
    const value = {
      contractVersion: "cortex.evaluator-bridge-capability.v1",
      capabilityHash: HASH,
      binding: { kind: "EXECUTION", executionId: ID },
      evaluatorConfigHash: HASH,
      maxCalls: 1,
      maxConcurrency: 2,
      timeoutMs: 30_000,
      expiresAt: TIME
    };
    expect(EvaluatorBridgeCapabilityV1Schema.parse(value).maxCalls).toBe(1);
    expect(EvaluatorBridgeCapabilityV1Schema.safeParse({ ...value, maxCalls: 2 }).success).toBe(
      false
    );
  });

  it("请求不能携带任意 Provider、URL、Header、Model 或 Secret", () => {
    const request = {
      contractVersion: "cortex.evaluator-bridge-request.v1",
      callId: ID,
      capability: "A".repeat(43),
      binding: { kind: "RUN", runId: ID },
      caseKey: "case-1",
      assertionIndex: 0,
      prompt: "判断输出是否满足标准"
    };
    expect(EvaluatorBridgeRequestV1Schema.parse(request).caseKey).toBe("case-1");
    expect(EvaluatorBridgeRequestV1Schema.safeParse({ ...request, model: "other" }).success).toBe(
      false
    );
  });

  it("响应严格区分成功和稳定错误", () => {
    const success = {
      contractVersion: "cortex.evaluator-bridge-response.v1",
      callId: ID,
      status: "SUCCESS",
      output: { text: "ok", structured: null, tokenUsage: null }
    };
    const failure = {
      contractVersion: "cortex.evaluator-bridge-response.v1",
      callId: ID,
      status: "ERROR",
      error: { code: "EVALUATOR_BUDGET_EXCEEDED", retryable: false, message: "调用预算已耗尽" }
    };
    expect(EvaluatorBridgeResponseV1Schema.parse(success).status).toBe("SUCCESS");
    expect(EvaluatorBridgeResponseV1Schema.parse(failure).status).toBe("ERROR");
  });

  it("Provider 能力错误不包含第三方响应正文", () => {
    const error = {
      contractVersion: "cortex.provider-capability-error.v1",
      code: "PROVIDER_CAPABILITY_UNSUPPORTED",
      providerType: "OPENAI_COMPATIBLE",
      capability: "JSON_SCHEMA",
      retryable: false
    };
    expect(ProviderCapabilityErrorV1Schema.parse(error).capability).toBe("JSON_SCHEMA");
    expect(
      ProviderCapabilityErrorV1Schema.safeParse({ ...error, rawResponse: "secret" }).success
    ).toBe(false);
  });
});

describe("Evaluator Bridge v2", () => {
  it("保留 v1 单次授权，同时以 Evaluation Context 绑定确定性总预算", () => {
    const value = {
      contractVersion: "cortex.evaluator-bridge-capability.v2",
      capabilityHash: HASH,
      binding: { kind: "RUN", runId: ID },
      evaluationContextHash: HASH,
      evaluatorConfigHash: HASH,
      maxCalls: 17,
      maxConcurrency: 2,
      timeoutMs: 30_000,
      expiresAt: TIME
    };

    expect(EvaluatorBridgeCapabilityV2Schema.parse(value).maxCalls).toBe(17);
    expect(EvaluatorBridgeCapabilityV1Schema.safeParse(value).success).toBe(false);
    expect(EvaluatorBridgeCapabilityV2Schema.safeParse({ ...value, maxCalls: 0 }).success).toBe(
      true
    );
    expect(
      EvaluatorBridgeCapabilityV2Schema.safeParse({
        ...value,
        maxCalls: Number.MAX_SAFE_INTEGER + 1
      }).success
    ).toBe(false);
  });

  it("请求只携带调用期身份和 Prompt，不携带 Assertion、Metric 或 Provider 覆盖", () => {
    const request = {
      contractVersion: "cortex.evaluator-bridge-request.v2",
      capability: "A".repeat(43),
      binding: { kind: "EXECUTION", executionId: ID },
      evaluationContextHash: HASH,
      prompt: "判断输出是否满足标准"
    };

    expect(EvaluatorBridgeRequestV2Schema.parse(request).evaluationContextHash).toBe(HASH);
    for (const forbidden of [
      { callId: ID },
      { caseKey: "case-1" },
      { assertionIndex: 0 },
      { metric: "quality" },
      { model: "other" },
      { url: "https://example.com" },
      { headers: { authorization: "secret" } }
    ]) {
      expect(EvaluatorBridgeRequestV2Schema.safeParse({ ...request, ...forbidden }).success).toBe(
        false
      );
    }
  });

  it("响应使用独立 v2 版本并保留稳定零重试错误", () => {
    const success = {
      contractVersion: "cortex.evaluator-bridge-response.v2",
      callId: ID,
      status: "SUCCESS",
      output: { text: "ok", structured: null, tokenUsage: null }
    };
    const failure = {
      contractVersion: "cortex.evaluator-bridge-response.v2",
      callId: ID,
      status: "ERROR",
      error: { code: "EVALUATOR_BUDGET_EXCEEDED", retryable: false, message: "调用预算已耗尽" }
    };

    expect(EvaluatorBridgeResponseV2Schema.parse(success).status).toBe("SUCCESS");
    expect(EvaluatorBridgeResponseV2Schema.parse(failure).status).toBe("ERROR");
    expect(EvaluatorBridgeResponseV1Schema.safeParse(success).success).toBe(false);
  });
});
