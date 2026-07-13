// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

describe("测试集详情页元数据与生命周期", () => {
  it("测试集元数据 409 后保留 Draft，并用最新 revision 重试", async () => {
    const firstRemoteSuite = { ...suite, name: "第一次远端名称", revision: 6 };
    const secondRemoteSuite = { ...suite, name: "第二次远端名称", revision: 7 };
    let suiteReads = 0;
    let updates = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url === `/api/v1/test-suites/${suiteId}` && init?.method === "PUT") {
        updates += 1;
        if (updates <= 2) {
          return Promise.resolve(
            response(
              {
                error: {
                  code: "RESOURCE_REVISION_CONFLICT",
                  message: "资源版本发生冲突",
                  requestId: "018f0f4e-7b7a-7cc0-8000-000000000099",
                  expectedRevision: updates === 1 ? 5 : 6,
                  actualRevision: updates === 1 ? 6 : 7
                }
              },
              409
            )
          );
        }
        return Promise.resolve(response({ ...secondRemoteSuite, name: "本地名称", revision: 8 }));
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

    await userEvent.click(await screen.findByRole("button", { name: "编辑测试集" }));
    const name = screen.getByRole("textbox", { name: "测试集名称" });
    await userEvent.clear(name);
    await userEvent.type(name, "本地名称");
    await userEvent.click(screen.getByRole("button", { name: "保存测试集" }));

    expect(await screen.findByRole("heading", { name: "发现并发修改" })).toBeInTheDocument();
    expect(screen.getByText("本地 Draft：本地名称")).toBeInTheDocument();
    expect(screen.getByText("服务端版本：第一次远端名称")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存测试集" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "测试集名称" })).toBeDisabled();
    expect(onLeaveBlockedChange).toHaveBeenLastCalledWith(true);
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("heading", { name: "发现并发修改" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "使用最新 Revision 重试" }));

    await waitFor(() => expect(updates).toBe(2));
    expect(await screen.findByText("服务端版本：第二次远端名称")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "使用最新 Revision 重试" }));
    await waitFor(() => expect(updates).toBe(3));
    const retryBody = requestBody(
      fetcher.mock.calls.filter(([, init]) => init?.method === "PUT").at(-1)?.[1]
    );
    expect(retryBody).toContain('"name":"本地名称"');
    expect(retryBody).toContain('"expectedRevision":7');
    await waitFor(() => expect(onLeaveBlockedChange).toHaveBeenLastCalledWith(false));
  });

  it("测试集元数据保存单飞，请求在途阻止关闭且字段错误留在 Sheet", async () => {
    let resolveUpdate: ((response: Response) => void) | undefined;
    const pendingUpdate = new Promise<Response>((resolve) => {
      resolveUpdate = resolve;
    });
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url === `/api/v1/test-suites/${suiteId}` && init?.method === "PUT") {
        return pendingUpdate.then((result) => result.clone());
      }
      if (url === `/api/v1/test-suites/${suiteId}`) return Promise.resolve(response(suite));
      return Promise.resolve(response({ items: [], nextCursor: null }));
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

    await userEvent.click(await screen.findByRole("button", { name: "编辑测试集" }));
    const save = screen.getByRole("button", { name: "保存测试集" });
    fireEvent.click(save);
    fireEvent.click(save);

    await waitFor(() =>
      expect(fetcher.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1)
    );
    expect(save).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "测试集名称" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "测试集说明" })).toBeDisabled();
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("heading", { name: "编辑测试集元数据" })).toBeInTheDocument();

    resolveUpdate?.(
      response(
        {
          error: {
            code: "RESOURCE_UNIQUE_CONFLICT",
            message: "名称重复",
            requestId: "018f0f4e-7b7a-7cc0-8000-000000000099",
            field: "name"
          }
        },
        409
      )
    );
    const name = screen.getByRole("textbox", { name: "测试集名称" });
    expect(await screen.findByText("服务端校验失败：name")).toBeInTheDocument();
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveFocus();
  });

  it("测试集元数据更新响应身份错配时保留 Sheet 与 Draft 且不误判成功", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url === `/api/v1/test-suites/${suiteId}` && init?.method === "PUT") {
        return Promise.resolve(
          response({ ...suite, id: "018f0f4e-7b7a-7cc0-8000-000000000099", name: "本地名称" })
        );
      }
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

    await userEvent.click(await screen.findByRole("button", { name: "编辑测试集" }));
    const name = screen.getByRole("textbox", { name: "测试集名称" });
    await userEvent.clear(name);
    await userEvent.type(name, "身份错配前的 Suite Draft");
    await userEvent.click(screen.getByRole("button", { name: "保存测试集" }));

    expect(
      await within(screen.getByRole("dialog")).findByText("操作失败，输入和当前事实均未被覆盖。")
    ).toBeInTheDocument();
    expect(name).toHaveValue("身份错配前的 Suite Draft");
    expect(screen.getByRole("heading", { name: "编辑测试集元数据" })).toBeInTheDocument();
    expect(screen.queryByText("操作已完成")).not.toBeInTheDocument();
  });

  it("测试集元数据 Session 冻结打开或采用 Snapshot 时的 Revision", async () => {
    const remoteSuite = { ...suite, name: "服务端 R6", revision: 6 };
    const backgroundSuite = { ...suite, name: "后台 R7", revision: 7 };
    const expectedRevisions: number[] = [];
    let suiteReads = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url === `/api/v1/test-suites/${suiteId}` && init?.method === "PUT") {
        const body = JSON.parse(requestBody(init)) as { readonly expectedRevision: number };
        expectedRevisions.push(body.expectedRevision);
        return Promise.resolve(
          response(
            {
              error: {
                code: "RESOURCE_REVISION_CONFLICT",
                message: "资源版本发生冲突",
                requestId: "018f0f4e-7b7a-7cc0-8000-000000000099",
                expectedRevision: body.expectedRevision,
                actualRevision: 6
              }
            },
            409
          )
        );
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

    await userEvent.click(await screen.findByRole("button", { name: "编辑测试集" }));
    act(() => {
      client.setQueryData(resourceKeys.testSuiteDetail(suiteId), backgroundSuite);
    });
    const name = screen.getByRole("textbox", { name: "测试集名称" });
    await userEvent.clear(name);
    await userEvent.type(name, "基于 R5 的 Draft");
    await userEvent.click(screen.getByRole("button", { name: "保存测试集" }));

    expect(await screen.findByRole("heading", { name: "发现并发修改" })).toBeInTheDocument();
    expect(expectedRevisions).toEqual([5]);
    await userEvent.click(screen.getByRole("button", { name: "放弃 Draft，采用服务端版本" }));

    act(() => {
      client.setQueryData(resourceKeys.testSuiteDetail(suiteId), backgroundSuite);
    });
    await userEvent.clear(name);
    await userEvent.type(name, "基于 R6 的 Draft");
    await userEvent.click(screen.getByRole("button", { name: "保存测试集" }));

    expect(await screen.findByRole("heading", { name: "发现并发修改" })).toBeInTheDocument();
    expect(expectedRevisions).toEqual([5, 6]);
  });

  it("导出验证后的完整 JSON，并按影响事实删除测试集", async () => {
    let unmountPage = (): void => undefined;
    const onNavigate = vi.fn(() => unmountPage());
    const createObjectURL = vi.fn().mockReturnValue("blob:cases");
    const revokeObjectURL = vi.fn();
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: createObjectURL },
      revokeObjectURL: { configurable: true, value: revokeObjectURL }
    });
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url.endsWith("/export")) return Promise.resolve(response([definition]));
      if (url.endsWith("/impact")) {
        return Promise.resolve(response({ caseCount: 1, activeRunReference: false }));
      }
      if (url.startsWith(`/api/v1/test-suites/${suiteId}?`) && init?.method === "DELETE") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url === `/api/v1/test-suites/${suiteId}`) return Promise.resolve(response(suite));
      return Promise.resolve(response({ items: [summary], nextCursor: null }));
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    client.setQueryData(resourceKeys.testSuiteDetail(suiteId), suite);
    client.setQueryData(resourceKeys.caseDetail(suiteId, "cached-case"), detail);
    client.setQueryData([...resourceKeys.caseLists(suiteId), { cursor: "cached" }], {
      items: [summary],
      nextCursor: null
    });
    const page = render(
      <QueryClientProvider client={client}>
        <TestSuiteDetailPage
          api={createResourceApi(fetcher)}
          suiteId={suiteId}
          onNavigate={onNavigate}
        />
      </QueryClientProvider>
    );
    unmountPage = page.unmount;

    await userEvent.click(await screen.findByRole("button", { name: "导出 Cases" }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledOnce());
    expect(anchorClick).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:cases");

    await userEvent.click(screen.getByRole("button", { name: "删除测试集" }));
    expect(
      await screen.findByText("将删除当前测试集及其中 1 个 Case。此操作不会修改历史运行快照。")
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith("/test-suites"));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: resourceKeys.dashboard() });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: resourceKeys.testSuiteLists() });
    expect(client.getQueryData(resourceKeys.testSuiteDetail(suiteId))).toBeUndefined();
    expect(client.getQueriesData({ queryKey: ["test-suites", suiteId, "cases"] })).toEqual([]);
    anchorClick.mockRestore();
  });

  it("活动运行引用会禁用测试集删除", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.endsWith("/impact")) {
        return Promise.resolve(response({ caseCount: 1, activeRunReference: true }));
      }
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

    await userEvent.click(await screen.findByRole("button", { name: "删除测试集" }));
    expect(await screen.findByText("测试集正在被运行使用，当前不能删除。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认删除" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("测试集删除影响预检单飞，并与其他写入口互斥", async () => {
    let resolveImpact: ((response: Response) => void) | undefined;
    const pendingImpact = new Promise<Response>((resolve) => {
      resolveImpact = resolve;
    });
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.endsWith("/impact")) return pendingImpact;
      if (url === `/api/v1/test-suites/${suiteId}`) return Promise.resolve(response(suite));
      return Promise.resolve(response({ items: [summary], nextCursor: null }));
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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

    const deleteSuite = await screen.findByRole("button", { name: "删除测试集" });
    await userEvent.click(deleteSuite);
    await waitFor(() =>
      expect(
        fetcher.mock.calls.filter(([input]) => requestUrl(input).endsWith("/impact"))
      ).toHaveLength(1)
    );
    expect(onLeaveBlockedChange).toHaveBeenLastCalledWith(true);
    expect(screen.getByRole("button", { name: "编辑测试集" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "新建 Case" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "编辑 case-001" })).toBeDisabled();
    expect(deleteSuite).toBeDisabled();

    resolveImpact?.(response({ caseCount: 1, activeRunReference: false }));
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(onLeaveBlockedChange).toHaveBeenLastCalledWith(false));
  });

  it("测试集删除非 Revision 失败在原确认框显示且允许重试", async () => {
    let deletes = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url.endsWith("/impact")) {
        return Promise.resolve(response({ caseCount: 1, activeRunReference: false }));
      }
      if (init?.method === "DELETE") {
        deletes += 1;
        return Promise.resolve(
          deletes === 1
            ? response(
                {
                  error: {
                    code: "INTERNAL_ERROR",
                    message: "内部错误",
                    requestId: "018f0f4e-7b7a-7cc0-8000-000000000099"
                  }
                },
                500
              )
            : new Response(null, { status: 204 })
        );
      }
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

    await userEvent.click(await screen.findByRole("button", { name: "删除测试集" }));
    await userEvent.click(screen.getByRole("button", { name: "确认删除" }));
    const dialog = screen.getByRole("alertdialog");
    expect(
      await within(dialog).findByText("操作失败，输入和当前事实均未被覆盖。")
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "确认删除" })).toBeEnabled();
    await userEvent.click(within(dialog).getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(deletes).toBe(2));
  });

  it("测试集删除 409 后刷新最新事实并用最新 Revision 重试", async () => {
    const remoteSuite = { ...suite, name: "远端测试集", revision: 6 };
    let suiteReads = 0;
    let deletes = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url.endsWith("/impact")) {
        return Promise.resolve(response({ caseCount: 1, activeRunReference: false }));
      }
      if (init?.method === "DELETE") {
        deletes += 1;
        if (deletes === 1) {
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
        return Promise.resolve(new Response(null, { status: 204 }));
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

    await userEvent.click(await screen.findByRole("button", { name: "删除测试集" }));
    await userEvent.click(await screen.findByRole("button", { name: "确认删除" }));
    expect(await screen.findByText("服务端版本：远端测试集")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "使用最新 Revision 重试" }));

    await waitFor(() => expect(deletes).toBe(2));
    expect(
      requestUrl(
        fetcher.mock.calls.filter(([, callInit]) => callInit?.method === "DELETE").at(-1)?.[0] ?? ""
      )
    ).toContain("expectedRevision=6");
  });

  it("测试集删除确认冻结影响预检开始时的 Suite Revision", async () => {
    const remoteSuite = { ...suite, name: "远端测试集", revision: 6 };
    const deleteRevisions: number[] = [];
    let suiteReads = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url.endsWith("/impact")) {
        return Promise.resolve(response({ caseCount: 1, activeRunReference: false }));
      }
      if (init?.method === "DELETE") {
        const revision = Number(
          new URL(url, "http://localhost").searchParams.get("expectedRevision")
        );
        deleteRevisions.push(revision);
        if (revision === 5) {
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
        return Promise.resolve(new Response(null, { status: 204 }));
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

    await userEvent.click(await screen.findByRole("button", { name: "删除测试集" }));
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    act(() => {
      client.setQueryData(resourceKeys.testSuiteDetail(suiteId), remoteSuite);
    });
    await userEvent.click(screen.getByRole("button", { name: "确认删除" }));

    expect(await screen.findByText("服务端版本：远端测试集")).toBeInTheDocument();
    expect(deleteRevisions).toEqual([5]);
  });

  it("测试集删除冲突按 Suite 后 Impact 顺序原子发布确认事实", async () => {
    const remoteSuite = { ...suite, name: "远端测试集", revision: 6 };
    let suiteReads = 0;
    let impactReads = 0;
    let resolveSuiteRefresh: ((value: Response) => void) | undefined;
    let resolveImpactRefresh: ((value: Response) => void) | undefined;
    const suiteRefresh = new Promise<Response>((resolve) => {
      resolveSuiteRefresh = resolve;
    });
    const impactRefresh = new Promise<Response>((resolve) => {
      resolveImpactRefresh = resolve;
    });
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url.endsWith("/impact")) {
        impactReads += 1;
        return impactReads === 1
          ? Promise.resolve(response({ caseCount: 1, activeRunReference: false }))
          : impactRefresh;
      }
      if (init?.method === "DELETE") {
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
      if (url === `/api/v1/test-suites/${suiteId}`) {
        suiteReads += 1;
        return suiteReads === 1 ? Promise.resolve(response(suite)) : suiteRefresh;
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

    await userEvent.click(await screen.findByRole("button", { name: "删除测试集" }));
    await userEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(suiteReads).toBe(2));
    expect(impactReads).toBe(1);
    expect(
      screen.queryByRole("button", { name: "使用最新 Revision 重试" })
    ).not.toBeInTheDocument();

    resolveSuiteRefresh?.(response(remoteSuite));
    await waitFor(() => expect(impactReads).toBe(2));
    expect(
      screen.queryByRole("button", { name: "使用最新 Revision 重试" })
    ).not.toBeInTheDocument();
    resolveImpactRefresh?.(
      response(
        {
          error: {
            code: "INTERNAL_ERROR",
            message: "内部错误",
            requestId: "018f0f4e-7b7a-7cc0-8000-000000000099"
          }
        },
        500
      )
    );

    expect(
      await within(screen.getByRole("alertdialog")).findByText(
        "操作失败，输入和当前事实均未被覆盖。"
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "使用最新 Revision 重试" })
    ).not.toBeInTheDocument();
  });

  it("测试集删除冲突可放弃本地删除并采用最新服务端事实", async () => {
    const remoteSuite = { ...suite, name: "远端测试集", revision: 6 };
    let suiteReads = 0;
    let deletes = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url.endsWith("/impact")) {
        return Promise.resolve(response({ caseCount: 1, activeRunReference: false }));
      }
      if (init?.method === "DELETE") {
        deletes += 1;
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

    await userEvent.click(await screen.findByRole("button", { name: "删除测试集" }));
    await userEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "放弃 Draft，采用服务端版本" })
    );

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "远端测试集" })).toBeInTheDocument();
    expect(deletes).toBe(1);
  });

  it("Case 详情读取失败显示稳定错误，过滤可清空且可返回上一页", async () => {
    const requestId = "018f0f4e-7b7a-7cc0-8000-000000000099";
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.endsWith("/cases/case-001")) {
        return Promise.resolve(
          response({ error: { code: "CASE_NOT_FOUND", message: "Case 不存在", requestId } }, 404)
        );
      }
      if (url === `/api/v1/test-suites/${suiteId}`) return Promise.resolve(response(suite));
      if (url.includes("cursor=next"))
        return Promise.resolve(response({ items: [summary], nextCursor: null }));
      return Promise.resolve(response({ items: [summary], nextCursor: "next" }));
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

    await userEvent.type(await screen.findByRole("searchbox", { name: "Case ID 搜索" }), "case");
    await userEvent.click(screen.getByRole("button", { name: "清空过滤" }));
    expect(window.location.search).toBe("?limit=50");
    await userEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(window.location.search).toContain("cursor=next"));
    await userEvent.click(screen.getByRole("button", { name: "上一页" }));
    await waitFor(() => expect(window.location.search).toBe("?limit=50"));

    await userEvent.click(screen.getByRole("button", { name: "编辑 case-001" }));
    expect(await screen.findByText("Case 详情读取失败")).toBeInTheDocument();
  });

  it("测试集元数据可成功保存，返回按钮使用显式路由", async () => {
    const onNavigate = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url === `/api/v1/test-suites/${suiteId}` && init?.method === "PUT") {
        return Promise.resolve(response({ ...suite, name: "新名称", revision: 6 }));
      }
      if (url === `/api/v1/test-suites/${suiteId}`) return Promise.resolve(response(suite));
      return Promise.resolve(response({ items: [], nextCursor: null }));
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <TestSuiteDetailPage
          api={createResourceApi(fetcher)}
          suiteId={suiteId}
          onNavigate={onNavigate}
        />
      </QueryClientProvider>
    );

    await userEvent.click(await screen.findByRole("button", { name: "返回测试集" }));
    expect(onNavigate).toHaveBeenCalledWith("/test-suites");
    await userEvent.click(screen.getByRole("button", { name: "编辑测试集" }));
    const name = screen.getByRole("textbox", { name: "测试集名称" });
    await userEvent.clear(name);
    await userEvent.type(name, "新名称");
    await userEvent.click(screen.getByRole("button", { name: "保存测试集" }));
    await waitFor(() =>
      expect(fetcher.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(true)
    );
  });

  it("测试集冲突可放弃 Draft 并采用最新服务端事实", async () => {
    const remoteSuite = { ...suite, name: "远端名称", description: "远端说明", revision: 6 };
    let reads = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url === `/api/v1/test-suites/${suiteId}` && init?.method === "PUT") {
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
      if (url === `/api/v1/test-suites/${suiteId}`) {
        reads += 1;
        return Promise.resolve(response(reads === 1 ? suite : remoteSuite));
      }
      return Promise.resolve(response({ items: [], nextCursor: null }));
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

    await userEvent.click(await screen.findByRole("button", { name: "编辑测试集" }));
    await userEvent.clear(screen.getByRole("textbox", { name: "测试集名称" }));
    await userEvent.type(screen.getByRole("textbox", { name: "测试集名称" }), "本地名称");
    await userEvent.click(screen.getByRole("button", { name: "保存测试集" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "放弃 Draft，采用服务端版本" })
    );

    expect(screen.getByRole("textbox", { name: "测试集名称" })).toHaveValue("远端名称");
    expect(screen.getByRole("textbox", { name: "测试集说明" })).toHaveValue("远端说明");
    expect(screen.queryByText("发现并发修改")).not.toBeInTheDocument();
  });

  it("首屏读取失败可同时重试 Suite 和 Cases", async () => {
    const requestId = "018f0f4e-7b7a-7cc0-8000-000000000099";
    let suiteReads = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === `/api/v1/test-suites/${suiteId}`) {
        suiteReads += 1;
        if (suiteReads === 1) {
          return Promise.resolve(
            response({ error: { code: "INTERNAL_ERROR", message: "内部错误", requestId } }, 500)
          );
        }
        return Promise.resolve(response(suite));
      }
      return Promise.resolve(response({ items: [], nextCursor: null }));
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
    await userEvent.click(screen.getByRole("button", { name: "重新读取" }));
    expect(await screen.findByRole("heading", { name: suite.name })).toBeInTheDocument();
  });

  it("导出或删除影响读取失败都收敛为页面操作错误", async () => {
    const requestId = "018f0f4e-7b7a-7cc0-8000-000000000099";
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.endsWith("/export") || url.endsWith("/impact")) {
        return Promise.resolve(
          response({ error: { code: "INTERNAL_ERROR", message: "内部错误", requestId } }, 500)
        );
      }
      if (url === `/api/v1/test-suites/${suiteId}`) return Promise.resolve(response(suite));
      return Promise.resolve(response({ items: [], nextCursor: null }));
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

    await userEvent.click(await screen.findByRole("button", { name: "导出 Cases" }));
    expect(await screen.findByText("操作失败，输入和当前事实均未被覆盖。")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "删除测试集" }));
    expect(screen.getByText("操作失败，输入和当前事实均未被覆盖。")).toBeInTheDocument();
  });
});
