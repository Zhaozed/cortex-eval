import type {
  PlatformRunResourceReader,
  PlatformRunTransactionManager
} from "../src/features/runs/platform-run-ports.ts";
import type { RunArtifactStore } from "../src/features/runs/run-artifact-port.ts";
import type { RestExecutor } from "../src/features/runs/run-rest-models.ts";
import { PlatformRunService } from "../src/features/runs/platform-run-service.ts";
import type { ConfigurationResource } from "../src/features/configurations/configuration-models.ts";
import type { StoredTestCase, TestSuite } from "../src/features/test-suites/test-suite-models.ts";
import { caseDefinitionJson } from "@cortex-eval/domain/src/domain-case-projection.ts";
import { hashCaseDefinition } from "@cortex-eval/domain/src/domain-hash-inputs.ts";
import {
  hashEndpointConfig,
  hashLlmConfig,
  hashSuite
} from "@cortex-eval/domain/src/domain-resource-hashes.ts";
import { describe, expect, it } from "vitest";

import { MemoryPlatformRunStore } from "../test-support/in-memory-platform-run-store.ts";
import {
  MemoryArtifacts,
  MemoryRunEvents,
  SuccessfulRestExecutor
} from "../test-support/platform-run-resilience-fixtures.ts";

const RUN_ID = "01900000-0000-7000-8000-000000000001";
const SUITE_ID = "01900000-0000-7000-8000-000000000100";
const ENDPOINT_ID = "01900000-0000-7000-8000-000000000200";
const EVALUATOR_ID = "01900000-0000-7000-8000-000000000300";
const NOW = "2026-07-13T00:00:00.000Z";
const definition = {
  caseKey: "case-1",
  description: "Case",
  threshold: 1,
  task: "route",
  requestBody: { input: "hello" },
  metadata: {
    requestId: "request-1",
    taskId: "task-1",
    businessModule: "chat",
    scenarioTag: "smoke"
  },
  assertions: [{ type: "equals", metric: "quality", weight: 1 }]
} as const;
const definitionJson = caseDefinitionJson(definition);
const definitionHash = hashCaseDefinition({
  contractVersion: "cortex.case-definition.v1",
  caseKey: definition.caseKey,
  definition: definitionJson
});
const suiteHash = hashSuite({
  contractVersion: "cortex.suite.v1",
  cases: [{ caseKey: definition.caseKey, ordinal: 0, definitionHash }]
});
const endpointDefinition = {
  urlTemplate: "https://example.test/{{vars.task}}",
  method: "POST" as const,
  headers: {},
  bodySelector: "/request_body",
  timeoutMs: 1_000,
  defaultConcurrency: 7
};
const evaluatorDefinition = {
  providerType: "GOOGLE_GEMINI" as const,
  apiKey: { kind: "ENV_SECRET" as const, envKey: "GEMINI_API_KEY" },
  model: "gemini-test",
  thinkingLevel: "OFF" as const,
  temperature: 0,
  topP: 1,
  maxOutputTokens: 1_024,
  timeoutMs: 60_000,
  structuredOutput: "JSON_SCHEMA" as const
};
const suite: TestSuite = {
  id: SUITE_ID,
  name: "Suite",
  description: "Suite",
  caseCount: 1,
  suiteHash,
  revision: 0,
  createdAt: NOW,
  updatedAt: NOW
};
const storedCase: StoredTestCase = {
  id: "01900000-0000-7000-8000-000000000400",
  suiteId: SUITE_ID,
  caseKey: definition.caseKey,
  ordinal: 0,
  description: definition.description,
  businessModule: "chat",
  scenarioTag: "smoke",
  assertionTypes: ["equals"],
  metrics: ["quality"],
  definition,
  definitionJson,
  rubricPromptKeys: [],
  definitionHash,
  revision: 0,
  createdAt: NOW,
  updatedAt: NOW
};
const endpoint: ConfigurationResource = {
  kind: "ENDPOINT",
  id: ENDPOINT_ID,
  name: "Endpoint",
  semanticHash: hashEndpointConfig({
    contractVersion: "cortex.endpoint-config.v1",
    config: endpointDefinition
  }),
  definition: endpointDefinition,
  revision: 0,
  createdAt: NOW,
  updatedAt: NOW
};
const evaluator: ConfigurationResource = {
  kind: "LLM",
  id: EVALUATOR_ID,
  name: "Evaluator",
  semanticHash: hashLlmConfig({
    contractVersion: "cortex.llm-config.v1",
    config: evaluatorDefinition
  }),
  definition: evaluatorDefinition,
  revision: 0,
  createdAt: NOW,
  updatedAt: NOW
};


