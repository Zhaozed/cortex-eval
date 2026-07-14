import type { ConfigurationResource } from "../src/features/configurations/configuration-models.ts";
import type { StoredTestCase, TestSuite } from "../src/features/test-suites/test-suite-models.ts";
import { describe, expect, it } from "vitest";

import {
  WorkPackageExportSnapshotService,
  type WorkPackageExportSelection
} from "../src/features/work-packages/work-package-export-snapshot-service.ts";
import { InMemoryApplicationStore } from "./test-support/in-memory-application-store.ts";

const SUITE_ID = "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeeee";
const ENDPOINT_ID = "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeee1";
const EVALUATOR_ID = "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeee2";
const ANALYZER_ID = "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeee3";
const ANALYSIS_PROMPT_ID = "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeee4";
const RUBRIC_ID = "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeee5";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const request: WorkPackageExportSelection = {
  suiteId: SUITE_ID,
  endpointConfigId: ENDPOINT_ID,
  evaluatorConfigId: EVALUATOR_ID,
  analyzerConfigId: ANALYZER_ID,
  analysisPromptId: ANALYSIS_PROMPT_ID
};

function suite(): TestSuite {
  return {
    id: SUITE_ID,
    name: "Export Suite",
    description: "snapshot",
    caseCount: 2,
    suiteHash: HASH_A,
    revision: 3,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z"
  };
}

function storedCase(ordinal: number, promptKeys: readonly string[]): StoredTestCase {
  const caseKey = `case-${ordinal + 1}`;
  const definition = {
    caseKey,
    description: "exported",
    threshold: 1,
    task: "evaluate",
    requestBody: { text: caseKey },
    metadata: {
      requestId: `req-${caseKey}`,
      taskId: `task-${caseKey}`,
      businessModule: "export",
      scenarioTag: "snapshot"
    },
    assertions: [{ type: "equals", metric: "exact", value: "ok", weight: 1 }]
  };
  const definitionJson = {
    contractVersion: "cortex.case-definition.v1",
    description: "exported",
    threshold: 1,
    vars: { task: "evaluate", request_body: { text: caseKey } },
    metadata: {
      case_id: caseKey,
      req_id: `req-${caseKey}`,
      task_id: `task-${caseKey}`,
      business_module: "export",
      scenario_tag: "snapshot"
    },
    assert: [{ type: "equals", metric: "exact", value: "ok", weight: 1 }]
  };
  return {
    id: `018f22aa-33bb-7ccc-8ddd-${String(ordinal + 10).padStart(12, "0")}`,
    suiteId: SUITE_ID,
    caseKey,
    ordinal,
    description: definition.description,
    businessModule: "export",
    scenarioTag: "snapshot",
    assertionTypes: ["equals"],
    metrics: ["exact"],
    definition,
    definitionJson,
    rubricPromptKeys: promptKeys,
    definitionHash: ordinal === 0 ? HASH_A : HASH_B,
    revision: 0,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z"
  };
}

function configurations(): readonly ConfigurationResource[] {
  const common = {
    revision: 2,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z"
  } as const;
  const llmDefinition = {
    providerType: "GOOGLE_GEMINI",
    model: "gemini-2.5-flash",
    apiKey: { kind: "ENV_SECRET", envKey: "GEMINI_API_KEY" },
    thinkingLevel: "OFF",
    temperature: 0,
    topP: 1,
    maxOutputTokens: 1024,
    timeoutMs: 60_000,
    structuredOutput: "JSON_SCHEMA"
  } as const;
  return [
    {
      ...common,
      id: ENDPOINT_ID,
      name: "Endpoint",
      kind: "ENDPOINT",
      semanticHash: HASH_A,
      definition: {
        urlTemplate: "https://example.com/evaluate",
        method: "POST",
        headers: {},
        bodySelector: "/request_body",
        timeoutMs: 60_000,
        defaultConcurrency: 4
      }
    },
    {
      ...common,
      id: EVALUATOR_ID,
      name: "Evaluator",
      kind: "LLM",
      semanticHash: HASH_A,
      definition: llmDefinition
    },
    {
      ...common,
      id: ANALYZER_ID,
      name: "Analyzer",
      kind: "LLM",
      semanticHash: HASH_B,
      definition: llmDefinition
    },
    {
      ...common,
      id: ANALYSIS_PROMPT_ID,
      name: "Analysis",
      kind: "CASE_ANALYSIS_PROMPT",
      semanticHash: HASH_A,
      definition: {
        kind: "CASE_ANALYSIS",
        promptKey: "analysis",
        messages: [{ role: "USER", content: "Analyze {{run_context}}" }]
      }
    },
    {
      ...common,
      id: RUBRIC_ID,
      name: "Quality",
      kind: "LLM_RUBRIC_PROMPT",
      semanticHash: HASH_B,
      definition: {
        kind: "LLM_RUBRIC",
        promptKey: "quality",
        messages: [{ role: "USER", content: "Judge quality" }]
      }
    }
  ];
}

function seededStore(): InMemoryApplicationStore {
  const store = new InMemoryApplicationStore();
  store.seedSuite(suite());
  store.seedCase(storedCase(0, ["quality"]));
  store.seedCase(storedCase(1, []));
  for (const configuration of configurations()) store.seedConfiguration(configuration);
  return store;
}

