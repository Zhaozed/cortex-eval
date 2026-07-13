import type {
  CreateCaseRequestV1Schema,
  UpdateCaseRequestV1Schema
} from "@cortex-eval/contracts/src/resource-api-contracts.ts";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { z } from "zod";

import {
  createResourceApi,
  invalidateCaseDeletion,
  invalidateCaseReplacement,
  invalidateConfigurationDeletion,
  invalidateConfigurationMutation,
  invalidateTestSuiteMutation,
  resourceKeys,
  synchronizeCaseListSnapshot,
  synchronizeCaseSnapshot,
  synchronizeConfigurationSnapshot,
  synchronizeTestSuiteSnapshot,
  testSuitePageQuery,
  type AnalysisPromptDefinition,
  type ResourceApi
} from "../src/lib/resource-api.ts";

describe("资源 API 与 Query 契约", () => {
  it("Case 写请求输入保持 Contracts 精确类型", () => {
    const api = createResourceApi();

    expectTypeOf(api.createCase)
      .parameter(1)
      .toEqualTypeOf<z.infer<typeof CreateCaseRequestV1Schema>>();
    expectTypeOf(api.updateCase)
      .parameter(2)
      .toEqualTypeOf<z.infer<typeof UpdateCaseRequestV1Schema>>();
  });

  it("Case 列表使用同源路由、重复过滤值并传递 AbortSignal", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ items: [], nextCursor: null }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    const api = createResourceApi(fetcher);

    await api.listCases(
      "suite/id",
      {
        limit: 20,
        cursor: "case_v1_cursor",
        caseKey: "case 1",
        description: "",
        businessModules: ["a", "b"],
        scenarioTags: [],
        assertionTypes: ["is-json"],
        metrics: ["quality"]
      },
      controller.signal
    );

    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/test-suites/suite%2Fid/cases?assertionType=is-json&businessModule=a&businessModule=b&caseKey=case+1&cursor=case_v1_cursor&limit=20&metric=quality",
      expect.objectContaining({ signal: controller.signal })
    );
  });

  it("TanStack Query 的 signal 原样传给资源 API", async () => {
    const api = createResourceApi(
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ items: [], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
    );
    const list = vi.spyOn(api, "listTestSuites");
    const options = testSuitePageQuery(api, { limit: 50, cursor: null });
    const signal = new AbortController().signal;

    await options.queryFn({ signal } as never);

    expect(list).toHaveBeenCalledWith({ limit: 50, cursor: null }, signal);
  });

  it("详情读取拒绝契约有效但身份不匹配的 Test Suite 与 Case 响应", async () => {
    const requestedSuiteId = "018f0f4e-7b7a-7cc0-8000-000000000001";
    const otherSuiteId = "018f0f4e-7b7a-7cc0-8000-000000000099";
    const requestedCaseKey = "case-001";
    const baseSuite = {
      id: otherSuiteId,
      name: "错误测试集",
      description: "",
      caseCount: 1,
      suiteHash: "a".repeat(64),
      revision: 2,
      createdAt: "2026-07-13T00:00:00.000Z",
      updatedAt: "2026-07-13T00:00:00.000Z"
    };
    const baseCase = {
      id: "018f0f4e-7b7a-7cc0-8000-000000000002",
      suiteId: requestedSuiteId,
      caseKey: requestedCaseKey,
      ordinal: 0,
      description: "Case",
      businessModule: "客服",
      scenarioTag: "正常",
      assertionTypes: ["equals"],
      metrics: ["quality"],
      revision: 3,
      updatedAt: "2026-07-13T00:00:00.000Z",
      definition: {
        contractVersion: "cortex.case-definition.v1",
        description: "Case",
        threshold: 0.8,
        vars: { task: "回答", request_body: {} },
        metadata: {
          case_id: requestedCaseKey,
          req_id: "req-1",
          task_id: "task-1",
          business_module: "客服",
          scenario_tag: "正常"
        },
        assert: [{ type: "equals", metric: "quality", value: "ok" }]
      },
      definitionHash: "b".repeat(64),
      rubricPromptKeys: [],
      createdAt: "2026-07-13T00:00:00.000Z"
    };
    const wrongBodies = [
      { method: "suite" as const, body: baseSuite },
      { method: "case" as const, body: { ...baseCase, suiteId: otherSuiteId } },
      { method: "case" as const, body: { ...baseCase, caseKey: "case-other" } }
    ];

    for (const wrong of wrongBodies) {
      const api = createResourceApi(
        vi.fn<typeof fetch>().mockResolvedValue(
          new Response(JSON.stringify(wrong.body), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        )
      );
      const read =
        wrong.method === "suite"
          ? api.getTestSuite(requestedSuiteId, new AbortController().signal)
          : api.getCase(requestedSuiteId, requestedCaseKey, new AbortController().signal);

      await expect(read).rejects.toMatchObject({
        code: "CLIENT_RESPONSE_INVALID",
        statusCode: 200
      });
    }
  });

  it("所有请求已固定身份的 P4 列表与写响应都拒绝契约合法的身份错配", async () => {
    const suiteId = "018f0f4e-7b7a-7cc0-8000-000000000001";
    const otherSuiteId = "018f0f4e-7b7a-7cc0-8000-000000000099";
    const caseKey = "case-001";
    const otherCaseKey = "case-other";
    const configId = "018f0f4e-7b7a-7cc0-8000-000000000003";
    const otherConfigId = "018f0f4e-7b7a-7cc0-8000-000000000098";
    const timestamp = "2026-07-13T00:00:00.000Z";
    const definition = {
      contractVersion: "cortex.case-definition.v1" as const,
      description: "Case",
      threshold: 0.8,
      vars: { task: "回答", request_body: {} },
      metadata: {
        case_id: caseKey,
        req_id: "req-1",
        task_id: "task-1",
        business_module: "客服",
        scenario_tag: "正常"
      },
      assert: [{ type: "equals", metric: "quality", value: "ok" }]
    };
    const suite = {
      id: suiteId,
      name: "测试集",
      description: "",
      caseCount: 1,
      suiteHash: "a".repeat(64),
      revision: 2,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const caseDetail = {
      id: "018f0f4e-7b7a-7cc0-8000-000000000002",
      suiteId,
      caseKey,
      ordinal: 0,
      description: "Case",
      businessModule: "客服",
      scenarioTag: "正常",
      assertionTypes: ["equals"],
      metrics: ["quality"],
      revision: 3,
      updatedAt: timestamp,
      definition,
      definitionHash: "b".repeat(64),
      rubricPromptKeys: [],
      createdAt: timestamp
    };
    const endpointDefinition = {
      contractVersion: "cortex.endpoint-config.v1" as const,
      urlTemplate: "https://example.com",
      method: "POST" as const,
      headers: {},
      bodySelector: "",
      timeoutMs: 60_000,
      defaultConcurrency: 4
    };
    const endpoint = {
      kind: "ENDPOINT" as const,
      id: configId,
      name: "接口",
      semanticHash: "c".repeat(64),
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      definition: endpointDefinition
    };
    const readCases = {
      limit: 50,
      cursor: null,
      caseKey: "",
      description: "",
      businessModules: [],
      scenarioTags: [],
      assertionTypes: [],
      metrics: []
    };
    const signal = new AbortController().signal;
    const operations: readonly {
      readonly name: string;
      readonly status: number;
      readonly body: unknown;
      readonly run: (api: ResourceApi) => Promise<unknown>;
    }[] = [
      {
        name: "Case 列表 Suite ID",
        status: 200,
        body: {
          items: [
            {
              id: caseDetail.id,
              suiteId: otherSuiteId,
              caseKey,
              ordinal: 0,
              description: "Case",
              businessModule: "客服",
              scenarioTag: "正常",
              assertionTypes: ["equals"],
              metrics: ["quality"],
              revision: 3,
              updatedAt: timestamp
            }
          ],
          nextCursor: null
        },
        run: (api) => api.listCases(suiteId, readCases, signal)
      },
      {
        name: "Test Suite 更新 ID",
        status: 200,
        body: { ...suite, id: otherSuiteId },
        run: (api) =>
          api.updateTestSuite(
            suiteId,
            { name: suite.name, description: suite.description, expectedRevision: 1 },
            signal
          )
      },
      {
        name: "Case 创建 Suite ID",
        status: 201,
        body: { case: { ...caseDetail, suiteId: otherSuiteId }, suite },
        run: (api) => api.createCase(suiteId, { expectedSuiteRevision: 1, definition }, signal)
      },
      {
        name: "Case 更新 Case Key",
        status: 200,
        body: { case: { ...caseDetail, caseKey: otherCaseKey }, suite },
        run: (api) =>
          api.updateCase(
            suiteId,
            caseKey,
            { expectedSuiteRevision: 1, expectedCaseRevision: 2, definition },
            signal
          )
      },
      {
        name: "Case 更新请求 Definition ID",
        status: 200,
        body: { case: caseDetail, suite },
        run: (api) =>
          api.updateCase(
            suiteId,
            caseKey,
            {
              expectedSuiteRevision: 1,
              expectedCaseRevision: 2,
              definition: {
                ...definition,
                metadata: { ...definition.metadata, case_id: otherCaseKey }
              }
            },
            signal
          )
      },
      {
        name: "Case 复制 Definition ID",
        status: 201,
        body: {
          case: {
            ...caseDetail,
            caseKey: "case-copy",
            definition: {
              ...definition,
              metadata: { ...definition.metadata, case_id: otherCaseKey }
            }
          },
          suite
        },
        run: (api) =>
          api.copyCase(
            suiteId,
            caseKey,
            { expectedSuiteRevision: 1, newCaseKey: "case-copy" },
            signal
          )
      },
      {
        name: "Case 导入 Suite ID",
        status: 200,
        body: { count: 1, suite: { ...suite, id: otherSuiteId } },
        run: (api) =>
          api.importCases(
            suiteId,
            1,
            new File(["[]"], "cases.json", { type: "application/json" }),
            signal
          )
      },
      {
        name: "配置列表 Kind",
        status: 200,
        body: {
          items: [
            {
              kind: "LLM",
              id: configId,
              name: "模型",
              revision: 1,
              updatedAt: timestamp
            }
          ],
          nextCursor: null
        },
        run: (api) => api.listConfigurations("ENDPOINT", { limit: 50, cursor: null }, signal)
      },
      {
        name: "配置读取 ID",
        status: 200,
        body: { ...endpoint, id: otherConfigId },
        run: (api) => api.getConfiguration("ENDPOINT", configId, signal)
      },
      {
        name: "配置创建 Kind",
        status: 201,
        body: {
          kind: "LLM",
          id: configId,
          name: "模型",
          semanticHash: "d".repeat(64),
          revision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          definition: {
            contractVersion: "cortex.llm-config.v1",
            providerType: "GOOGLE_GEMINI",
            model: "gemini-2.5-flash",
            thinkingLevel: "OFF",
            temperature: 0,
            topP: 1,
            maxOutputTokens: 1024,
            timeoutMs: 60_000,
            apiKey: { kind: "ENV_SECRET", envKey: "GEMINI_API_KEY" },
            structuredOutput: "JSON_OBJECT"
          }
        },
        run: (api) =>
          api.createConfiguration(
            "ENDPOINT",
            { name: endpoint.name, definition: endpointDefinition },
            signal
          )
      },
      {
        name: "配置更新 ID",
        status: 200,
        body: { ...endpoint, id: otherConfigId },
        run: (api) =>
          api.updateConfiguration(
            "ENDPOINT",
            configId,
            { name: endpoint.name, definition: endpointDefinition, expectedRevision: 1 },
            signal
          )
      }
    ];

    for (const operation of operations) {
      const api = createResourceApi(
        vi.fn<typeof fetch>().mockResolvedValue(
          new Response(JSON.stringify(operation.body), {
            status: operation.status,
            headers: { "content-type": "application/json" }
          })
        )
      );

      await expect(operation.run(api), operation.name).rejects.toMatchObject({
        code: "CLIENT_RESPONSE_INVALID",
        statusCode: operation.status
      });
    }
  });

  it("Test Suite mutation 只失效资源计数、目标列表和目标详情", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();

    await invalidateTestSuiteMutation(queryClient, "suite-1");

    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      resourceKeys.dashboard(),
      resourceKeys.testSuiteLists(),
      resourceKeys.testSuiteDetail("suite-1")
    ]);
  });

  it("冲突 Snapshot 同步 Test Suite 与 Case 的已加载列表事实", () => {
    const queryClient = new QueryClient();
    const suiteSnapshot = {
      id: "suite-1",
      name: "远端测试集",
      description: "远端说明",
      caseCount: 2,
      suiteHash: "a".repeat(64),
      revision: 3,
      createdAt: "2026-07-13T00:00:00.000Z",
      updatedAt: "2026-07-13T01:00:00.000Z"
    };
    const suiteListKey = [...resourceKeys.testSuiteLists(), { limit: 50, cursor: null }] as const;
    queryClient.setQueryData(suiteListKey, {
      items: [
        {
          id: "suite-1",
          name: "旧测试集",
          description: "旧说明",
          caseCount: 1,
          revision: 2,
          updatedAt: "2026-07-13T00:00:00.000Z"
        }
      ],
      nextCursor: null
    });
    synchronizeTestSuiteSnapshot(queryClient, suiteSnapshot);
    expect(queryClient.getQueryData(suiteListKey)).toMatchObject({
      items: [{ name: "远端测试集", caseCount: 2, revision: 3 }]
    });

    const caseSnapshot = {
      id: "case-id",
      suiteId: "suite-1",
      caseKey: "case-1",
      ordinal: 0,
      description: "远端 Case",
      businessModule: "客服",
      scenarioTag: "正常",
      assertionTypes: ["equals"],
      metrics: ["quality"],
      revision: 4,
      updatedAt: "2026-07-13T01:00:00.000Z",
      definition: {
        contractVersion: "cortex.case-definition.v1" as const,
        description: "远端 Case",
        threshold: 0.8,
        vars: { task: "回答", request_body: {} },
        metadata: {
          case_id: "case-1",
          req_id: "req-1",
          task_id: "task-1",
          business_module: "客服",
          scenario_tag: "正常"
        },
        assert: [{ type: "equals", metric: "quality", value: "ok" }]
      },
      definitionHash: "b".repeat(64),
      rubricPromptKeys: [],
      createdAt: "2026-07-13T00:00:00.000Z"
    };
    const caseListKey = [
      ...resourceKeys.caseLists("suite-1"),
      { limit: 50, cursor: null }
    ] as const;
    queryClient.setQueryData(caseListKey, {
      items: [{ ...caseSnapshot, description: "旧 Case", revision: 3 }],
      nextCursor: null
    });
    queryClient.setQueryData(resourceKeys.caseDetail("suite-1", "case-1"), {
      ...caseSnapshot,
      description: "可见 Draft",
      revision: 3
    });

    synchronizeCaseListSnapshot(queryClient, caseSnapshot);

    expect(queryClient.getQueryData(caseListKey)).toMatchObject({
      items: [{ description: "远端 Case", revision: 4 }]
    });
    expect(queryClient.getQueryData(resourceKeys.caseDetail("suite-1", "case-1"))).toMatchObject({
      description: "可见 Draft",
      revision: 3
    });

    synchronizeCaseSnapshot(queryClient, caseSnapshot);
    expect(queryClient.getQueryData(resourceKeys.caseDetail("suite-1", "case-1"))).toEqual(
      caseSnapshot
    );
  });

  it("配置 mutation 只失效资源计数、对应类型列表和目标详情", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();

    await invalidateConfigurationMutation(queryClient, "LLM", "llm-1");

    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      resourceKeys.dashboard(),
      resourceKeys.configurationLists("LLM"),
      resourceKeys.configurationDetail("LLM", "llm-1")
    ]);
  });

  it("配置 Snapshot 同步目标详情和已加载列表中的服务端事实", () => {
    const queryClient = new QueryClient();
    const resource = {
      kind: "ENDPOINT" as const,
      id: "endpoint-1",
      name: "远端接口",
      semanticHash: "a".repeat(64),
      revision: 3,
      createdAt: "2026-07-13T00:00:00.000Z",
      updatedAt: "2026-07-13T01:00:00.000Z",
      definition: {
        contractVersion: "cortex.endpoint-config.v1" as const,
        urlTemplate: "https://example.com",
        method: "POST" as const,
        headers: {},
        bodySelector: "",
        timeoutMs: 60_000,
        defaultConcurrency: 4
      }
    };
    const listKey = [...resourceKeys.configurationLists("ENDPOINT"), { cursor: null }] as const;
    queryClient.setQueryData(listKey, {
      items: [
        {
          kind: "ENDPOINT",
          id: resource.id,
          name: "旧接口",
          revision: 2,
          updatedAt: "2026-07-13T00:00:00.000Z"
        }
      ],
      nextCursor: null
    });

    synchronizeConfigurationSnapshot(queryClient, resource);

    expect(
      queryClient.getQueryData(resourceKeys.configurationDetail("ENDPOINT", resource.id))
    ).toEqual(resource);
    expect(queryClient.getQueryData(listKey)).toMatchObject({
      items: [{ name: "远端接口", revision: 3, updatedAt: resource.updatedAt }]
    });
  });

  it("配置删除移除精确详情并只刷新仍然存在的聚合消费者", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(resourceKeys.configurationDetail("LLM", "llm-1"), { revision: 2 });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();

    await invalidateConfigurationDeletion(queryClient, "LLM", "llm-1");

    expect(
      queryClient.getQueryData(resourceKeys.configurationDetail("LLM", "llm-1"))
    ).toBeUndefined();
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      resourceKeys.dashboard(),
      resourceKeys.configurationLists("LLM")
    ]);
  });

  it("Case 删除移除精确详情，导入替换移除全部 Case 详情", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(resourceKeys.caseDetail("suite-1", "case-a"), { revision: 0 });
    queryClient.setQueryData(resourceKeys.caseDetail("suite-1", "case-b"), { revision: 2 });

    await invalidateCaseDeletion(queryClient, "suite-1", "case-a");

    expect(queryClient.getQueryData(resourceKeys.caseDetail("suite-1", "case-a"))).toBeUndefined();
    expect(queryClient.getQueryData(resourceKeys.caseDetail("suite-1", "case-b"))).toEqual({
      revision: 2
    });

    await invalidateCaseReplacement(queryClient, "suite-1");

    expect(queryClient.getQueriesData({ queryKey: resourceKeys.caseDetails("suite-1") })).toEqual(
      []
    );
  });

  it("请求写操作发送 JSON 契约并验证返回资源", async () => {
    const definition: AnalysisPromptDefinition = {
      contractVersion: "cortex.prompt.v1",
      kind: "CASE_ANALYSIS",
      promptKey: "analysis.default",
      messages: [{ role: "SYSTEM", content: "{{case_definition}}" }]
    };
    const resource = {
      kind: "CASE_ANALYSIS_PROMPT" as const,
      id: "018f0f4e-7b7a-7cc0-8000-000000000001",
      name: "失败分析",
      semanticHash: "a".repeat(64),
      revision: 0,
      createdAt: "2026-07-13T00:00:00.000Z",
      updatedAt: "2026-07-13T00:00:00.000Z",
      definition
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(resource), {
        status: 201,
        headers: { "content-type": "application/json" }
      })
    );
    const api = createResourceApi(fetcher);

    await expect(
      api.createConfiguration(
        "CASE_ANALYSIS_PROMPT",
        { name: resource.name, definition: resource.definition },
        new AbortController().signal
      )
    ).resolves.toEqual(resource);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/case-analysis-prompts",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: resource.name, definition: resource.definition })
      })
    );
  });
});
