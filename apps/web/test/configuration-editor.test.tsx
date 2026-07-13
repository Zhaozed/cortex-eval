// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ConfigurationEditor } from "../src/features/configurations/configuration-editor.tsx";
import { requestBody, requestUrl } from "./request-fixture.ts";
import { createResourceApi } from "../src/lib/resource-api.ts";

const id = "018f0f4e-7b7a-7cc0-8000-000000000001";
const timestamp = "2026-07-13T00:00:00.000Z";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("四类配置编辑器", () => {
  it("Prompt 本地内容错误关联并聚焦真实消息控件", async () => {
    const fetcher = vi.fn<typeof fetch>();
    render(
      <ConfigurationEditor
        kind="LLM_RUBRIC_PROMPT"
        resource={null}
        api={createResourceApi(fetcher)}
        rubricReferences={[]}
        onSaved={vi.fn()}
      />
    );

    await userEvent.type(screen.getByRole("textbox", { name: "配置名称" }), "空提示词");
    await userEvent.type(screen.getByRole("textbox", { name: "Prompt Key" }), "empty.default");
    await userEvent.click(screen.getByRole("button", { name: "保存配置" }));

    const content = screen.getByRole("textbox", { name: "内容" });
    expect(await screen.findByText("表单不符合当前配置契约。")).toBeInTheDocument();
    expect(content).toHaveAttribute("aria-invalid", "true");
    expect(content).toHaveFocus();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("本地 Endpoint Header 与 LLM 认证契约错误可见并聚焦真实控件", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const endpointView = render(
      <ConfigurationEditor
        kind="ENDPOINT"
        resource={null}
        api={createResourceApi(fetcher)}
        rubricReferences={[]}
        onSaved={vi.fn()}
      />
    );
    await userEvent.type(screen.getByRole("textbox", { name: "配置名称" }), "不安全接口");
    await userEvent.type(screen.getByRole("textbox", { name: "URL 模板" }), "https://example.com");
    await userEvent.click(screen.getByRole("button", { name: "添加 Header" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Header 名称" }), "Authorization");
    await userEvent.click(screen.getByRole("combobox", { name: "Header 值类型" }));
    await userEvent.click(await screen.findByRole("option", { name: "LITERAL" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Literal 值" }), "secret");
    await userEvent.click(screen.getByRole("button", { name: "保存配置" }));

    expect(await screen.findByText("表单不符合当前配置契约。")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Header 名称" })).toHaveFocus();
    expect(fetcher).not.toHaveBeenCalled();
    endpointView.unmount();

    render(
      <ConfigurationEditor
        kind="LLM"
        resource={null}
        api={createResourceApi(fetcher)}
        rubricReferences={[]}
        onSaved={vi.fn()}
      />
    );
    await userEvent.type(screen.getByRole("textbox", { name: "配置名称" }), "远端模型");
    await userEvent.click(screen.getByRole("combobox", { name: "Provider 类型" }));
    await userEvent.click(await screen.findByRole("option", { name: "OPENAI_COMPATIBLE" }));
    await userEvent.type(screen.getByRole("textbox", { name: "模型" }), "remote-model");
    await userEvent.type(
      screen.getByRole("textbox", { name: "OpenAI-compatible Base URL" }),
      "https://llm.example.com/v1"
    );
    await userEvent.click(screen.getByRole("button", { name: "保存配置" }));

    expect(await screen.findByText("表单不符合当前配置契约。")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "认证模式" })).toHaveFocus();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("创建 Gemini LLM 前可独立验证，并只提交 Env Key", async () => {
    const onSaved = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
      const body = JSON.parse(requestBody(init)) as {
        readonly name: string;
        readonly definition: unknown;
      };
      if (requestUrl(_input).endsWith("/validate")) return Promise.resolve(response({ ok: true }));
      return Promise.resolve(
        response(
          {
            kind: "LLM",
            id,
            name: body.name,
            semanticHash: "a".repeat(64),
            revision: 0,
            createdAt: timestamp,
            updatedAt: timestamp,
            definition: body.definition
          },
          201
        )
      );
    });
    render(
      <ConfigurationEditor
        kind="LLM"
        resource={null}
        api={createResourceApi(fetcher)}
        rubricReferences={[]}
        onSaved={onSaved}
      />
    );

    await userEvent.type(screen.getByRole("textbox", { name: "配置名称" }), "Gemini 评估器");
    await userEvent.type(screen.getByRole("textbox", { name: "模型" }), "gemini-2.5-flash");
    await userEvent.type(
      screen.getByRole("textbox", { name: "Gemini API Key 环境变量" }),
      "GEMINI_API_KEY"
    );
    await userEvent.click(screen.getByRole("button", { name: "验证可用性" }));
    expect(await screen.findByText("验证通过，尚未保存。")).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    const createBody = requestBody(
      fetcher.mock.calls.find(([input]) => !requestUrl(input).endsWith("/validate"))?.[1]
    );
    expect(createBody).toContain('"envKey":"GEMINI_API_KEY"');
    expect(createBody).toContain('"structuredOutput":"JSON_OBJECT"');
    expect(createBody).not.toContain("api-key-secret-value");
  });

  it("OpenAI-compatible 分支显式提交结构输出和 Bearer Env 引用", async () => {
    const onSaved = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
      const body = JSON.parse(requestBody(init)) as {
        readonly name: string;
        readonly definition: unknown;
      };
      return Promise.resolve(
        response(
          {
            kind: "LLM",
            id,
            name: body.name,
            semanticHash: "b".repeat(64),
            revision: 0,
            createdAt: timestamp,
            updatedAt: timestamp,
            definition: body.definition
          },
          201
        )
      );
    });
    render(
      <ConfigurationEditor
        kind="LLM"
        resource={null}
        api={createResourceApi(fetcher)}
        rubricReferences={[]}
        onSaved={onSaved}
      />
    );

    await userEvent.click(screen.getByRole("combobox", { name: "Provider 类型" }));
    await userEvent.click(await screen.findByRole("option", { name: "OPENAI_COMPATIBLE" }));
    await userEvent.type(screen.getByRole("textbox", { name: "配置名称" }), "兼容模型");
    await userEvent.type(screen.getByRole("textbox", { name: "模型" }), "local-model");
    await userEvent.type(
      screen.getByRole("textbox", { name: "OpenAI-compatible Base URL" }),
      "https://llm.example.com/v1"
    );
    await userEvent.click(screen.getByRole("combobox", { name: "认证模式" }));
    await userEvent.click(await screen.findByRole("option", { name: "BEARER_ENV" }));
    await userEvent.type(
      screen.getByRole("textbox", { name: "Bearer Token 环境变量" }),
      "LLM_TOKEN"
    );
    await userEvent.click(screen.getByRole("combobox", { name: "结构输出" }));
    await userEvent.click(await screen.findByRole("option", { name: "JSON_SCHEMA" }));
    await userEvent.click(screen.getByRole("button", { name: "保存配置" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    const body = requestBody(fetcher.mock.calls[0]?.[1]);
    expect(body).toContain('"providerType":"OPENAI_COMPATIBLE"');
    expect(body).toContain('"structuredOutput":"JSON_SCHEMA"');
    expect(body).toContain('"envKey":"LLM_TOKEN"');
    expect(body).not.toContain("geminiApiKeyEnv");
  });

  it("Endpoint 可编辑动态 Secret Header，探测失败不阻止后续显式保存", async () => {
    const onSaved = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url.endsWith("/validate")) {
        return Promise.resolve(
          response(
            {
              error: {
                code: "CONFIGURATION_PROBE_FAILED",
                message: "配置探测失败",
                requestId: id,
                reason: "UNAVAILABLE"
              }
            },
            502
          )
        );
      }
      const body = JSON.parse(requestBody(init)) as {
        readonly name: string;
        readonly definition: unknown;
      };
      return Promise.resolve(
        response(
          {
            kind: "ENDPOINT",
            id,
            name: body.name,
            semanticHash: "c".repeat(64),
            revision: 0,
            createdAt: timestamp,
            updatedAt: timestamp,
            definition: body.definition
          },
          201
        )
      );
    });
    render(
      <ConfigurationEditor
        kind="ENDPOINT"
        resource={null}
        api={createResourceApi(fetcher)}
        rubricReferences={[]}
        onSaved={onSaved}
      />
    );

    await userEvent.type(screen.getByRole("textbox", { name: "配置名称" }), "客服接口");
    await userEvent.type(screen.getByRole("textbox", { name: "URL 模板" }), "https://example.com");
    await userEvent.click(screen.getByRole("button", { name: "添加 Header" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Header 名称" }), "authorization");
    await userEvent.type(
      screen.getByRole("textbox", { name: "Secret 环境变量名" }),
      "ENDPOINT_TOKEN"
    );
    await userEvent.click(screen.getByRole("button", { name: "验证可用性" }));
    expect(await screen.findByText("可用性验证失败，配置尚未保存。")).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    const body = requestBody(fetcher.mock.calls.at(-1)?.[1]);
    expect(body).toContain('"envKey":"ENDPOINT_TOKEN"');
    expect(body).toContain('"timeoutMs":60000');
  });

  it("Endpoint 探测字段错误关联并聚焦对应表单控件", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response(
        {
          error: {
            code: "ENDPOINT_CONFIG_INVALID",
            message: "Endpoint 配置无效",
            requestId: id,
            path: "definition.urlTemplate"
          }
        },
        422
      )
    );
    render(
      <ConfigurationEditor
        kind="ENDPOINT"
        resource={null}
        api={createResourceApi(fetcher)}
        rubricReferences={[]}
        onSaved={vi.fn()}
      />
    );
    await userEvent.type(screen.getByRole("textbox", { name: "配置名称" }), "客服接口");
    await userEvent.type(screen.getByRole("textbox", { name: "URL 模板" }), "https://example.com");
    await userEvent.click(screen.getByRole("button", { name: "验证可用性" }));

    expect(await screen.findByText("服务端校验失败：definition.urlTemplate")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "URL 模板" })).toHaveAttribute(
      "aria-invalid",
      "true"
    );
    expect(screen.getByRole("textbox", { name: "URL 模板" })).toHaveFocus();
  });

  it("Analysis Prompt 可增删消息、预览实际变量并显式创建", async () => {
    const onSaved = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url.endsWith("/preview")) {
        return Promise.resolve(response({ variables: ["case_definition", "provider_output"] }));
      }
      const body = JSON.parse(requestBody(init)) as {
        readonly name: string;
        readonly definition: unknown;
      };
      return Promise.resolve(
        response(
          {
            kind: "CASE_ANALYSIS_PROMPT",
            id,
            name: body.name,
            semanticHash: "d".repeat(64),
            revision: 0,
            createdAt: timestamp,
            updatedAt: timestamp,
            definition: body.definition
          },
          201
        )
      );
    });
    render(
      <ConfigurationEditor
        kind="CASE_ANALYSIS_PROMPT"
        resource={null}
        api={createResourceApi(fetcher)}
        rubricReferences={[]}
        onSaved={onSaved}
      />
    );

    const allowedVariables = [
      "case_definition",
      "provider_output",
      "failed_assertions",
      "expected_actual_diffs",
      "llm_rubric_results",
      "run_context"
    ];
    expect(screen.getByRole("heading", { name: "允许变量" })).toBeInTheDocument();
    for (const variable of allowedVariables) {
      expect(screen.getByText(variable)).toBeInTheDocument();
    }

    await userEvent.type(screen.getByRole("textbox", { name: "配置名称" }), "失败分析");
    await userEvent.type(screen.getByRole("textbox", { name: "Prompt Key" }), "analysis.default");
    await userEvent.type(screen.getByRole("textbox", { name: "内容" }), "{{case_definition}}");
    await userEvent.click(screen.getByRole("button", { name: "添加消息" }));
    const contents = screen.getAllByRole("textbox", { name: "内容" });
    await userEvent.type(contents[1] as HTMLElement, "{{provider_output}}");
    await userEvent.click(screen.getByRole("button", { name: "删除消息 2" }));
    await userEvent.click(screen.getByRole("button", { name: "预览变量引用" }));

    const preview = (await screen.findByRole("heading", { name: "服务端预览" })).parentElement;
    expect(preview).not.toBeNull();
    if (preview === null) return;
    expect(within(preview).getByText("case_definition")).toBeInTheDocument();
    expect(within(preview).getByText("provider_output")).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  });

  it("Analysis Prompt 非法变量错误关联并聚焦消息内容", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response(
        {
          error: {
            code: "ANALYSIS_PROMPT_INVALID",
            message: "分析提示词无效",
            requestId: id,
            path: "messages.variables"
          }
        },
        422
      )
    );
    render(
      <ConfigurationEditor
        kind="CASE_ANALYSIS_PROMPT"
        resource={null}
        api={createResourceApi(fetcher)}
        rubricReferences={[]}
        onSaved={vi.fn()}
      />
    );
    await userEvent.type(screen.getByRole("textbox", { name: "配置名称" }), "失败分析");
    await userEvent.type(screen.getByRole("textbox", { name: "Prompt Key" }), "analysis.default");
    await userEvent.type(screen.getByRole("textbox", { name: "内容" }), "{{unknown_variable}}");
    await userEvent.click(screen.getByRole("button", { name: "预览变量引用" }));

    expect(await screen.findByText("服务端校验失败：messages.variables")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "内容" })).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("textbox", { name: "内容" })).toHaveFocus();
  });

  it("LLM 保存冲突可放弃本地 Draft 并采用最新服务端表单", async () => {
    const initial = {
      kind: "LLM",
      id,
      name: "原模型",
      semanticHash: "e".repeat(64),
      revision: 2,
      createdAt: timestamp,
      updatedAt: timestamp,
      definition: {
        contractVersion: "cortex.llm-config.v1",
        providerType: "GOOGLE_GEMINI",
        model: "gemini-old",
        thinkingLevel: "OFF",
        temperature: 0,
        topP: 1,
        maxOutputTokens: 2048,
        timeoutMs: 60_000,
        structuredOutput: "JSON_SCHEMA",
        apiKey: { kind: "ENV_SECRET", envKey: "GEMINI_API_KEY" }
      }
    } as const;
    const remote = {
      ...initial,
      name: "远端模型",
      revision: 3,
      definition: { ...initial.definition, model: "gemini-remote" }
    } as const;
    let updates = 0;
    const onSaved = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
      if (init?.method === "PUT") {
        updates += 1;
        if (updates > 1) return Promise.resolve(response({ ...remote, revision: 4 }));
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
      return Promise.resolve(response(remote));
    });
    render(
      <ConfigurationEditor
        kind="LLM"
        resource={initial}
        api={createResourceApi(fetcher)}
        rubricReferences={[]}
        onSaved={onSaved}
      />
    );

    await userEvent.clear(screen.getByRole("textbox", { name: "配置名称" }));
    await userEvent.type(screen.getByRole("textbox", { name: "配置名称" }), "本地模型");
    await userEvent.click(screen.getByRole("button", { name: "保存配置" }));
    expect(await screen.findByText("服务端版本：远端模型")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "放弃 Draft，采用服务端版本" }));

    expect(screen.getByRole("textbox", { name: "配置名称" })).toHaveValue("远端模型");
    expect(screen.getByRole("textbox", { name: "模型" })).toHaveValue("gemini-remote");
    await userEvent.clear(screen.getByRole("textbox", { name: "配置名称" }));
    await userEvent.type(screen.getByRole("textbox", { name: "配置名称" }), "采用后模型");
    await userEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(
      requestBody(fetcher.mock.calls.filter(([, init]) => init?.method === "PUT").at(-1)?.[1])
    ).toContain('"expectedRevision":3');
  });

  it("LLM 连续保存冲突时每次刷新 Snapshot 并使用最新 Revision 重试", async () => {
    const initial = {
      kind: "LLM",
      id,
      name: "原模型",
      semanticHash: "e".repeat(64),
      revision: 2,
      createdAt: timestamp,
      updatedAt: timestamp,
      definition: {
        contractVersion: "cortex.llm-config.v1",
        providerType: "GOOGLE_GEMINI",
        model: "gemini-old",
        thinkingLevel: "OFF",
        temperature: 0,
        topP: 1,
        maxOutputTokens: 2048,
        timeoutMs: 60_000,
        structuredOutput: "JSON_SCHEMA",
        apiKey: { kind: "ENV_SECRET", envKey: "GEMINI_API_KEY" }
      }
    } as const;
    const firstRemote = { ...initial, name: "第一次远端模型", revision: 3 } as const;
    const secondRemote = { ...initial, name: "第二次远端模型", revision: 4 } as const;
    let updates = 0;
    let reads = 0;
    const onSaved = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
      if (init?.method === "PUT") {
        updates += 1;
        if (updates <= 2) {
          return Promise.resolve(
            response(
              {
                error: {
                  code: "RESOURCE_REVISION_CONFLICT",
                  message: "资源版本发生冲突",
                  requestId: id,
                  expectedRevision: updates === 1 ? 2 : 3,
                  actualRevision: updates === 1 ? 3 : 4
                }
              },
              409
            )
          );
        }
        return Promise.resolve(response({ ...secondRemote, name: "本地模型", revision: 5 }));
      }
      reads += 1;
      return Promise.resolve(response(reads === 1 ? firstRemote : secondRemote));
    });
    render(
      <ConfigurationEditor
        kind="LLM"
        resource={initial}
        api={createResourceApi(fetcher)}
        rubricReferences={[]}
        onSaved={onSaved}
      />
    );

    await userEvent.clear(screen.getByRole("textbox", { name: "配置名称" }));
    await userEvent.type(screen.getByRole("textbox", { name: "配置名称" }), "本地模型");
    await userEvent.click(screen.getByRole("button", { name: "保存配置" }));
    expect(await screen.findByText("服务端版本：第一次远端模型")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "验证可用性" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "保存配置" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "使用最新 Revision 重试" }));
    expect(await screen.findByText("服务端版本：第二次远端模型")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "使用最新 Revision 重试" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(
      requestBody(fetcher.mock.calls.filter(([, init]) => init?.method === "PUT").at(-1)?.[1])
    ).toContain('"expectedRevision":4');
  });

  it("配置冲突重试在途保留决策并禁用所有竞争动作", async () => {
    const initial = {
      kind: "LLM" as const,
      id,
      name: "原模型",
      semanticHash: "e".repeat(64),
      revision: 2,
      createdAt: timestamp,
      updatedAt: timestamp,
      definition: {
        contractVersion: "cortex.llm-config.v1" as const,
        providerType: "GOOGLE_GEMINI" as const,
        model: "gemini-old",
        thinkingLevel: "OFF" as const,
        temperature: 0,
        topP: 1,
        maxOutputTokens: 2048,
        timeoutMs: 60_000,
        structuredOutput: "JSON_OBJECT" as const,
        apiKey: { kind: "ENV_SECRET" as const, envKey: "GEMINI_API_KEY" }
      }
    };
    const remote = { ...initial, name: "远端模型", revision: 3 };
    let updates = 0;
    let resolveRetry: ((response: Response) => void) | undefined;
    const retry = new Promise<Response>((resolve) => {
      resolveRetry = resolve;
    });
    const onSaved = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
      if (init?.method === "PUT") {
        updates += 1;
        if (updates === 2) return retry;
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
      return Promise.resolve(response(remote));
    });
    render(
      <ConfigurationEditor
        kind="LLM"
        resource={initial}
        api={createResourceApi(fetcher)}
        rubricReferences={[]}
        onSaved={onSaved}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await userEvent.click(await screen.findByRole("button", { name: "使用最新 Revision 重试" }));

    expect(screen.getByRole("heading", { name: "发现并发修改" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "使用最新 Revision 重试" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "放弃 Draft，采用服务端版本" })).toBeDisabled();
    act(() => resolveRetry?.(response({ ...remote, revision: 4 })));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  });

  it("Rubric Prompt 使用冲突定位 Prompt Key 并保留服务端键值", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response(
        {
          error: {
            code: "RUBRIC_PROMPT_IN_USE",
            message: "Prompt Key 正在被 Case 引用",
            requestId: id,
            promptKey: "quality.default"
          }
        },
        409
      )
    );
    render(
      <ConfigurationEditor
        kind="LLM_RUBRIC_PROMPT"
        resource={null}
        api={createResourceApi(fetcher)}
        rubricReferences={[]}
        onSaved={vi.fn()}
      />
    );

    await userEvent.type(screen.getByRole("textbox", { name: "配置名称" }), "质量提示词");
    await userEvent.type(screen.getByRole("textbox", { name: "Prompt Key" }), "quality.default");
    await userEvent.type(screen.getByRole("textbox", { name: "内容" }), "检查质量");
    await userEvent.click(screen.getByRole("button", { name: "保存配置" }));

    const promptKey = screen.getByRole("textbox", { name: "Prompt Key" });
    expect(await screen.findByText("服务端校验失败：promptKey")).toBeInTheDocument();
    expect(promptKey).toHaveAttribute("aria-invalid", "true");
    expect(promptKey).toHaveFocus();
  });

  it("Prompt 采用服务端 Snapshot 后使用其 Revision 继续保存", async () => {
    const initial = {
      kind: "CASE_ANALYSIS_PROMPT" as const,
      id,
      name: "原分析提示词",
      semanticHash: "f".repeat(64),
      revision: 2,
      createdAt: timestamp,
      updatedAt: timestamp,
      definition: {
        contractVersion: "cortex.prompt.v1" as const,
        kind: "CASE_ANALYSIS" as const,
        promptKey: "analysis.default",
        messages: [{ role: "SYSTEM" as const, content: "分析 {{case_definition}}" }]
      }
    };
    const remote = { ...initial, name: "远端分析提示词", revision: 3 };
    let updates = 0;
    const onSaved = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
      if (init?.method === "PUT") {
        updates += 1;
        if (updates > 1) return Promise.resolve(response({ ...remote, revision: 4 }));
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
      return Promise.resolve(response(remote));
    });
    render(
      <ConfigurationEditor
        kind="CASE_ANALYSIS_PROMPT"
        resource={initial}
        api={createResourceApi(fetcher)}
        rubricReferences={[]}
        onSaved={onSaved}
      />
    );

    await userEvent.clear(screen.getByRole("textbox", { name: "配置名称" }));
    await userEvent.type(screen.getByRole("textbox", { name: "配置名称" }), "本地分析提示词");
    await userEvent.click(screen.getByRole("button", { name: "保存配置" }));
    expect(await screen.findByText("服务端版本：远端分析提示词")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "放弃 Draft，采用服务端版本" }));
    await userEvent.clear(screen.getByRole("textbox", { name: "配置名称" }));
    await userEvent.type(screen.getByRole("textbox", { name: "配置名称" }), "采用后分析提示词");
    await userEvent.click(screen.getByRole("button", { name: "保存配置" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(
      requestBody(fetcher.mock.calls.filter(([, init]) => init?.method === "PUT").at(-1)?.[1])
    ).toContain('"expectedRevision":3');
  });

  it("Prompt 保存使用单飞门禁并在请求完成前禁用重复提交", async () => {
    let resolveSave: ((response: Response) => void) | undefined;
    const pendingSave = new Promise<Response>((resolve) => {
      resolveSave = resolve;
    });
    const onSaved = vi.fn();
    const resource = {
      kind: "CASE_ANALYSIS_PROMPT",
      id,
      name: "失败分析",
      semanticHash: "f".repeat(64),
      revision: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      definition: {
        contractVersion: "cortex.prompt.v1",
        kind: "CASE_ANALYSIS",
        promptKey: "analysis.default",
        messages: [{ role: "SYSTEM", content: "{{case_definition}}" }]
      }
    } as const;
    const fetcher = vi.fn<typeof fetch>().mockReturnValue(pendingSave);
    render(
      <ConfigurationEditor
        kind="CASE_ANALYSIS_PROMPT"
        resource={null}
        api={createResourceApi(fetcher)}
        rubricReferences={[]}
        onSaved={onSaved}
      />
    );
    await userEvent.type(screen.getByRole("textbox", { name: "配置名称" }), resource.name);
    await userEvent.type(screen.getByRole("textbox", { name: "Prompt Key" }), "analysis.default");
    await userEvent.type(screen.getByRole("textbox", { name: "内容" }), "{{case_definition}}");
    const save = screen.getByRole("button", { name: "保存配置" });
    fireEvent.click(save);
    fireEvent.click(save);

    expect(fetcher).toHaveBeenCalledOnce();
    expect(save).toBeDisabled();
    resolveSave?.(response(resource, 201));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  });

  it("空 Endpoint 在探测和保存时都定位本地表单错误", async () => {
    const fetcher = vi.fn<typeof fetch>();
    render(
      <ConfigurationEditor
        kind="ENDPOINT"
        resource={null}
        api={createResourceApi(fetcher)}
        rubricReferences={[]}
        onSaved={vi.fn()}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "验证可用性" }));
    expect(await screen.findByText("表单不符合当前配置契约。")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "保存配置" }));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("Endpoint 服务端字段冲突回填并聚焦对应表单控件", async () => {
    const requestId = "018f0f4e-7b7a-7cc0-8000-000000000098";
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response(
        {
          error: {
            code: "RESOURCE_UNIQUE_CONFLICT",
            message: "Endpoint 名称重复",
            requestId,
            field: "name"
          }
        },
        409
      )
    );
    render(
      <ConfigurationEditor
        kind="ENDPOINT"
        resource={null}
        api={createResourceApi(fetcher)}
        rubricReferences={[]}
        onSaved={vi.fn()}
      />
    );

    await userEvent.type(screen.getByRole("textbox", { name: "配置名称" }), "重复接口");
    await userEvent.type(
      screen.getByRole("textbox", { name: "URL 模板" }),
      "https://duplicate.example.com"
    );
    await userEvent.click(screen.getByRole("button", { name: "保存配置" }));

    expect(await screen.findByText("服务端校验失败：name")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "配置名称" })).toHaveAttribute(
      "aria-invalid",
      "true"
    );
  });

  it("空 LLM 在验证和保存时都停留在本地契约边界", async () => {
    const fetcher = vi.fn<typeof fetch>();
    render(
      <ConfigurationEditor
        kind="LLM"
        resource={null}
        api={createResourceApi(fetcher)}
        rubricReferences={[]}
        onSaved={vi.fn()}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "验证可用性" }));
    expect(await screen.findByText("表单不符合当前配置契约。")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "保存配置" }));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("LLM 服务端名称冲突回填对应表单控件", async () => {
    const requestId = "018f0f4e-7b7a-7cc0-8000-000000000097";
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response(
        {
          error: {
            code: "RESOURCE_UNIQUE_CONFLICT",
            message: "LLM 名称重复",
            requestId,
            field: "name"
          }
        },
        409
      )
    );
    render(
      <ConfigurationEditor
        kind="LLM"
        resource={null}
        api={createResourceApi(fetcher)}
        rubricReferences={[]}
        onSaved={vi.fn()}
      />
    );

    await userEvent.type(screen.getByRole("textbox", { name: "配置名称" }), "重复模型");
    await userEvent.type(screen.getByRole("textbox", { name: "模型" }), "gemini-test");
    await userEvent.type(
      screen.getByRole("textbox", { name: "Gemini API Key 环境变量" }),
      "GEMINI_API_KEY"
    );
    await userEvent.click(screen.getByRole("button", { name: "保存配置" }));

    expect(await screen.findByText("服务端校验失败：name")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "配置名称" })).toHaveAttribute(
      "aria-invalid",
      "true"
    );
  });

  it("Prompt 本地无效不请求服务端，预览失败与唯一冲突分别显示", async () => {
    const requestId = "018f0f4e-7b7a-7cc0-8000-000000000099";
    let saveAttempts = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const preview = requestUrl(input).endsWith("/preview");
      if (!preview) saveAttempts += 1;
      return Promise.resolve(
        response(
          preview
            ? { error: { code: "INTERNAL_ERROR", message: "内部错误", requestId } }
            : saveAttempts > 1
              ? {
                  error: {
                    code: "PROMPT_INVALID",
                    message: "未知 Prompt 字段无效",
                    requestId,
                    path: "definition.unknown"
                  }
                }
              : {
                  error: {
                    code: "RESOURCE_UNIQUE_CONFLICT",
                    message: "Prompt Key 重复",
                    requestId,
                    field: "promptKey"
                  }
                },
          preview ? 500 : 409
        )
      );
    });
    render(
      <ConfigurationEditor
        kind="LLM_RUBRIC_PROMPT"
        resource={null}
        api={createResourceApi(fetcher)}
        rubricReferences={[]}
        onSaved={vi.fn()}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "预览消息" }));
    expect(await screen.findByText("表单不符合当前配置契约。")).toBeInTheDocument();
    expect(fetcher).not.toHaveBeenCalled();
    await userEvent.type(screen.getByRole("textbox", { name: "配置名称" }), "质量评估");
    await userEvent.type(screen.getByRole("textbox", { name: "Prompt Key" }), "quality.default");
    await userEvent.type(screen.getByRole("textbox", { name: "内容" }), "检查质量");
    await userEvent.click(screen.getByRole("button", { name: "预览消息" }));
    expect(await screen.findByText("预览失败，内容尚未保存。")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "保存配置" }));
    expect(await screen.findByText("服务端校验失败：promptKey")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Prompt Key" })).toHaveAttribute(
      "aria-invalid",
      "true"
    );
    await userEvent.click(screen.getByRole("button", { name: "保存配置" }));
    expect(await screen.findByText("配置保存失败，Draft 已保留。")).toBeInTheDocument();
  });
});