class MemoryResources implements PlatformRunResourceReader {
  /** Current Suite returned to the service. */
  suiteValue: TestSuite | null = suite;
  /** Current Cases returned to the service. */
  caseValues: readonly StoredTestCase[] = [storedCase];
  /** Current Endpoint returned to the service. */
  endpointValue: ConfigurationResource | null = endpoint;
  /** Current Evaluator returned to the service. */
  evaluatorValue: ConfigurationResource | null = evaluator;
  /** Current Rubric Prompt set returned to the service. */
  rubricValues: readonly ConfigurationResource[] = [];

  /** Read the one test Suite. */
  public getSuite(id: string): Promise<TestSuite | null> {
    return Promise.resolve(id === SUITE_ID ? this.suiteValue : null);
  }

  /** Read the one test Case. */
  public listCases(id: string): Promise<readonly StoredTestCase[]> {
    return Promise.resolve(id === SUITE_ID ? this.caseValues : []);
  }

  /** Read one test Configuration. */
  public getConfiguration(
    kind: "ENDPOINT" | "LLM" | "LLM_RUBRIC_PROMPT" | "CASE_ANALYSIS_PROMPT",
    id: string
  ): Promise<ConfigurationResource | null> {
    if (kind === "ENDPOINT" && id === ENDPOINT_ID) return Promise.resolve(this.endpointValue);
    if (kind === "LLM" && id === EVALUATOR_ID) return Promise.resolve(this.evaluatorValue);
    return Promise.resolve(null);
  }

  /** No test Case references a Rubric Prompt. */
  public listRubricPrompts(): Promise<readonly ConfigurationResource[]> {
    return Promise.resolve(this.rubricValues);
  }
}


function serviceFixture(
  restExecutor: RestExecutor,
  artifacts: RunArtifactStore = new MemoryArtifacts(),
  runs: MemoryPlatformRunStore = new MemoryPlatformRunStore(),
  resources: MemoryResources = new MemoryResources(),
  events: MemoryRunEvents = new MemoryRunEvents()
): {
  readonly service: PlatformRunService;
  readonly runs: MemoryPlatformRunStore;
  readonly events: MemoryRunEvents;
} {
  const manager: PlatformRunTransactionManager = {
    execute: (work) => work({ resources, runs })
  };
  return {
    runs,
    events,
    service: new PlatformRunService({
      transactionManager: manager,
      restExecutor,
      artifactStore: artifacts,
      clock: { now: (): string => NOW },
      idGenerator: { nextId: (): string => RUN_ID },
      messageResolver: { message: (code): string => code },
      eventSink: events,
      cancellationPollMs: 25
    })
  };
}

describe("PlatformRunService 删除", () => {
  it("删除区分缺失、运行中与被引用，并清理 READY 运行", async () => {
    const fixture = serviceFixture(new SuccessfulRestExecutor());
    expect(await fixture.service.deleteRun({ runId: RUN_ID })).toEqual({
      ok: false,
      error: { code: "RUN_NOT_FOUND" }
    });
    await fixture.service.create({
      suiteId: SUITE_ID,
      endpointConfigId: ENDPOINT_ID,
      evaluatorConfigId: EVALUATOR_ID,
      runMode: "STAGED"
    });
    const created = fixture.runs.values.get(RUN_ID);
    if (created === undefined) throw new Error("TEST_RUN_MISSING");
    fixture.runs.values.set(RUN_ID, { ...created, status: "RUNNING" });
    expect(await fixture.service.deleteRun({ runId: RUN_ID })).toEqual({
      ok: false,
      error: { code: "RESOURCE_IN_ACTIVE_RUN" }
    });
    fixture.runs.values.set(RUN_ID, created);
    expect(await fixture.service.deleteRun({ runId: RUN_ID })).toEqual({ ok: true });
    expect(fixture.runs.values.has(RUN_ID)).toBe(false);
  });

  it("删除拒绝被重跑引用或复用结果引用的源运行", async () => {
    const fixture = serviceFixture(new SuccessfulRestExecutor());
    await fixture.service.create({
      suiteId: SUITE_ID,
      endpointConfigId: ENDPOINT_ID,
      evaluatorConfigId: EVALUATOR_ID,
      runMode: "STAGED"
    });
    const source = fixture.runs.values.get(RUN_ID);
    if (source === undefined) throw new Error("TEST_RUN_MISSING");
    const RERUN_ID = "01900000-0000-7000-8000-000000000010";
    fixture.runs.values.set(RERUN_ID, {
      ...source,
      id: RERUN_ID,
      sourceRunId: RUN_ID,
      rerunMode: "RETRY_FAILED"
    });
    expect(await fixture.service.deleteRun({ runId: RUN_ID })).toEqual({
      ok: false,
      error: { code: "RUN_REFERENCED" }
    });
    expect(await fixture.service.deleteRun({ runId: RERUN_ID })).toEqual({ ok: true });
    expect(await fixture.service.deleteRun({ runId: RUN_ID })).toEqual({ ok: true });
  });
});
