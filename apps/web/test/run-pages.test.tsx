// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { RunListPage } from "../src/features/runs/run-list-page.tsx";
import { createResourceApi } from "../src/lib/resource-api.ts";
import { createRunApi, type RunCaseDetail, type RunCasePage } from "../src/lib/run-api.ts";
import { requestBody, requestUrl } from "./request-fixture.ts";
import {
  ENDPOINT_ID,
  EVALUATOR_ID,
  RUN_ID,
  RUN_TIME,
  SUITE_ID,
  runCaseDetail,
  runCasePage,
  runDetail,
  runEvalPage,
  runPage,
  runPreflight,
  runProgress
} from "./run-test-fixture.ts";

const SECOND_ENDPOINT_ID = "018f0f4e-7b7a-7cc0-8000-000000000005";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function client(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
}

function inertEventSource(): {
  readonly addEventListener: (type: string, listener: (event: Event) => void) => void;
  readonly close: () => void;
} {
  return { addEventListener: () => undefined, close: () => undefined };
}

/** One externally completed Promise used to hold a visible pending UI state. */
interface Deferred<Value> {
  /** Promise observed by the production client. */
  readonly promise: Promise<Value>;
  /** Complete the pending operation. */
  readonly resolve: (value: Value) => void;
}

// Create one deterministic externally completed Promise.
function deferred<Value>(): Deferred<Value> {
  let resolvePromise: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  if (resolvePromise === undefined) throw new Error("TEST_DEFERRED_INVALID");
  return { promise, resolve: resolvePromise };
}

