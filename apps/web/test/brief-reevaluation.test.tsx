import type { BriefReevaluationOptions } from "@cortex-eval/contracts/src/run-api-contracts.ts";
import type { Mock } from "vitest";
// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResourceApi } from "../src/lib/resource-api.ts";
import { BriefReevaluationForm } from "../src/features/runs/run-brief-reevaluation.tsx";
import { compareCases } from "../src/features/runs/run-comparison.tsx";
import { runReportCase } from "./run-test-fixture.ts";
import type { DashboardCase } from "../src/features/runs/run-dashboard-model.ts";

const profile = {
  briefType: "daily" as const,
  judge: "LLM" as const,
  constraints: { allowedGenerationStatuses: ["generated" as const] },
  rubric: {
    dimensions: [{ id: "facts", assertion: "事实准确", sourceRefs: ["/material"] }],
    minTotalScore: 2,
    hardFailRules: ["编造"]
  }
};
afterEach(cleanup);
type Submit = (value: BriefReevaluationOptions, name: string) => void;
function setup(batch = false, modelFails = false): Mock<Submit> {
  const onSubmit = vi.fn<Submit>();
  const resourceApi = {
    listConfigurations: vi.fn().mockResolvedValue({
      items: [{ id: "01900000-0000-7000-8000-000000000002", name: "Judge B" }],
      nextCursor: null
    }),
    getConfiguration: modelFails
      ? vi.fn().mockRejectedValue(new Error("unavailable"))
      : vi.fn().mockResolvedValue({
          kind: "LLM",
          revision: 2,
          definition: { model: "test-model", temperature: 0 }
        })
  } as unknown as ResourceApi;
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <BriefReevaluationForm
        profile={profile}
        pending={false}
        failed={false}
        onSubmit={onSubmit}
        onCancel={() => undefined}
        resourceApi={resourceApi}
        batch={batch}
      />
    </QueryClientProvider>
  );
  return onSubmit;
}

