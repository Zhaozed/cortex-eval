// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
  type RenderResult
} from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ConfigurationListPage } from "../src/features/configurations/configuration-list-page.tsx";
import { requestBody, requestUrl } from "./request-fixture.ts";
import { createResourceApi, type ConfigurationKind } from "../src/lib/resource-api.ts";

const id = "018f0f4e-7b7a-7cc0-8000-000000000001";
const timestamp = "2026-07-13T00:00:00.000Z";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function renderPage(
  kind: ConfigurationKind,
  fetcher: typeof fetch,
  onLeaveBlockedChange: (blocked: boolean) => void = vi.fn()
): RenderResult {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ConfigurationListPage
        api={createResourceApi(fetcher)}
        kind={kind}
        onLeaveBlockedChange={onLeaveBlockedChange}
      />
    </QueryClientProvider>
  );
}

describe("配置资源页面", () => {
  it("Endpoint 可先验证且不自动保存，再显式创建", async () => {
    const resource = {
      kind: "ENDPOINT",
      id,
      name: "客服接口",
      semanticHash: "a".repeat(64),
      revision: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      definition: {
        contractVersion: "cortex.endpoint-config.v1",
        urlTemplate: "https://example.com/v1",
        method: "POST",
        headers: {},
        bodySelector: "",
        timeoutMs: 30_000,
        defaultConcurrency: 4
      }
    } as const;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url.endsWith("/validate")) return Promise.resolve(response({ ok: true }));
      if (init?.method === "POST") return Promise.resolve(response(resource, 201));
      return Promise.resolve(response({ items: [], nextCursor: null }));
    });

    renderPage("ENDPOINT", fetcher);
    await userEvent.click(await screen.findByRole("button", { name: "新建 Endpoint 配置" }));
    await userEvent.type(screen.getByRole("textbox", { name: "配置名称" }), resource.name);
    await userEvent.clear(screen.getByRole("textbox", { name: "URL 模板" }));
    await userEvent.type(
      screen.getByRole("textbox", { name: "URL 模板" }),
      resource.definition.urlTemplate
    );
    await userEvent.click(screen.getByRole("button", { name: "验证可用性" }));

    expect(await screen.findByText("验证通过，尚未保存。")).toBeInTheDocument();
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await waitFor(() =>
      expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2)
    );
  });

  it("LLM 保存单飞且请求在途时不能关闭编辑 Sheet", async () => {
    let resolveSave: ((response: Response) => void) | undefined;
    const pendingSave = new Promise<Response>((resolve) => {
      resolveSave = resolve;
    });
    const resource = {
      kind: "LLM",
      id,
      name: "Gemini 评估器",
      semanticHash: "a".repeat(64),
      revision: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      definition: {
        contractVersion: "cortex.llm-config.v1",
        providerType: "GOOGLE_GEMINI",
        model: "gemini-test",
        thinkingLevel: "OFF",
        temperature: 0,
        topP: 1,
        maxOutputTokens: 2048,
        timeoutMs: 60_000,
        structuredOutput: "JSON_SCHEMA",
        apiKey: { kind: "ENV_SECRET", envKey: "GEMINI_API_KEY" }
      }
    } as const;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation((_input, init) =>
        init?.method === "POST"
          ? pendingSave
          : Promise.resolve(response({ items: [], nextCursor: null }))
      );

    renderPage("LLM", fetcher);
    await userEvent.click(await screen.findByRole("button", { name: "新建 LLM 配置" }));
    await userEvent.type(screen.getByRole("textbox", { name: "配置名称" }), resource.name);
    await userEvent.type(screen.getByRole("textbox", { name: "模型" }), "gemini-test");
    await userEvent.type(
      screen.getByRole("textbox", { name: "Gemini API Key 环境变量" }),
      "GEMINI_API_KEY"
    );
    const save = screen.getByRole("button", { name: "保存配置" });
    fireEvent.click(save);
    fireEvent.click(save);

    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(save).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "配置名称" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "模型" })).toBeDisabled();
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("heading", { name: "新建 LLM 配置" })).toBeInTheDocument();

    resolveSave?.(response(resource, 201));
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "新建 LLM 配置" })).not.toBeInTheDocument()
    );
  });

  it("Rubric 编辑页显示服务端预览和当前 Case 引用", async () => {
    const resource = {
      kind: "LLM_RUBRIC_PROMPT",
      id,
      name: "质量评估",
      semanticHash: "b".repeat(64),
      revision: 2,
      createdAt: timestamp,
      updatedAt: timestamp,
      definition: {
        contractVersion: "cortex.prompt.v1",
        kind: "LLM_RUBRIC",
        promptKey: "quality.default",
        messages: [{ role: "SYSTEM", content: "检查质量" }]
      }
    } as const;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url.endsWith("/references")) {
        return Promise.resolve(response({ items: [{ suiteId: id, caseKey: "case-001" }] }));
      }
      if (url.endsWith("/preview") && init?.method === "POST") {
        return Promise.resolve(
          response({ promptKey: "quality.default", messages: resource.definition.messages })
        );
      }
      if (url.endsWith(`/${id}`)) return Promise.resolve(response(resource));
      return Promise.resolve(
        response({
          items: [
            { kind: resource.kind, id, name: resource.name, revision: 2, updatedAt: timestamp }
          ],
          nextCursor: null
        })
      );
    });

    renderPage("LLM_RUBRIC_PROMPT", fetcher);
    await userEvent.click(await screen.findByRole("button", { name: "编辑 质量评估" }));
    expect(await screen.findByText("case-001")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "预览消息" }));

    const preview = (await screen.findByRole("heading", { name: "服务端预览" })).parentElement;
    expect(preview).not.toBeNull();
    if (preview === null) return;
    expect(within(preview).getByText("检查质量")).toBeInTheDocument();
    expect(within(preview).getByText("quality.default")).toBeInTheDocument();
  });

  it("Rubric 编辑在引用读取完成前不伪造空集合，失败后可重试", async () => {
    const resource = {
      kind: "LLM_RUBRIC_PROMPT",
      id,
      name: "质量评估",
      semanticHash: "b".repeat(64),
      revision: 2,
      createdAt: timestamp,
      updatedAt: timestamp,
      definition: {
        contractVersion: "cortex.prompt.v1",
        kind: "LLM_RUBRIC",
        promptKey: "quality.default",
        messages: [{ role: "SYSTEM", content: "检查质量" }]
      }
    } as const;
    let referenceCalls = 0;
    let resolveFirstReference: ((value: Response) => void) | undefined;
    const firstReference = new Promise<Response>((resolve) => {
      resolveFirstReference = resolve;
    });
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.endsWith("/references")) {
        referenceCalls += 1;
        return referenceCalls === 1 ? firstReference : Promise.resolve(response({ items: [] }));
      }
      if (url.endsWith(`/${id}`)) return Promise.resolve(response(resource));
      return Promise.resolve(
        response({
          items: [
            { kind: resource.kind, id, name: resource.name, revision: 2, updatedAt: timestamp }
          ],
          nextCursor: null
        })
      );
    });

    renderPage("LLM_RUBRIC_PROMPT", fetcher);
    await userEvent.click(await screen.findByRole("button", { name: "编辑 质量评估" }));
    expect(await screen.findByText("正在读取 Prompt 引用")).toBeInTheDocument();
    expect(screen.queryByText("当前没有 Case 引用。")).not.toBeInTheDocument();

    resolveFirstReference?.(
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
    expect(await screen.findByText("Prompt 引用读取失败。")).toBeInTheDocument();
    expect(screen.queryByText("当前没有 Case 引用。")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "重试读取 Prompt 引用" }));
    expect(await screen.findByText("当前没有 Case 引用。")).toBeInTheDocument();
  });

  it("Rubric 删除确认显示引用并阻止提交", async () => {
    const resource = {
      kind: "LLM_RUBRIC_PROMPT",
      id,
      name: "质量评估",
      revision: 2,
      updatedAt: timestamp
    } as const;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.endsWith("/references")) {
        return Promise.resolve(response({ items: [{ suiteId: id, caseKey: "case-001" }] }));
      }
      return Promise.resolve(response({ items: [resource], nextCursor: null }));
    });

    renderPage("LLM_RUBRIC_PROMPT", fetcher);
    await userEvent.click(await screen.findByRole("button", { name: "删除 质量评估" }));

    expect(await screen.findByText("case-001")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认删除" })).toBeDisabled();
  });

  it("Rubric 引用读取完成前保持删除禁用", async () => {
    const resource = {
      kind: "LLM_RUBRIC_PROMPT",
      id,
      name: "质量评估",
      revision: 2,
      updatedAt: timestamp
    } as const;
    let resolveReferences: ((response: Response) => void) | undefined;
    const pendingReferences = new Promise<Response>((resolve) => {
      resolveReferences = resolve;
    });
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.endsWith("/references")) return pendingReferences;
      return Promise.resolve(response({ items: [resource], nextCursor: null }));
    });

    renderPage("LLM_RUBRIC_PROMPT", fetcher);
    await userEvent.click(await screen.findByRole("button", { name: "删除 质量评估" }));

    expect(screen.getByRole("button", { name: "确认删除" })).toBeDisabled();
    resolveReferences?.(response({ items: [] }));
    await waitFor(() => expect(screen.getByRole("button", { name: "确认删除" })).toBeEnabled());
  });

  it("Rubric 删除引用读取失败后可在原确认框重试", async () => {
    const resource = {
      kind: "LLM_RUBRIC_PROMPT",
      id,
      name: "质量评估",
      revision: 2,
      updatedAt: timestamp
    } as const;
    let referenceCalls = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.endsWith("/references")) {
        referenceCalls += 1;
        return Promise.resolve(
          referenceCalls === 1
            ? response(
                {
                  error: { code: "INTERNAL_ERROR", message: "内部错误", requestId: id }
                },
                500
              )
            : response({ items: [] })
        );
      }
      return Promise.resolve(response({ items: [resource], nextCursor: null }));
    });

    renderPage("LLM_RUBRIC_PROMPT", fetcher);
    await userEvent.click(await screen.findByRole("button", { name: "删除 质量评估" }));
    expect(await screen.findByText("Prompt 引用读取失败。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认删除" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "重试读取 Prompt 引用" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "确认删除" })).toBeEnabled());
  });

  it("Rubric 删除切换目标时忽略前一目标迟到的引用结果", async () => {
    const secondId = "018f0f4e-7b7a-7cc0-8000-000000000002";
    const resources = [
      { kind: "LLM_RUBRIC_PROMPT", id, name: "提示词 A", revision: 2, updatedAt: timestamp },
      {
        kind: "LLM_RUBRIC_PROMPT",
        id: secondId,
        name: "提示词 B",
        revision: 4,
        updatedAt: timestamp
      }
    ] as const;
    let resolveFirst: ((response: Response) => void) | undefined;
    const firstReferences = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.includes(`${id}/references`)) return firstReferences;
      if (url.includes(`${secondId}/references`)) {
        return Promise.resolve(response({ items: [] }));
      }
      return Promise.resolve(response({ items: resources, nextCursor: null }));
    });

    renderPage("LLM_RUBRIC_PROMPT", fetcher);
    await userEvent.click(await screen.findByRole("button", { name: "删除 提示词 A" }));
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    await userEvent.click(screen.getByRole("button", { name: "删除 提示词 B" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "确认删除" })).toBeEnabled());

    await act(async () => {
      resolveFirst?.(response({ items: [{ suiteId: id, caseKey: "case-from-a" }] }));
      await firstReferences;
    });
    expect(screen.queryByText("case-from-a")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认删除" })).toBeEnabled();
  });

  it("配置 409 后保留 Draft、刷新 Snapshot 并用最新 revision 重试", async () => {
    const initial = {
      kind: "ENDPOINT",
      id,
      name: "原名称",
      semanticHash: "c".repeat(64),
      revision: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      definition: {
        contractVersion: "cortex.endpoint-config.v1",
        urlTemplate: "https://example.com",
        method: "POST",
        headers: {},
        bodySelector: "",
        timeoutMs: 30_000,
        defaultConcurrency: 4
      }
    } as const;
    const firstRemote = { ...initial, name: "第一次远端名称", revision: 1 };
    const secondRemote = { ...initial, name: "第二次远端名称", revision: 2 };
    let detailReads = 0;
    let updates = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (init?.method === "PUT") {
        updates += 1;
        if (updates <= 2) {
          return Promise.resolve(
            response(
              {
                error: {
                  code: "RESOURCE_REVISION_CONFLICT",
                  message: "资源版本发生冲突",
                  requestId: "018f0f4e-7b7a-7cc0-8000-000000000099",
                  expectedRevision: updates === 1 ? 0 : 1,
                  actualRevision: updates === 1 ? 1 : 2
                }
              },
              409
            )
          );
        }
        return Promise.resolve(response({ ...secondRemote, name: "本地名称", revision: 3 }));
      }
      if (url.endsWith(`/${id}`)) {
        detailReads += 1;
        return Promise.resolve(
          response(detailReads === 1 ? initial : detailReads === 2 ? firstRemote : secondRemote)
        );
      }
      return Promise.resolve(
        response({
          items: [{ kind: "ENDPOINT", id, name: initial.name, revision: 0, updatedAt: timestamp }],
          nextCursor: null
        })
      );
    });

    const onLeaveBlockedChange = vi.fn();
    renderPage("ENDPOINT", fetcher, onLeaveBlockedChange);
    await userEvent.click(await screen.findByRole("button", { name: "编辑 原名称" }));
    const name = await screen.findByRole("textbox", { name: "配置名称" });
    await userEvent.clear(name);
    await userEvent.type(name, "本地名称");
    await userEvent.click(screen.getByRole("button", { name: "保存配置" }));

    expect(await screen.findByRole("heading", { name: "发现并发修改" })).toBeInTheDocument();
    expect(screen.getByText("本地 Draft：本地名称")).toBeInTheDocument();
    expect(screen.getByText("服务端版本：第一次远端名称")).toBeInTheDocument();
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
    expect(retryBody).toContain('"expectedRevision":2');
    await waitFor(() => expect(onLeaveBlockedChange).toHaveBeenLastCalledWith(false));
  });

  it("配置采用 Snapshot 后关闭重开仍读取同步后的 Query 事实", async () => {
    const initial = {
      kind: "ENDPOINT" as const,
      id,
      name: "原名称",
      semanticHash: "c".repeat(64),
      revision: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      definition: {
        contractVersion: "cortex.endpoint-config.v1" as const,
        urlTemplate: "https://initial.example.com",
        method: "POST" as const,
        headers: {},
        bodySelector: "",
        timeoutMs: 60_000,
        defaultConcurrency: 4
      }
    };
    const remote = {
      ...initial,
      name: "远端名称",
      revision: 1,
      definition: { ...initial.definition, urlTemplate: "https://remote.example.com" }
    };
    let detailReads = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (init?.method === "PUT") {
        return Promise.resolve(
          response(
            {
              error: {
                code: "RESOURCE_REVISION_CONFLICT",
                message: "资源版本发生冲突",
                requestId: id,
                expectedRevision: 0,
                actualRevision: 1
              }
            },
            409
          )
        );
      }
      if (url.endsWith(`/${id}`)) {
        detailReads += 1;
        return Promise.resolve(response(detailReads === 1 ? initial : remote));
      }
      return Promise.resolve(
        response({
          items: [{ kind: "ENDPOINT", id, name: initial.name, revision: 0, updatedAt: timestamp }],
          nextCursor: null
        })
      );
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } }
    });
    render(
      <QueryClientProvider client={client}>
        <ConfigurationListPage api={createResourceApi(fetcher)} kind="ENDPOINT" />
      </QueryClientProvider>
    );

    await userEvent.click(await screen.findByRole("button", { name: "编辑 原名称" }));
    await userEvent.clear(await screen.findByRole("textbox", { name: "配置名称" }));
    await userEvent.type(screen.getByRole("textbox", { name: "配置名称" }), "本地名称");
    await userEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "放弃 Draft，采用服务端版本" })
    );
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "编辑配置 · 原名称" })).not.toBeInTheDocument()
    );
    await userEvent.click(screen.getByRole("button", { name: "编辑 远端名称" }));

    expect(await screen.findByRole("textbox", { name: "配置名称" })).toHaveValue("远端名称");
    expect(screen.getByRole("textbox", { name: "URL 模板" })).toHaveValue(
      "https://remote.example.com"
    );
    expect(detailReads).toBe(2);
  });

  it.each([
    ["LLM_RUBRIC_PROMPT", "LLM_RUBRIC"],
    ["CASE_ANALYSIS_PROMPT", "CASE_ANALYSIS"]
  ] as const)(
    "%s 保存 409 后保留 Prompt Draft 并用最新 revision 重试",
    async (kind, definitionKind) => {
      const initial = {
        kind,
        id,
        name: "原提示词",
        semanticHash: "d".repeat(64),
        revision: 2,
        createdAt: timestamp,
        updatedAt: timestamp,
        definition: {
          contractVersion: "cortex.prompt.v1",
          kind: definitionKind,
          promptKey: "quality.default",
          messages: [{ role: "SYSTEM", content: "检查质量" }]
        }
      } as const;
      const firstRemote = { ...initial, name: "第一次远端提示词", revision: 3 };
      const secondRemote = { ...initial, name: "第二次远端提示词", revision: 4 };
      let detailReads = 0;
      let updates = 0;
      const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
        const url = requestUrl(input);
        if (url.endsWith("/references")) return Promise.resolve(response({ items: [] }));
        if (init?.method === "PUT") {
          updates += 1;
          if (updates <= 2) {
            return Promise.resolve(
              response(
                {
                  error: {
                    code: "RESOURCE_REVISION_CONFLICT",
                    message: "资源版本发生冲突",
                    requestId: "018f0f4e-7b7a-7cc0-8000-000000000099",
                    expectedRevision: updates === 1 ? 2 : 3,
                    actualRevision: updates === 1 ? 3 : 4
                  }
                },
                409
              )
            );
          }
          return Promise.resolve(response({ ...secondRemote, name: "本地提示词", revision: 5 }));
        }
        if (url.endsWith(`/${id}`)) {
          detailReads += 1;
          return Promise.resolve(
            response(detailReads === 1 ? initial : detailReads === 2 ? firstRemote : secondRemote)
          );
        }
        return Promise.resolve(
          response({
            items: [{ kind, id, name: initial.name, revision: 2, updatedAt: timestamp }],
            nextCursor: null
          })
        );
      });

      renderPage(kind, fetcher);
      await userEvent.click(await screen.findByRole("button", { name: "编辑 原提示词" }));
      const name = await screen.findByRole("textbox", { name: "配置名称" });
      await userEvent.clear(name);
      await userEvent.type(name, "本地提示词");
      await userEvent.click(screen.getByRole("button", { name: "保存配置" }));

      expect(await screen.findByRole("heading", { name: "发现并发修改" })).toBeInTheDocument();
      expect(screen.getByText("本地 Draft：本地提示词")).toBeInTheDocument();
      expect(screen.getByText("服务端版本：第一次远端提示词")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "使用最新 Revision 重试" }));

      await waitFor(() => expect(updates).toBe(2));
      expect(await screen.findByText("服务端版本：第二次远端提示词")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "使用最新 Revision 重试" }));
      await waitFor(() => expect(updates).toBe(3));
      const retryBody = requestBody(
        fetcher.mock.calls.filter(([, callInit]) => callInit?.method === "PUT").at(-1)?.[1]
      );
      expect(retryBody).toContain('"name":"本地提示词"');
      expect(retryBody).toContain('"expectedRevision":4');
    }
  );

  it("普通配置删除成功后关闭确认框并刷新列表", async () => {
    const resource = {
      kind: "ENDPOINT",
      id,
      name: "客服接口",
      revision: 2,
      updatedAt: timestamp
    } as const;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
      if (init?.method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
      return Promise.resolve(response({ items: [resource], nextCursor: null }));
    });

    renderPage("ENDPOINT", fetcher);
    await userEvent.click(await screen.findByRole("button", { name: "删除 客服接口" }));
    await userEvent.click(screen.getByRole("button", { name: "确认删除" }));

    await waitFor(() =>
      expect(fetcher.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true)
    );
    await waitFor(() =>
      expect(screen.queryByText("删除配置 · 客服接口？")).not.toBeInTheDocument()
    );
  });

  it("配置删除 409 后刷新 Snapshot 并用最新 Revision 重试", async () => {
    const summary = {
      kind: "ENDPOINT",
      id,
      name: "客服接口",
      revision: 2,
      updatedAt: timestamp
    } as const;
    const remote = {
      ...summary,
      name: "远端客服接口",
      semanticHash: "a".repeat(64),
      revision: 3,
      createdAt: timestamp,
      definition: {
        contractVersion: "cortex.endpoint-config.v1",
        urlTemplate: "https://example.com/v1",
        method: "POST",
        headers: {},
        bodySelector: "",
        timeoutMs: 30_000,
        defaultConcurrency: 4
      }
    } as const;
    let deletes = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (init?.method === "DELETE") {
        deletes += 1;
        if (deletes === 1) {
          return Promise.resolve(
            response(
              {
                error: {
                  code: "RESOURCE_REVISION_CONFLICT",
                  message: "资源版本发生冲突",
                  requestId: id,
                  expectedRevision: 2,
                  actualRevision: 3
                }
              },
              409
            )
          );
        }
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url.endsWith(`/${id}`)) return Promise.resolve(response(remote));
      return Promise.resolve(response({ items: [summary], nextCursor: null }));
    });

    renderPage("ENDPOINT", fetcher);
    await userEvent.click(await screen.findByRole("button", { name: "删除 客服接口" }));
    await userEvent.click(screen.getByRole("button", { name: "确认删除" }));
    expect(await screen.findByText("服务端版本：远端客服接口")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "使用最新 Revision 重试" }));

    await waitFor(() => expect(deletes).toBe(2));
    expect(
      requestUrl(
        fetcher.mock.calls.filter(([, callInit]) => callInit?.method === "DELETE").at(-1)?.[0] ?? ""
      )
    ).toContain("expectedRevision=3");
  });

  it("配置删除冲突可放弃删除并采用最新服务端事实", async () => {
    const summary = {
      kind: "ENDPOINT",
      id,
      name: "客服接口",
      revision: 2,
      updatedAt: timestamp
    } as const;
    const remote = {
      ...summary,
      name: "远端客服接口",
      semanticHash: "a".repeat(64),
      revision: 3,
      createdAt: timestamp,
      definition: {
        contractVersion: "cortex.endpoint-config.v1",
        urlTemplate: "https://example.com/v1",
        method: "POST",
        headers: {},
        bodySelector: "",
        timeoutMs: 60_000,
        defaultConcurrency: 4
      }
    } as const;
    let deletes = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (init?.method === "DELETE") {
        deletes += 1;
        return Promise.resolve(
          response(
            {
              error: {
                code: "RESOURCE_REVISION_CONFLICT",
                message: "资源版本发生冲突",
                requestId: id,
                expectedRevision: 2,
                actualRevision: 3
              }
            },
            409
          )
        );
      }
      if (url.endsWith(`/${id}`)) return Promise.resolve(response(remote));
      return Promise.resolve(response({ items: [summary], nextCursor: null }));
    });

    renderPage("ENDPOINT", fetcher);
    await userEvent.click(await screen.findByRole("button", { name: "删除 客服接口" }));
    await userEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "放弃 Draft，采用服务端版本" })
    );

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "编辑 远端客服接口" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "3" })).toBeInTheDocument();
    expect(deletes).toBe(1);
  });

  it("配置删除非 Revision 失败在原确认框显示且允许重试", async () => {
    const resource = {
      kind: "ENDPOINT",
      id,
      name: "客服接口",
      revision: 2,
      updatedAt: timestamp
    } as const;
    let deletes = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
      if (init?.method === "DELETE") {
        deletes += 1;
        return Promise.resolve(
          deletes === 1
            ? response(
                {
                  error: { code: "INTERNAL_ERROR", message: "内部错误", requestId: id }
                },
                500
              )
            : new Response(null, { status: 204 })
        );
      }
      return Promise.resolve(response({ items: [resource], nextCursor: null }));
    });

    renderPage("ENDPOINT", fetcher);
    await userEvent.click(await screen.findByRole("button", { name: "删除 客服接口" }));
    await userEvent.click(screen.getByRole("button", { name: "确认删除" }));
    const dialog = screen.getByRole("alertdialog");
    expect(
      await within(dialog).findByText("操作失败，输入和当前事实均未被覆盖。")
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "确认删除" })).toBeEnabled();
    await userEvent.click(within(dialog).getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(deletes).toBe(2));
  });

  it("配置列表使用 cursor 前进并按历史返回", async () => {
    const resource = {
      kind: "ENDPOINT",
      id,
      name: "客服接口",
      revision: 2,
      updatedAt: timestamp
    } as const;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      return Promise.resolve(
        response({ items: [resource], nextCursor: url.includes("cursor=next") ? null : "next" })
      );
    });

    renderPage("ENDPOINT", fetcher);
    await userEvent.click(await screen.findByRole("button", { name: "下一页" }));
    await waitFor(() =>
      expect(fetcher.mock.calls.some(([input]) => requestUrl(input).includes("cursor=next"))).toBe(
        true
      )
    );
    await userEvent.click(screen.getByRole("button", { name: "上一页" }));
    await waitFor(() => expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(3));
  });

  it("列表失败可重试，详情失败显示稳定状态", async () => {
    const requestId = "018f0f4e-7b7a-7cc0-8000-000000000099";
    const resource = {
      kind: "ENDPOINT",
      id,
      name: "客服接口",
      revision: 2,
      updatedAt: timestamp
    } as const;
    let listReads = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.endsWith(`/${id}`)) {
        return Promise.resolve(
          response(
            {
              error: {
                code: "CONFIGURATION_NOT_FOUND",
                message: "配置不存在",
                requestId
              }
            },
            404
          )
        );
      }
      listReads += 1;
      if (listReads === 1) {
        return Promise.resolve(
          response({ error: { code: "INTERNAL_ERROR", message: "内部错误", requestId } }, 500)
        );
      }
      return Promise.resolve(response({ items: [resource], nextCursor: null }));
    });

    renderPage("ENDPOINT", fetcher);
    expect(await screen.findByText("配置读取失败")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "重新读取" }));
    await userEvent.click(await screen.findByRole("button", { name: "编辑 客服接口" }));
    expect(await screen.findByText("配置详情读取失败")).toBeInTheDocument();
  });
});
