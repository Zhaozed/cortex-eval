// @vitest-environment jsdom
import dailySmokeJson from "../../../test_suite/brief-content/daily.smoke.case.json?raw";
import { CaseDefinitionV1Schema } from "@cortex-eval/contracts/src/case-contracts.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CaseDetailContent,
  CaseDetailSheet
} from "../src/features/test-suites/case-detail-sheet.tsx";
import { TestSuiteDetailPage } from "../src/features/test-suites/test-suite-detail-page.tsx";
import { createResourceApi } from "../src/lib/resource-api.ts";
import { requestUrl } from "./request-fixture.ts";
import {
  detail,
  response,
  suite,
  suiteId,
  summary
} from "./test-suite-detail-page-test-fixture.ts";

function smokeDefinition(): ReturnType<typeof CaseDefinitionV1Schema.parse> {
  return CaseDefinitionV1Schema.parse(JSON.parse(dailySmokeJson));
}

beforeEach(() => window.history.replaceState(null, "", `/test-suites/${suiteId}`));

describe("只读 Case 详情", () => {
  it.each(["查看 Case case-001", "查看详情 case-001"])(
    "从 %s 查看详情，不进入编辑或发起写入",
    async (entry) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
        const url = requestUrl(input);
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
      fireEvent.click(await screen.findByRole("button", { name: entry }));
      const dialog = await screen.findByRole("dialog", { name: "Case 详情 · case-001" });
      expect(await within(dialog).findByText("原 Case 描述")).toBeInTheDocument();
      expect(within(dialog).getByText("完整 Case JSON")).toBeInTheDocument();
      expect(within(dialog).queryByRole("textbox")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "保存 Case" })).not.toBeInTheDocument();
      fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(fetcher.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(
        true
      );
    }
  );

  it("清晰展示 Brief 材料、裁判、原子 GT 和容量约束，GT 不混入请求", () => {
    const definition = smokeDefinition();
    render(<CaseDetailContent definition={definition} />);
    expect(screen.getByText("内容裁判：LLM")).toBeInTheDocument();
    const input = screen.getByRole("region", { name: "输入材料" });
    expect(input).toHaveTextContent("今天下班前确认 Atlas 试点的 20 个核心案例和脱敏权限。");
    expect(input).not.toHaveTextContent("core_cases");
    const gt = screen.getByRole("region", { name: "原子 GT" });
    expect(gt).toHaveTextContent("提醒需确认20个核心案例，而非声称已经确认完成");
    expect(gt).toHaveTextContent("将偏好深色界面作为今日重点事项");
    expect(gt).toHaveTextContent("/material/snapshot/memories/0/content");
    expect(screen.getByText("允许的生成状态：generated")).toBeInTheDocument();
    expect(screen.getByText("最多卡片数：不限制")).toBeInTheDocument();
  });

  it("旧 Brief 未指定裁判时显示 JEV，支持 Meeting 类型", () => {
    const definition = smokeDefinition();
    const brief = definition.semanticEvaluation?.brief;
    if (!brief) throw new Error("Missing Brief fixture");
    delete brief.judge;
    brief.briefType = "meeting";
    render(<CaseDetailContent definition={definition} />);
    expect(screen.getByText("内容裁判：JEV")).toBeInTheDocument();
    expect(screen.getByText("Brief 类型：Meeting Brief")).toBeInTheDocument();
  });

  it("加载失败可重试，成功后展示详情", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ error: "unavailable" }, 500))
      .mockResolvedValueOnce(response(detail));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <CaseDetailSheet
          api={createResourceApi(fetcher)}
          suiteId={suiteId}
          caseKey="case-001"
          onClose={vi.fn()}
        />
      </QueryClientProvider>
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("详情加载失败");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("原 Case 描述")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("Brief Case 详情折叠", () => {
  it("Brief 请求默认折叠，摘要行显示类型与材料条数", () => {
    render(<CaseDetailContent definition={smokeDefinition()} />);
    const input = screen.getByRole("region", { name: "输入材料" });
    expect(input).toHaveTextContent("Daily Brief · 材料：记忆 2 条 · 项目 0 个 · 人物 0 个");
    const summary = within(input).getByText("完整请求 JSON");
    expect(summary.closest("details")).not.toHaveAttribute("open");
    // 折叠不等于丢失：完整 JSON 仍可展开核对。
    expect(input).toHaveTextContent("今天下班前确认 Atlas 试点的 20 个核心案例和脱敏权限。");
  });

  it("无 checklist 的 rubric Brief 展示评分维度，不渲染原子 GT", () => {
    const definition = smokeDefinition();
    const brief = definition.semanticEvaluation?.brief;
    if (!brief) throw new Error("Missing Brief fixture");
    delete brief.checklist;
    brief.rubric = {
      dimensions: [
        {
          id: "coverage",
          assertion: "覆盖所有到期承诺",
          sourceRefs: ["/material/snapshot/memories/0/content"]
        }
      ],
      minTotalScore: 1,
      failOnZeroDimension: true,
      hardFailRules: ["编造不存在的记忆"]
    };
    render(<CaseDetailContent definition={definition} />);
    expect(screen.queryByRole("region", { name: "原子 GT" })).not.toBeInTheDocument();
    const rubric = screen.getByRole("region", { name: "评分维度" });
    expect(rubric).toHaveTextContent("满分 2 分 · 通过线 1 分 · 任一维度 0 分即不通过");
    expect(rubric).toHaveTextContent("覆盖所有到期承诺");
    expect(rubric).toHaveTextContent("编造不存在的记忆");
  });

  it("非 Brief Case 的请求数据保持原样展开", () => {
    const definition = smokeDefinition();
    delete definition.semanticEvaluation;
    definition.metadata.business_module = "tasks";
    render(<CaseDetailContent definition={definition} />);
    const input = screen.getByRole("region", { name: "输入材料" });
    expect(within(input).queryByText("完整请求 JSON")).not.toBeInTheDocument();
    expect(input.querySelector("details")).toBeNull();
    expect(input).toHaveTextContent("今天下班前确认 Atlas 试点的 20 个核心案例和脱敏权限。");
  });
});
