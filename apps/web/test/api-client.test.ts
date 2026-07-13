import type { ApiErrorResponseV1Schema } from "@cortex-eval/contracts/src/resource-api-contracts.ts";
import { z } from "zod";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  ApiClientError,
  apiRequestEmpty,
  apiRequestJson,
  buildApiSearch,
  type WebClientErrorCode
} from "../src/lib/api-client.ts";

const SuccessSchema = z.strictObject({ value: z.string() });

type ExpectedWebClientErrorCode =
  | z.infer<typeof ApiErrorResponseV1Schema>["error"]["code"]
  | "CLIENT_ERROR_RESPONSE_INVALID"
  | "CLIENT_REQUEST_CANCELLED"
  | "CLIENT_REQUEST_FAILED"
  | "CLIENT_RESPONSE_INVALID"
  | "CLIENT_MUTATION_PENDING";

describe("Web API Client 边界", () => {
  it("错误码严格闭合为 API Schema 与明确客户端错误", () => {
    expectTypeOf<WebClientErrorCode>().toEqualTypeOf<ExpectedWebClientErrorCode>();
  });

  it("校验成功响应并返回清洗后的 DTO", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ value: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    await expect(apiRequestJson("/api/v1/example", SuccessSchema, {}, fetcher)).resolves.toEqual({
      value: "ok"
    });
  });

  it("拒绝结构不合法的成功响应", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ value: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    await expect(
      apiRequestJson("/api/v1/example", SuccessSchema, {}, fetcher)
    ).rejects.toMatchObject({
      name: "ApiClientError",
      code: "CLIENT_RESPONSE_INVALID"
    });
  });

  it("拒绝 Schema 合法但不满足请求上下文身份的成功响应并保留真实状态码", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ value: "wrong-resource" }), {
        status: 201,
        headers: { "content-type": "application/json" }
      })
    );

    await expect(
      apiRequestJson(
        "/api/v1/example",
        SuccessSchema,
        { method: "POST" },
        fetcher,
        (output) => output.value === "expected-resource"
      )
    ).rejects.toMatchObject({
      code: "CLIENT_RESPONSE_INVALID",
      statusCode: 201
    });
  });

  it("清洗服务端错误并保留稳定字段路径", async () => {
    const requestId = "018f0f4e-7b7a-7cc0-8000-000000000001";
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "CASE_DEFINITION_INVALID",
            message: "Case 定义无效",
            requestId,
            path: "definition.assert.0.threshold"
          }
        }),
        { status: 422, headers: { "content-type": "application/json" } }
      )
    );

    const failure = await apiRequestJson("/api/v1/example", SuccessSchema, {}, fetcher).catch(
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(ApiClientError);
    expect(failure).toMatchObject({
      code: "CASE_DEFINITION_INVALID",
      fieldPath: "definition.assert.0.threshold",
      requestId,
      statusCode: 422
    });
  });

  it("清洗批量导入错误并保留顺序、Case ID 与原因", async () => {
    const requestId = "018f0f4e-7b7a-7cc0-8000-000000000001";
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "CASE_IMPORT_ITEM_INVALID",
            message: "Case 导入项无效",
            requestId,
            index: 2,
            caseKey: "case-bad",
            causeCode: "CASE_DEFINITION_INVALID",
            path: "threshold"
          }
        }),
        { status: 422, headers: { "content-type": "application/json" } }
      )
    );

    const failure = await apiRequestJson("/api/v1/example", SuccessSchema, {}, fetcher).catch(
      (error: unknown) => error
    );

    expect(failure).toMatchObject({
      code: "CASE_IMPORT_ITEM_INVALID",
      importIndex: 2,
      caseKey: "case-bad",
      causeCode: "CASE_DEFINITION_INVALID",
      fieldPath: "threshold"
    });
  });

  it("把资源唯一性冲突字段清洗为可定位表单路径", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "RESOURCE_UNIQUE_CONFLICT",
            message: "名称重复",
            requestId: "018f0f4e-7b7a-7cc0-8000-000000000001",
            field: "name"
          }
        }),
        { status: 409, headers: { "content-type": "application/json" } }
      )
    );

    await expect(
      apiRequestJson("/api/v1/example", SuccessSchema, {}, fetcher)
    ).rejects.toMatchObject({
      code: "RESOURCE_UNIQUE_CONFLICT",
      fieldPath: "name"
    });
  });

  it("保留 Rubric Prompt 使用冲突的 Prompt Key 并定位到对应字段", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "RUBRIC_PROMPT_IN_USE",
            message: "Prompt Key 正在被 Case 引用",
            requestId: "018f0f4e-7b7a-7cc0-8000-000000000001",
            promptKey: "quality.default"
          }
        }),
        { status: 409, headers: { "content-type": "application/json" } }
      )
    );

    await expect(
      apiRequestJson("/api/v1/example", SuccessSchema, {}, fetcher)
    ).rejects.toMatchObject({
      code: "RUBRIC_PROMPT_IN_USE",
      fieldPath: "promptKey",
      promptKey: "quality.default"
    });
  });

  it("拒绝无法通过错误契约校验的错误响应", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "raw backend error" } }), {
        status: 500,
        headers: { "content-type": "application/json" }
      })
    );

    await expect(
      apiRequestJson("/api/v1/example", SuccessSchema, {}, fetcher)
    ).rejects.toMatchObject({
      code: "CLIENT_ERROR_RESPONSE_INVALID",
      statusCode: 500
    });
  });

  it("处理 204 且不尝试解析响应正文", async () => {
    const response = new Response(null, { status: 204 });
    const json = vi.spyOn(response, "json");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);

    await expect(apiRequestEmpty("/api/v1/example", { method: "DELETE" }, fetcher)).resolves.toBe(
      undefined
    );
    expect(json).not.toHaveBeenCalled();
  });

  it("把同一 AbortSignal 传给 fetch 并收敛取消错误", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
      expect(init?.signal).toBe(controller.signal);
      controller.abort();
      return Promise.reject(new DOMException("aborted", "AbortError"));
    });

    await expect(
      apiRequestJson("/api/v1/example", SuccessSchema, { signal: controller.signal }, fetcher)
    ).rejects.toMatchObject({ code: "CLIENT_REQUEST_CANCELLED" });
  });

  it("稳定编码文本、重复多值和 cursor 查询", () => {
    expect(
      buildApiSearch({
        caseKey: "a/b c",
        businessModule: ["问答", "客服"],
        metric: [],
        cursor: "case_v1_a-b_c"
      }).toString()
    ).toBe(
      "businessModule=%E9%97%AE%E7%AD%94&businessModule=%E5%AE%A2%E6%9C%8D&caseKey=a%2Fb+c&cursor=case_v1_a-b_c"
    );
  });
});
