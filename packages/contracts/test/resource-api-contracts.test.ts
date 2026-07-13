import { describe, expect, it } from "vitest";

import {
  ApiErrorResponseV1Schema,
  AnalysisPromptPreviewV1Schema,
  CaseListQueryV1Schema,
  CreateEndpointConfigRequestV1Schema,
  CreateTestSuiteRequestV1Schema,
  PromptDefinitionV1Schema,
  ResourceCursorV1Schema,
  TestSuiteSummaryV1Schema,
  decodeResourceCursorV1,
  encodeResourceCursorV1
} from "../src/resource-api-contracts.ts";

const requestId = "018f0c8e-9f79-7abc-8def-0123456789ab";
const resourceId = "018f0c8e-9f79-7abc-8def-0123456789ac";

describe("P3 资源 API 契约", () => {
  it("资源 Cursor 使用版本、排序字段与内部 ID，并拒绝未知键和错误版本", () => {
    const value = { version: 1 as const, name: "Alpha", id: resourceId };
    const encoded = encodeResourceCursorV1(value);

    expect(encoded.startsWith("res_v1_")).toBe(true);
    expect(decodeResourceCursorV1(encoded)).toEqual(value);
    expect(ResourceCursorV1Schema.safeParse({ ...value, extra: true }).success).toBe(false);
    expect(() => decodeResourceCursorV1("res_v2_e30")).toThrow("CURSOR_VERSION_UNSUPPORTED");
    expect(() => decodeResourceCursorV1("res_v1_not-base64-json")).toThrow("CURSOR_INVALID");
  });

  it("列表摘要不携带大定义，且所有对象严格拒绝未知键", () => {
    const summary = {
      id: resourceId,
      name: "Alpha",
      description: "current suite",
      caseCount: 3,
      revision: 2,
      updatedAt: "2026-07-13T00:00:00.000Z"
    };

    expect(TestSuiteSummaryV1Schema.parse(summary)).toEqual(summary);
    expect(
      TestSuiteSummaryV1Schema.safeParse({ ...summary, cases: [{ secret: "large" }] }).success
    ).toBe(false);
  });

  it("错误响应是闭合判别联合，不允许错误码与详情字段错配", () => {
    expect(
      ApiErrorResponseV1Schema.safeParse({
        error: {
          code: "RESOURCE_REVISION_CONFLICT",
          message: "资源版本发生冲突",
          requestId,
          expectedRevision: 1,
          actualRevision: 2
        }
      }).success
    ).toBe(true);
    expect(
      ApiErrorResponseV1Schema.safeParse({
        error: {
          code: "RESOURCE_REVISION_CONFLICT",
          message: "资源版本发生冲突",
          requestId,
          path: "name"
        }
      }).success
    ).toBe(false);
    expect(
      ApiErrorResponseV1Schema.safeParse({
        error: {
          code: "CASE_IMPORT_ITEM_INVALID",
          message: "导入项无效",
          requestId,
          index: 0,
          caseKey: "CASE-1",
          causeCode: "FUTURE_UNREGISTERED_CAUSE"
        }
      }).success
    ).toBe(false);
    expect(
      ApiErrorResponseV1Schema.safeParse({
        error: {
          code: "INTERNAL_ERROR",
          message: "内部错误",
          requestId,
          stack: "secret stack"
        }
      }).success
    ).toBe(false);
  });

  it("写入 DTO 严格拒绝未知键和展开 Secret", () => {
    expect(
      CreateTestSuiteRequestV1Schema.safeParse({ name: "Suite", description: "Current" }).success
    ).toBe(true);
    expect(
      CreateTestSuiteRequestV1Schema.safeParse({
        name: "Suite",
        description: "Current",
        revision: 0
      }).success
    ).toBe(false);

    const endpoint = {
      name: "Endpoint",
      definition: {
        contractVersion: "cortex.endpoint-config.v1",
        urlTemplate: "https://example.test/{{vars.task}}",
        method: "POST",
        headers: { Authorization: { kind: "ENV_SECRET", envKey: "ENDPOINT_TOKEN" } },
        bodySelector: "/request_body",
        timeoutMs: 1000,
        defaultConcurrency: 4
      }
    };
    expect(CreateEndpointConfigRequestV1Schema.safeParse(endpoint).success).toBe(true);
    expect(
      CreateEndpointConfigRequestV1Schema.safeParse({
        ...endpoint,
        definition: { ...endpoint.definition, apiKey: "expanded-secret" }
      }).success
    ).toBe(false);
  });

  it("Case 查询同字段多值保持数组，默认与上限明确", () => {
    expect(
      CaseListQueryV1Schema.parse({
        businessModule: ["chat", "search"],
        scenarioTag: "smoke"
      })
    ).toEqual({
      limit: 50,
      businessModule: ["chat", "search"],
      scenarioTag: ["smoke"]
    });
    expect(CaseListQueryV1Schema.safeParse({ limit: "201" }).success).toBe(false);
  });

  it("两类 Prompt 使用显式判别和严格消息结构", () => {
    expect(
      PromptDefinitionV1Schema.safeParse({
        contractVersion: "cortex.prompt.v1",
        kind: "LLM_RUBRIC",
        promptKey: "quality",
        messages: [{ role: "SYSTEM", content: "Evaluate" }]
      }).success
    ).toBe(true);
    expect(
      PromptDefinitionV1Schema.safeParse({
        contractVersion: "cortex.prompt.v1",
        kind: "LLM_RUBRIC",
        promptKey: "quality",
        messages: [{ role: "SYSTEM", content: "Evaluate", secret: "x" }]
      }).success
    ).toBe(false);
  });

  it("Analysis Prompt 预览公开全部六个合法变量", () => {
    const variables = [
      "case_definition",
      "provider_output",
      "failed_assertions",
      "expected_actual_diffs",
      "llm_rubric_results",
      "run_context"
    ];

    expect(AnalysisPromptPreviewV1Schema.parse({ variables })).toEqual({ variables });
  });
});
