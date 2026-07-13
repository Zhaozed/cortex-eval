// @vitest-environment jsdom

import { QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useCaseMutationRecovery } from "../src/features/test-suites/use-case-mutation-recovery.ts";
import { ApiClientError } from "../src/lib/api-client.ts";
import { createResourceApi, resourceKeys } from "../src/lib/resource-api.ts";
import { requestUrl } from "./request-fixture.ts";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("Case 非编辑写操作恢复", () => {
  it("409 重试遇到终态失败时统一清洗错误、清除冲突并把最新事实交还 owner", async () => {
    const suiteId = "018f0f4e-7b7a-7cc0-8000-000000000001";
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        id: suiteId,
        name: "远端测试集",
        description: "",
        caseCount: 0,
        suiteHash: "a".repeat(64),
        revision: 6,
        createdAt: "2026-07-13T00:00:00.000Z",
        updatedAt: "2026-07-13T00:00:00.000Z"
      })
    );
    const terminalError = new Error("opaque transport detail");
    const mutation = vi
      .fn<
        (facts: {
          readonly suiteRevision: number;
          readonly caseRevision: number | null;
        }) => Promise<void>
      >()
      .mockRejectedValueOnce(new ApiClientError("RESOURCE_REVISION_CONFLICT"))
      .mockRejectedValueOnce(terminalError);
    const onRetryFailure = vi.fn();
    const onFailureChange = vi.fn();
    const close = vi.fn();
    const { result } = renderHook(() =>
      useCaseMutationRecovery({
        api: createResourceApi(fetcher),
        queryClient,
        suiteId,
        onFailureChange,
        onSuccess: vi.fn()
      })
    );

    await act(async () => {
      await result.current.finish(
        "case-new",
        mutation,
        {
          kind: "CREATE",
          draftLabel: "case-new",
          caseKey: null,
          close,
          onRetryFailure
        },
        { suiteRevision: 5, caseRevision: null }
      );
    });
    expect(result.current.conflict).toMatchObject({
      kind: "CREATE",
      recoveryState: "RETRYABLE",
      serverSuiteRevision: 6
    });

    const conflict = result.current.conflict;
    if (conflict?.recoveryState !== "RETRYABLE") {
      throw new Error("测试前置条件失败：未进入可重试冲突状态");
    }
    act(() => conflict.onRetry());

    await waitFor(() => expect(onRetryFailure).toHaveBeenCalledOnce());
    expect(onRetryFailure).toHaveBeenCalledWith(
      expect.objectContaining({ code: "CLIENT_REQUEST_FAILED" }),
      { suiteRevision: 6, caseRevision: null }
    );
    expect(result.current.conflict).toBeNull();
    expect(close).not.toHaveBeenCalled();
    expect(onFailureChange).toHaveBeenLastCalledWith(false);
  });

  it("同一恢复控制器只允许一个写操作在途", async () => {
    const queryClient = new QueryClient();
    let resolveMutation: (() => void) | undefined;
    const pendingMutation = new Promise<void>((resolve) => {
      resolveMutation = resolve;
    });
    const mutation = vi
      .fn<
        (facts: {
          readonly suiteRevision: number;
          readonly caseRevision: number | null;
        }) => Promise<void>
      >()
      .mockReturnValueOnce(pendingMutation)
      .mockResolvedValue(undefined);
    const onSuccess = vi.fn();
    const { result } = renderHook(() =>
      useCaseMutationRecovery({
        api: createResourceApi(vi.fn<typeof fetch>()),
        queryClient,
        suiteId: "018f0f4e-7b7a-7cc0-8000-000000000001",
        onFailureChange: vi.fn(),
        onSuccess
      })
    );

    let firstMutation: ReturnType<typeof result.current.finish> | undefined;
    act(() => {
      firstMutation = result.current.finish(
        "case-new",
        mutation,
        {
          kind: "CREATE",
          draftLabel: "case-new",
          caseKey: null,
          close: vi.fn(),
          onRetryFailure: vi.fn()
        },
        { suiteRevision: 5, caseRevision: null }
      );
    });
    expect(result.current).toMatchObject({ pending: true });

    const duplicateOutcome = await result.current.finish(
      "case-new",
      mutation,
      {
        kind: "CREATE",
        draftLabel: "case-new",
        caseKey: null,
        close: vi.fn(),
        onRetryFailure: vi.fn()
      },
      { suiteRevision: 5, caseRevision: null }
    );

    expect(mutation).toHaveBeenCalledOnce();
    expect(duplicateOutcome).toMatchObject({ ok: false, skipped: true });
    resolveMutation?.();
    await act(async () => firstMutation);
    expect(result.current).toMatchObject({ pending: false });
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it("删除冲突刷新发现远端 Case 已删除时只允许显式接受删除事实", async () => {
    const suiteId = "018f0f4e-7b7a-7cc0-8000-000000000001";
    const caseKey = "case-001";
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(resourceKeys.caseDetail(suiteId, caseKey), { revision: 3 });
    const listKey = [...resourceKeys.caseLists(suiteId), { limit: 50 }] as const;
    queryClient.setQueryData(listKey, { items: [{ caseKey }], nextCursor: null });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === `/api/v1/test-suites/${suiteId}`) {
        return Promise.resolve(
          response({
            id: suiteId,
            name: "远端测试集",
            description: "",
            caseCount: 0,
            suiteHash: "a".repeat(64),
            revision: 6,
            createdAt: "2026-07-13T00:00:00.000Z",
            updatedAt: "2026-07-13T00:00:00.000Z"
          })
        );
      }
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
    });
    const close = vi.fn();
    const onFailureChange = vi.fn();
    const { result } = renderHook(() =>
      useCaseMutationRecovery({
        api: createResourceApi(fetcher),
        queryClient,
        suiteId,
        onFailureChange,
        onSuccess: vi.fn()
      })
    );

    await act(async () => {
      await result.current.finish(
        caseKey,
        vi.fn().mockRejectedValue(new ApiClientError("RESOURCE_REVISION_CONFLICT")),
        { kind: "DELETE", draftLabel: caseKey, caseKey, close, onRetryFailure: vi.fn() },
        { suiteRevision: 5, caseRevision: 3 }
      );
    });

    expect(result.current.conflict).toMatchObject({
      kind: "DELETE",
      recoveryState: "REMOTE_CASE_DELETED",
      serverSuiteRevision: 6
    });
    expect(result.current.conflict).not.toHaveProperty("onRetry");
    expect(queryClient.getQueryData(resourceKeys.caseDetail(suiteId, caseKey))).toBeUndefined();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: resourceKeys.caseLists(suiteId) });
    expect(close).not.toHaveBeenCalled();

    act(() => result.current.conflict?.onAccept());
    expect(close).toHaveBeenCalledOnce();
    expect(result.current.conflict).toBeNull();
    expect(onFailureChange).toHaveBeenLastCalledWith(false);
  });
});
