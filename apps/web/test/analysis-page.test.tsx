// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AnalysisPage } from "../src/features/analysis/analysis-page.tsx";
import { createResourceApi } from "../src/lib/resource-api.ts";
import { createRunApi, type CurrentCaseAnalysis } from "../src/lib/run-api.ts";
import { requestBody, requestUrl } from "./request-fixture.ts";
import {
  RUN_ID,
  RUN_TIME,
  SUITE_ID,
  runReportCase,
  runReportOverview
} from "./run-test-fixture.ts";

const HASH = "a".repeat(64);
const ANALYSIS_ID = "018f0f4e-7b7a-7cc0-8000-000000000010";
const ANALYZER_ID = "018f0f4e-7b7a-7cc0-8000-000000000011";
const PROMPT_ID = "018f0f4e-7b7a-7cc0-8000-000000000012";
const CASE_ID = "018f0f4e-7b7a-7cc0-8000-000000000013";
const LATER_ANALYZER_ID = "018f0f4e-7b7a-7cc0-8000-000000000014";
const LATER_PROMPT_ID = "018f0f4e-7b7a-7cc0-8000-000000000015";
const REANALYSIS_ID = "018f0f4e-7b7a-7cc0-8000-000000000016";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function errorResponse(code: string, status: number): Response {
  return response(
    {
      error: {
        code,
        message: "请求失败。",
        requestId: "018f0f4e-7b7a-7cc0-8000-000000000099"
      }
    },
    status
  );
}

const failedCase = {
  ...runReportCase,
  evaluation: {
    ...runReportCase.evaluation,
    status: "FAIL" as const,
    promptfooSuccess: false,
    score: 0,
    reason: "quality 断言失败",
    assertions: [
      {
        ...runReportCase.evaluation.assertions[0],
        status: "FAIL" as const,
        score: 0,
        reason: "quality 断言失败"
      }
    ],
    metrics: [{ metric: "quality", status: "FAIL" as const }]
  }
};

const proposal = {
  action: "ADD_ASSERTION" as const,
  baseDefinitionHash: HASH,
  targetAssertionIndex: 1,
  assertion: { type: "equals", metric: "quality", weight: 1, value: "accepted" }
};

function currentAnalysis(
  decision: "PENDING" | "ACCEPTED" | "REJECTED" = "PENDING"
): CurrentCaseAnalysis {
  return {
    contractVersion: "cortex.current-case-analysis.v1" as const,
    id: ANALYSIS_ID,
    runId: RUN_ID,
    caseKey: "case-1",
    finalCaseResultHash: HASH,
    revision: decision === "PENDING" ? 3 : 4,
    prompt: { sourceId: PROMPT_ID, promptKey: "analysis", promptHash: HASH },
    analyzer: {
      sourceId: ANALYZER_ID,
      configHash: HASH,
      provider: "GOOGLE_GEMINI" as const,
      model: "gemini-test"
    },
    analysisInputHash: HASH,
    analysisExecutionLimits: {
      contractVersion: "cortex.analysis-execution-limits.v1" as const,
      analysisConcurrency: 2
    },
    status: "SUCCEEDED" as const,
    output: {
      contractVersion: "cortex.analysis-output.v1" as const,
      classification: "LABEL_ERROR" as const,
      confidence: 0.87,
      evidence: [
        {
          source: "case_definition" as const,
          fieldPath: "/assert/0/value",
          conclusion: "冻结期望值与业务事实不一致"
        },
        {
          source: "failed_assertions" as const,
          fieldPath: null,
          conclusion: "quality 断言失败"
        }
      ],
      explanation: "当前 Case 标注需要修正",
      recommendedAction: "增加一个合法结果断言",
      proposal
    },
    analysisResultHash: HASH,
    decision,
    applyStatus: decision === "ACCEPTED" ? ("APPLIED" as const) : ("NOT_APPLIED" as const),
    baseDefinitionHash: HASH,
    appliedDefinitionHash: decision === "ACCEPTED" ? HASH : null,
    errorCode: null,
    errorMessage: null,
    createdAt: RUN_TIME,
    updatedAt: RUN_TIME
  };
}

const suite = {
  id: SUITE_ID,
  name: "客服回归集",
  description: "当前 Suite",
  caseCount: 1,
  suiteHash: HASH,
  revision: 2,
  createdAt: RUN_TIME,
  updatedAt: RUN_TIME
};