describe("Run 页面", () => {
  it("选择改变时主动取消在途预检，过期响应不能继续占用流程", async () => {
    const resourceFetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.includes("test-suites")) {
        return Promise.resolve(
          response({
            items: [
              {
                id: SUITE_ID,
                name: "客服回归集",
                description: "核心流程",
                caseCount: 3,
                revision: 1,
                updatedAt: RUN_TIME,
                latestRun: null
              }
            ],
            nextCursor: null
          })
        );
      }
      if (url.includes("endpoint-configs")) {
        return Promise.resolve(
          response({
            items: [
              {
                kind: "ENDPOINT",
                id: ENDPOINT_ID,
                name: "Endpoint A",
                revision: 0,
                updatedAt: RUN_TIME
              },
              {
                kind: "ENDPOINT",
                id: SECOND_ENDPOINT_ID,
                name: "Endpoint B",
                revision: 0,
                updatedAt: RUN_TIME
              }
            ],
            nextCursor: null
          })
        );
      }
      return Promise.resolve(
        response({
          items: [
            {
              kind: "LLM",
              id: EVALUATOR_ID,
              name: "Evaluator",
              revision: 0,
              updatedAt: RUN_TIME
            }
          ],
          nextCursor: null
        })
      );
    });
    const preflightSignals: AbortSignal[] = [];
    const runFetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url === "/api/v1/runs?limit=50") return Promise.resolve(response(runPage()));
      if (url.endsWith("/preflight")) {
        const signal = init?.signal;
        if (!(signal instanceof AbortSignal)) throw new Error("TEST_SIGNAL_MISSING");
        preflightSignals.push(signal);
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            {
              once: true
            }
          );
        });
      }
      return Promise.resolve(response({ invalid: true }));
    });
    render(
      <QueryClientProvider client={client()}>
        <RunListPage
          api={createRunApi(runFetcher)}
          resourceApi={createResourceApi(resourceFetcher)}
          onNavigate={vi.fn()}
          onCommittedNavigate={vi.fn()}
        />
      </QueryClientProvider>
    );

    await userEvent.click(await screen.findByRole("button", { name: "新建运行" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "测试集" }), SUITE_ID);
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Endpoint 配置" }),
      ENDPOINT_ID
    );
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Evaluator LLM" }),
      EVALUATOR_ID
    );
    await userEvent.click(screen.getByRole("button", { name: "运行前检查" }));
    await waitFor(() => expect(preflightSignals).toHaveLength(1));
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Endpoint 配置" }),
      SECOND_ENDPOINT_ID
    );

    await waitFor(() => expect(preflightSignals[0]?.aborted).toBe(true));
  });

  it("同一选择往返后拒绝忽略 Abort 的旧代预检成功", async () => {
    const resourceFetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.includes("test-suites")) {
        return Promise.resolve(
          response({
            items: [
              {
                id: SUITE_ID,
                name: "客服回归集",
                description: "核心流程",
                caseCount: 3,
                revision: 1,
                updatedAt: RUN_TIME,
                latestRun: null
              }
            ],
            nextCursor: null
          })
        );
      }
      if (url.includes("endpoint-configs")) {
        return Promise.resolve(
          response({
            items: [
              {
                kind: "ENDPOINT",
                id: ENDPOINT_ID,
                name: "Endpoint A",
                revision: 0,
                updatedAt: RUN_TIME
              },
              {
                kind: "ENDPOINT",
                id: SECOND_ENDPOINT_ID,
                name: "Endpoint B",
                revision: 0,
                updatedAt: RUN_TIME
              }
            ],
            nextCursor: null
          })
        );
      }
      return Promise.resolve(
        response({
          items: [
            {
              kind: "LLM",
              id: EVALUATOR_ID,
              name: "Evaluator",
              revision: 0,
              updatedAt: RUN_TIME
            }
          ],
          nextCursor: null
        })
      );
    });
    const requests: Deferred<Response>[] = [];
    const runFetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/runs?limit=50") return Promise.resolve(response(runPage()));
      if (url.endsWith("/preflight")) {
        const request = deferred<Response>();
        requests.push(request);
        return request.promise;
      }
      return Promise.resolve(response({ invalid: true }));
    });
    render(
      <QueryClientProvider client={client()}>
        <RunListPage
          api={createRunApi(runFetcher)}
          resourceApi={createResourceApi(resourceFetcher)}
          onNavigate={vi.fn()}
          onCommittedNavigate={vi.fn()}
        />
      </QueryClientProvider>
    );

    await userEvent.click(await screen.findByRole("button", { name: "新建运行" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "测试集" }), SUITE_ID);
    const endpointSelect = screen.getByRole("combobox", { name: "Endpoint 配置" });
    await userEvent.selectOptions(endpointSelect, ENDPOINT_ID);
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Evaluator LLM" }),
      EVALUATOR_ID
    );
    await userEvent.click(screen.getByRole("button", { name: "运行前检查" }));
    await waitFor(() => expect(requests).toHaveLength(1));
    await userEvent.selectOptions(endpointSelect, SECOND_ENDPOINT_ID);
    await userEvent.selectOptions(endpointSelect, ENDPOINT_ID);
    await userEvent.click(screen.getByRole("button", { name: "运行前检查" }));
    await waitFor(() => expect(requests).toHaveLength(2));

    requests[0]?.resolve(response({ ...runPreflight, caseCount: 99 }));
    await act(async () => Promise.resolve());
    expect(screen.queryByText("99 Cases")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建运行" })).toBeDisabled();

    requests[1]?.resolve(response(runPreflight));
    expect(await screen.findByText("3 Cases")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建运行" })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: "运行前检查" }));
    await waitFor(() => expect(requests).toHaveLength(3));
    expect(screen.queryByText("3 Cases")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建运行" })).toBeDisabled();
    requests[2]?.resolve(
      response(
        {
          error: { code: "INTERNAL_ERROR", message: "预检失败", requestId: RUN_ID }
        },
        500
      )
    );
    await waitFor(() => expect(screen.getByText("运行前检查失败")).toBeVisible());
    expect(screen.queryByText("3 Cases")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建运行" })).toBeDisabled();
  });

  it("先预检并展示冻结输入，再创建 Run 并进入详情", async () => {
    const resourceFetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.includes("test-suites")) {
        return Promise.resolve(
          response({
            items: [
              {
                id: SUITE_ID,
                name: "客服回归集",
                description: "核心流程",
                caseCount: 3,
                revision: 1,
                updatedAt: RUN_TIME,
                latestRun: null
              }
            ],
            nextCursor: null
          })
        );
      }
      const endpoint = url.includes("endpoint-configs");
      return Promise.resolve(
        response({
          items: [
            {
              kind: endpoint ? "ENDPOINT" : "LLM",
              id: endpoint ? ENDPOINT_ID : EVALUATOR_ID,
              name: endpoint ? "客服 Endpoint" : "Gemini Evaluator",
              revision: 0,
              updatedAt: RUN_TIME
            }
          ],
          nextCursor: null
        })
      );
    });
    const runFetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url === "/api/v1/runs?limit=50") return Promise.resolve(response(runPage()));
      if (url.endsWith("/preflight")) return Promise.resolve(response(runPreflight));
      if (url === "/api/v1/runs" && init?.method === "POST") {
        return Promise.resolve(response(runDetail(), 201));
      }
      return Promise.resolve(response({ invalid: true }));
    });
    const onNavigate = vi.fn();
    const onCommittedNavigate = vi.fn();

    render(
      <QueryClientProvider client={client()}>
        <RunListPage
          api={createRunApi(runFetcher)}
          resourceApi={createResourceApi(resourceFetcher)}
          onNavigate={onNavigate}
          onCommittedNavigate={onCommittedNavigate}
        />
      </QueryClientProvider>
    );

    await userEvent.click(await screen.findByRole("button", { name: "新建运行" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "测试集" }), SUITE_ID);
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Endpoint 配置" }),
      ENDPOINT_ID
    );
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Evaluator LLM" }),
      EVALUATOR_ID
    );
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "运行模式" }), "STAGED");
    await userEvent.click(screen.getByRole("button", { name: "运行前检查" }));

    expect(await screen.findByText("3 Cases")).toBeInTheDocument();
    expect(screen.getByText("REST_TOKEN")).toBeInTheDocument();
    expect(screen.getByText("GEMINI_API_KEY")).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "REST 并发" })).toHaveValue(4);
    expect(screen.getByRole("spinbutton", { name: "Eval 并发" })).toHaveValue(2);
    expect(screen.getByRole("textbox", { name: "运行名称" })).toHaveValue("客服回归集");
    await userEvent.clear(screen.getByRole("textbox", { name: "运行名称" }));
    await userEvent.type(screen.getByRole("textbox", { name: "运行名称" }), "客服意图修复回归");
    await userEvent.type(
      screen.getByRole("textbox", { name: /运行描述/ }),
      "验证路由修复，关注澄清场景"
    );
    await userEvent.click(screen.getByRole("button", { name: "创建运行" }));

    await waitFor(() => expect(onCommittedNavigate).toHaveBeenCalledWith(`/runs/${RUN_ID}`));
    expect(onNavigate).not.toHaveBeenCalled();
    const createCall = runFetcher.mock.calls.find(
      ([input, init]) => requestUrl(input) === "/api/v1/runs" && init?.method === "POST"
    );
    expect(JSON.parse(requestBody(createCall?.[1]))).toEqual({
      name: "客服意图修复回归",
      description: "验证路由修复，关注澄清场景",
      suiteId: SUITE_ID,
      endpointConfigId: ENDPOINT_ID,
      evaluatorConfigId: EVALUATOR_ID,
      runMode: "STAGED",
      runExecutionLimits: {
        contractVersion: "cortex.run-execution-limits.v1",
        restConcurrency: 4,
        evalConcurrency: 2
      }
    });
  });

  it("Run 列表加载失败可重试，资源 Cursor 循环明确失败", async () => {
    let listCalls = 0;
    const runFetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      if (requestUrl(input).startsWith("/api/v1/runs?")) {
        listCalls += 1;
        return Promise.resolve(listCalls === 1 ? response({}, 500) : response(runPage()));
      }
      return Promise.resolve(response({ invalid: true }));
    });
    const loopingResources = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      const endpoint = url.includes("endpoint-configs");
      const llm = url.includes("llm-configs");
      return Promise.resolve(
        response({
          items: url.includes("cursor=cycle")
            ? []
            : url.includes("test-suites")
              ? [
                  {
                    id: SUITE_ID,
                    name: "客服回归集",
                    description: "核心流程",
                    caseCount: 3,
                    revision: 1,
                    updatedAt: RUN_TIME,
                    latestRun: null
                  }
                ]
              : [
                  {
                    kind: endpoint ? "ENDPOINT" : llm ? "LLM" : "LLM",
                    id: endpoint ? ENDPOINT_ID : EVALUATOR_ID,
                    name: endpoint ? "客服 Endpoint" : "Gemini Evaluator",
                    revision: 0,
                    updatedAt: RUN_TIME
                  }
                ],
          nextCursor: "cycle"
        })
      );
    });
    render(
      <QueryClientProvider client={client()}>
        <RunListPage
          api={createRunApi(runFetcher)}
          resourceApi={createResourceApi(loopingResources)}
          onNavigate={vi.fn()}
          onCommittedNavigate={vi.fn()}
        />
      </QueryClientProvider>
    );

    expect(await screen.findByText("运行列表读取失败")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "重新读取" }));
    expect(await screen.findByRole("link", { name: "客服回归集" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "新建运行" }));
    expect(await screen.findByText("运行资源选项读取失败")).toBeInTheDocument();
  });

  it("Run 列表完成三页往返、内部导航、失败预检和失败创建", async () => {
    const resourceFetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      const secondPage = url.includes("cursor=resource-next");
      const endpoint = url.includes("endpoint-configs");
      return Promise.resolve(
        response({
          items: secondPage
            ? []
            : url.includes("test-suites")
              ? [
                  {
                    id: SUITE_ID,
                    name: "客服回归集",
                    description: "核心流程",
                    caseCount: 3,
                    revision: 1,
                    updatedAt: RUN_TIME,
                    latestRun: null
                  }
                ]
              : [
                  {
                    kind: endpoint ? "ENDPOINT" : "LLM",
                    id: endpoint ? ENDPOINT_ID : EVALUATOR_ID,
                    name: endpoint ? "客服 Endpoint" : "Gemini Evaluator",
                    revision: 0,
                    updatedAt: RUN_TIME
                  }
                ],
          nextCursor: secondPage ? null : "resource-next"
        })
      );
    });
    let preflightCalls = 0;
    const runFetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url.startsWith("/api/v1/runs?")) {
        const cursor = new URL(url, "http://local.test").searchParams.get("cursor");
        const page = runPage();
        if (cursor === null) {
          return Promise.resolve(
            response({
              ...page,
              items: [{ ...page.items[0], suiteName: "page-0" }],
              nextCursor: "run-1"
            })
          );
        }
        if (cursor === "run-1") {
          return Promise.resolve(
            response({
              ...page,
              items: [{ ...page.items[0], suiteName: "page-1" }],
              nextCursor: "run-2"
            })
          );
        }
        return Promise.resolve(response({ items: [], nextCursor: null }));
      }
      if (url.endsWith("/preflight")) {
        preflightCalls += 1;
        return Promise.resolve(
          preflightCalls === 1
            ? response({}, 422)
            : response({
                ...runPreflight,
                rubricPromptKeys: [],
                requiredEnvKeys: { REST: [], EVALUATION: [] }
              })
        );
      }
      if (url === "/api/v1/runs" && init?.method === "POST") {
        return Promise.resolve(response({}, 500));
      }
      return Promise.resolve(response({ invalid: true }));
    });
    const onNavigate = vi.fn();
    render(
      <QueryClientProvider client={client()}>
        <RunListPage
          api={createRunApi(runFetcher)}
          resourceApi={createResourceApi(resourceFetcher)}
          onNavigate={onNavigate}
          onCommittedNavigate={vi.fn()}
        />
      </QueryClientProvider>
    );

    expect(await screen.findByRole("link", { name: "page-0" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "A2UI 模板回归" })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: "page-0" }));
    expect(onNavigate).toHaveBeenCalledWith(`/runs/${RUN_ID}`);
    await userEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(await screen.findByRole("link", { name: "page-1" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(await screen.findByText("当前没有运行。")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "上一页" }));
    expect(await screen.findByRole("link", { name: "page-1" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "上一页" }));
    expect(await screen.findByRole("link", { name: "page-0" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "新建运行" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "测试集" }), SUITE_ID);
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Endpoint 配置" }),
      ENDPOINT_ID
    );
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Evaluator LLM" }),
      EVALUATOR_ID
    );
    expect(screen.getByRole("combobox", { name: "运行模式" })).toHaveValue("PIPELINE");
    await userEvent.click(screen.getByRole("button", { name: "运行前检查" }));
    expect(await screen.findByText("运行前检查失败")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "运行前检查" }));
    expect(await screen.findByLabelText("运行前检查事实")).toBeInTheDocument();
    expect(screen.getAllByText("无")).toHaveLength(3);

    const restConcurrency = screen.getByRole("spinbutton", { name: "REST 并发" });
    const evalConcurrency = screen.getByRole("spinbutton", { name: "Eval 并发" });
    const create = screen.getByRole("button", { name: "创建运行" });
    await userEvent.clear(restConcurrency);
    expect(create).toBeDisabled();
    await userEvent.type(restConcurrency, "4");
    await userEvent.clear(evalConcurrency);
    await userEvent.type(evalConcurrency, "17");
    expect(create).toBeDisabled();
    await userEvent.clear(evalConcurrency);
    await userEvent.type(evalConcurrency, "2");
    await userEvent.click(create);
    expect(await screen.findByText("运行创建失败")).toBeInTheDocument();
  });

  it("创建 pending 期间阻止关闭，并覆盖模式和 REST 并发上界", async () => {
    const createResponse = deferred<Response>();
    const resourceFetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const endpoint = requestUrl(input).includes("endpoint-configs");
      return Promise.resolve(
        response({
          items: requestUrl(input).includes("test-suites")
            ? [
                {
                  id: SUITE_ID,
                  name: "客服回归集",
                  description: "核心流程",
                  caseCount: 3,
                  revision: 1,
                  updatedAt: RUN_TIME,
                  latestRun: null
                }
              ]
            : [
                {
                  kind: endpoint ? "ENDPOINT" : "LLM",
                  id: endpoint ? ENDPOINT_ID : EVALUATOR_ID,
                  name: endpoint ? "客服 Endpoint" : "Gemini Evaluator",
                  revision: 0,
                  updatedAt: RUN_TIME
                }
              ],
          nextCursor: null
        })
      );
    });
    const runFetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url.startsWith("/api/v1/runs?")) return Promise.resolve(response(runPage()));
      if (url.endsWith("/preflight")) return Promise.resolve(response(runPreflight));
      if (url === "/api/v1/runs" && init?.method === "POST") return createResponse.promise;
      return Promise.resolve(response({ invalid: true }));
    });
    const onCommittedNavigate = vi.fn();
    render(
      <QueryClientProvider client={client()}>
        <RunListPage
          api={createRunApi(runFetcher)}
          resourceApi={createResourceApi(resourceFetcher)}
          onNavigate={vi.fn()}
          onCommittedNavigate={onCommittedNavigate}
        />
      </QueryClientProvider>
    );

    await userEvent.click(await screen.findByRole("button", { name: "新建运行" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "测试集" }), SUITE_ID);
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Endpoint 配置" }),
      ENDPOINT_ID
    );
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Evaluator LLM" }),
      EVALUATOR_ID
    );
    const mode = screen.getByRole("combobox", { name: "运行模式" });
    await userEvent.selectOptions(mode, "PIPELINE");
    await userEvent.selectOptions(mode, "STAGED");
    await userEvent.click(screen.getByRole("button", { name: "运行前检查" }));
    expect(await screen.findByLabelText("运行前检查事实")).toBeInTheDocument();
    const restConcurrency = screen.getByRole("spinbutton", { name: "REST 并发" });
    await userEvent.clear(restConcurrency);
    await userEvent.type(restConcurrency, "65");
    expect(screen.getByRole("button", { name: "创建运行" })).toBeDisabled();
    await userEvent.clear(restConcurrency);
    await userEvent.type(restConcurrency, "4");
    await userEvent.click(screen.getByRole("button", { name: "创建运行" }));
    expect(await screen.findByRole("button", { name: "正在创建" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.getByRole("heading", { name: "新建平台运行" })).toBeInTheDocument();

    act(() => createResponse.resolve(response(runDetail(), 201)));
    await waitFor(() => expect(onCommittedNavigate).toHaveBeenCalledWith(`/runs/${RUN_ID}`));
  });
});
