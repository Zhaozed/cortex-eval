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
    expect(changed?.brief?.checklist[0]?.tier).toBe("P0");
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
    expect(saved?.semanticEvaluation?.brief?.checklist[0]?.assertion).toBe("新的20个核心案例提醒");
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
