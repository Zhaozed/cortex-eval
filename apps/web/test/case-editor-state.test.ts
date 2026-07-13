import type { CaseDefinitionV1 } from "@cortex-eval/contracts/src/case-contracts.ts";
import { describe, expect, it } from "vitest";

import {
  applyStructuredCaseFields,
  caseApiPathToEditorField,
  createCaseEditorState,
  replaceAssertionJson,
  replaceRequestBodyJson,
  switchCaseEditorMode,
  updateFullCaseJson
} from "../src/features/test-suites/case-editor-state.ts";

function caseDefinition(): CaseDefinitionV1 {
  return {
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
        type: "assert-set",
        metric: "quality",
        weight: 0.5,
        config: { mode: "all", extra: { retained: true } },
        transform: "output.trim()",
        contextTransform: "context.vars.task",
        assert: [
          {
            type: "llm-rubric",
            metric: "quality",
            rubricPrompt: "prompt://quality.default",
            value: { requirement: "准确" },
            threshold: 0.8
          }
        ]
      }
    ]
  };
}

describe("Case 双编辑器共享 Draft", () => {
  it("结构化字段更新不丢失完整 Assertion JSON", () => {
    const initial = caseDefinition();
    const state = createCaseEditorState(initial);
    const updated = applyStructuredCaseFields(state, {
      caseId: "case-001",
      description: "新描述",
      threshold: 0.9,
      task: "新任务",
      reqId: "req-002",
      taskId: "task-002",
      businessModule: "售后",
      scenarioTag: "追问"
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;

    expect(updated.state.draft.assert).toEqual(initial.assert);
    expect(updated.state.draft).toMatchObject({
      description: "新描述",
      threshold: 0.9,
      vars: { task: "新任务" },
      metadata: {
        case_id: "case-001",
        req_id: "req-002",
        task_id: "task-002",
        business_module: "售后",
        scenario_tag: "追问"
      }
    });
  });

  it("Request Body 和单条 Assertion 分别严格解析后替换", () => {
    const state = createCaseEditorState(caseDefinition());
    const withBody = replaceRequestBodyJson(state, '{"messages":[],"stream":false}');
    expect(withBody.ok).toBe(true);
    if (!withBody.ok) return;
    const withAssertion = replaceAssertionJson(
      withBody.state,
      0,
      '{"type":"equals","metric":"exact","value":"ok","config":{"x":1}}'
    );

    expect(withAssertion).toMatchObject({
      ok: true,
      state: {
        draft: {
          vars: { request_body: { messages: [], stream: false } },
          assert: [{ type: "equals", metric: "exact", value: "ok", config: { x: 1 } }]
        }
      }
    });
  });

  it("完整 JSON 解析失败时保留原 Draft 和当前模式", () => {
    const state = createCaseEditorState(caseDefinition());
    const editing = updateFullCaseJson(state, '{"description":');
    const switched = switchCaseEditorMode(editing, "STRUCTURED");

    expect(switched).toMatchObject({
      ok: false,
      state: { mode: "JSON", draft: caseDefinition() },
      errorPath: "$"
    });
  });

  it("完整 JSON 通过 Contract 后成为结构化模式的同一 Draft", () => {
    const state = createCaseEditorState(caseDefinition());
    const changed = { ...caseDefinition(), description: "JSON 修改" };
    const editing = updateFullCaseJson(state, JSON.stringify(changed));
    const switched = switchCaseEditorMode(editing, "STRUCTURED");

    expect(switched).toMatchObject({ ok: true, state: { mode: "STRUCTURED", draft: changed } });
  });

  it("把 API definition path 映射到可聚焦编辑字段", () => {
    expect(caseApiPathToEditorField("definition.metadata.case_id")).toBe("metadata.case_id");
    expect(caseApiPathToEditorField("definition.assert.0.threshold")).toBe("assert.0");
    expect(caseApiPathToEditorField("definition.vars.request_body.messages.0.content")).toBe(
      "vars.request_body"
    );
    expect(caseApiPathToEditorField("definition.unknown")).toBe("root");
  });

  it("拒绝非对象 Request Body、越界 Assertion 和 Contract 无效的完整 JSON", () => {
    const state = createCaseEditorState(caseDefinition());
    expect(replaceRequestBodyJson(state, "[]")).toMatchObject({
      ok: false,
      errorPath: "vars.request_body"
    });
    expect(
      replaceAssertionJson(state, 4, '{"type":"equals","metric":"exact","value":"ok"}')
    ).toMatchObject({
      ok: false,
      errorPath: "assert.4"
    });
    expect(
      switchCaseEditorMode(updateFullCaseJson(state, '{"description":"缺字段"}'), "STRUCTURED")
    ).toMatchObject({ ok: false, errorPath: "contractVersion" });
  });

  it("结构化模式的同模式切换和进入 JSON 都保持同一合法 Draft", () => {
    const state = createCaseEditorState(caseDefinition());
    expect(switchCaseEditorMode(state, "STRUCTURED")).toEqual({ ok: true, state });
    expect(switchCaseEditorMode(state, "JSON")).toMatchObject({
      ok: true,
      state: { mode: "JSON", draft: state.draft }
    });
  });

  it("API 路径允许省略 definition 前缀并覆盖全部结构化字段", () => {
    expect(caseApiPathToEditorField("description")).toBe("description");
    expect(caseApiPathToEditorField("threshold")).toBe("threshold");
    expect(caseApiPathToEditorField("vars.task")).toBe("vars.task");
    expect(caseApiPathToEditorField("metadata.req_id")).toBe("metadata.req_id");
    expect(caseApiPathToEditorField("metadata.task_id")).toBe("metadata.task_id");
    expect(caseApiPathToEditorField("metadata.business_module")).toBe("metadata.business_module");
    expect(caseApiPathToEditorField("metadata.scenario_tag")).toBe("metadata.scenario_tag");
  });
});