const currentCase = {
  id: CASE_ID,
  suiteId: SUITE_ID,
  caseKey: "case-1",
  ordinal: 0,
  description: failedCase.definition.description,
  businessModule: failedCase.definition.metadata.business_module,
  scenarioTag: failedCase.definition.metadata.scenario_tag,
  assertionTypes: ["equals"],
  metrics: ["quality"],
  revision: 5,
  updatedAt: RUN_TIME,
  definition: failedCase.definition,
  definitionHash: HASH,
  rubricPromptKeys: [],
  createdAt: RUN_TIME
};

function baseFetcher(): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>().mockImplementation((input) => {
    const url = requestUrl(input);
    if (url === `/api/v1/runs/${RUN_ID}/report`) {
      return Promise.resolve(response({ ...runReportOverview, sourceType: "PLATFORM" }));
    }
    if (url.includes(`/api/v1/runs/${RUN_ID}/report/cases?`)) {
      return Promise.resolve(response({ items: [failedCase], nextCursor: null }));
    }
    if (url === "/api/v1/llm-configs?limit=100") {
      return Promise.resolve(
        response({
          items: [
            {
              kind: "LLM",
              id: ANALYZER_ID,
              name: "Gemini Analyzer",
              revision: 0,
              updatedAt: RUN_TIME
            }
          ],
          nextCursor: null
        })
      );
    }
    if (url === "/api/v1/case-analysis-prompts?limit=100") {
      return Promise.resolve(
        response({
          items: [
            {
              kind: "CASE_ANALYSIS_PROMPT",
              id: PROMPT_ID,
              name: "Failure Analysis",
              revision: 0,
              updatedAt: RUN_TIME
            }
          ],
          nextCursor: null
        })
      );
    }
    if (url === `/api/v1/runs/${RUN_ID}/analyses`) {
      return Promise.resolve(
        response({
          contractVersion: "cortex.case-analysis-start-result.v1",
          runId: RUN_ID,
          selector: "failed",
          selectedCount: 1,
          succeededCount: 1,
          errorCount: 0,
          finalCaseResultSetHash: HASH
        })
      );
    }
    if (url === `/api/v1/runs/${RUN_ID}/analyses/case-1`) {
      return Promise.resolve(response(currentAnalysis()));
    }
    if (url === `/api/v1/test-suites/${SUITE_ID}`) return Promise.resolve(response(suite));
    if (url === `/api/v1/test-suites/${SUITE_ID}/cases/case-1`) {
      return Promise.resolve(response(currentCase));
    }
    return Promise.resolve(response({ invalid: true }));
  });
}

function renderPage(
  fetcher: typeof fetch,
  onNavigate: (path: string) => void = vi.fn()
): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  render(
    <QueryClientProvider client={client}>
      <AnalysisPage
        api={createRunApi(fetcher)}
        resourceApi={createResourceApi(fetcher)}
        runId={RUN_ID}
        onNavigate={onNavigate}
      />
    </QueryClientProvider>
  );
  return client;
}

