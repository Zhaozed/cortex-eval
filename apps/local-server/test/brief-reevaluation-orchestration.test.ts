import type { PlatformRun } from "@cortex-eval/application/src/features/runs/platform-run-models.ts";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { CaseDefinitionV1Schema } from "@cortex-eval/contracts/src/case-contracts.ts";
import { caseFromV1 } from "@cortex-eval/storage-sqlite/src/sqlite-platform-run-mappers.ts";
import { PlatformRerunService } from "@cortex-eval/application/src/features/runs/platform-rerun-service.ts";
import { PlatformRunService } from "@cortex-eval/application/src/features/runs/platform-run-service.ts";
import type { PlatformRunTransactionManager } from "@cortex-eval/application/src/features/runs/platform-run-ports.ts";
import type { RestExecutor } from "@cortex-eval/application/src/features/runs/run-rest-models.ts";
import { MemoryPlatformRunStore } from "@cortex-eval/application/test-support/in-memory-platform-run-store.ts";
import {
  evaluationRun,
  restResult,
  NOW
} from "@cortex-eval/application/test-support/platform-evaluation-service-fixtures.ts";
import {
  MemoryArtifacts,
  MemoryRunEvents
} from "@cortex-eval/application/test-support/platform-run-resilience-fixtures.ts";
import { freezeBriefReevaluation } from "../src/brief-reevaluation.ts";

const TARGET = "01900000-0000-7000-8000-000000000011";
const MODEL = "01900000-0000-7000-8000-000000000012";
function fixture(): {
  runs: MemoryPlatformRunStore;
  source: PlatformRun;
  transactions: PlatformRunTransactionManager;
  service: PlatformRerunService;
} {
  const input = CaseDefinitionV1Schema.parse(
    JSON.parse(
      readFileSync(
        new URL("../../../test_suite/brief-content/daily.case.json", import.meta.url),
        "utf8"
      )
    )
  );
  const runs = new MemoryPlatformRunStore();
  const base = evaluationRun();
  const cases = [0, 1].map((ordinal) => ({
    caseKey: `brief-${ordinal}`,
    ordinal,
    definitionHash: "b".repeat(64),
    definition: { ...caseFromV1(input), caseKey: `brief-${ordinal}` }
  }));
  const source = {
    ...base,
    suite: { ...base.suite, cases },
    status: "COMPLETED" as const,
    stage: "DONE" as const,
    completedAt: NOW,
    restCompletedCount: 2
  };
  runs.values.set(source.id, source);
  for (const c of cases)
    runs.results.set(`${source.id}:${c.caseKey}`, {
      ...restResult,
      caseKey: c.caseKey,
      ordinal: c.ordinal,
      definition: c.definition
    });
  const transactions: PlatformRunTransactionManager = {
    execute: (work) =>
      work({
        runs,
        resources: {
          getSuite: () => Promise.resolve(null),
          listCases: () => Promise.resolve([]),
          listRubricPrompts: () => Promise.resolve([]),
          getConfiguration: (_kind, id) =>
            Promise.resolve(
              id === MODEL
                ? {
                    kind: "LLM",
                    id: MODEL,
                    name: "Judge B",
                    revision: 2,
                    createdAt: NOW,
                    updatedAt: NOW,
                    semanticHash: "d".repeat(64),
                    definition: { ...source.evaluator.definition, model: "judge-b" }
                  }
                : null
            )
        }
      })
  };
  const service = new PlatformRerunService({
    runTransactionManager: transactions,
    evalTransactionManager: {
      execute: (): never => {
        throw new Error("Must not reuse evaluation");
      }
    },
    artifactStore: new MemoryArtifacts(),
    idGenerator: { nextId: (): string => TARGET },
    clock: { now: (): string => NOW },
    prepareBriefReevaluation: freezeBriefReevaluation
  });
  return { runs, source, transactions, service };
}

describe("Brief calibration execution", () => {
  it.each([undefined, "brief-1"])(
    "%s freezes Judge overrides and executes zero generation requests",
    async (caseKey) => {
      const f = fixture();
      const original = structuredClone(f.source);
      const created = await f.service.create({
        sourceRunId: f.source.id,
        mode: "FORCE",
        reevaluateOnly: true,
        caseKey,
        reevaluation: { evaluatorConfigId: MODEL, judgePrompt: "judge prompt v2" }
      });
      const count = caseKey ? 1 : 2;
      expect(created).toMatchObject({
        ok: true,
        plan: { counts: { executeRest: 0, reuseRest: count, executeEval: count, reuseEval: 0 } },
        run: { evaluator: { definition: { model: "judge-b" } } }
      });
      if (!created.ok) throw new Error("create failed");
      for (const c of created.run.suite.cases) {
        expect(c.definition.semanticEvaluation?.brief).toMatchObject({
          judge: "LLM",
          judgePrompt: "judge prompt v2"
        });
        const stored = await f.runs.getRestResult(TARGET, c.caseKey);
        expect(stored?.providerOutput).toEqual(restResult.providerOutput);
        expect(stored?.provenance?.sourceResultHash).toBe(restResult.resultHash);
      }
      const dispatch = vi.fn<RestExecutor["execute"]>((input) => {
        expect(input.cases).toEqual([]);
        return Promise.resolve({ dispatchedCount: 0 });
      });
      const execution = new PlatformRunService({
        transactionManager: f.transactions,
        restExecutor: { execute: dispatch },
        artifactStore: new MemoryArtifacts(),
        clock: { now: (): string => NOW },
        idGenerator: { nextId: (): string => "unused" },
        messageResolver: { message: (code): string => code },
        eventSink: new MemoryRunEvents(),
        cancellationPollMs: 25
      });
      await execution.start({ runId: TARGET, expectedRevision: 0 });
      await execution.waitForIdle();
      expect(await execution.getProgress(TARGET)).toMatchObject({
        status: "READY",
        stage: "EVALUATION",
        restCompletedCount: count
      });
      expect(f.runs.values.get(f.source.id)).toEqual(original);
    }
  );
  it("rejects unknown models without creating a new run", async () => {
    const f = fixture();
    expect(
      await f.service.create({
        sourceRunId: f.source.id,
        mode: "FORCE",
        reevaluateOnly: true,
        reevaluation: { evaluatorConfigId: TARGET }
      })
    ).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(f.runs.values.size).toBe(1);
  });
});
