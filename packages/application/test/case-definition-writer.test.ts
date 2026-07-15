import { describe, expect, it } from "vitest";

import { hashSuite } from "@cortex-eval/domain/src/domain-resource-hashes.ts";
import type { CaseDefinition } from "@cortex-eval/domain/src/domain-evaluation.ts";

import { CaseDefinitionWriter } from "../src/features/test-suites/case-definition-writer.ts";
import { InMemoryApplicationStore } from "./test-support/in-memory-application-store.ts";

function definition(caseKey: string, promptKey = "quality"): CaseDefinition {
  return {
    caseKey,
    description: `Case ${caseKey}`,
    threshold: 1,
    task: "route",
    requestBody: { input: caseKey },
    metadata: {
      requestId: `req-${caseKey}`,
      taskId: `task-${caseKey}`,
      businessModule: "chat",
      scenarioTag: "smoke"
    },
    assertions: [
      {
        type: "llm-rubric",
        metric: "quality",
        weight: 1,
        rubricPrompt: `prompt://${promptKey}`
      },
      { type: "contains-json", metric: "schema", weight: 1 }
    ]
  };
}

describe("CaseDefinitionWriter", () => {
  it("创建 Case 时统一派生筛选列、定义 Hash、Suite Count/Hash 与 Revision", async () => {
    const store = new InMemoryApplicationStore();
    store.seedSuite({
      id: "suite-1",
      name: "Suite",
      description: "Current suite",
      caseCount: 0,
      suiteHash: hashSuite({ contractVersion: "cortex.suite.v1", cases: [] }),
      revision: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    });
    store.seedRubricPrompt("quality");
    const writer = new CaseDefinitionWriter(store.dependencies());

    const result = await writer.createCase({
      suiteId: "suite-1",
      expectedSuiteRevision: 0,
      definition: definition("case-1")
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.case).toMatchObject({
      caseKey: "case-1",
      ordinal: 0,
      businessModule: "chat",
      scenarioTag: "smoke",
      assertionTypes: ["contains-json", "llm-rubric"],
      metrics: ["quality", "schema"],
      rubricPromptKeys: ["quality"],
      revision: 0
    });
    expect(result.suite).toMatchObject({ caseCount: 1, revision: 1 });
    expect(result.suite.suiteHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("Rubric 引用缺失时整笔回滚，不递增 Suite Revision", async () => {
    const store = InMemoryApplicationStore.withEmptySuite("suite-1");
    const writer = new CaseDefinitionWriter(store.dependencies());

    const result = await writer.createCase({
      suiteId: "suite-1",
      expectedSuiteRevision: 0,
      definition: definition("case-1", "missing")
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "RUBRIC_PROMPT_NOT_FOUND", promptKey: "missing" }
    });
    expect(store.snapshot().suites[0]).toMatchObject({ caseCount: 0, revision: 0 });
    expect(store.snapshot().cases).toEqual([]);
  });

  it("全量替换遇到重复 Case Key 时不删除已有 Case", async () => {
    const store = InMemoryApplicationStore.withEmptySuite("suite-1");
    store.seedRubricPrompt("quality");
    const writer = new CaseDefinitionWriter(store.dependencies());
    const first = await writer.createCase({
      suiteId: "suite-1",
      expectedSuiteRevision: 0,
      definition: definition("existing")
    });
    expect(first.ok).toBe(true);

    const result = await writer.replaceAllCases({
      suiteId: "suite-1",
      expectedSuiteRevision: 1,
      definitions: [definition("duplicate"), definition("duplicate")]
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "CASE_IMPORT_ITEM_INVALID",
        index: 1,
        caseKey: "duplicate",
        cause: { code: "CASE_ID_DUPLICATE", caseKey: "duplicate" }
      }
    });
    expect(store.snapshot().cases.map((item) => item.caseKey)).toEqual(["existing"]);
    expect(store.snapshot().suites[0]?.revision).toBe(1);
  });

  it("两个客户端持有同一旧 Suite Revision 时只有第一个写入成功", async () => {
    const store = InMemoryApplicationStore.withEmptySuite("suite-1");
    store.seedRubricPrompt("quality");
    const writer = new CaseDefinitionWriter(store.dependencies());

    const first = await writer.createCase({
      suiteId: "suite-1",
      expectedSuiteRevision: 0,
      definition: definition("case-1")
    });
    const stale = await writer.createCase({
      suiteId: "suite-1",
      expectedSuiteRevision: 0,
      definition: definition("case-2")
    });

    expect(first.ok).toBe(true);
    expect(stale).toEqual({
      ok: false,
      error: { code: "RESOURCE_REVISION_CONFLICT", actualRevision: 1, expectedRevision: 0 }
    });
    expect(store.snapshot().cases.map((item) => item.caseKey)).toEqual(["case-1"]);
  });

  it("编辑、复制、接受建议和编辑后接受共用相同写入不变量", async () => {
    const store = InMemoryApplicationStore.withEmptySuite("suite-1");
    store.seedRubricPrompt("quality");
    const writer = new CaseDefinitionWriter(store.dependencies());
    const created = await writer.createCase({
      suiteId: "suite-1",
      expectedSuiteRevision: 0,
      definition: definition("case-1")
    });
    expect(created.ok).toBe(true);

    const editedDefinition = { ...definition("case-1"), description: "Edited" };
    const edited = await writer.editCase({
      suiteId: "suite-1",
      caseKey: "case-1",
      expectedSuiteRevision: 1,
      expectedCaseRevision: 0,
      definition: editedDefinition
    });
    expect(edited).toMatchObject({
      ok: true,
      case: { description: "Edited", revision: 1 },
      suite: { revision: 2 }
    });

    const copied = await writer.copyCase({
      suiteId: "suite-1",
      expectedSuiteRevision: 2,
      definition: definition("case-copy")
    });
    expect(copied).toMatchObject({ ok: true, suite: { caseCount: 2, revision: 3 } });

    const accepted = await writer.acceptSuggestion({
      suiteId: "suite-1",
      caseKey: "case-1",
      expectedSuiteRevision: 3,
      expectedCaseRevision: 1,
      definition: { ...editedDefinition, description: "Accepted" }
    });
    expect(accepted).toMatchObject({ ok: true, case: { revision: 2 } });

    const editedAndAccepted = await writer.editAndAcceptSuggestion({
      suiteId: "suite-1",
      caseKey: "case-1",
      expectedSuiteRevision: 4,
      expectedCaseRevision: 2,
      definition: { ...editedDefinition, description: "Edited and accepted" }
    });
    expect(editedAndAccepted).toMatchObject({ ok: true, case: { revision: 3 } });
  });

  it("允许 Analysis 协调器在既有短事务内复用同一 Case Writer", async () => {
    const store = InMemoryApplicationStore.withEmptySuite("suite-1");
    store.seedRubricPrompt("quality");
    const dependencies = store.dependencies();
    const writer = new CaseDefinitionWriter(dependencies);
    await writer.createCase({
      suiteId: "suite-1",
      expectedSuiteRevision: 0,
      definition: definition("case-1")
    });

    const result = await dependencies.transactionManager.execute((transaction) =>
      writer.editCaseWithinTransaction(
        transaction,
        {
          suiteId: "suite-1",
          caseKey: "case-1",
          expectedSuiteRevision: 1,
          expectedCaseRevision: 0,
          definition: { ...definition("case-1"), description: "Atomic Analysis edit" }
        },
        "2026-07-15T00:00:00.000Z"
      )
    );

    expect(result).toMatchObject({
      ok: true,
      case: { description: "Atomic Analysis edit", revision: 1 },
      suite: { revision: 2 }
    });
  });

  it("覆盖创建、替换和编辑的校验、身份、引用与 Revision 错误", async () => {
    const emptyStore = new InMemoryApplicationStore();
    const emptyWriter = new CaseDefinitionWriter(emptyStore.dependencies());
    expect(
      await emptyWriter.createCase({
        suiteId: "missing",
        expectedSuiteRevision: 0,
        definition: definition("case-1")
      })
    ).toEqual({ ok: false, error: { code: "SUITE_NOT_FOUND" } });
    expect(
      await emptyWriter.createCase({
        suiteId: "missing",
        expectedSuiteRevision: 0,
        definition: { ...definition("case-1"), description: "" }
      })
    ).toMatchObject({ ok: false, error: { code: "CASE_DEFINITION_INVALID" } });

    const store = InMemoryApplicationStore.withEmptySuite("suite-1");
    store.seedRubricPrompt("quality");
    const writer = new CaseDefinitionWriter(store.dependencies());
    await writer.createCase({
      suiteId: "suite-1",
      expectedSuiteRevision: 0,
      definition: definition("case-1")
    });
    expect(
      await writer.createCase({
        suiteId: "suite-1",
        expectedSuiteRevision: 1,
        definition: definition("case-1")
      })
    ).toEqual({ ok: false, error: { code: "CASE_ID_DUPLICATE", caseKey: "case-1" } });
    expect(
      await writer.replaceAllCases({
        suiteId: "suite-1",
        expectedSuiteRevision: 0,
        definitions: [definition("replacement")]
      })
    ).toMatchObject({ ok: false, error: { code: "RESOURCE_REVISION_CONFLICT" } });
    expect(
      await writer.replaceAllCases({
        suiteId: "suite-1",
        expectedSuiteRevision: 1,
        definitions: [definition("replacement", "missing")]
      })
    ).toEqual({
      ok: false,
      error: {
        code: "CASE_IMPORT_ITEM_INVALID",
        index: 0,
        caseKey: "replacement",
        cause: { code: "RUBRIC_PROMPT_NOT_FOUND", promptKey: "missing" }
      }
    });
    expect(
      await writer.replaceAllCases({
        suiteId: "suite-1",
        expectedSuiteRevision: 1,
        definitions: [definition("valid"), { ...definition("invalid"), description: "" }]
      })
    ).toMatchObject({
      ok: false,
      error: {
        code: "CASE_IMPORT_ITEM_INVALID",
        index: 1,
        caseKey: "invalid",
        cause: { code: "CASE_DEFINITION_INVALID", path: "description" }
      }
    });
    expect(
      await writer.editCase({
        suiteId: "suite-1",
        caseKey: "case-1",
        expectedSuiteRevision: 1,
        expectedCaseRevision: 0,
        definition: definition("changed-key")
      })
    ).toEqual({ ok: false, error: { code: "CASE_IDENTITY_CONFLICT", caseKey: "case-1" } });
    expect(
      await writer.editCase({
        suiteId: "suite-1",
        caseKey: "missing",
        expectedSuiteRevision: 1,
        expectedCaseRevision: 0,
        definition: definition("missing")
      })
    ).toEqual({ ok: false, error: { code: "CASE_NOT_FOUND", caseKey: "missing" } });
    expect(
      await writer.editCase({
        suiteId: "suite-1",
        caseKey: "case-1",
        expectedSuiteRevision: 1,
        expectedCaseRevision: 3,
        definition: definition("case-1")
      })
    ).toMatchObject({ ok: false, error: { code: "RESOURCE_REVISION_CONFLICT" } });
    expect(
      await writer.editCase({
        suiteId: "suite-1",
        caseKey: "case-1",
        expectedSuiteRevision: 1,
        expectedCaseRevision: 0,
        definition: definition("case-1", "missing")
      })
    ).toEqual({
      ok: false,
      error: { code: "RUBRIC_PROMPT_NOT_FOUND", promptKey: "missing" }
    });
  });

  it("删除中间 Case 后原子重排 Ordinal 并重算 Suite Hash 与 Revision", async () => {
    const store = InMemoryApplicationStore.withEmptySuite("suite-1");
    store.seedRubricPrompt("quality");
    const writer = new CaseDefinitionWriter(store.dependencies());
    const imported = await writer.replaceAllCases({
      suiteId: "suite-1",
      expectedSuiteRevision: 0,
      definitions: [definition("case-0"), definition("case-1"), definition("case-2")]
    });
    expect(imported.ok).toBe(true);

    const deleted = await writer.deleteCase({
      suiteId: "suite-1",
      caseKey: "case-1",
      expectedSuiteRevision: 1,
      expectedCaseRevision: 0
    });

    expect(deleted).toMatchObject({ ok: true, suite: { caseCount: 2, revision: 2 } });
    expect(store.snapshot().cases.map((item) => [item.caseKey, item.ordinal])).toEqual([
      ["case-0", 0],
      ["case-2", 1]
    ]);
  });

  it("删除 Case 时分别收敛 Suite、Case 和两级 Revision 冲突", async () => {
    const missingStore = new InMemoryApplicationStore();
    expect(
      await new CaseDefinitionWriter(missingStore.dependencies()).deleteCase({
        suiteId: "missing",
        caseKey: "case-1",
        expectedSuiteRevision: 0,
        expectedCaseRevision: 0
      })
    ).toEqual({ ok: false, error: { code: "SUITE_NOT_FOUND" } });

    const store = InMemoryApplicationStore.withEmptySuite("suite-1");
    store.seedRubricPrompt("quality");
    const writer = new CaseDefinitionWriter(store.dependencies());
    await writer.createCase({
      suiteId: "suite-1",
      expectedSuiteRevision: 0,
      definition: definition("case-1")
    });
    expect(
      await writer.deleteCase({
        suiteId: "suite-1",
        caseKey: "case-1",
        expectedSuiteRevision: 0,
        expectedCaseRevision: 0
      })
    ).toMatchObject({ ok: false, error: { code: "RESOURCE_REVISION_CONFLICT" } });
    expect(
      await writer.deleteCase({
        suiteId: "suite-1",
        caseKey: "missing",
        expectedSuiteRevision: 1,
        expectedCaseRevision: 0
      })
    ).toEqual({ ok: false, error: { code: "CASE_NOT_FOUND", caseKey: "missing" } });
    expect(
      await writer.deleteCase({
        suiteId: "suite-1",
        caseKey: "case-1",
        expectedSuiteRevision: 1,
        expectedCaseRevision: 1
      })
    ).toMatchObject({ ok: false, error: { code: "RESOURCE_REVISION_CONFLICT" } });
  });
});
