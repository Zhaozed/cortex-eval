// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TestSuiteDeleteControl } from "../src/features/test-suites/test-suite-delete-control.tsx";
import { createResourceApi, resourceKeys } from "../src/lib/resource-api.ts";
import { requestUrl } from "./request-fixture.ts";
import { response, suite, suiteId } from "./test-suite-detail-page-test-fixture.ts";

describe("测试集删除确认事实", () => {
  it("预检失败不发布临时 Suite Snapshot，重新预检只使用新 Revision", async () => {
    let impactReads = 0;
    const deleteRevisions: number[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url.endsWith("/impact")) {
        impactReads += 1;
        if (impactReads === 1) {
          return Promise.resolve(
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
        }
        return Promise.resolve(response({ caseCount: 1, activeRunReference: false }));
      }
      if (init?.method === "DELETE") {
        deleteRevisions.push(
          Number(new URL(url, "http://localhost").searchParams.get("expectedRevision"))
        );
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      throw new Error(`未预期请求：${url}`);
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onFailureChange = vi.fn();
    const view = render(
      <QueryClientProvider client={client}>
        <TestSuiteDeleteControl
          api={createResourceApi(fetcher)}
          queryClient={client}
          suiteId={suiteId}
          suite={suite}
          disabled={false}
          onDeleted={vi.fn()}
          onFailureChange={onFailureChange}
        />
      </QueryClientProvider>
    );

    await userEvent.click(screen.getByRole("button", { name: "删除测试集" }));
    await waitFor(() => expect(onFailureChange).toHaveBeenLastCalledWith(true));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

    view.rerender(
      <QueryClientProvider client={client}>
        <TestSuiteDeleteControl
          api={createResourceApi(fetcher)}
          queryClient={client}
          suiteId={suiteId}
          suite={{ ...suite, name: "远端测试集", revision: 6 }}
          disabled={false}
          onDeleted={vi.fn()}
          onFailureChange={onFailureChange}
        />
      </QueryClientProvider>
    );
    await userEvent.click(screen.getByRole("button", { name: "删除测试集" }));
    await userEvent.click(await screen.findByRole("button", { name: "确认删除" }));

    await waitFor(() => expect(deleteRevisions).toEqual([6]));
  });

  it("卸载时中止尚未完成的影响预检", async () => {
    const impactSignal: { current: AbortSignal | null } = { current: null };
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
      impactSignal.current = init?.signal instanceof AbortSignal ? init.signal : null;
      return new Promise<Response>(() => undefined);
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={client}>
        <TestSuiteDeleteControl
          api={createResourceApi(fetcher)}
          queryClient={client}
          suiteId={suiteId}
          suite={suite}
          disabled={false}
          onDeleted={vi.fn()}
          onFailureChange={vi.fn()}
        />
      </QueryClientProvider>
    );

    await userEvent.click(screen.getByRole("button", { name: "删除测试集" }));
    await waitFor(() => expect(impactSignal.current).not.toBeNull());
    view.unmount();

    expect(impactSignal.current?.aborted).toBe(true);
  });

  it("卸载时中止 409 恢复且拒绝迟到 Suite 发布或继续读取 Impact", async () => {
    const remoteSuite = { ...suite, name: "迟到远端测试集", revision: 6 };
    const recoverySignal: { current: AbortSignal | null } = { current: null };
    let impactReads = 0;
    let resolveSuiteRecovery: ((value: Response) => void) | undefined;
    const suiteRecovery = new Promise<Response>((resolve) => {
      resolveSuiteRecovery = resolve;
    });
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url.endsWith("/impact")) {
        impactReads += 1;
        return Promise.resolve(response({ caseCount: impactReads, activeRunReference: false }));
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
        recoverySignal.current = init?.signal instanceof AbortSignal ? init.signal : null;
        return suiteRecovery;
      }
      throw new Error(`未预期请求：${url}`);
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(resourceKeys.testSuiteDetail(suiteId), suite);
    const view = render(
      <QueryClientProvider client={client}>
        <TestSuiteDeleteControl
          api={createResourceApi(fetcher)}
          queryClient={client}
          suiteId={suiteId}
          suite={suite}
          disabled={false}
          onDeleted={vi.fn()}
          onFailureChange={vi.fn()}
        />
      </QueryClientProvider>
    );

    await userEvent.click(screen.getByRole("button", { name: "删除测试集" }));
    await userEvent.click(await screen.findByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(recoverySignal.current).not.toBeNull());
    view.unmount();

    expect(recoverySignal.current?.aborted).toBe(true);
    await act(async () => {
      resolveSuiteRecovery?.(response(remoteSuite));
      await Promise.resolve();
    });
    expect(impactReads).toBe(1);
    expect(client.getQueryData(resourceKeys.testSuiteDetail(suiteId))).toEqual(suite);
  });
});