describe("Analysis 页面", () => {
  it("冻结显式参数发起分析，并按来源、路径、结论展示结构化 Evidence", async () => {
    const fetcher = baseFetcher();
    renderPage(fetcher);

    expect(
      await screen.findByRole("heading", { name: "Case Analysis 工作台" })
    ).toBeInTheDocument();
    expect(await screen.findByText("Gemini Analyzer")).toBeInTheDocument();
    expect(screen.getByText("Failure Analysis")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "开始分析" }));
    await waitFor(() =>
      expect(fetcher.mock.calls.map(([input]) => requestUrl(input))).toContain(
        `/api/v1/runs/${RUN_ID}/analyses`
      )
    );
    expect(await screen.findByText("已选择 1 个 Case，成功 1 个，错误 0 个。")).toBeInTheDocument();
    expect(
      requestBody(
        fetcher.mock.calls.find(([input]) => requestUrl(input).endsWith("/analyses"))?.[1]
      )
    ).toContain('"analysisConcurrency":1');

    await userEvent.click(await screen.findByRole("button", { name: "查看分析 case-1" }));
    expect(await screen.findByText("冻结期望值与业务事实不一致")).toBeInTheDocument();
    expect(screen.getByText("case_definition")).toBeInTheDocument();
    expect(screen.getByText("/assert/0/value")).toBeInTheDocument();
    expect(screen.getByText("failed_assertions")).toBeInTheDocument();
    expect(screen.getByText("整个来源")).toBeInTheDocument();
    expect(screen.getByText("87% · 模型自评")).toBeInTheDocument();
    expect(screen.getByText("ADD_ASSERTION")).toBeInTheDocument();
  });

  it("接受 Proposal 时提交 Analysis 与当前 Suite/Case 的全部可见版本身份", async () => {
    const original = baseFetcher();
    const originalImplementation = original.getMockImplementation();
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url.endsWith("/accept")) return Promise.resolve(response(currentAnalysis("ACCEPTED")));
      return originalImplementation === undefined
        ? Promise.resolve(response({ invalid: true }))
        : originalImplementation(input, init);
    });
    renderPage(fetcher);
    await userEvent.click(await screen.findByRole("button", { name: "查看分析 case-1" }));
    await userEvent.click(await screen.findByRole("button", { name: "接受 Proposal" }));
    expect(await screen.findByText("Proposal 已应用")).toBeInTheDocument();
    const call = fetcher.mock.calls.find(([input]) => requestUrl(input).endsWith("/accept"));
    expect(requestBody(call?.[1])).toBe(
      JSON.stringify({
        analysisId: ANALYSIS_ID,
        expectedAnalysisRevision: 3,
        expectedFinalCaseResultHash: HASH,
        expectedAnalysisInputHash: HASH,
        expectedPromptHash: HASH,
        expectedAnalyzerConfigHash: HASH,
        suiteId: SUITE_ID,
        expectedSuiteRevision: 2,
        expectedCaseId: CASE_ID,
        expectedCaseRevision: 5
      })
    );
  });

  it("编辑后接受先严格验证 Proposal JSON；冲突时保留用户编辑内容", async () => {
    const original = baseFetcher();
    let analysisReads = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url === `/api/v1/runs/${RUN_ID}/analyses/case-1`) {
        analysisReads += 1;
        return Promise.resolve(
          response(
            analysisReads === 1
              ? currentAnalysis()
              : {
                  ...currentAnalysis(),
                  id: REANALYSIS_ID
                }
          )
        );
      }
      if (url.endsWith("/edit-and-accept")) {
        return Promise.resolve(
          response(
            {
              error: {
                code: "ANALYSIS_APPLY_CONFLICT",
                message: "Proposal 应用冲突。",
                requestId: "018f0f4e-7b7a-7cc0-8000-000000000099",
                reason: "CASE_REVISION_CONFLICT"
              }
            },
            409
          )
        );
      }
      const implementation = original.getMockImplementation();
      return implementation === undefined
        ? Promise.resolve(response({ invalid: true }))
        : implementation(input, init);
    });
    renderPage(fetcher);
    await userEvent.click(await screen.findByRole("button", { name: "查看分析 case-1" }));
    const editor = await screen.findByLabelText("编辑 Proposal JSON");
    await userEvent.clear(editor);
    await userEvent.type(editor, "not-json");
    await userEvent.click(screen.getByRole("button", { name: "编辑后接受" }));
    expect(await screen.findByText("Proposal JSON 不符合契约。")).toBeInTheDocument();
    expect(
      fetcher.mock.calls.some(([input]) => requestUrl(input).endsWith("/edit-and-accept"))
    ).toBe(false);

    fireEvent.change(editor, { target: { value: "{}" } });
    await userEvent.click(screen.getByRole("button", { name: "编辑后接受" }));
    expect(await screen.findByText("Proposal JSON 不符合契约。")).toBeInTheDocument();
    expect(
      fetcher.mock.calls.some(([input]) => requestUrl(input).endsWith("/edit-and-accept"))
    ).toBe(false);

    const edited = JSON.stringify({ ...proposal, targetAssertionIndex: 2 }, null, 2);
    await userEvent.clear(editor);
    fireEvent.change(editor, { target: { value: edited } });
    await userEvent.click(screen.getByRole("button", { name: "编辑后接受" }));
    expect(await screen.findByText("Proposal 应用冲突，编辑内容已保留。")).toBeInTheDocument();
    expect(await screen.findByText("r3")).toBeInTheDocument();
    expect(screen.getByText("NOT_APPLIED")).toBeInTheDocument();
    expect(screen.getByText("PENDING")).toBeInTheDocument();
    const currentProposalEditor = screen.getByLabelText("编辑 Proposal JSON");
    expect(JSON.parse((currentProposalEditor as HTMLTextAreaElement).value)).toEqual(proposal);
    expect(currentProposalEditor).toBeEnabled();
    expect(screen.getByLabelText("冲突前保留的 Proposal Draft")).toHaveValue(edited);
    expect(screen.getByLabelText("冲突前保留的 Proposal Draft")).toBeDisabled();
    expect(screen.getByRole("button", { name: "拒绝 Proposal" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "接受 Proposal" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "编辑后接受" })).toBeInTheDocument();
    expect(analysisReads).toBe(2);
  });

  it("按 Cursor 加载全部可分析 Case，不把列表截断在首批 200 条", async () => {
    const original = baseFetcher();
    const laterCase = {
      ...failedCase,
      caseKey: "case-201",
      ordinal: 200,
      definition: {
        ...failedCase.definition,
        metadata: { ...failedCase.definition.metadata, case_id: "case-201" }
      },
      rest: { ...failedCase.rest, caseKey: "case-201", ordinal: 200 },
      evaluation: { ...failedCase.evaluation, caseKey: "case-201", ordinal: 200 }
    };
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url.includes(`/api/v1/runs/${RUN_ID}/report/cases?`)) {
        return url.includes("cursor=cursor-2")
          ? Promise.resolve(response({ items: [laterCase], nextCursor: null }))
          : Promise.resolve(response({ items: [failedCase], nextCursor: "cursor-2" }));
      }
      const implementation = original.getMockImplementation();
      return implementation === undefined
        ? Promise.resolve(response({ invalid: true }))
        : implementation(input, init);
    });

    renderPage(fetcher);
    expect(await screen.findByText("case-1")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "加载更多 Case" }));
    expect(await screen.findByText("case-201")).toBeInTheDocument();
    expect(
      fetcher.mock.calls.some(([input]) => requestUrl(input).includes("cursor=cursor-2"))
    ).toBe(true);
  });

  it("重复 Case Cursor 只读取一次循环页并停止继续加载", async () => {
    const original = baseFetcher();
    let caseReads = 0;
    const laterCase = {
      ...failedCase,
      caseKey: "case-loop",
      ordinal: 1,
      definition: {
        ...failedCase.definition,
        metadata: { ...failedCase.definition.metadata, case_id: "case-loop" }
      },
      rest: { ...failedCase.rest, caseKey: "case-loop", ordinal: 1 },
      evaluation: { ...failedCase.evaluation, caseKey: "case-loop", ordinal: 1 }
    };
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url.includes(`/api/v1/runs/${RUN_ID}/report/cases?`)) {
        caseReads += 1;
        return Promise.resolve(
          response({
            items: url.includes("cursor=loop") ? [laterCase] : [failedCase],
            nextCursor: "loop"
          })
        );
      }
      const implementation = original.getMockImplementation();
      return implementation === undefined
        ? Promise.resolve(response({ invalid: true }))
        : implementation(input, init);
    });

    renderPage(fetcher);
    expect(await screen.findByText("case-1")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "加载更多 Case" }));
    expect(await screen.findByText("case-loop")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "加载更多 Case" })).not.toBeInTheDocument();
    expect(caseReads).toBe(2);
  });

  it("遍历配置 Cursor，使首批 100 条之后的 Analyzer 与 Prompt 可选择", async () => {
    const original = baseFetcher();
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url === "/api/v1/llm-configs?limit=100") {
        return Promise.resolve(
          response({
            items: [
              {
                kind: "LLM",
                id: ANALYZER_ID,
                name: "Gemini Analyzer",
                revision: 0,
                updatedAt: RUN_TIME
              }
            ],
            nextCursor: "llm-page-2"
          })
        );
      }
      if (url === "/api/v1/llm-configs?cursor=llm-page-2&limit=100") {
        return Promise.resolve(
          response({
            items: [
              {
                kind: "LLM",
                id: LATER_ANALYZER_ID,
                name: "Later Analyzer",
                revision: 0,
                updatedAt: RUN_TIME
              }
            ],
            nextCursor: null
          })
        );
      }
      if (url === "/api/v1/case-analysis-prompts?limit=100") {
        return Promise.resolve(
          response({
            items: [
              {
                kind: "CASE_ANALYSIS_PROMPT",
                id: PROMPT_ID,
                name: "Failure Analysis",
                revision: 0,
                updatedAt: RUN_TIME
              }
            ],
            nextCursor: "prompt-page-2"
          })
        );
      }
      if (url === "/api/v1/case-analysis-prompts?cursor=prompt-page-2&limit=100") {
        return Promise.resolve(
          response({
            items: [
              {
                kind: "CASE_ANALYSIS_PROMPT",
                id: LATER_PROMPT_ID,
                name: "Later Analysis Prompt",
                revision: 0,
                updatedAt: RUN_TIME
              }
            ],
            nextCursor: null
          })
        );
      }
      const implementation = original.getMockImplementation();
      return implementation === undefined
        ? Promise.resolve(response({ invalid: true }))
        : implementation(input, init);
    });

    renderPage(fetcher);
    await waitFor(() =>
      expect(fetcher.mock.calls.map(([input]) => requestUrl(input))).toEqual(
        expect.arrayContaining([
          "/api/v1/llm-configs?cursor=llm-page-2&limit=100",
          "/api/v1/case-analysis-prompts?cursor=prompt-page-2&limit=100"
        ])
      )
    );
    await userEvent.click(screen.getByRole("combobox", { name: "Analyzer" }));
    expect(await screen.findByRole("option", { name: "Later Analyzer" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("option", { name: "Later Analyzer" }));
    await userEvent.click(screen.getByRole("combobox", { name: "Analysis Prompt" }));
    expect(
      await screen.findByRole("option", { name: "Later Analysis Prompt" })
    ).toBeInTheDocument();
  });

  it("Report 首次读取失败时展示重试，并在重试成功后恢复工作台", async () => {
    const original = baseFetcher();
    let reportAttempts = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url === `/api/v1/runs/${RUN_ID}/report` && reportAttempts++ === 0) {
        return Promise.resolve(errorResponse("RUN_NOT_FOUND", 404));
      }
      const implementation = original.getMockImplementation();
      return implementation === undefined
        ? Promise.resolve(response({ invalid: true }))
        : implementation(input, init);
    });
    renderPage(fetcher);

    expect(await screen.findByText("Analysis 工作台读取失败")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "重新读取" }));
    expect(
      await screen.findByRole("heading", { name: "Case Analysis 工作台" })
    ).toBeInTheDocument();
    expect(reportAttempts).toBe(2);
  });

  it("校验并发上下界、切换全部 Selector，并展示 Analysis 启动错误", async () => {
    const original = baseFetcher();
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url === `/api/v1/runs/${RUN_ID}/analyses`) {
        return Promise.resolve(errorResponse("ANALYSIS_STATE_CONFLICT", 409));
      }
      const implementation = original.getMockImplementation();
      return implementation === undefined
        ? Promise.resolve(response({ invalid: true }))
        : implementation(input, init);
    });
    renderPage(fetcher);
    await screen.findByRole("heading", { name: "Case Analysis 工作台" });
    const start = screen.getByRole("button", { name: "开始分析" });
    const concurrency = screen.getByRole("spinbutton", { name: "分析并发" });
    fireEvent.change(concurrency, { target: { value: "0" } });
    expect(start).toBeDisabled();
    fireEvent.change(concurrency, { target: { value: "9" } });
    expect(start).toBeDisabled();
    fireEvent.change(concurrency, { target: { value: "1.5" } });
    expect(start).toBeDisabled();
    fireEvent.change(concurrency, { target: { value: "2" } });
    expect(start).toBeEnabled();

    await userEvent.click(screen.getByRole("combobox", { name: "分析范围" }));
    await userEvent.click(await screen.findByRole("option", { name: "评估错误 Case" }));
    await waitFor(() =>
      expect(
        fetcher.mock.calls.some(([input]) =>
          requestUrl(input).includes("evalStatus=EVALUATION_ERROR")
        )
      ).toBe(true)
    );
    await userEvent.click(screen.getByRole("combobox", { name: "分析范围" }));
    await userEvent.click(await screen.findByRole("option", { name: "全部可分析 Case" }));
    await waitFor(() =>
      expect(
        fetcher.mock.calls.some(([input]) => {
          const url = requestUrl(input);
          return url.includes("evalStatus=FAIL") && url.includes("evalStatus=EVALUATION_ERROR");
        })
      ).toBe(true)
    );

    await userEvent.click(start);
    expect(await screen.findByText("Analysis 发起失败")).toBeInTheDocument();
  });

  it("区分尚未分析与读取失败，并展示 Case Error 的无 Proposal 终态", async () => {
    const original = baseFetcher();
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url === `/api/v1/runs/${RUN_ID}/analyses/case-1`) {
        return Promise.resolve(
          response({
            ...currentAnalysis(),
            status: "ERROR",
            output: null,
            decision: "NO_PROPOSAL",
            applyStatus: "NOT_APPLICABLE",
            baseDefinitionHash: null,
            appliedDefinitionHash: null,
            errorCode: "ANALYZER_OUTPUT_INVALID",
            errorMessage: "Analyzer 输出结构无效"
          })
        );
      }
      const implementation = original.getMockImplementation();
      return implementation === undefined
        ? Promise.resolve(response({ invalid: true }))
        : implementation(input, init);
    });
    renderPage(fetcher);
    await userEvent.click(await screen.findByRole("button", { name: "查看分析 case-1" }));

    expect(await screen.findByText("该 Case 分析失败")).toBeInTheDocument();
    expect(screen.getByText("Analyzer 输出结构无效")).toBeInTheDocument();
    expect(screen.getByText("Analysis 尚未形成终态结果。")).toBeInTheDocument();
    expect(screen.getByText("本次 Analysis 没有 Proposal。")).toBeInTheDocument();
  });

  it("把 ANALYSIS_NOT_FOUND 解释为空态，其他读取错误保持为错误态", async () => {
    const original = baseFetcher();
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url === `/api/v1/runs/${RUN_ID}/analyses/case-1`) {
        return Promise.resolve(errorResponse("ANALYSIS_NOT_FOUND", 404));
      }
      const implementation = original.getMockImplementation();
      return implementation === undefined
        ? Promise.resolve(response({ invalid: true }))
        : implementation(input, init);
    });
    renderPage(fetcher);
    await userEvent.click(await screen.findByRole("button", { name: "查看分析 case-1" }));
    expect(await screen.findByText("该 Case 尚无 Analysis 结果。")).toBeInTheDocument();
    expect(screen.queryByText("当前 Analysis 读取失败")).not.toBeInTheDocument();
  });

  it("导入 Run 无当前 Suite 时禁用应用，但仍允许拒绝 Proposal", async () => {
    const original = baseFetcher();
    const rejected = currentAnalysis("REJECTED");
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url === `/api/v1/runs/${RUN_ID}/report`) {
        return Promise.resolve(
          response({
            ...runReportOverview,
            sourceType: "OFFLINE_IMPORT",
            context: {
              ...runReportOverview.context,
              suite: { ...runReportOverview.context.suite, sourceId: null, name: null }
            }
          })
        );
      }
      if (url.endsWith("/reject")) return Promise.resolve(response(rejected));
      const implementation = original.getMockImplementation();
      return implementation === undefined
        ? Promise.resolve(response({ invalid: true }))
        : implementation(input, init);
    });
    renderPage(fetcher);
    await userEvent.click(await screen.findByRole("button", { name: "查看分析 case-1" }));

    expect(
      await screen.findByText("当前 Suite 或 Case 版本不可用，不能应用 Proposal。")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "接受 Proposal" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "编辑后接受" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "拒绝 Proposal" }));
    expect(await screen.findByText("Proposal 已拒绝")).toBeInTheDocument();
  });

  it("返回 Report，并把接受或拒绝的版本冲突统一呈现为决策冲突", async () => {
    const original = baseFetcher();
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url.endsWith("/accept") || url.endsWith("/reject")) {
        return Promise.resolve(errorResponse("ANALYSIS_REVISION_CONFLICT", 409));
      }
      const implementation = original.getMockImplementation();
      return implementation === undefined
        ? Promise.resolve(response({ invalid: true }))
        : implementation(input, init);
    });
    const onNavigate = vi.fn<(path: string) => void>();
    renderPage(fetcher, onNavigate);
    await userEvent.click(await screen.findByRole("button", { name: "返回报告" }));
    expect(onNavigate).toHaveBeenCalledWith(`/runs/${RUN_ID}/report`);

    await userEvent.click(await screen.findByRole("button", { name: "查看分析 case-1" }));
    const accept = await screen.findByRole("button", { name: "接受 Proposal" });
    await waitFor(() => expect(accept).toBeEnabled());
    await userEvent.click(accept);
    expect(await screen.findByText("Analysis 决策冲突，请重新读取当前版本。")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "拒绝 Proposal" }));
    await waitFor(() =>
      expect(
        fetcher.mock.calls.filter(([input]) => {
          const url = requestUrl(input);
          return url.endsWith("/accept") || url.endsWith("/reject");
        })
      ).toHaveLength(2)
    );
  });
});
