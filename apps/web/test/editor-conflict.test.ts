import type { CaseDefinitionV1 } from "@cortex-eval/contracts/src/case-contracts.ts";
import { describe, expect, it } from "vitest";

import {
  acceptConfigurationSnapshot,
  acceptCaseSnapshot,
  createCaseConflict,
  createConfigurationConflict,
  createDeletedCaseConflict,
  retryCaseDraft,
  retryConfigurationDraft
} from "../src/lib/editor-conflict.ts";

const draftDefinition: CaseDefinitionV1 = {
  contractVersion: "cortex.case-definition.v1",
  description: "本地未保存内容",
  threshold: 0.8,
  vars: { task: "task", request_body: {} },
  metadata: {
    case_id: "case-1",
    req_id: "req-1",
    task_id: "task-1",
    business_module: "module",
    scenario_tag: "tag"
  },
  assert: [{ type: "equals", metric: "quality", value: "ok" }]
};

describe("409 Draft 与最新服务端 Snapshot", () => {
  it("Case 冲突保留 Draft，并用最新 Suite/Case revision 重试", () => {
    const conflict = createCaseConflict({
      draft: draftDefinition,
      serverCase: { definition: { ...draftDefinition, description: "远端内容" }, revision: 7 },
      serverSuiteRevision: 11
    });

    expect(retryCaseDraft(conflict)).toEqual({
      expectedSuiteRevision: 11,
      expectedCaseRevision: 7,
      definition: draftDefinition
    });
    expect(conflict.draft.description).toBe("本地未保存内容");
    expect(acceptCaseSnapshot(conflict).description).toBe("远端内容");
  });

  it("远端 Case 已删除时保留 Draft，但不伪造可重试的 Case revision", () => {
    const conflict = createDeletedCaseConflict({
      draft: draftDefinition,
      serverSuiteRevision: 12
    });

    expect(conflict).toEqual({
      remoteState: "REMOTE_CASE_DELETED",
      draft: draftDefinition,
      serverSuiteRevision: 12
    });
    expect(conflict).not.toHaveProperty("serverCase");
  });

  it("配置冲突保留 Draft，并用最新 resource revision 重试", () => {
    const draft = { name: "本地名称", definition: { model: "local" } };
    const snapshot = { name: "远端名称", definition: { model: "remote" }, revision: 4 };
    const conflict = createConfigurationConflict({ draft, serverSnapshot: snapshot });

    expect(retryConfigurationDraft(conflict)).toEqual({
      name: "本地名称",
      definition: { model: "local" },
      expectedRevision: 4
    });
    expect(acceptConfigurationSnapshot(conflict)).toBe(snapshot);
  });
});