function storeWithSuite(
  value: TestSuite,
  cases: readonly StoredTestCase[]
): InMemoryApplicationStore {
  const store = new InMemoryApplicationStore();
  store.seedSuite(value);
  for (const item of cases) store.seedCase(item);
  for (const configuration of configurations()) store.seedConfiguration(configuration);
  return store;
}

describe("Work Package export snapshot service", () => {
  it("captures resources, pages Cases and revalidates the same current facts", async () => {
    const store = seededStore();
    const service = new WorkPackageExportSnapshotService({ transactionManager: store });
    const session = await service.begin(request);
    const cases: StoredTestCase[] = [];
    for await (const item of service.streamCases(session)) cases.push(item);
    const prompts = service.resolveRubricPrompts(
      session,
      cases.flatMap((item) => item.rubricPromptKeys)
    );
    await expect(service.revalidate(session, prompts)).resolves.toBeUndefined();

    expect(cases.map((item) => item.caseKey)).toEqual(["case-1", "case-2"]);
    expect(prompts.map((item) => item.definition.promptKey)).toEqual(["quality"]);
    expect(session.endpoint.id).toBe(ENDPOINT_ID);
    expect(store.transactionCount).toBeGreaterThanOrEqual(3);
  });

  it("rejects a Suite revision drift before exposing a completed snapshot", async () => {
    const store = seededStore();
    const service = new WorkPackageExportSnapshotService({ transactionManager: store });
    const session = await service.begin(request);
    await store.execute(async (transaction) => {
      const changed = { ...suite(), revision: 4, updatedAt: "2026-07-14T01:00:00.000Z" };
      await transaction.testSuites.updateSuiteDetails(changed, 3);
    });
    await expect(
      (async (): Promise<void> => {
        for await (const _item of service.streamCases(session)) void _item;
      })()
    ).rejects.toThrow("EXPORT_REVISION_CONFLICT");
  });

  it("rejects a referenced Rubric Prompt absent from the captured resource set", async () => {
    const store = seededStore();
    store.seedCase({ ...storedCase(2, ["missing"]), ordinal: 2 });
    const service = new WorkPackageExportSnapshotService({ transactionManager: store });
    const session = await service.begin(request);
    expect(() => service.resolveRubricPrompts(session, ["missing"])).toThrow(
      "RUBRIC_PROMPT_NOT_FOUND"
    );
  });

  it("rejects missing or empty Suite and incomplete configuration selections", async () => {
    const missing = new WorkPackageExportSnapshotService({
      transactionManager: new InMemoryApplicationStore()
    });
    await expect(missing.begin(request)).rejects.toThrow("SUITE_NOT_FOUND");

    const emptyStore = storeWithSuite({ ...suite(), caseCount: 0 }, []);
    const empty = new WorkPackageExportSnapshotService({ transactionManager: emptyStore });
    await expect(empty.begin(request)).rejects.toThrow("RUN_SUITE_EMPTY");

    const incompleteStore = storeWithSuite({ ...suite(), caseCount: 1 }, [storedCase(0, [])]);
    const incomplete = new WorkPackageExportSnapshotService({
      transactionManager: incompleteStore
    });
    await expect(
      incomplete.begin({ ...request, evaluatorConfigId: "018f22aa-33bb-7ccc-8ddd-000000000099" })
    ).rejects.toThrow("CONFIGURATION_NOT_FOUND");
  });

  it("rejects ordinal gaps and a final Case count inconsistent with the frozen Suite", async () => {
    const gapStore = storeWithSuite({ ...suite(), caseCount: 1 }, [storedCase(1, [])]);
    const gapService = new WorkPackageExportSnapshotService({ transactionManager: gapStore });
    const gapSession = await gapService.begin(request);
    await expect(
      (async (): Promise<void> => {
        for await (const item of gapService.streamCases(gapSession)) void item;
      })()
    ).rejects.toThrow("EXPORT_REVISION_CONFLICT");

    const countStore = storeWithSuite({ ...suite(), caseCount: 3 }, [
      storedCase(0, []),
      storedCase(1, [])
    ]);
    const countService = new WorkPackageExportSnapshotService({ transactionManager: countStore });
    const countSession = await countService.begin(request);
    await expect(
      (async (): Promise<void> => {
        for await (const item of countService.streamCases(countSession)) void item;
      })()
    ).rejects.toThrow("EXPORT_REVISION_CONFLICT");
  });

  it("pages beyond the fixed snapshot boundary and rejects revalidation drift", async () => {
    const cases = Array.from({ length: 101 }, (_, ordinal) => storedCase(ordinal, []));
    const store = storeWithSuite({ ...suite(), caseCount: cases.length }, cases);
    const service = new WorkPackageExportSnapshotService({ transactionManager: store });
    const session = await service.begin(request);
    const streamed: StoredTestCase[] = [];
    for await (const item of service.streamCases(session)) streamed.push(item);
    expect(streamed).toHaveLength(101);

    await store.execute(async (transaction) => {
      await transaction.testSuites.updateSuiteDetails(
        { ...session.suite, revision: session.suite.revision + 1 },
        session.suite.revision
      );
    });
    await expect(service.revalidate(session, [])).rejects.toThrow("EXPORT_REVISION_CONFLICT");
  });
});
