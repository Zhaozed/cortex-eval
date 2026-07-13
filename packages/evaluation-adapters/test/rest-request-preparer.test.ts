import { describe, expect, it } from "vitest";

import type { FrozenRunCase } from "@cortex-eval/application/src/features/runs/run-rest-models.ts";

import {
  MAX_REST_REQUEST_BYTES,
  prepareRestRequest,
  RestPreparationError
} from "../src/rest-request-preparer.ts";

const baseCase = {
  caseKey: "case-1",
  ordinal: 0,
  definitionHash: "a".repeat(64),
  definition: {
    caseKey: "case-1",
    description: "case",
    threshold: 1,
    task: "route/a",
    requestBody: { nested: { "a/b": { value: 7 } } },
    metadata: {
      requestId: "req-1",
      taskId: "task-1",
      businessModule: "module",
      scenarioTag: "scenario"
    },
    assertions: [{ type: "equals", metric: "quality", weight: 1 }]
  }
} as const;

const endpoint = {
  urlTemplate:
    'http://127.0.0.1:4311/api/{{vars.task}}?value={{vars.request_body.nested["a/b"].value}}',
  method: "POST" as const,
  headers: {
    "Content-Type": { kind: "LITERAL" as const, value: "application/json" },
    Authorization: { kind: "ENV_SECRET" as const, envKey: "ENDPOINT_TOKEN" }
  },
  bodySelector: "/request_body/nested/a~1b",
  timeoutMs: 100,
  defaultConcurrency: 4
};

describe("REST 请求准备", () => {
  it("按单个 URL component 编码嵌套标量并解析 RFC 6901 Selector", () => {
    const prepared = prepareRestRequest(baseCase, endpoint, (key) =>
      key === "ENDPOINT_TOKEN" ? "secret-value" : undefined
    );
    expect(prepared.url).toBe("http://127.0.0.1:4311/api/route%2Fa?value=7");
    expect(new TextDecoder().decode(prepared.body)).toBe('{"value":7}');
    expect(prepared.headers.get("authorization")).toBe("secret-value");
  });

  it("根 Selector 选择严格 vars 对象", () => {
    const prepared = prepareRestRequest(
      baseCase,
      { ...endpoint, headers: {}, bodySelector: "" },
      () => undefined
    );
    expect(JSON.parse(new TextDecoder().decode(prepared.body))).toEqual({
      task: "route/a",
      request_body: baseCase.definition.requestBody
    });
  });

  it.each([
    ["缺失变量", { ...baseCase.definition, task: undefined }],
    ["null 变量", { ...baseCase.definition, task: null }],
    ["对象变量", { ...baseCase.definition, task: { route: "a" } }],
    ["数组变量", { ...baseCase.definition, task: ["a"] }]
  ])("%s 不执行网络并归类 TEMPLATE_INPUT", (_name, definition) => {
    expect(() =>
      prepareRestRequest(
        { ...baseCase, definition } as unknown as FrozenRunCase,
        endpoint,
        () => "secret-value"
      )
    ).toThrow(expect.objectContaining<Partial<RestPreparationError>>({ code: "TEMPLATE_INPUT" }));
  });

  it("Selector 缺失或选中非对象时归类 TEMPLATE_INPUT", () => {
    for (const bodySelector of ["/request_body/missing", "/task"]) {
      expect(() =>
        prepareRestRequest(baseCase, { ...endpoint, bodySelector }, () => "secret-value")
      ).toThrow(expect.objectContaining<Partial<RestPreparationError>>({ code: "TEMPLATE_INPUT" }));
    }
  });

  it("Secret 缺失不回显 Env Key 或已展开值", () => {
    let error: unknown;
    try {
      prepareRestRequest(baseCase, endpoint, () => undefined);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RestPreparationError);
    expect(String(error)).not.toContain("ENDPOINT_TOKEN");
    expect(String(error)).not.toContain("secret-value");
  });

  it("请求体按 UTF-8 字节精确接受 5 MiB 前一字节、边界并拒绝超 1 字节", () => {
    const bodyBoundaryEndpoint = {
      ...endpoint,
      urlTemplate: "http://127.0.0.1:4311/api/{{vars.task}}",
      bodySelector: "/request_body"
    };
    const fixedBytes = new TextEncoder().encode('{"payload":""}').byteLength;
    const sizedCase = (size: number): FrozenRunCase => ({
      ...baseCase,
      definition: {
        ...baseCase.definition,
        requestBody: { payload: "x".repeat(size - fixedBytes) }
      }
    });
    expect(
      prepareRestRequest(
        sizedCase(MAX_REST_REQUEST_BYTES - 1),
        bodyBoundaryEndpoint,
        () => "secret"
      ).body.byteLength
    ).toBe(MAX_REST_REQUEST_BYTES - 1);
    expect(
      prepareRestRequest(sizedCase(MAX_REST_REQUEST_BYTES), bodyBoundaryEndpoint, () => "secret")
        .body.byteLength
    ).toBe(MAX_REST_REQUEST_BYTES);
    expect(() =>
      prepareRestRequest(
        sizedCase(MAX_REST_REQUEST_BYTES + 1),
        bodyBoundaryEndpoint,
        () => "secret"
      )
    ).toThrow(expect.objectContaining<Partial<RestPreparationError>>({ code: "TEMPLATE_INPUT" }));
  });

  it("再次校验渲染后的协议、Host 和端口没有变化", () => {
    expect(() =>
      prepareRestRequest(
        baseCase,
        { ...endpoint, urlTemplate: "http://{{vars.task}}/api" },
        () => "secret"
      )
    ).toThrow(expect.objectContaining<Partial<RestPreparationError>>({ code: "TEMPLATE_INPUT" }));
  });
});