describe("Brief Judge calibration UI", () => {
  it("submits only scoring changes with a version label and blocks invalid rubric", async () => {
    const onSubmit = setup();
    fireEvent.click(screen.getByRole("tab", { name: "Judge Prompt" }));
    fireEvent.change(screen.getByLabelText("Judge prompt"), { target: { value: "新版裁判指令" } });
    fireEvent.change(screen.getByLabelText("评测版本名称"), {
      target: { value: "Rubric v2 / judge A" }
    });
    fireEvent.click(screen.getByRole("tab", { name: /Rubric 评分标准/ }));
    fireEvent.change(screen.getByLabelText("评分标准 1"), { target: { value: "" } });
    fireEvent.click(screen.getByText("创建重评版本"));
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("评分标准 1"), {
      target: { value: "新版事实标准" }
    });
    fireEvent.click(screen.getByText("创建重评版本"));
    expect(onSubmit).toHaveBeenCalledWith(
      {
        judgePrompt: "新版裁判指令",
        evaluatorPrompt: null,
        rubric: {
          ...profile.rubric,
          dimensions: [{ ...profile.rubric.dimensions[0], assertion: "新版事实标准" }]
        }
      },
      "Rubric v2 / judge A"
    );
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
  it("batch defaults to retaining individual rubrics rather than copying the first Case rubric", async () => {
    const onSubmit = setup(true);
    expect(screen.getByLabelText("评分标准 1").closest("fieldset")?.disabled).toBe(true);
    fireEvent.click(screen.getByText("创建重评版本"));
    expect(onSubmit.mock.calls[0]?.[0].rubric).toBeUndefined();
    fireEvent.click(screen.getByLabelText("统一覆盖所有样本的 Rubric"));
    fireEvent.click(screen.getByText("创建重评版本"));
    expect(onSubmit.mock.calls[1]?.[0].rubric).toEqual(profile.rubric);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
  it("edits thresholds and hard failures without mutating the source profile", async () => {
    const before = structuredClone(profile);
    const onSubmit = setup();
    fireEvent.change(screen.getByLabelText("通过阈值"), { target: { value: "3" } });
    fireEvent.click(screen.getByText("创建重评版本"));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("不能超过");
    fireEvent.change(screen.getByLabelText("通过阈值"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("一票否决规则 1"), { target: { value: "新否决规则" } });
    fireEvent.click(screen.getByText("创建重评版本"));
    expect(onSubmit.mock.calls[0]?.[0].rubric).toMatchObject({
      minTotalScore: 1,
      hardFailRules: ["新否决规则"]
    });
    expect(profile).toEqual(before);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
  it("adds and deletes dimensions and rejects duplicate dimension IDs", async () => {
    const onSubmit = setup();
    fireEvent.click(screen.getByText("添加维度"));
    fireEvent.change(screen.getByLabelText("评分标准 2"), { target: { value: "第二维度" } });
    fireEvent.change(screen.getByLabelText("维度 2 标识"), { target: { value: "facts" } });
    fireEvent.click(screen.getByText("创建重评版本"));
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("维度 2 标识"), { target: { value: "relevance" } });
    fireEvent.click(screen.getByText("创建重评版本"));
    expect(onSubmit.mock.calls[0]?.[0].rubric?.dimensions).toHaveLength(2);
    fireEvent.click(screen.getByLabelText("删除维度 2"));
    expect(screen.queryByLabelText("评分标准 2")).toBeNull();
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
  it("preserves edits across tabs and focuses the Prompt tab for an empty instruction", async () => {
    const onSubmit = setup();
    fireEvent.change(screen.getByLabelText("评分标准 1"), { target: { value: "保留的标准" } });
    fireEvent.click(screen.getByRole("tab", { name: "Judge Prompt" }));
    fireEvent.change(screen.getByLabelText("Judge prompt"), { target: { value: "  " } });
    fireEvent.click(screen.getByRole("tab", { name: /Rubric 评分标准/ }));
    expect(screen.getByLabelText<HTMLTextAreaElement>("评分标准 1").value).toBe("保留的标准");
    fireEvent.click(screen.getByText("创建重评版本"));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("tab", { name: "Judge Prompt" }).getAttribute("aria-selected")).toBe(
      "true"
    );
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("不能为空"));
  });
  it("selects a new judge model and includes its configuration ID", async () => {
    const onSubmit = setup();
    await screen.findByRole("option", { name: "Judge B" });
    fireEvent.change(screen.getByLabelText("Judge 模型"), {
      target: { value: "01900000-0000-7000-8000-000000000002" }
    });
    await screen.findByText("test-model");
    fireEvent.click(screen.getByText("创建重评版本"));
    expect(onSubmit.mock.calls[0]?.[0].evaluatorConfigId).toBe(
      "01900000-0000-7000-8000-000000000002"
    );
  });
  it("blocks submission when the selected model cannot be loaded", async () => {
    const onSubmit = setup(false, true);
    await screen.findByRole("option", { name: "Judge B" });
    fireEvent.change(screen.getByLabelText("Judge 模型"), {
      target: { value: "01900000-0000-7000-8000-000000000002" }
    });
    await screen.findByText("模型读取失败，请重新选择。");
    const submit = screen.getByRole<HTMLButtonElement>("button", { name: /创建重评版本/ });
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Judge 模型"), { target: { value: "" } });
    expect(submit.disabled).toBe(false);
  });
  it("compares same frozen evidence across rubric hashes but never mistakes changed output for frozen evidence", () => {
    const definition = {
      ...runReportCase.definition,
      semanticEvaluation: {
        contractVersion: "cortex.semantic-evaluation-contract.v1" as const,
        goal: "brief",
        successCriteria: ["准确"],
        enabledDimensions: ["response" as const],
        brief: profile
      }
    };
    const before: DashboardCase = {
      caseKey: "case",
      ordinal: 0,
      definition,
      rest: runReportCase.rest,
      report: runReportCase,
      evaluation: undefined
    };
    const after: DashboardCase = {
      ...before,
      definition: {
        ...definition,
        semanticEvaluation: {
          ...definition.semanticEvaluation,
          brief: { ...profile, judgePrompt: "v2" }
        }
      },
      report: { ...runReportCase, definitionHash: "b".repeat(64) }
    };
    expect(compareCases([before], [after])[0]?.kind).toBe("FROZEN");
    const changed = {
      ...after,
      rest: {
        ...after.rest,
        status: "SUCCEEDED" as const,
        providerOutput: { ok: false as const, err_msg: "different" }
      }
    } as DashboardCase;
    expect(compareCases([before], [changed])[0]?.kind).toBe("CHANGED");
    const inputChanged = {
      ...after,
      definition: { ...definition, vars: { ...definition.vars, request_body: { changed: true } } }
    };
    expect(compareCases([before], [inputChanged])[0]?.kind).toBe("CHANGED");
  });
});
