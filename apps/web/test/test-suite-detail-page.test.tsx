// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TestSuiteDetailPage } from "../src/features/test-suites/test-suite-detail-page.tsx";
import { createResourceApi, resourceKeys } from "../src/lib/resource-api.ts";
import { requestBody, requestUrl } from "./request-fixture.ts";
import {
  definition,
  detail,
  response,
  suite,
  suiteId,
  summary
} from "./test-suite-detail-page-test-fixture.ts";

beforeEach(() => {
  window.history.replaceState(null, "", `/test-suites/${suiteId}`);
});

describe("测试集详情、Case 列表与编辑", () => {
  it("组合过滤写入 URL，并用 next cursor 翻页", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === `/api/v1/test-suites/${suiteId}`) return Promise.resolve(response(suite));
      if (url.includes("cursor=case_v1_next")) {
        return Promise.resolve(response({ items: [], nextCursor: null }));
      }
      return Promise.resolve(response({ items: [summary], nextCursor: "case_v1_next" }));
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={client}>
        <TestSuiteDetailPage
          api={createResourceApi(fetcher)}
          suiteId={suiteId}
          onNavigate={vi.fn()}
        />
      </QueryClientProvider>
    );

    await screen.findByRole("heading", { name: "客服回归集" });
    expect(screen.getByRole("columnheader", { name: "更新时间" })).toBeInTheDocument();
    await userEvent.type(screen.getByRole("searchbox", { name: "Case ID 搜索" }), "case");
    await userEvent.type(screen.getByRole("textbox", { name: "业务模块过滤" }), "客服,售后");
    await userEvent.click(screen.getByRole("button", { name: "应用过滤" }));

    await waitFor(() => {
      expect(window.location.search).toContain("caseKey=case");
      expect(window.location.search).toContain("businessModule=%E5%AE%A2%E6%9C%8D");
      expect(window.location.search).toContain("businessModule=%E5%94%AE%E5%90%8E");
    });
    await userEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(window.location.search).toContain("cursor=case_v1_next"));
    expect(window.location.search).toContain("before=FIRST_PAGE");
  });

  it("编辑 Case 时发送最新 Suite 与 Case revision", async () => {
    const updated = {
      ...detail,
      description: "编辑后描述",
      revision: 4,
      definition: { ...definition, description: "编辑后描述" }
    };
    let resolveUpdate: ((response: Response) => void) | undefined;
    const pendingUpdate = new Promise<Response>((resolve) => {
      resolveUpdate = resolve;
    });
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (init?.method === "PUT") {
        return pendingUpdate;
      }
      if (url.endsWith("/cases/case-001")) return Promise.resolve(response(detail));
      if (url === `/api/v1/test-suites/${suiteId}`) return Promise.resolve(response(suite));
      return Promise.resolve(response({ items: [summary], nextCursor: null }));
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={client}>
        <TestSuiteDetailPage
          api={createResourceApi(fetcher)}
          suiteId={suiteId}
          onNavigate={vi.fn()}
        />
      </QueryClientProvider>
    );

    await userEvent.click(await screen.findByRole("button", { name: "编辑 case-001" }));
    const description = await screen.findByRole("textbox", { name: "Case 描述" });
    await userEvent.clear(description);
    await userEvent.type(description, "编辑后描述");
    const save = screen.getByRole("button", { name: "保存 Case" });
    fireEvent.click(save);
    fireEvent.click(save);

    await waitFor(() =>
      expect(fetcher.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(true)
    );
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
    const updateCall = fetcher.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(updateCall?.[0]).toBe(`/api/v1/test-suites/${suiteId}/cases/case-001`);
    expect(requestBody(updateCall?.[1])).toContain('"expectedSuiteRevision":5');
    expect(requestBody(updateCall?.[1])).toContain('"expectedCaseRevision":3');
    expect(requestBody(updateCall?.[1])).toContain('"description":"编辑后描述"');
    resolveUpdate?.(response({ case: updated, suite: { ...suite, revision: 6 } }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("Case 更新响应身份错配时保留同一编辑器 Draft 且不误判成功", async () => {
    const wrongSuiteId = "018f0f4e-7b7a-7cc0-8000-000000000099";
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (init?.method === "PUT") {
        return Promise.resolve(
          response({
            case: { ...detail, suiteId: wrongSuiteId, revision: 4 },
            suite: { ...suite, revision: 6 }
          })
        );
      }
      if (url.endsWith("/cases/case-001")) return Promise.resolve(response(detail));
      if (url === `/api/v1/test-suites/${suiteId}`) return Promise.resolve(response(suite));
      return Promise.resolve(response({ items: [summary], nextCursor: null }));
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <TestSuiteDetailPage
          api={createResourceApi(fetcher)}
          suiteId={suiteId}
          onNavigate={vi.fn()}
        />
      </QueryClientProvider>
    );

    await userEvent.click(await screen.findByRole("button", { name: "编辑 case-001" }));
    const description = await screen.findByRole("textbox", { name: "Case 描述" });
    await userEvent.clear(description);
    await userEvent.type(description, "身份错配前的 Case Draft");
    await userEvent.click(screen.getByRole("button", { name: "保存 Case" }));

    expect((await screen.findAllByText("Case 保存失败，Draft 已保留。")).length).toBeGreaterThan(0);
    expect(description).toHaveValue("身份错配前的 Case Draft");
    expect(screen.getByRole("heading", { name: "编辑 Case · case-001" })).toBeInTheDocument();
    expect(screen.queryByText("操作已完成")).not.toBeInTheDocument();
  });

  it("重新打开 Case 时等待本次详情成功并冻结同一 Definition 与 Revision 快照", async () => {
    const cachedDetail = {
      ...detail,
      revision: 3,
      definition: { ...definition, vars: { ...definition.vars, task: "旧缓存任务" } }
    };
    const refreshedDetail = {
      ...detail,
      revision: 4,
      definition: { ...definition, vars: { ...definition.vars, task: "远端新任务" } }
    };
    let resolveDetailRead: ((value: Response) => void) | undefined;
    const pendingDetailRead = new Promise<Response>((resolve) => {
      resolveDetailRead = resolve;
    });
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (init?.method === "PUT") {
        return Promise.resolve(
          response({ case: { ...refreshedDetail, revision: 5 }, suite: { ...suite, revision: 6 } })
        );
      }
      if (url.endsWith("/cases/case-001")) return pendingDetailRead;
      if (url === `/api/v1/test-suites/${suiteId}`) return Promise.resolve(response(suite));
      return Promise.resolve(response({ items: [summary], nextCursor: null }));
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(resourceKeys.caseDetail(suiteId, "case-001"), cachedDetail);
    render(
      <QueryClientProvider client={client}>
        <TestSuiteDetailPage
          api={createResourceApi(fetcher)}
          suiteId={suiteId}
          onNavigate={vi.fn()}
        />
      </QueryClientProvider>
    );

    await userEvent.click(await screen.findByRole("button", { name: "编辑 case-001" }));
    expect(screen.queryByRole("textbox", { name: "Case 描述" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存 Case" })).not.toBeInTheDocument();

    resolveDetailRead?.(response(refreshedDetail));
    expect(await screen.findByRole("textbox", { name: "任务" })).toHaveValue("远端新任务");
    const description = screen.getByRole("textbox", { name: "Case 描述" });
    await userEvent.clear(description);
    await userEvent.type(description, "基于新快照编辑");
    await userEvent.click(screen.getByRole("button", { name: "保存 Case" }));

    await waitFor(() =>
      expect(fetcher.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1)
    );
    const updateBody = requestBody(
      fetcher.mock.calls.find(([, init]) => init?.method === "PUT")?.[1]
    );
    expect(updateBody).toContain('"expectedSuiteRevision":5');
    expect(updateBody).toContain('"expectedCaseRevision":4');
    expect(updateBody).toContain('"task":"远端新任务"');
    expect(updateBody).toContain('"description":"基于新快照编辑"');
  });

  it("旧 Case 缓存刷新失败时只显示读取错误且不开放编辑", async () => {
    const cachedDetail = {
      ...detail,
      definition: { ...definition, vars: { ...definition.vars, task: "不可编辑的旧缓存" } }
    };
    let resolveFirstRead: ((value: Response) => void) | undefined;
    let resolveRetryRead: ((value: Response) => void) | undefined;
    const firstRead = new Promise<Response>((resolve) => {
      resolveFirstRead = resolve;
    });
    const retryRead = new Promise<Response>((resolve) => {
      resolveRetryRead = resolve;
    });
    let caseReads = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.endsWith("/cases/case-001")) {
        caseReads += 1;
        return caseReads === 1 ? firstRead : retryRead;
      }
      if (url === `/api/v1/test-suites/${suiteId}`) return Promise.resolve(response(suite));
      return Promise.resolve(response({ items: [summary], nextCursor: null }));
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(resourceKeys.caseDetail(suiteId, "case-001"), cachedDetail);
    render(
      <QueryClientProvider client={client}>
        <TestSuiteDetailPage
          api={createResourceApi(fetcher)}
          suiteId={suiteId}
          onNavigate={vi.fn()}
        />
      </QueryClientProvider>
    );

    await userEvent.click(await screen.findByRole("button", { name: "编辑 case-001" }));
    expect(screen.queryByRole("textbox", { name: "Case 描述" })).not.toBeInTheDocument();
    resolveFirstRead?.(
      response(
        {
          error: {
            code: "INTERNAL_ERROR",
            message: "读取失败",
            requestId: "018f0f4e-7b7a-7cc0-8000-000000000099"
          }
        },
        500
      )
    );

    expect(await screen.findByText("Case 详情读取失败")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Case 描述" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存 Case" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "重新读取" }));
    expect(screen.queryByRole("textbox", { name: "Case 描述" })).not.toBeInTheDocument();

    resolveRetryRead?.(response(detail));
    expect(await screen.findByRole("textbox", { name: "Case 描述" })).toHaveValue(
      definition.description
    );
    expect(caseReads).toBe(2);
  });

  it.each([
    ["CASE_SUITE", { ...detail, suiteId: "018f0f4e-7b7a-7cc0-8000-000000000099" }],
    ["CASE_KEY", { ...detail, caseKey: "case-other" }]
  ] as const)("Case 首次详情读取拒绝 %s 身份错配且不建立编辑 Session", async (_kind, body) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.endsWith("/cases/case-001")) return Promise.resolve(response(body));
      if (url === `/api/v1/test-suites/${suiteId}`) return Promise.resolve(response(suite));
      return Promise.resolve(response({ items: [summary], nextCursor: null }));
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <TestSuiteDetailPage
          api={createResourceApi(fetcher)}
          suiteId={suiteId}
          onNavigate={vi.fn()}
        />
      </QueryClientProvider>
    );

    await userEvent.click(await screen.findByRole("button", { name: "编辑 case-001" }));

    expect(await screen.findByText("Case 详情读取失败")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Case 描述" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存 Case" })).not.toBeInTheDocument();
    expect(client.getQueryData(resourceKeys.caseDetail(suiteId, "case-001"))).toBeUndefined();
  });

  it("Test Suite 首次详情读取拒绝身份错配且不渲染错误资源", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === `/api/v1/test-suites/${suiteId}`) {
        return Promise.resolve(
          response({ ...suite, id: "018f0f4e-7b7a-7cc0-8000-000000000099", name: "错误测试集" })
        );
      }
      return Promise.resolve(response({ items: [summary], nextCursor: null }));
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <TestSuiteDetailPage
          api={createResourceApi(fetcher)}
          suiteId={suiteId}
          onNavigate={vi.fn()}
        />
      </QueryClientProvider>
    );

    expect(await screen.findByText("Case 列表读取失败")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "错误测试集" })).not.toBeInTheDocument();
    expect(client.getQueryData(resourceKeys.testSuiteDetail(suiteId))).toBeUndefined();
  });

  it("409 后刷新最新事实、保留 Draft，并可用最新双 revision 重试", async () => {
    const firstRemoteSuite = { ...suite, revision: 6 };
    const secondRemoteSuite = { ...suite, revision: 7 };
    const firstRemoteDetail = {
      ...detail,
      revision: 4,
      description: "第一次远端修改",
      definition: { ...definition, description: "第一次远端修改" }
    };
    const secondRemoteDetail = {
      ...detail,
      revision: 5,
      description: "第二次远端修改",
      definition: { ...definition, description: "第二次远端修改" }
    };
    let updateCount = 0;
    let suiteReads = 0;
    let caseReads = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (init?.method === "PUT") {
        updateCount += 1;
        if (updateCount <= 2) {
          return Promise.resolve(
            response(
              {
                error: {
                  code: "RESOURCE_REVISION_CONFLICT",
                  message: "资源版本发生冲突",
                  requestId: "018f0f4e-7b7a-7cc0-8000-000000000099",
                  expectedRevision: updateCount === 1 ? 5 : 6,
                  actualRevision: updateCount === 1 ? 6 : 7
                }
              },
              409
            )
          );
        }
        return Promise.resolve(
          response({
            case: {
              ...secondRemoteDetail,
              revision: 6,
              definition: { ...definition, description: "本地 Draft" }
            },
            suite: { ...secondRemoteSuite, revision: 8 }
          })
        );
      }
      if (url.endsWith("/cases/case-001")) {
        caseReads += 1;
        return Promise.resolve(
          response(
            caseReads === 1 ? detail : caseReads === 2 ? firstRemoteDetail : secondRemoteDetail
          )
        );
      }
      if (url === `/api/v1/test-suites/${suiteId}`) {
        suiteReads += 1;
        return Promise.resolve(
          response(
            suiteReads === 1 ? suite : suiteReads === 2 ? firstRemoteSuite : secondRemoteSuite
          )
        );
      }
      return Promise.resolve(response({ items: [summary], nextCursor: null }));
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={client}>
        <TestSuiteDetailPage
          api={createResourceApi(fetcher)}
          suiteId={suiteId}
          onNavigate={vi.fn()}
        />
      </QueryClientProvider>
    );

    await userEvent.click(await screen.findByRole("button", { name: "编辑 case-001" }));
    const description = await screen.findByRole("textbox", { name: "Case 描述" });
    await userEvent.clear(description);
    await userEvent.type(description, "本地 Draft");
    await userEvent.click(screen.getByRole("button", { name: "保存 Case" }));

    expect(await screen.findByRole("heading", { name: "发现并发修改" })).toBeInTheDocument();
    expect(screen.getByText("本地 Draft：本地 Draft")).toBeInTheDocument();
    expect(screen.getByText("服务端版本：第一次远端修改")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Case 描述" })).toHaveValue("本地 Draft");
    expect(screen.getByRole("textbox", { name: "Case 描述" })).toBeDisabled();
    expect(screen.getByRole("tab", { name: "完整 JSON" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "保存 Case" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "使用最新 Revision 重试" }));

    await waitFor(() => expect(updateCount).toBe(2));
    expect(await screen.findByText("服务端版本：第二次远端修改")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "使用最新 Revision 重试" }));
    await waitFor(() => expect(updateCount).toBe(3));
    const retryBody = requestBody(
      fetcher.mock.calls.filter(([, init]) => init?.method === "PUT").at(-1)?.[1]
    );
    expect(retryBody).toContain('"expectedSuiteRevision":7');
    expect(retryBody).toContain('"expectedCaseRevision":5');
    expect(retryBody).toContain('"description":"本地 Draft"');
  });

  it.each([
    ["SUITE_ID", { suiteId: false, caseSuiteId: true, caseKey: true }],
    ["CASE_SUITE_ID", { suiteId: true, caseSuiteId: false, caseKey: true }],
    ["CASE_KEY", { suiteId: true, caseSuiteId: true, caseKey: false }]
  ] as const)("Case 409 刷新拒绝 %s 身份错配且不污染缓存", async (_kind, identity) => {
    let suiteReads = 0;
    let caseReads = 0;
    const wrongSuiteId = "018f0f4e-7b7a-7cc0-8000-000000000099";
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (init?.method === "PUT") {
        return Promise.resolve(
          response(
            {
              error: {
                code: "RESOURCE_REVISION_CONFLICT",
                message: "资源版本发生冲突",
                requestId: "018f0f4e-7b7a-7cc0-8000-000000000098",
                expectedRevision: 5,
                actualRevision: 6
              }
            },
            409
          )
        );
      }
      if (url.endsWith("/cases/case-001")) {
        caseReads += 1;
        if (caseReads === 1) return Promise.resolve(response(detail));
        return Promise.resolve(
          response({
            ...detail,
            suiteId: identity.caseSuiteId ? suiteId : wrongSuiteId,
            caseKey: identity.caseKey ? "case-001" : "case-other",
            revision: 4,
            definition: { ...definition, description: "错误远端 Case" }
          })
        );
      }
      if (url === `/api/v1/test-suites/${suiteId}`) {
        suiteReads += 1;
        return Promise.resolve(
          response({
            ...suite,
            id: suiteReads === 1 || identity.suiteId ? suiteId : wrongSuiteId,
            revision: suiteReads === 1 ? 5 : 6
          })
        );
      }
      return Promise.resolve(response({ items: [summary], nextCursor: null }));
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <TestSuiteDetailPage
          api={createResourceApi(fetcher)}
          suiteId={suiteId}
          onNavigate={vi.fn()}
        />
      </QueryClientProvider>
    );

    await userEvent.click(await screen.findByRole("button", { name: "编辑 case-001" }));
    const description = await screen.findByRole("textbox", { name: "Case 描述" });
    await userEvent.clear(description);
    await userEvent.type(description, "身份错配前的 Draft");
    await userEvent.click(screen.getByRole("button", { name: "保存 Case" }));

    expect(await screen.findByText("Case 保存失败，Draft 已保留。")).toBeInTheDocument();
    expect(description).toHaveValue("身份错配前的 Draft");
    expect(screen.queryByRole("heading", { name: "发现并发修改" })).not.toBeInTheDocument();
    expect(client.getQueryData(resourceKeys.caseDetail(suiteId, "case-001"))).toEqual(detail);
    expect(client.getQueryData(resourceKeys.caseDetail(suiteId, "case-other"))).toBeUndefined();
  });

  it("Case 冲突重试收到字段错误时在同一编辑器消费一次且不产生未处理拒绝", async () => {
    const remoteSuite = { ...suite, revision: 6 };
    const remoteDetail = { ...detail, revision: 4 };
    let suiteReads = 0;
    let caseReads = 0;
    let updates = 0;
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (init?.method === "PUT") {
        updates += 1;
        if (updates === 1) {
          return Promise.resolve(
            response(
              {
                error: {
                  code: "RESOURCE_REVISION_CONFLICT",
                  message: "资源版本发生冲突",
                  requestId: "018f0f4e-7b7a-7cc0-8000-000000000098",
                  expectedRevision: 5,
                  actualRevision: 6
                }
              },
              409
            )
          );
        }
        return Promise.resolve(
          response(
            {
              error: {
                code: "VALIDATION_FAILED",
                message: "字段无效",
                requestId: "018f0f4e-7b7a-7cc0-8000-000000000099",
                path: "definition.description"
              }
            },
            400
          )
        );
      }
      if (url.endsWith("/cases/case-001")) {
        caseReads += 1;
        return Promise.resolve(response(caseReads === 1 ? detail : remoteDetail));
      }
      if (url === `/api/v1/test-suites/${suiteId}`) {
        suiteReads += 1;
        return Promise.resolve(response(suiteReads === 1 ? suite : remoteSuite));
      }
      return Promise.resolve(response({ items: [summary], nextCursor: null }));
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <TestSuiteDetailPage
          api={createResourceApi(fetcher)}
          suiteId={suiteId}
          onNavigate={vi.fn()}
        />
      </QueryClientProvider>
    );

    await userEvent.click(await screen.findByRole("button", { name: "编辑 case-001" }));
    const description = await screen.findByRole("textbox", { name: "Case 描述" });
    await userEvent.clear(description);
    await userEvent.type(description, "字段错误前的 Draft");
    await userEvent.click(screen.getByRole("button", { name: "保存 Case" }));
    await screen.findByRole("heading", { name: "发现并发修改" });
    await userEvent.click(screen.getByRole("button", { name: "使用最新 Revision 重试" }));

    expect(await screen.findByText("服务端校验失败：definition.description")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "发现并发修改" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Case 描述" })).toBe(description);
    expect(description).toHaveValue("字段错误前的 Draft");
    expect(description).toHaveFocus();
    expect(unhandled).not.toHaveBeenCalled();
    window.removeEventListener("unhandledrejection", unhandled);
  });

  it("完整 JSON Case 冲突时保留可见 Draft 并禁用普通保存", async () => {
    const remoteSuite = { ...suite, revision: 6 };
    const remoteDetail = {
      ...detail,
      revision: 4,
      description: "远端修改",
      definition: { ...definition, description: "远端修改" }
    };
    let suiteReads = 0;
    let caseReads = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (init?.method === "PUT") {
        return Promise.resolve(
          response(
            {
              error: {
                code: "RESOURCE_REVISION_CONFLICT",
                message: "资源版本发生冲突",
                requestId: "018f0f4e-7b7a-7cc0-8000-000000000099",
                expectedRevision: 5,
                actualRevision: 6
              }
            },
            409
          )
        );
      }
      if (url.endsWith("/cases/case-001")) {
        caseReads += 1;
        return Promise.resolve(response(caseReads === 1 ? detail : remoteDetail));
      }
      if (url === `/api/v1/test-suites/${suiteId}`) {
        suiteReads += 1;
        return Promise.resolve(response(suiteReads === 1 ? suite : remoteSuite));
      }
      return Promise.resolve(response({ items: [summary], nextCursor: null }));
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <TestSuiteDetailPage
          api={createResourceApi(fetcher)}
          suiteId={suiteId}
          onNavigate={vi.fn()}
        />
      </QueryClientProvider>
    );

    await userEvent.click(await screen.findByRole("button", { name: "编辑 case-001" }));
    await userEvent.click(await screen.findByRole("tab", { name: "完整 JSON" }));
    const fullJson = screen.getByRole("textbox", { name: "完整 Case JSON" });
    fireEvent.change(fullJson, {
      target: { value: JSON.stringify({ ...definition, description: "JSON 本地 Draft" }, null, 2) }
    });
    await userEvent.click(screen.getByRole("button", { name: "保存 Case" }));

    expect(await screen.findByRole("heading", { name: "发现并发修改" })).toBeInTheDocument();
    expect(fullJson).toHaveValue(
      JSON.stringify({ ...definition, description: "JSON 本地 Draft" }, null, 2)
    );
    expect(screen.getByRole("tab", { name: "完整 JSON" })).toHaveAttribute("data-state", "active");
    expect(fullJson).toBeDisabled();
    expect(screen.getByRole("tab", { name: "结构化" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "保存 Case" })).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "放弃 Draft，采用服务端版本" }));
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "发现并发修改" })).not.toBeInTheDocument()
    );
    expect(fullJson).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "结构化" })).toHaveAttribute("data-state", "active");
    expect(screen.getByRole("textbox", { name: "Case 描述" })).toHaveValue("远端修改");
    expect(screen.getByRole("textbox", { name: "Case 描述" })).toBeEnabled();
  });

  it.each(["STRUCTURED", "JSON"] as const)(
    "Case %s 编辑冲突发现远端已删除时保持原编辑器并停止详情重取",
    async (editorMode) => {
      const remoteSuite = { ...suite, caseCount: 0, revision: 6 };
      let suiteReads = 0;
      let caseReads = 0;
      let remoteDeleted = false;
      const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
        const url = requestUrl(input);
        if (init?.method === "PUT") {
          return Promise.resolve(
            response(
              {
                error: {
                  code: "RESOURCE_REVISION_CONFLICT",
                  message: "资源版本发生冲突",
                  requestId: "018f0f4e-7b7a-7cc0-8000-000000000099",
                  expectedRevision: 5,
                  actualRevision: 6
                }
              },
              409
            )
          );
        }
        if (url.endsWith("/cases/case-001")) {
          caseReads += 1;
          if (caseReads === 1) return Promise.resolve(response(detail));
          remoteDeleted = true;
          return Promise.resolve(
            response(
              {
                error: {
                  code: "CASE_NOT_FOUND",
                  message: "Case 不存在",
                  requestId: "018f0f4e-7b7a-7cc0-8000-000000000099"
                }
              },
              404
            )
          );
        }
        if (url === `/api/v1/test-suites/${suiteId}`) {
          suiteReads += 1;
          return Promise.resolve(response(suiteReads === 1 ? suite : remoteSuite));
        }
        return Promise.resolve(
          response({ items: remoteDeleted ? [] : [summary], nextCursor: null })
        );
      });
      const client = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });
      const onLeaveBlockedChange = vi.fn();
      render(
        <QueryClientProvider client={client}>
          <TestSuiteDetailPage
            api={createResourceApi(fetcher)}
            suiteId={suiteId}
            onNavigate={vi.fn()}
            onLeaveBlockedChange={onLeaveBlockedChange}
          />
        </QueryClientProvider>
      );

      await userEvent.click(await screen.findByRole("button", { name: "编辑 case-001" }));
      let draftControl: HTMLElement;
      if (editorMode === "JSON") {
        await userEvent.click(await screen.findByRole("tab", { name: "完整 JSON" }));
        const fullJson = screen.getByRole("textbox", { name: "完整 Case JSON" });
        fireEvent.change(fullJson, {
          target: {
            value: JSON.stringify({ ...definition, description: "远端删除前的本地 Draft" }, null, 2)
          }
        });
        draftControl = fullJson;
      } else {
        const description = await screen.findByRole("textbox", { name: "Case 描述" });
        await userEvent.clear(description);
        await userEvent.type(description, "远端删除前的本地 Draft");
        draftControl = description;
      }
      await userEvent.click(screen.getByRole("button", { name: "保存 Case" }));

      expect(
        await screen.findByRole("heading", { name: "服务端 Case 已删除" })
      ).toBeInTheDocument();
      if (editorMode === "JSON") {
        const fullJson = screen.getByRole("textbox", { name: "完整 Case JSON" });
        expect(fullJson).toBe(draftControl);
        expect(fullJson).toHaveValue(
          JSON.stringify({ ...definition, description: "远端删除前的本地 Draft" }, null, 2)
        );
        expect(screen.getByRole("tab", { name: "完整 JSON" })).toHaveAttribute(
          "data-state",
          "active"
        );
        expect(fullJson).toBeDisabled();
      } else {
        expect(screen.getByRole("textbox", { name: "Case 描述" })).toHaveValue(
          "远端删除前的本地 Draft"
        );
        expect(screen.getByRole("textbox", { name: "Case 描述" })).toBeDisabled();
      }
      expect(screen.getByRole("tab", { name: "结构化" })).toBeDisabled();
      expect(screen.getByRole("tab", { name: "完整 JSON" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "保存 Case" })).toBeDisabled();
      expect(
        screen.queryByRole("button", { name: "使用最新 Revision 重试" })
      ).not.toBeInTheDocument();
      expect(onLeaveBlockedChange).toHaveBeenLastCalledWith(true);

      await waitFor(() => {
        expect(caseReads).toBe(2);
        expect(client.getQueryData(resourceKeys.caseDetail(suiteId, "case-001"))).toBeUndefined();
        expect(screen.queryByRole("button", { name: "编辑 case-001" })).not.toBeInTheDocument();
      });
      await userEvent.click(screen.getByRole("button", { name: "关闭" }));
      expect(screen.getByRole("heading", { name: "服务端 Case 已删除" })).toBeInTheDocument();
      expect(caseReads).toBe(2);

      await userEvent.click(screen.getByRole("button", { name: "采用服务端已删除事实" }));
      await waitFor(() =>
        expect(
          screen.queryByRole("heading", { name: "服务端 Case 已删除" })
        ).not.toBeInTheDocument()
      );
      expect(onLeaveBlockedChange).toHaveBeenLastCalledWith(false);
      expect(caseReads).toBe(2);
    }
  );
});
