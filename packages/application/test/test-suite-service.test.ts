import { describe, expect, it } from "vitest";

import { TestSuiteService } from "../src/features/test-suites/test-suite-service.ts";
import { CaseDefinitionWriter } from "../src/features/test-suites/case-definition-writer.ts";
import { InMemoryApplicationStore } from "./test-support/in-memory-application-store.ts";

describe("TestSuiteService", () => {
  it("测试集列表返回稳定名称/ID Cursor 摘要", async () => {
    const store = new InMemoryApplicationStore();
    const service = new TestSuiteService(store.dependencies());
    for (const name of ["Beta", "Alpha", "Gamma"]) {
      expect(await service.create({ name, description: `${name} description` })).toMatchObject({
        ok: true
      });
    }

    const first = await service.query({ limit: 2 });
    expect(first).toMatchObject({
      ok: true,
      page: {
        items: [{ name: "Alpha" }, { name: "Beta" }],
        nextCursor: { name: "Beta" }
      }
    });
    if (!first.ok || first.page.nextCursor === null) return;
    expect(typeof first.page.nextCursor.id).toBe("string");
    expect(await service.query({ limit: 2, afterCursor: first.page.nextCursor })).toMatchObject({
      ok: true,
      page: { items: [{ name: "Gamma" }], nextCursor: null }
    });
  });
  it("创建、仅改名称更新和旧 Revision 冲突使用独立并发 Token", async () => {
    const store = new InMemoryApplicationStore();
    const service = new TestSuiteService(store.dependencies());
    const created = await service.create({ name: "Suite", description: "Current" });
    expect(created).toMatchObject({ ok: true, suite: { caseCount: 0, revision: 0 } });
    if (!created.ok) return;

    const updated = await service.update({
      id: created.suite.id,
      expectedRevision: 0,
      name: "Renamed",
      description: "Current"
    });
    const stale = await service.update({
      id: created.suite.id,
      expectedRevision: 0,
      name: "Lost",
      description: "Current"
    });
    expect(updated).toMatchObject({ ok: true, suite: { name: "Renamed", revision: 1 } });
    expect(stale).toMatchObject({
      ok: false,
      error: { code: "RESOURCE_REVISION_CONFLICT", actualRevision: 1, expectedRevision: 0 }
    });
    expect(await service.get(created.suite.id)).toMatchObject({ name: "Renamed" });
    expect((await service.list()).map((item) => item.id)).toEqual([created.suite.id]);
    expect(await service.create({ name: "Renamed", description: "Duplicate" })).toEqual({
      ok: false,
      error: { code: "RESOURCE_UNIQUE_CONFLICT", field: "name" }
    });
    expect(
      await service.update({
        id: "missing",
        expectedRevision: 0,
        name: "Missing",
        description: "Missing"
      })
    ).toEqual({ ok: false, error: { code: "SUITE_NOT_FOUND" } });
    const second = await service.create({ name: "Second", description: "Second" });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(
      await service.update({
        id: second.suite.id,
        expectedRevision: 0,
        name: "Renamed",
        description: "Conflict"
      })
    ).toEqual({
      ok: false,
      error: { code: "RESOURCE_UNIQUE_CONFLICT", field: "name" }
    });
  });

  it("READY/RUNNING 引用存在时拒绝删除，终态快照不阻止删除", async () => {
    const store = InMemoryApplicationStore.withEmptySuite("suite-1");
    const service = new TestSuiteService(store.dependencies());
    expect(await service.delete({ id: "missing", expectedRevision: 0 })).toEqual({
      ok: false,
      error: { code: "SUITE_NOT_FOUND" }
    });
    expect(await service.delete({ id: "suite-1", expectedRevision: 1 })).toMatchObject({
      ok: false,
      error: { code: "RESOURCE_REVISION_CONFLICT" }
    });
    store.seedActiveResourceReference("TEST_SUITE", "suite-1");
    expect(await service.delete({ id: "suite-1", expectedRevision: 0 })).toEqual({
      ok: false,
      error: { code: "RESOURCE_IN_ACTIVE_RUN" }
    });
    store.clearActiveResourceReferences();
    expect(await service.delete({ id: "suite-1", expectedRevision: 0 })).toEqual({ ok: true });
  });

  it("按稳定 Cursor 与组合条件查询并按 Ordinal 导出完整定义", async () => {
    const store = InMemoryApplicationStore.withEmptySuite("suite-1");
    const writer = new CaseDefinitionWriter(store.dependencies());
    const definitions = Array.from({ length: 3 }, (_, index) => ({
      caseKey: `case-${index}`,
      description: `Case ${index}`,
      threshold: 1,
      task: "route",
      requestBody: { index },
      metadata: {
        requestId: `req-${index}`,
        taskId: `task-${index}`,
        businessModule: index === 1 ? "search" : "chat",
        scenarioTag: "smoke"
      },
      assertions: [
        { type: index === 2 ? "contains-json" : "contains", metric: "quality", weight: 1 }
      ]
    }));
    const imported = await writer.replaceAllCases({
      suiteId: "suite-1",
      expectedSuiteRevision: 0,
      definitions
    });
    expect(imported.ok).toBe(true);
    const service = new TestSuiteService(store.dependencies());
    const firstPage = await service.queryCases({
      suiteId: "suite-1",
      businessModules: ["chat"],
      descriptionContains: "Case 0",
      assertionTypes: ["contains"],
      metrics: ["quality"],
      limit: 1
    });
    expect(firstPage).toMatchObject({
      ok: true,
      page: { nextCursor: null, items: [{ caseKey: "case-0" }] }
    });
    expect(
      await service.queryCases({
        suiteId: "suite-1",
        caseKeyContains: "CASE-0",
        descriptionContains: "case 0",
        limit: 20
      })
    ).toMatchObject({ ok: true, page: { items: [{ caseKey: "case-0" }] } });
    expect(await service.getCase("suite-1", "case-1")).toMatchObject({
      suiteId: "suite-1",
      caseKey: "case-1",
      ordinal: 1
    });
    expect(await service.getCase("suite-1", "missing")).toBeNull();
    expect(await service.queryCases({ suiteId: "suite-1", limit: 0 })).toEqual({
      ok: false,
      error: { code: "CASE_QUERY_INVALID", path: "limit" }
    });
    expect(
      await service.queryCases({
        suiteId: "suite-1",
        limit: 20,
        afterCursor: { ordinal: -1, id: "id" }
      })
    ).toEqual({
      ok: false,
      error: { code: "CASE_QUERY_INVALID", path: "afterCursor.ordinal" }
    });
    expect(await service.queryCases({ suiteId: "suite-1", limit: 201 })).toEqual({
      ok: false,
      error: { code: "CASE_QUERY_INVALID", path: "limit" }
    });
    expect(await service.queryCases({ suiteId: "suite-1", limit: 1.5 })).toEqual({
      ok: false,
      error: { code: "CASE_QUERY_INVALID", path: "limit" }
    });
    expect(
      await service.queryCases({
        suiteId: "suite-1",
        limit: 20,
        afterCursor: { ordinal: 1.5, id: "id" }
      })
    ).toEqual({
      ok: false,
      error: { code: "CASE_QUERY_INVALID", path: "afterCursor.ordinal" }
    });
    expect((await service.exportCaseDefinitions("suite-1")).map((item) => item.caseKey)).toEqual([
      "case-0",
      "case-1",
      "case-2"
    ]);
  });

  it("同一筛选字段使用 OR、不同字段使用 AND，并返回内部 ID Tie-breaker", async () => {
    const store = InMemoryApplicationStore.withEmptySuite("suite-1");
    const writer = new CaseDefinitionWriter(store.dependencies());
    const definitions = ["chat", "search", "billing"].map((businessModule, index) => ({
      caseKey: `case-${index}`,
      description: index === 2 ? "Other" : "Target",
      threshold: 1,
      task: "route",
      requestBody: { index },
      metadata: {
        requestId: `req-${index}`,
        taskId: `task-${index}`,
        businessModule,
        scenarioTag: index === 1 ? "edge" : "smoke"
      },
      assertions: [
        {
          type: index === 0 ? "contains" : "is-json",
          metric: index === 1 ? "safety" : "quality",
          weight: 1
        }
      ]
    }));
    expect(
      await writer.replaceAllCases({
        suiteId: "suite-1",
        expectedSuiteRevision: 0,
        definitions
      })
    ).toMatchObject({ ok: true });

    const result = await new TestSuiteService(store.dependencies()).queryCases({
      suiteId: "suite-1",
      businessModules: ["chat", "search"],
      scenarioTags: ["smoke", "edge"],
      assertionTypes: ["contains", "is-json"],
      metrics: ["quality", "safety"],
      descriptionContains: "target",
      limit: 1
    });

    expect(result).toMatchObject({
      ok: true,
      page: {
        items: [{ caseKey: "case-0" }],
        nextCursor: { ordinal: 0 }
      }
    });
    if (!result.ok || result.page.nextCursor === null) {
      throw new Error("CASE_PAGE_CURSOR_EXPECTED");
    }
    expect(typeof result.page.nextCursor.id).toBe("string");
  });
});
