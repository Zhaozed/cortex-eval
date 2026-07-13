import { describe, expect, it } from "vitest";

import type {
  CaseImportStagingFactory,
  CaseImportStagingSession,
  StagedCaseRepository
} from "../src/application-ports.ts";
import { StreamingCaseImportService } from "../src/features/test-suites/streaming-case-import-service.ts";
import type { StoredTestCase } from "../src/features/test-suites/test-suite-models.ts";
import type { CaseDefinition } from "@cortex-eval/domain/src/domain-evaluation.ts";
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

class FakeStagingFactory implements CaseImportStagingFactory {
  readonly #store: InMemoryApplicationStore;
  readonly #cleanupFailure: boolean;
  public cleaned = false;

  public constructor(store: InMemoryApplicationStore, cleanupFailure = false) {
    this.#store = store;
    this.#cleanupFailure = cleanupFailure;
  }

  public open(): Promise<CaseImportStagingSession> {
    const staged: StoredTestCase[] = [];
    return Promise.resolve({
      stage: (value) => {
        if (staged.some((item) => item.caseKey === value.caseKey)) {
          return Promise.resolve("CASE_ID_DUPLICATE" as const);
        }
        staged.push(value);
        return Promise.resolve("STAGED" as const);
      },
      withStagedTransaction: (work) =>
        this.#store.execute(async (transaction) => {
          const repository: StagedCaseRepository = {
            findFirstMissingRubricPrompt: async () => {
              for (const [index, item] of staged.entries()) {
                const promptKey = await transaction.configurations.findMissingRubricPromptKey(
                  item.rubricPromptKeys
                );
                if (promptKey !== null) return { index, caseKey: item.caseKey, promptKey };
              }
              return null;
            },
            replaceCases: (suiteId) => transaction.testSuites.replaceCases(suiteId, staged)
          };
          return work(transaction, repository);
        }),
      cleanup: () => {
        this.cleaned = true;
        return this.#cleanupFailure
          ? Promise.reject(new Error("CASE_IMPORT_CLEANUP_FAILED"))
          : Promise.resolve();
      }
    });
  }
}

describe("StreamingCaseImportService", () => {
  it("逐条准备并提交完整 staging，结果 Hash 与既有 Suite Hash 一致", async () => {
    const store = InMemoryApplicationStore.withEmptySuite("suite-1");
    const stagingFactory = new FakeStagingFactory(store);
    const service = new StreamingCaseImportService({
      ...store.dependencies(),
      stagingFactory
    });
    async function* definitions(): AsyncGenerator<CaseDefinition, void, void> {
      await Promise.resolve();
      yield definition("case-1");
      yield definition("case-2");
    }

    const result = await service.importCases({
      suiteId: "suite-1",
      expectedSuiteRevision: 0,
      definitions: definitions(),
      signal: new AbortController().signal
    });

    expect(result).toMatchObject({ ok: true, count: 2, suite: { caseCount: 2, revision: 1 } });
    if (!result.ok) throw new Error("CASE_IMPORT_EXPECTED_SUCCESS");
    expect(result.suite.suiteHash).toMatch(/^[0-9a-f]{64}$/);
    expect(store.snapshot().cases.map((item) => item.caseKey)).toEqual(["case-1", "case-2"]);
    expect(stagingFactory.cleaned).toBe(true);
  });

  it("重复 Case 或取消时不提交，并始终清理 staging", async () => {
    const store = InMemoryApplicationStore.withEmptySuite("suite-1");
    const duplicateFactory = new FakeStagingFactory(store);
    const service = new StreamingCaseImportService({
      ...store.dependencies(),
      stagingFactory: duplicateFactory
    });
    async function* duplicates(): AsyncGenerator<CaseDefinition, void, void> {
      await Promise.resolve();
      yield definition("case-1");
      yield definition("case-1");
    }
    expect(
      await service.importCases({
        suiteId: "suite-1",
        expectedSuiteRevision: 0,
        definitions: duplicates(),
        signal: new AbortController().signal
      })
    ).toMatchObject({
      ok: false,
      error: { code: "CASE_IMPORT_ITEM_INVALID", index: 1, caseKey: "case-1" }
    });
    expect(store.snapshot().cases).toEqual([]);
    expect(duplicateFactory.cleaned).toBe(true);

    const cancelledFactory = new FakeStagingFactory(store);
    const cancelled = new AbortController();
    cancelled.abort();
    expect(
      await new StreamingCaseImportService({
        ...store.dependencies(),
        stagingFactory: cancelledFactory
      }).importCases({
        suiteId: "suite-1",
        expectedSuiteRevision: 0,
        definitions: (async function* (): AsyncGenerator<CaseDefinition, void, void> {
          await Promise.resolve();
          yield definition("case-2");
        })(),
        signal: cancelled.signal
      })
    ).toEqual({ ok: false, error: { code: "CASE_IMPORT_CANCELLED" } });
    expect(cancelledFactory.cleaned).toBe(true);
  });

  it("主事务已提交后清理失败不改写成功结果", async () => {
    const store = InMemoryApplicationStore.withEmptySuite("suite-1");
    const stagingFactory = new FakeStagingFactory(store, true);
    const service = new StreamingCaseImportService({
      ...store.dependencies(),
      stagingFactory
    });
    const result = await service.importCases({
      suiteId: "suite-1",
      expectedSuiteRevision: 0,
      definitions: (async function* (): AsyncGenerator<CaseDefinition, void, void> {
        await Promise.resolve();
        yield definition("case-1");
      })(),
      signal: new AbortController().signal
    });

    expect(result).toMatchObject({ ok: true, count: 1, suite: { revision: 1 } });
    expect(store.snapshot().cases.map((item) => item.caseKey)).toEqual(["case-1"]);
    expect(stagingFactory.cleaned).toBe(true);
  });
});
