import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WorkPackageExportSnapshotService } from "@cortex-eval/application/src/features/work-packages/work-package-export-snapshot-service.ts";
import type { ConfigurationResource } from "@cortex-eval/application/src/features/configurations/configuration-models.ts";
import type {
  StoredTestCase,
  TestSuite
} from "@cortex-eval/application/src/features/test-suites/test-suite-models.ts";
import { InMemoryApplicationStore } from "@cortex-eval/application/test/test-support/in-memory-application-store.ts";
import { CaseImportWorkspaceManager } from "@cortex-eval/storage-sqlite/src/case-import-workspace.ts";
import { receiveWorkPackageExport } from "@cortex-eval/work-package/src/work-package-export-receiver.ts";
import { validateWorkPackage } from "@cortex-eval/work-package/src/work-package-validator.ts";
import { runBenchmark } from "../../../tooling/src/benchmark-harness.ts";
import { afterEach, describe, expect, it } from "vitest";

import { WorkPackageExportService } from "../src/work-package-export-service.ts";

const ID = "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeeee";
const ENDPOINT_ID = "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeee1";
const EVALUATOR_ID = "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeee2";
const ANALYZER_ID = "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeee3";
const ANALYSIS_ID = "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeee4";
const PROMPT_ID = "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeee5";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const roots: string[] = [];

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function seed(store: InMemoryApplicationStore, caseCount = 1): void {
  const suite: TestSuite = {
    id: ID,
    name: "Export",
    description: "service",
    caseCount,
    suiteHash: HASH_A,
    revision: 1,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z"
  };
  const common = {
    revision: 1,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z"
  } as const;
  const llm = {
    providerType: "GOOGLE_GEMINI" as const,
    model: "gemini-2.5-flash",
    thinkingLevel: "OFF" as const,
    temperature: 0,
    topP: 1,
    maxOutputTokens: 1024,
    timeoutMs: 60_000,
    structuredOutput: "JSON_SCHEMA" as const,
    apiKey: { kind: "ENV_SECRET" as const, envKey: "GEMINI_API_KEY" }
  };
  const configurations: ConfigurationResource[] = [
    {
      ...common,
      id: ENDPOINT_ID,
      kind: "ENDPOINT",
      name: "Endpoint",
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
      kind: "LLM",
      name: "Evaluator",
      semanticHash: HASH_A,
      definition: llm
    },
    {
      ...common,
      id: ANALYZER_ID,
      kind: "LLM",
      name: "Analyzer",
      semanticHash: HASH_B,
      definition: llm
    },
    {
      ...common,
      id: ANALYSIS_ID,
      kind: "CASE_ANALYSIS_PROMPT",
      name: "Analysis",
      semanticHash: HASH_A,
      definition: {
        kind: "CASE_ANALYSIS",
        promptKey: "analysis",
        messages: [{ role: "USER", content: "Analyze {{run_context}}" }]
      }
    },
    {
      ...common,
      id: PROMPT_ID,
      kind: "LLM_RUBRIC_PROMPT",
      name: "Quality",
      semanticHash: HASH_B,
      definition: {
        kind: "LLM_RUBRIC",
        promptKey: "quality",
        messages: [{ role: "USER", content: "Judge quality" }]
      }
    }
  ];
  store.seedSuite(suite);
  for (let ordinal = 0; ordinal < caseCount; ordinal += 1) {
    const number = String(ordinal + 1).padStart(4, "0");
    const caseKey = `case-${number}`;
    const requestId = `req-${number}`;
    const taskId = `task-${number}`;
    const assertion = {
      type: "llm-rubric",
      metric: "quality",
      weight: 1,
      rubricPrompt: "prompt://quality"
    } as const;
    const definition = {
      caseKey,
      description: "service",
      threshold: 1,
      task: "evaluate",
      requestBody: { text: "hello" },
      metadata: {
        requestId,
        taskId,
        businessModule: "service",
        scenarioTag: "roundtrip"
      },
      assertions: [assertion]
    };
    const storedCase: StoredTestCase = {
      id: `018f22aa-33bb-7ccc-8ddd-${String(ordinal + 6).padStart(12, "0")}`,
      suiteId: ID,
      caseKey,
      ordinal,
      description: "service",
      businessModule: "service",
      scenarioTag: "roundtrip",
      assertionTypes: ["llm-rubric"],
      metrics: ["quality"],
      definition,
      definitionJson: {
        contractVersion: "cortex.case-definition.v1",
        description: "service",
        threshold: 1,
        vars: { task: "evaluate", request_body: { text: "hello" } },
        metadata: {
          case_id: caseKey,
          req_id: requestId,
          task_id: taskId,
          business_module: "service",
          scenario_tag: "roundtrip"
        },
        assert: [assertion]
      },
      rubricPromptKeys: ["quality"],
      definitionHash: HASH_B,
      revision: 0,
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z"
    };
    store.seedCase(storedCase);
  }
  for (const configuration of configurations) store.seedConfiguration(configuration);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("platform Work Package export service", () => {
  it("prepares a reconciled body and removes its workspace after the body is consumed", async () => {
    const project = await temporaryRoot("cortex-work-package-service-");
    const temporary = join(project, "tmp");
    await mkdir(temporary, { mode: 0o700 });
    const store = new InMemoryApplicationStore();
    seed(store);
    const workspaces = new CaseImportWorkspaceManager({
      containmentRoot: project,
      temporaryRoot: temporary,
      processLiveness: {
        processStartedAt: (): Promise<string> => Promise.resolve("process-start")
      },
      now: (): number => Date.parse("2026-07-14T00:00:00.000Z"),
      nonce: (): string => "service-workspace-nonce",
      pid: process.pid,
      ttlMs: 60_000,
      workspacePrefix: "work-package-export-"
    });
    const service = new WorkPackageExportService({
      snapshots: new WorkPackageExportSnapshotService({ transactionManager: store }),
      workspaces,
      nextId: (): string => ID,
      now: (): string => "2026-07-14T00:00:00.000Z"
    });
    const body = await service.prepare(
      {
        suiteId: ID,
        endpointConfigId: ENDPOINT_ID,
        evaluatorConfigId: EVALUATOR_ID,
        analyzerConfigId: ANALYZER_ID,
        analysisPromptId: ANALYSIS_ID
      },
      new AbortController().signal
    );
    const targetParent = await temporaryRoot("cortex-work-package-received-");
    const target = join(targetParent, "package");
    await receiveWorkPackageExport(body, target, {
      nonce: "service-receiver",
      owner: {
        pid: process.pid,
        processStartedAt: "process-start",
        executionId: null,
        acquiredAt: "2026-07-14T00:00:00.000Z"
      }
    });

    await expect(
      validateWorkPackage(target, {
        pid: process.pid,
        processStartedAt: "process-start",
        executionId: null,
        acquiredAt: "2026-07-14T00:00:00.000Z"
      })
    ).resolves.toMatchObject({ manifest: { packageId: ID } });
    expect(await readdir(temporary)).toEqual([]);
  });

  it("千级 Case 完整导出与接收预热一次、测量五次的中位数不超过十秒", async () => {
    const project = await temporaryRoot("cortex-work-package-performance-");
    const temporary = join(project, "tmp");
    const targets = join(project, "targets");
    await mkdir(temporary, { mode: 0o700 });
    await mkdir(targets, { mode: 0o700 });
    const store = new InMemoryApplicationStore();
    seed(store, 1_000);
    const service = new WorkPackageExportService({
      snapshots: new WorkPackageExportSnapshotService({ transactionManager: store }),
      workspaces: new CaseImportWorkspaceManager({
        containmentRoot: project,
        temporaryRoot: temporary,
        processLiveness: {
          processStartedAt: (): Promise<string> => Promise.resolve("process-start")
        },
        now: (): number => Date.parse("2026-07-14T00:00:00.000Z"),
        nonce: (): string => "performance-workspace-nonce",
        pid: process.pid,
        ttlMs: 60_000,
        workspacePrefix: "work-package-export-"
      }),
      nextId: (): string => ID,
      now: (): string => "2026-07-14T00:00:00.000Z"
    });
    let iteration = 0;
    const benchmark = await runBenchmark(
      async () => {
        iteration += 1;
        const body = await service.prepare(
          {
            suiteId: ID,
            endpointConfigId: ENDPOINT_ID,
            evaluatorConfigId: EVALUATOR_ID,
            analyzerConfigId: ANALYZER_ID,
            analysisPromptId: ANALYSIS_ID
          },
          new AbortController().signal
        );
        const target = join(targets, `package-${iteration}`);
        const result = await receiveWorkPackageExport(body, target, {
          nonce: `performance-receiver-${iteration}`,
          owner: {
            pid: process.pid,
            processStartedAt: "process-start",
            executionId: null,
            acquiredAt: "2026-07-14T00:00:00.000Z"
          }
        });
        expect(result.targetPath).toBe(target);
      },
      1,
      5
    );

    expect(benchmark.environment).toMatchObject({ platform: "darwin", architecture: "arm64" });
    expect(benchmark.medianMs).toBeLessThanOrEqual(10_000);
    process.stdout.write(
      `${JSON.stringify({ gate: "P10_WORK_PACKAGE_EXPORT_PERFORMANCE", benchmark })}\n`
    );
    expect(await readdir(temporary)).toEqual([]);
  }, 90_000);
});
