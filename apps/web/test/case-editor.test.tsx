// @vitest-environment jsdom

import type { CaseDefinitionV1 } from "@cortex-eval/contracts/src/case-contracts.ts";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CaseEditor } from "../src/features/test-suites/case-editor.tsx";
import { ApiClientError } from "../src/lib/api-client.ts";

const definition: CaseDefinitionV1 = {
  contractVersion: "cortex.case-definition.v1",
  description: "原描述",
  threshold: 0.7,
  vars: { task: "回答问题", request_body: { messages: [{ role: "user", content: "你好" }] } },
  metadata: {
    case_id: "case-001",
    req_id: "req-001",
    task_id: "task-001",
    business_module: "客服",
    scenario_tag: "正常"
  },
  assert: [
    {
      type: "llm-rubric",
      metric: "quality",
      rubricPrompt: "prompt://quality.default",
      config: { retained: true },
      threshold: 0.8
    }
  ]
};

describe("Case 双编辑器组件", () => {
  it("结构化编辑后切换完整 JSON，共享 Draft 且保留完整 Assertion", async () => {
    render(<CaseEditor initialDefinition={definition} onSave={vi.fn()} />);
    const description = screen.getByRole("textbox", { name: "Case 描述" });
    await userEvent.clear(description);
    await userEvent.type(description, "结构化修改");
    await userEvent.click(screen.getByRole("tab", { name: "高级 JSON" }));

    const json = screen.getByRole("textbox", { name: "完整 Case JSON" });
    expect((json as HTMLTextAreaElement).value).toContain('"description": "结构化修改"');
    expect((json as HTMLTextAreaElement).value).toContain('"retained": true');
    expect((json as HTMLTextAreaElement).value).toContain(
      '"rubricPrompt": "prompt://quality.default"'
    );
  });

  it("完整 JSON 无效时不切回结构化模式并关联错误", async () => {
    render(<CaseEditor initialDefinition={definition} onSave={vi.fn()} />);
    await userEvent.click(screen.getByRole("tab", { name: "高级 JSON" }));
    const json = screen.getByRole("textbox", { name: "完整 Case JSON" });
    await userEvent.clear(json);
    fireEvent.change(json, { target: { value: "{" } });
    await userEvent.click(screen.getByRole("tab", { name: "表单" }));

    expect(screen.getByRole("tab", { name: "高级 JSON" })).toHaveAttribute("aria-selected", "true");
    expect(json).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("完整 JSON 无法解析，请修正后再切换。")).toHaveAttribute(
      "id",
      "case-json-error"
    );
    expect(json).toHaveAttribute("aria-describedby", "case-json-error");
  });

  it("保存只提交当前共享 Draft", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<CaseEditor initialDefinition={definition} onSave={onSave} />);
    await userEvent.click(screen.getByRole("button", { name: "保存 Case" }));

    expect(onSave).toHaveBeenCalledWith(definition);
  });

  it("把服务端 Case 字段路径关联到结构化字段并保留 Draft", async () => {
    const onSave = vi.fn().mockRejectedValue(
      new ApiClientError("CASE_DEFINITION_INVALID", {
        fieldPath: "definition.metadata.case_id"
      })
    );
    render(<CaseEditor initialDefinition={definition} onSave={onSave} />);

    await userEvent.click(screen.getByRole("button", { name: "保存 Case" }));

    const caseId = screen.getByRole("textbox", { name: "Case ID" });
    expect(
      await screen.findByText("服务端校验失败：definition.metadata.case_id")
    ).toBeInTheDocument();
    expect(caseId).toHaveAttribute("aria-invalid", "true");
    await waitFor(() => expect(caseId).toHaveFocus());
    expect(caseId).toHaveValue("case-001");
  });

  it("结构化 Request Body 与 Assertion 无效时分别阻止保存", async () => {
    const onSave = vi.fn();
    render(<CaseEditor initialDefinition={definition} onSave={onSave} />);
    const requestBody = screen.getByRole("textbox", { name: "Request Body JSON" });
    await userEvent.clear(requestBody);
    fireEvent.change(requestBody, { target: { value: "{" } });
    await userEvent.click(screen.getByRole("button", { name: "保存 Case" }));
    expect(screen.getByText("Request Body 必须是合法 JSON 对象。")).toBeInTheDocument();
    expect(requestBody).toHaveAttribute("aria-invalid", "true");
    expect(requestBody).toHaveAttribute("aria-describedby", "case-structured-error");
    expect(requestBody).toHaveFocus();
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.change(requestBody, { target: { value: "{}" } });
    const assertion = screen.getByRole("textbox", { name: "Assertion JSON 1" });
    await userEvent.clear(assertion);
    fireEvent.change(assertion, { target: { value: '{"type":"unknown"}' } });
    await userEvent.click(screen.getByRole("button", { name: "保存 Case" }));
    expect(screen.getByText("Assertion 必须符合当前契约。")).toBeInTheDocument();
    expect(assertion).toHaveAttribute("aria-invalid", "true");
    expect(assertion).toHaveAttribute("aria-describedby", "case-structured-error");
    expect(assertion).toHaveFocus();
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.change(assertion, {
      target: { value: '{"type":"equals","metric":"quality","value":"ok"}' }
    });
    expect(assertion).toHaveAttribute("aria-invalid", "false");
  });

  it("结构化普通字段的本地契约错误关联并聚焦真实控件", async () => {
    const onSave = vi.fn();
    render(<CaseEditor initialDefinition={definition} onSave={onSave} />);
    const caseId = screen.getByRole("textbox", { name: "Case ID" });
    await userEvent.clear(caseId);
    await userEvent.click(screen.getByRole("button", { name: "保存 Case" }));

    expect(screen.getByText("结构化字段无效，请检查标记项。")).toBeInTheDocument();
    expect(caseId).toHaveAttribute("aria-invalid", "true");
    expect(caseId).toHaveFocus();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("完整 JSON 模式直接保存校验后的同一 Draft", async () => {
    const onSave = vi.fn();
    render(<CaseEditor initialDefinition={definition} onSave={onSave} />);
    await userEvent.click(screen.getByRole("tab", { name: "高级 JSON" }));
    const json = screen.getByRole("textbox", { name: "完整 Case JSON" });
    fireEvent.change(json, {
      target: { value: JSON.stringify({ ...definition, description: "JSON 直接保存" }) }
    });
    await userEvent.click(screen.getByRole("button", { name: "保存 Case" }));

    expect(onSave).toHaveBeenCalledWith({ ...definition, description: "JSON 直接保存" });
  });

  it("服务端非字段错误和 Assertion 路径均显示可读错误并保留 Draft", async () => {
    const onSave = vi
      .fn()
      .mockRejectedValueOnce(new Error("opaque"))
      .mockRejectedValueOnce(
        new ApiClientError("CASE_DEFINITION_INVALID", {
          fieldPath: "definition.assert.0.threshold"
        })
      )
      .mockRejectedValueOnce(
        new ApiClientError("CASE_DEFINITION_INVALID", {
          fieldPath: "definition.unknown"
        })
      );
    render(<CaseEditor initialDefinition={definition} onSave={onSave} />);

    await userEvent.click(screen.getByRole("button", { name: "保存 Case" }));
    expect(await screen.findByText("Case 保存失败，Draft 已保留。")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "保存 Case" }));
    expect(
      await screen.findByText("服务端校验失败：definition.assert.0.threshold")
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Assertion JSON 1" })).toHaveAttribute(
      "aria-invalid",
      "true"
    );
    expect(screen.getByRole("textbox", { name: "Assertion JSON 1" })).toHaveFocus();
    expect(screen.getByRole("textbox", { name: "Case ID" })).toHaveValue("case-001");
    await userEvent.click(screen.getByRole("button", { name: "保存 Case" }));
    expect(await screen.findByText("服务端校验失败：definition.unknown")).toBeInTheDocument();
  });

  it("完整 JSON 保存收到服务端字段错误时在当前编辑器显示并聚焦", async () => {
    const onSave = vi.fn().mockRejectedValue(
      new ApiClientError("CASE_DEFINITION_INVALID", {
        fieldPath: "definition.assert.0.threshold"
      })
    );
    render(<CaseEditor initialDefinition={definition} onSave={onSave} />);
    await userEvent.click(screen.getByRole("tab", { name: "高级 JSON" }));
    await userEvent.click(screen.getByRole("button", { name: "保存 Case" }));

    expect(
      await screen.findByText("服务端校验失败：definition.assert.0.threshold")
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "完整 Case JSON" })).toHaveAttribute(
      "aria-invalid",
      "true"
    );
    expect(screen.getByRole("textbox", { name: "完整 Case JSON" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "高级 JSON" })).toHaveAttribute("data-state", "active");
  });

  it("外部保存错误事件按 eventId 只消费一次，新事件才再次映射和聚焦", async () => {
    const error = new ApiClientError("CASE_DEFINITION_INVALID", {
      fieldPath: "definition.metadata.case_id"
    });
    const onHandled = vi.fn();
    const { rerender } = render(
      <CaseEditor
        initialDefinition={definition}
        onSave={vi.fn()}
        externalSaveError={{ eventId: 1, error }}
        onExternalSaveErrorHandled={onHandled}
      />
    );

    const caseId = await screen.findByRole("textbox", { name: "Case ID" });
    expect(caseId).toHaveFocus();
    expect(onHandled).toHaveBeenCalledWith(1);
    const task = screen.getByRole("combobox", { name: "任务" });
    task.focus();

    rerender(
      <CaseEditor
        initialDefinition={definition}
        onSave={vi.fn()}
        externalSaveError={{ eventId: 1, error }}
        onExternalSaveErrorHandled={vi.fn()}
      />
    );
    expect(task).toHaveFocus();

    rerender(
      <CaseEditor
        initialDefinition={definition}
        onSave={vi.fn()}
        externalSaveError={{ eventId: 2, error }}
        onExternalSaveErrorHandled={onHandled}
      />
    );
    await waitFor(() => expect(caseId).toHaveFocus());
    expect(onHandled).toHaveBeenLastCalledWith(2);
    expect(onHandled).toHaveBeenCalledTimes(2);
  });

  it("结构化数字字段无效时显示本地契约错误", async () => {
    render(<CaseEditor initialDefinition={definition} onSave={vi.fn()} />);
    const threshold = screen.getByRole("spinbutton", { name: "通过阈值" });
    fireEvent.change(threshold, { target: { value: "" } });
    await userEvent.click(screen.getByRole("button", { name: "保存 Case" }));

    expect(screen.getByText("结构化字段无效，请检查标记项。")).toBeInTheDocument();
  });
});

it("通过可视化开关选择 A2UI 人工复核，并保留默认关闭", async () => {
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(<CaseEditor initialDefinition={definition} onSave={onSave} />);
  const toggle = screen.getByRole("checkbox", { name: /要求 A2UI 人工复核/ });
  expect(toggle).not.toBeChecked();
  await userEvent.click(toggle);
  await userEvent.click(screen.getByRole("button", { name: "保存 Case" }));
  expect(onSave).toHaveBeenLastCalledWith({
    ...definition,
    metadata: { ...definition.metadata, a2ui_capture: true }
  });
});
