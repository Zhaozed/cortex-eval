// @vitest-environment jsdom
import dailyCaseJson from "../../../test_suite/brief-content/daily.case.json?raw";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CaseDefinitionV1Schema } from "@cortex-eval/contracts/src/case-contracts.ts";
import {
  BriefCaseFields,
  newBriefContract,
  parseBriefImport
} from "../src/features/test-suites/brief-case-fields.tsx";
import { CaseEditor } from "../src/features/test-suites/case-editor.tsx";
import { RunBriefContent, RunBriefEvaluation } from "../src/features/runs/run-brief-content.tsx";
import { evidenceRow } from "./run-case-drawer-fixture.ts";

function fixture(): ReturnType<typeof CaseDefinitionV1Schema.parse> {
  return CaseDefinitionV1Schema.parse(JSON.parse(dailyCaseJson));
}
describe("Brief content UI", () => {
  it("imports bundle/replay/snapshot forms but rejects GT and failure envelopes", () => {
    const request = fixture().vars.request_body;
    expect(parseBriefImport(JSON.stringify(request))).toEqual(request);
    expect(parseBriefImport(JSON.stringify(request.bundle)).bundle).toEqual(request.bundle);
    expect(
      parseBriefImport(JSON.stringify({ ok: true, parsed_output: { bundle: request.bundle } }))
        .bundle
    ).toEqual(request.bundle);
    expect(() => parseBriefImport(JSON.stringify({ ...request, ground_truth: {} }))).toThrow();
    expect(() =>
      parseBriefImport(JSON.stringify({ ok: false, parsed_output: { bundle: request.bundle } }))
    ).toThrow();
  });
  it("imports materials without mutating checklist and blocks wrong types", () => {
    const value = newBriefContract("meeting");
    const onImport = vi.fn();
    const onChange = vi.fn();
    render(<BriefCaseFields value={value} onChange={onChange} onImport={onImport} />);
    fireEvent.change(screen.getByLabelText("或粘贴材料 JSON"), {
      target: { value: JSON.stringify(fixture().vars.request_body) }
    });
    fireEvent.click(screen.getByRole("button", { name: "导入并替换请求材料" }));
    expect(screen.getByRole("alert")).toHaveTextContent("材料类型与所选");
    expect(onImport).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "添加原子断言" }));
    const changed = onChange.mock.calls[0]?.[0] as ReturnType<typeof newBriefContract> | undefined;
    expect(changed?.brief?.checklist?.[0]?.tier).toBe("P0");
  });
  it("edits an atomic checklist and saves GT outside request_body", async () => {
    const onSave = vi.fn<(value: ReturnType<typeof fixture>) => void>();
    const source = fixture();
    render(<CaseEditor initialDefinition={source} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText("断言 1"), {
      target: { value: "新的20个核心案例提醒" }
    });
    fireEvent.click(screen.getByRole("button", { name: "保存 Case" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const saved = onSave.mock.calls[0]?.[0];
    expect(saved?.semanticEvaluation?.brief?.checklist?.[0]?.assertion).toBe(
      "新的20个核心案例提醒"
    );
    expect(saved?.vars.request_body).toEqual(source.vars.request_body);
  });
  it("saves the judge selector without changing request materials or GT", async () => {
    const onSave = vi.fn<(value: ReturnType<typeof fixture>) => void>();
    const source = fixture();
    render(<CaseEditor initialDefinition={source} onSave={onSave} />);
    expect(screen.getByLabelText("内容裁判")).toHaveValue("JEV");
    fireEvent.change(screen.getByLabelText("内容裁判"), { target: { value: "LLM" } });
    expect(screen.getByText(/该配置会冻结到 Run/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存 Case" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const saved = onSave.mock.calls[0]?.[0];
    expect(saved?.semanticEvaluation?.brief?.judge).toBe("LLM");
    expect(saved?.semanticEvaluation?.brief?.checklist).toEqual(
      source.semanticEvaluation?.brief?.checklist
    );
    expect(saved?.vars.request_body).toEqual(source.vars.request_body);
  });
  it("can explicitly leave Brief mode without silently retaining semantic rules", async () => {
    const onSave = vi.fn<(value: ReturnType<typeof fixture>) => void>();
    render(<CaseEditor initialDefinition={fixture()} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText("评测模式"), { target: { value: "agent" } });
    fireEvent.click(screen.getByRole("button", { name: "保存 Case" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]?.[0].semanticEvaluation).toBeUndefined();
  });
  it("shows generated Brief, never model input as final text or delivered messages", () => {
    const row = evidenceRow({
      brief_type: "daily",
      generation_status: "fact_only_fallback",
      presentation_status: "plain_text",
      llm_called: false,
      delivered: false,
      model_input: { text: "不应展示的输入" },
      output: { text: "待确认脱敏权限", cards: [] }
    });
    render(<RunBriefContent row={row} />);
    expect(screen.getByText("待确认脱敏权限")).toBeInTheDocument();
    expect(screen.getByText(/未向用户交付/)).toHaveTextContent("fact_only_fallback");
    expect(screen.queryByText("不应展示的输入")).not.toBeInTheDocument();
  });
  it("displays a soft atomic failure as failure even when overall threshold passed", () => {
    render(
      <RunBriefEvaluation
        semantic={{
          provider: "fake",
          model: "test",
          planVersion: "cortex.brief-atomic-plan.v1",
          result: {
            contractVersion: "cortex.semantic-evaluation-contract.v1",
            passed: true,
            score: 0.8,
            blockingFailures: [],
            warnings: [],
            decisions: [
              {
                questionId: "brief.P1.time",
                kind: "BOOLEAN",
                value: false,
                applicable: true,
                reason: "漏了会议时间",
                evidence: [],
                evidenceRefs: ["bundle/material/start"]
              }
            ]
          }
        }}
      />
    );
    expect(screen.getByText("未通过")).toBeInTheDocument();
    expect(screen.getByText("漏了会议时间")).toBeInTheDocument();
    expect(screen.getByText(/80.0 分/)).toBeInTheDocument();
  });
});

import {
  RunBriefEvaluation as BriefEval,
  RunBriefInput,
  RunBriefVerdict
} from "../src/features/runs/run-brief-content.tsx";

type Semantic = Parameters<typeof BriefEval>[0]["semantic"];

const RUBRIC_DIMENSIONS = [
  ["coverage", 2],
  ["faithfulness", 1],
  ["prioritization", 2],
  ["actionability", 2],
  ["noise_control", 0],
  ["readability", 2]
] as const;

function rubricSemantic(overrides: {
  readonly passed?: boolean;
  readonly hardFails?: readonly string[];
  readonly blocking?: readonly string[];
}): Semantic {
  const hardFails = overrides.hardFails ?? [];
  return {
    provider: "llm:evaluator",
    model: "judge-model",
    planVersion: "cortex.brief-rubric-plan.v1",
    result: {
      contractVersion: "cortex.semantic-evaluation-contract.v1",
      passed: overrides.passed ?? false,
      score: 0.75,
      blockingFailures: [
        ...hardFails.map((reason) => `brief.hard_fail: ${reason}`),
        ...(overrides.blocking ?? ["brief.rubric.noise_control: 维度得分为0"])
      ],
      warnings: [],
      decisions: [
        ...RUBRIC_DIMENSIONS.map(([id, value]) => ({
          questionId: `brief.rubric.${id}`,
          kind: "SCORE" as const,
          value,
          applicable: true,
          reason: `维度 ${id} 的裁判理由`,
          evidence: [`输出原文引文 ${id}`],
          evidenceRefs: ["/material/snapshot/memories/0/content"],
          platformReason: `维度断言：${id}`
        })),
        {
          questionId: "brief.structure",
          kind: "BOOLEAN" as const,
          value: true,
          applicable: true,
          evidence: [],
          evidenceRefs: []
        },
        {
          questionId: "brief.generation",
          kind: "BOOLEAN" as const,
          value: false,
          applicable: true,
          evidence: [],
          evidenceRefs: []
        },
        {
          questionId: "brief.metric.total",
          kind: "SCORE" as const,
          value: 9,
          applicable: true,
          evidence: [],
          evidenceRefs: []
        },
        {
          questionId: "brief.metric.rubric",
          kind: "SCORE" as const,
          value: 0.75,
          applicable: true,
          evidence: [],
          evidenceRefs: []
        }
      ]
    }
  };
}

describe("Brief rubric 裁判结论", () => {
  it("renders the six-dimension table with colored score badges and collapsible quotes", () => {
    render(<BriefEval semantic={rubricSemantic({})} />);
    const region = screen.getByRole("region", { name: "Brief 裁判结论" });
    expect(region).toHaveTextContent("总分 9/12");
    expect(region).toHaveTextContent("维度断言：coverage");
    expect(screen.getByText("0/2")).toHaveAttribute("data-score", "0");
    expect(screen.getByText("1/2")).toHaveAttribute("data-score", "1");
    expect(screen.getAllByText("2/2")[0]).toHaveAttribute("data-score", "2");
    expect(region).toHaveTextContent("维度 faithfulness 的裁判理由");
    const quotes = screen.getAllByText("引文 1 条");
    expect(quotes).toHaveLength(6);
    expect(quotes[0]?.closest("details")).not.toHaveAttribute("open");
    expect(region).toHaveTextContent("结构检查通过 · 生成检查未通过");
    expect(region).toHaveTextContent("noise_control: 维度得分为0");
    expect(screen.getByText("原始裁判 JSON").closest("details")).not.toHaveAttribute("open");
  });

  it("lists hard fail reasons as an alert without the machine prefix", () => {
    render(
      <BriefEval
        semantic={rubricSemantic({ hardFails: ["编造了不存在的会议", "泄露了他人日程"] })}
      />
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("编造了不存在的会议");
    expect(alert).toHaveTextContent("泄露了他人日程");
    expect(alert).not.toHaveTextContent("brief.hard_fail:");
  });

  it("shows 无 instead of an alert when there is no hard fail", () => {
    render(<BriefEval semantic={rubricSemantic({ hardFails: [], blocking: [] })} />);
    expect(screen.getByText("无")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the verdict band for rubric results", () => {
    render(<RunBriefVerdict semantic={rubricSemantic({})} />);
    const band = screen.getByRole("region", { name: "Brief 评测结论" });
    expect(band).toHaveTextContent("总分 9/12");
    expect(band).toHaveTextContent("FAIL · 未通过");
    expect(band).toHaveTextContent("Hard Fail 0 项");
    expect(band).toHaveTextContent("得分率 75.0%");
  });

  it("hides the verdict band for legacy checklist results", () => {
    render(
      <RunBriefVerdict
        semantic={
          {
            provider: "fake",
            model: "test",
            planVersion: "cortex.brief-atomic-plan.v1",
            result: {
              contractVersion: "cortex.semantic-evaluation-contract.v1",
              passed: true,
              score: 1,
              blockingFailures: [],
              warnings: [],
              decisions: [
                {
                  questionId: "brief.P0.time",
                  kind: "BOOLEAN",
                  value: true,
                  applicable: true,
                  evidence: [],
                  evidenceRefs: []
                }
              ]
            }
          }
        }
      />
    );
    expect(screen.queryByRole("region", { name: "Brief 评测结论" })).not.toBeInTheDocument();
  });
});

describe("Brief 输入材料", () => {
  it("sections the frozen bundle and folds model_input", () => {
    const row = evidenceRow({
      brief_type: "daily",
      generation_status: "generated",
      presentation_status: "plain_text",
      llm_called: true,
      delivered: false,
      model_input: { system_prompt: "你是简报生成器", messages: [{ role: "user", text: "材料" }] },
      output: { text: "正文", cards: [] }
    });
    const definition = row.definition;
    if (!definition) throw new Error("Missing fixture definition");
    const withDefinition = {
      ...row,
      definition: {
        ...definition,
        metadata: { ...definition.metadata, business_module: "brief_daily" },
        vars: {
          ...definition.vars,
          request_body: {
            bundle: {
              version: 1,
              brief_type: "daily",
              context: { uid: 7, timezone: "Asia/Shanghai", recent_conversation_messages: [] },
              material: {
                snapshot: {
                  memories: [
                    {
                      domain: "USER",
                      memory_kind: "user.commitment",
                      content: "今天下班前确认脱敏权限。"
                    }
                  ],
                  projects: [],
                  persons: []
                }
              }
            }
          }
        }
      }
    };
    render(<RunBriefInput row={withDefinition} />);
    const region = screen.getByRole("region", { name: "Brief 输入材料" });
    expect(region).toHaveTextContent("Asia/Shanghai");
    expect(region).toHaveTextContent("USER");
    expect(region).toHaveTextContent("user.commitment");
    expect(region).toHaveTextContent("今天下班前确认脱敏权限。");
    const modelInput = screen.getByText("模型输入（system_prompt / messages）");
    expect(modelInput.closest("details")).not.toHaveAttribute("open");
    expect(region).toHaveTextContent("你是简报生成器");
  });

  it("renders nothing without a bundle", () => {
    const { container } = render(<RunBriefInput row={evidenceRow({})} />);
    expect(container).toBeEmptyDOMElement();
  });
});
