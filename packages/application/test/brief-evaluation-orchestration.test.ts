import type { PlatformEvaluationEngineResult } from "../src/features/evaluation/platform-evaluation-engine.ts";
import type { ProviderOutput } from "@cortex-eval/domain/src/domain-evaluation.ts";
import { describe, expect, it, vi } from "vitest";
import { PlatformEvaluationService } from "../src/features/evaluation/platform-evaluation-service.ts";
import type { PlatformSemanticEvaluator } from "../src/features/evaluation/semantic-evaluation-port.ts";
import { MemoryPlatformRunStore } from "../test-support/in-memory-platform-run-store.ts";
import { MemoryPlatformEvalRepository } from "../test-support/platform-run-resilience-fixtures.ts";
import {
  evaluationRun,
  restResult,
  RUN_ID
} from "../test-support/platform-evaluation-service-fixtures.ts";
import {
  RunTransactions,
  SuccessfulEvaluationEngine,
  evaluationDependencies
} from "../test-support/platform-evaluation-orchestration-fixtures.ts";

describe("Brief per-case judge failure isolation", () => {
  it.each([true, false])("commits report-ready results with business ok=%s", async (ok) => {
    const runs = new MemoryPlatformRunStore();
    const original = evaluationRun();
    if (restResult.status !== "SUCCEEDED") throw new Error("fixture");
    const first = original.suite.cases[0];
    if (!first) throw new Error("fixture");
    const definition = {
      ...first.definition,
      semanticEvaluation: {
        contractVersion: "cortex.semantic-evaluation-contract.v1",
        goal: "Brief",
        successCriteria: ["事实准确"],
        enabledDimensions: ["response"],
        brief: {
          briefType: "daily",
          checklist: [{ id: "fact", tier: "P0", assertion: "事实", sourceRefs: ["/material"] }],
          constraints: { allowedGenerationStatuses: ["generated"] }
        }
      }
    };
    runs.values.set(RUN_ID, {
      ...original,
      suite: { ...original.suite, cases: [{ ...first, definition }] }
    });
    const providerOutput: ProviderOutput = ok
      ? { ok: true, taskName: "EVAL_BRIEF_REPLAY", resolvedConfig: {}, parsedOutput: {} }
      : { ok: false, errorMessage: "business" };
    runs.results.set(`${RUN_ID}:case-1`, {
      ...restResult,
      definition,
      providerOutput
    });
    const repository = new MemoryPlatformEvalRepository(runs);
    const evaluate = vi.fn<PlatformSemanticEvaluator["evaluate"]>(() =>
      Promise.reject(new Error("BRIEF_JUDGE_EVIDENCE_MISSING:brief.P0.fact"))
    );
    const baseEngine = new SuccessfulEvaluationEngine(new RunTransactions(runs));
    const engine = {
      execute: async (): Promise<PlatformEvaluationEngineResult> => {
        const result = await baseEngine.execute();
        const raw = result.raw as { results: { results: { response: { output: unknown } }[] } };
        const row = raw.results.results[0];
        if (!row) throw new Error("fixture");
        row.response.output = providerOutput.ok
          ? {
              ok: true,
              task_name: providerOutput.taskName,
              resolved_config: providerOutput.resolvedConfig,
              parsed_output: providerOutput.parsedOutput
            }
          : providerOutput;
        return result;
      }
    };
    const service = new PlatformEvaluationService({
      ...evaluationDependencies(runs, engine, repository),
      semanticEvaluator: { evaluate }
    });
    expect((await service.start({ runId: RUN_ID, expectedRevision: 2 })).ok).toBe(true);
    await service.waitForIdle();
    expect(runs.values.get(RUN_ID)).toMatchObject({
      stage: "REPORT",
      status: "READY",
      evalCompletedCount: 1,
      evalErrorCount: ok ? 1 : 0
    });
    if (ok) {
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(repository.completeInput?.results[0]).toMatchObject({
        status: "EVALUATION_ERROR",
        score: null,
        evaluationError: { code: "BRIEF_JUDGE_EVIDENCE_MISSING" }
      });
    } else {
      expect(evaluate).not.toHaveBeenCalled();
      expect(repository.completeInput?.results[0]?.status).toBe("FAIL");
    }
  });
});
