import { describe, expect, it } from "vitest";
import type { CaseDefinition } from "@cortex-eval/domain/src/domain-evaluation.ts";

import { CaseDefinitionWriter } from "../src/features/test-suites/case-definition-writer.ts";
import {
  CaseExportError,
  CaseExportService
} from "../src/features/test-suites/case-export-service.ts";
import { InMemoryApplicationStore } from "./test-support/in-memory-application-store.ts";

function definition(caseKey: string): CaseDefinition {
  return {
    caseKey,
    description: caseKey,
    threshold: 1,
    task: "route",
    requestBody: { caseKey },
    metadata: {
      requestId: `req-${caseKey}`,
      taskId: `task-${caseKey}`,
      businessModule: "chat",
      scenarioTag: "smoke"
    },
    assertions: [{ type: "contains", metric: "quality", weight: 1 }]
  };
}

describe("CaseExportService", () => {
  it("按背压逐条短事务读取固定 Revision，不预取完整 Case 数组", async () => {
    const store = InMemoryApplicationStore.withEmptySuite("suite-1");
    const writer = new CaseDefinitionWriter(store.dependencies());
    expect(
      await writer.replaceAllCases({
        suiteId: "suite-1",
        expectedSuiteRevision: 0,
        definitions: [definition("case-1"), definition("case-2")]
      })
    ).toMatchObject({ ok: true });
    const before = store.transactionCount;
    const stream = new CaseExportService({ transactionManager: store }).stream("suite-1");

    expect(await stream.next()).toMatchObject({ done: false, value: { caseKey: "case-1" } });
    expect(store.transactionCount - before).toBe(2);
    expect(await stream.next()).toMatchObject({ done: false, value: { caseKey: "case-2" } });
    expect(await stream.next()).toEqual({ done: true, value: undefined });
    expect(store.transactionCount - before).toBe(4);
  });

  it("导出期间 Suite Revision 变化时中止，不生成混合版本", async () => {
    const store = InMemoryApplicationStore.withEmptySuite("suite-1");
    const writer = new CaseDefinitionWriter(store.dependencies());
    expect(
      await writer.replaceAllCases({
        suiteId: "suite-1",
        expectedSuiteRevision: 0,
        definitions: [definition("case-1"), definition("case-2")]
      })
    ).toMatchObject({ ok: true });
    const stream = new CaseExportService({ transactionManager: store }).stream("suite-1");
    expect(await stream.next()).toMatchObject({ value: { caseKey: "case-1" } });
    expect(
      await writer.createCase({
        suiteId: "suite-1",
        expectedSuiteRevision: 1,
        definition: definition("case-3")
      })
    ).toMatchObject({ ok: true });

    await expect(stream.next()).rejects.toMatchObject({ code: "EXPORT_REVISION_CONFLICT" });
  });

  it("不存在的 Suite 使用稳定导出错误", async () => {
    const store = new InMemoryApplicationStore();
    const stream = new CaseExportService({ transactionManager: store }).stream("missing");
    await expect(stream.next()).rejects.toEqual(new CaseExportError("SUITE_NOT_FOUND"));
  });
});
