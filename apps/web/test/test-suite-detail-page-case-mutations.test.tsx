// @vitest-environment jsdom

import type { CaseMutationV1Schema } from "@cortex-eval/contracts/src/resource-api-contracts.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";

import { TestSuiteDetailPage } from "../src/features/test-suites/test-suite-detail-page.tsx";
import { createResourceApi } from "../src/lib/resource-api.ts";
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

// Complete the new form rather than submitting an automatically passing placeholder.
async function completeCreateForm(): Promise<void> {
  await userEvent.type(screen.getByRole("textbox", { name: "Case 描述" }), "确认实际输出字段存在");
  await userEvent.type(screen.getByRole("combobox", { name: "任务" }), "agent-e2e");
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "业务模块" }), "客服");
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "场景标签" }), "正常");
  await userEvent.type(screen.getByRole("combobox", { name: "目标字段 1" }), "parsed_output");
}

describe("测试集详情页 Case 资源写操作", () => {
  it("导入失败时保留确认框并显示顺序、Case ID 与字段路径", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url.includes("dryRun=true")) {
        const revision = Number(new URL(url, "http://local").searchParams.get("expectedRevision"));
        return Promise.resolve(
          response({
            count: 1,
            suite: { ...suite, revision },
            preview: {
              added: 0,
              modified: 0,
              removed: suite.caseCount - 1,
              unchanged: 1,
              reordered: 0
            }
          })
        );
      }
      if (url.includes("/import?") && init?.method === "POST") {
        return Promise.resolve(
          response(
            {
              error: {
                code: "CASE_IMPORT_ITEM_INVALID",
                message: "Case 导入项无效",
                requestId: "018f0f4e-7b7a-7cc0-8000-000000000099",
                index: 2,
                caseKey: "case-bad",
                causeCode: "CASE_DEFINITION_INVALID",
                path: "threshold"
              }
            },
            422
          )
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

    const input = await screen.findByLabelText("导入 Cases JSON/JSONL");
    expect(input).toHaveAttribute("accept", "application/json,application/x-ndjson,.json,.jsonl");
    await userEvent.upload(input, new File(["[]"], "cases.json", { type: "application/json" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "确认导入并替换" })).toBeEnabled()
    );
    await userEvent.click(screen.getByRole("button", { name: "确认导入并替换" }));

    expect(await screen.findByRole("heading", { name: "导入预检与替换确认" })).toBeInTheDocument();
    expect(
      screen.getByText("第 3 项（Case ID：case-bad）字段 threshold 无效。")
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(input).toHaveValue("");
  });

  it("依次完成 Case 创建、复制、删除和成功导入", async () => {
    const mutationResponse = (
      caseKey: string,
      submitted = definition
    ): z.infer<typeof CaseMutationV1Schema> => ({
      case: {
        ...detail,
        caseKey,
        definition: {
          ...submitted,
          assert: [...submitted.assert],
          metadata: { ...submitted.metadata, case_id: caseKey }
        }
      },
      suite: { ...suite, revision: 6 }
    });
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url.includes("dryRun=true")) {
        const revision = Number(new URL(url, "http://local").searchParams.get("expectedRevision"));
        return Promise.resolve(
          response({
            count: 1,
            suite: { ...suite, revision },
            preview: {
              added: 0,
              modified: 0,
              removed: suite.caseCount - 1,
              unchanged: 1,
              reordered: 0
            }
          })
        );
      }
      if (url.includes("/import?") && init?.method === "POST") {
        return Promise.resolve(response({ count: 1, suite: { ...suite, revision: 6 } }));
      }
      if (url.endsWith("/copy") && init?.method === "POST") {
        const body = JSON.parse(requestBody(init)) as { readonly newCaseKey: string };
        return Promise.resolve(response(mutationResponse(body.newCaseKey), 201));
      }
      if (url.endsWith("/cases") && init?.method === "POST") {
        const body = JSON.parse(requestBody(init)) as { readonly definition: typeof definition };
        return Promise.resolve(
          response(mutationResponse(body.definition.metadata.case_id, body.definition), 201)
        );
      }
      if (url.includes("/cases/case-001?") && init?.method === "DELETE") {
        return Promise.resolve(new Response(null, { status: 204 }));
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

    await userEvent.click(await screen.findByRole("button", { name: "新建 Case" }));
    await completeCreateForm();
    await userEvent.click(screen.getByRole("button", { name: "保存 Case" }));
    await waitFor(() =>
      expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true)
    );
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "新建 Case" })).not.toBeInTheDocument()
    );

    await userEvent.click(screen.getByRole("button", { name: "复制 case-001" }));
    await userEvent.click(screen.getByRole("button", { name: "复制 Case" }));
    await waitFor(() =>
      expect(fetcher.mock.calls.some(([input]) => requestUrl(input).endsWith("/copy"))).toBe(true)
    );
    await waitFor(() => expect(screen.queryByText("复制 Case · case-001")).not.toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "删除 case-001" }));
    await userEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() =>
      expect(fetcher.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true)
    );
    await waitFor(() =>
      expect(screen.queryByText("删除 Case · case-001？")).not.toBeInTheDocument()
    );

    await userEvent.upload(
      screen.getByLabelText("导入 Cases JSON/JSONL"),
      new File(["[]"], "cases.json", { type: "application/json" })
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "确认导入并替换" })).toBeEnabled()
    );
    await userEvent.click(screen.getByRole("button", { name: "确认导入并替换" }));
    await waitFor(() =>
      expect(fetcher.mock.calls.some(([input]) => requestUrl(input).includes("/import?"))).toBe(
        true
      )
    );
  });

  it("Case 创建、复制、删除和导入在 409 后保留操作并支持重试或采用服务端事实", async () => {
    const attempts = new Map<string, number>();
    let currentSuiteRevision = suite.revision;
    const conflict = (operation: string): Response | null => {
      const attempt = (attempts.get(operation) ?? 0) + 1;
      attempts.set(operation, attempt);
      if (attempt > 1) return null;
      const expectedRevision = currentSuiteRevision;
      currentSuiteRevision += 1;
      return response(
        {
          error: {
            code: "RESOURCE_REVISION_CONFLICT",
            message: "资源版本发生冲突",
            requestId: "018f0f4e-7b7a-7cc0-8000-000000000099",
            expectedRevision,
            actualRevision: currentSuiteRevision
          }
        },
        409
      );
    };
    const mutationResponse = (caseKey: string): z.infer<typeof CaseMutationV1Schema> => ({
      case: {
        ...detail,
        caseKey,
        definition: {
          ...definition,
          assert: [...definition.assert],
          metadata: { ...definition.metadata, case_id: caseKey }
        }
      },
      suite: { ...suite, revision: currentSuiteRevision }
    });
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url.includes("dryRun=true")) {
        const revision = Number(new URL(url, "http://local").searchParams.get("expectedRevision"));
        return Promise.resolve(
          response({
            count: 1,
            suite: { ...suite, revision },
            preview: {
              added: 0,
              modified: 0,
              removed: suite.caseCount - 1,
              unchanged: 1,
              reordered: 0
            }
          })
        );
      }
      if (url.includes("/import?") && init?.method === "POST") {
        const rejected = conflict("IMPORT");
        return Promise.resolve(
          rejected ?? response({ count: 1, suite: { ...suite, revision: currentSuiteRevision } })
        );
      }
      if (url.endsWith("/copy") && init?.method === "POST") {
        const rejected = conflict("COPY");
        if (rejected !== null) return Promise.resolve(rejected);
        const body = JSON.parse(requestBody(init)) as { readonly newCaseKey: string };
        return Promise.resolve(response(mutationResponse(body.newCaseKey), 201));
      }
      if (url.endsWith("/cases") && init?.method === "POST") {
        const rejected = conflict("CREATE");
        if (rejected !== null) return Promise.resolve(rejected);
        const body = JSON.parse(requestBody(init)) as { readonly definition: typeof definition };
        return Promise.resolve(response(mutationResponse(body.definition.metadata.case_id), 201));
      }
      if (url.includes("/cases/case-001?") && init?.method === "DELETE") {
        return Promise.resolve(conflict("DELETE") ?? new Response(null, { status: 204 }));
      }
      if (url.endsWith("/cases/case-001")) return Promise.resolve(response(detail));
      if (url === `/api/v1/test-suites/${suiteId}`) {
        return Promise.resolve(response({ ...suite, revision: currentSuiteRevision }));
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
    const retryLatest = async (
      originalActionName: string,
      frozenFieldName?: string
    ): Promise<void> => {
      expect(
        await screen.findByRole("heading", { name: "Case 操作遇到并发修改" })
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: originalActionName })).toBeDisabled();
      if (frozenFieldName !== undefined) {
        expect(screen.getByRole("textbox", { name: frozenFieldName })).toBeDisabled();
      }
      await userEvent.click(screen.getByRole("button", { name: "使用最新 Revision 重试" }));
      await waitFor(() =>
        expect(
          screen.queryByRole("heading", { name: "Case 操作遇到并发修改" })
        ).not.toBeInTheDocument()
      );
    };

    await userEvent.click(await screen.findByRole("button", { name: "新建 Case" }));
    await completeCreateForm();
    await userEvent.click(screen.getByRole("button", { name: "保存 Case" }));
    await retryLatest("保存 Case", "Case 描述");
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "新建 Case" })).not.toBeInTheDocument()
    );

    await userEvent.click(screen.getByRole("button", { name: "复制 case-001" }));
    await userEvent.click(screen.getByRole("button", { name: "复制 Case" }));
    await retryLatest("复制 Case", "新 Case ID");
    await waitFor(() => expect(screen.queryByText("复制 Case · case-001")).not.toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "删除 case-001" }));
    await userEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await retryLatest("确认删除");
    await waitFor(() =>
      expect(screen.queryByText("删除 Case · case-001？")).not.toBeInTheDocument()
    );

    await userEvent.upload(
      screen.getByLabelText("导入 Cases JSON/JSONL"),
      new File(["[]"], "cases.json", { type: "application/json" })
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "确认导入并替换" })).toBeEnabled()
    );
    await userEvent.click(screen.getByRole("button", { name: "确认导入并替换" }));
    expect(
      await screen.findByRole("heading", { name: "Case 操作遇到并发修改" })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认导入并替换" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "放弃 Draft，采用服务端版本" }));
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "导入预检与替换确认" })).not.toBeInTheDocument()
    );
    expect(screen.getByLabelText("导入 Cases JSON/JSONL")).toHaveValue("");

    expect(attempts).toEqual(
      new Map([
        ["CREATE", 2],
        ["COPY", 2],
        ["DELETE", 2],
        ["IMPORT", 1]
      ])
    );
  });

  it.each(["CREATE", "COPY", "DELETE", "IMPORT"] as const)(
    "Case %s 冲突重试遇到终态失败时在原 owner 显示错误并保留输入",
    async (operation) => {
      const requestId = "018f0f4e-7b7a-7cc0-8000-000000000099";
      let suiteReads = 0;
      let mutationAttempts = 0;
      const mutationFailure = (): Response => {
        mutationAttempts += 1;
        if (mutationAttempts === 1) {
          return response(
            {
              error: {
                code: "RESOURCE_REVISION_CONFLICT",
                message: "资源版本发生冲突",
                requestId,
                expectedRevision: 5,
                actualRevision: 6
              }
            },
            409
          );
        }
        return response({ error: { code: "INTERNAL_ERROR", message: "内部错误", requestId } }, 500);
      };
      const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
        const url = requestUrl(input);
        if (url.includes("dryRun=true")) {
          const revision = Number(
            new URL(url, "http://local").searchParams.get("expectedRevision")
          );
          return Promise.resolve(
            response({
              count: 1,
              suite: { ...suite, revision },
              preview: {
                added: 0,
                modified: 0,
                removed: suite.caseCount - 1,
                unchanged: 1,
                reordered: 0
              }
            })
          );
        }
        if (
          (operation === "CREATE" && url.endsWith("/cases") && init?.method === "POST") ||
          (operation === "COPY" && url.endsWith("/copy") && init?.method === "POST") ||
          (operation === "DELETE" &&
            url.includes("/cases/case-001?") &&
            init?.method === "DELETE") ||
          (operation === "IMPORT" && url.includes("/import?") && init?.method === "POST")
        ) {
          return Promise.resolve(mutationFailure());
        }
        if (url.endsWith("/cases/case-001")) {
          return Promise.resolve(response({ ...detail, revision: 4 }));
        }
        if (url === `/api/v1/test-suites/${suiteId}`) {
          suiteReads += 1;
          return Promise.resolve(response({ ...suite, revision: suiteReads === 1 ? 5 : 6 }));
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
      await screen.findByRole("heading", { name: "客服回归集" });

      if (operation === "CREATE") {
        await userEvent.click(screen.getByRole("button", { name: "新建 Case" }));
        await completeCreateForm();
        const description = screen.getByRole("textbox", { name: "Case 描述" });
        await userEvent.clear(description);
        await userEvent.type(description, "保留创建 Draft");
        await userEvent.click(screen.getByRole("button", { name: "保存 Case" }));
      }
      if (operation === "COPY") {
        await userEvent.click(screen.getByRole("button", { name: "复制 case-001" }));
        const newCaseKey = screen.getByRole("textbox", { name: "新 Case ID" });
        await userEvent.clear(newCaseKey);
        await userEvent.type(newCaseKey, "retained-copy");
        await userEvent.click(screen.getByRole("button", { name: "复制 Case" }));
      }
      if (operation === "DELETE") {
        await userEvent.click(screen.getByRole("button", { name: "删除 case-001" }));
        await userEvent.click(screen.getByRole("button", { name: "确认删除" }));
      }
      if (operation === "IMPORT") {
        await userEvent.upload(
          screen.getByLabelText("导入 Cases JSON/JSONL"),
          new File(["[]"], "retained-cases.json", { type: "application/json" })
        );
        await waitFor(() =>
          expect(screen.getByRole("button", { name: "确认导入并替换" })).toBeEnabled()
        );
        await userEvent.click(screen.getByRole("button", { name: "确认导入并替换" }));
      }

      expect(
        await screen.findByRole("heading", { name: "Case 操作遇到并发修改" })
      ).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "使用最新 Revision 重试" }));
      if (operation === "IMPORT") {
        expect(mutationAttempts).toBe(1);
        await waitFor(() =>
          expect(screen.getByRole("button", { name: "确认导入并替换" })).toBeEnabled()
        );
        await userEvent.click(screen.getByRole("button", { name: "确认导入并替换" }));
      }

      await waitFor(() =>
        expect(
          screen.queryByRole("heading", { name: "Case 操作遇到并发修改" })
        ).not.toBeInTheDocument()
      );
      const ownerHeading =
        operation === "CREATE"
          ? screen.getByRole("heading", { name: "新建 Case" })
          : operation === "COPY"
            ? screen.getByText("复制 Case · case-001")
            : operation === "DELETE"
              ? screen.getByText("删除 Case · case-001？")
              : screen.getByText("导入预检与替换确认");
      const owner = ownerHeading.closest('[role="dialog"], [role="alertdialog"]');
      expect(owner).not.toBeNull();
      expect(
        (await within(owner as HTMLElement).findAllByText("操作失败，输入和当前事实均未被覆盖。"))
          .length
      ).toBeGreaterThan(0);

      if (operation === "CREATE") {
        expect(
          within(owner as HTMLElement).getByRole("textbox", { name: "Case 描述" })
        ).toHaveValue("保留创建 Draft");
        expect(
          within(owner as HTMLElement).getByRole("button", { name: "保存 Case" })
        ).toBeEnabled();
      }
      if (operation === "COPY") {
        expect(
          within(owner as HTMLElement).getByRole("textbox", { name: "新 Case ID" })
        ).toHaveValue("retained-copy");
        expect(
          within(owner as HTMLElement).getByRole("button", { name: "复制 Case" })
        ).toBeEnabled();
      }
      if (operation === "DELETE") {
        expect(
          within(owner as HTMLElement).getByRole("button", { name: "确认删除" })
        ).toBeEnabled();
        const retryUrl = requestUrl(
          fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE").at(-1)?.[0] ?? ""
        );
        expect(retryUrl).toContain("expectedSuiteRevision=6");
        expect(retryUrl).toContain("expectedCaseRevision=4");
      }
      if (operation === "IMPORT") {
        const fileInput = screen.getByLabelText<HTMLInputElement>("导入 Cases JSON/JSONL");
        expect(fileInput.files?.[0]?.name).toBe("retained-cases.json");
        expect(
          within(owner as HTMLElement).getByRole("button", { name: "确认导入并替换" })
        ).toBeEnabled();
      }
      expect(mutationAttempts).toBe(2);
    }
  );

  it("Case 复制和删除的非 Revision 失败在当前模态框内可访问", async () => {
    const requestId = "018f0f4e-7b7a-7cc0-8000-000000000099";
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url.includes("dryRun=true")) {
        const revision = Number(new URL(url, "http://local").searchParams.get("expectedRevision"));
        return Promise.resolve(
          response({
            count: 1,
            suite: { ...suite, revision },
            preview: {
              added: 0,
              modified: 0,
              removed: suite.caseCount - 1,
              unchanged: 1,
              reordered: 0
            }
          })
        );
      }
      if (url.endsWith("/copy") && init?.method === "POST") {
        return Promise.resolve(
          response(
            {
              error: {
                code: "RESOURCE_UNIQUE_CONFLICT",
                message: "Case ID 重复",
                requestId,
                field: "newCaseKey"
              }
            },
            409
          )
        );
      }
      if (url.includes("/cases/case-001?") && init?.method === "DELETE") {
        return Promise.resolve(
          response({ error: { code: "INTERNAL_ERROR", message: "内部错误", requestId } }, 500)
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

    await userEvent.click(await screen.findByRole("button", { name: "复制 case-001" }));
    await userEvent.click(screen.getByRole("button", { name: "复制 Case" }));
    const copyDialog = screen.getByRole("dialog");
    expect(
      (await within(copyDialog).findAllByText("操作失败，输入和当前事实均未被覆盖。")).length
    ).toBeGreaterThan(0);
    expect(within(copyDialog).getByRole("textbox", { name: "新 Case ID" })).toHaveAttribute(
      "aria-invalid",
      "true"
    );
    expect(within(copyDialog).getByRole("textbox", { name: "新 Case ID" })).toHaveFocus();
    await userEvent.click(within(copyDialog).getByRole("button", { name: "关闭" }));

    await userEvent.click(screen.getByRole("button", { name: "删除 case-001" }));
    await userEvent.click(screen.getByRole("button", { name: "确认删除" }));
    const deleteDialog = screen.getByRole("alertdialog");
    expect(
      await within(deleteDialog).findByText("操作失败，输入和当前事实均未被覆盖。")
    ).toBeInTheDocument();
  });

  it("Case 409 后刷新最新 Suite 失败时收敛为页面错误并保留创建 Draft", async () => {
    let suiteReads = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url.includes("dryRun=true")) {
        const revision = Number(new URL(url, "http://local").searchParams.get("expectedRevision"));
        return Promise.resolve(
          response({
            count: 1,
            suite: { ...suite, revision },
            preview: {
              added: 0,
              modified: 0,
              removed: suite.caseCount - 1,
              unchanged: 1,
              reordered: 0
            }
          })
        );
      }
      if (url.endsWith("/cases") && init?.method === "POST") {
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
        return Promise.resolve(
          suiteReads === 1
            ? response(suite)
            : response(
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

    await userEvent.click(await screen.findByRole("button", { name: "新建 Case" }));
    await completeCreateForm();
    await userEvent.click(screen.getByRole("button", { name: "保存 Case" }));
    expect(await screen.findByText("操作失败，输入和当前事实均未被覆盖。")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "新建 Case" })).toBeInTheDocument();
  });
});
