import {
  MEMORY_EVALUATION_CONTRACT_V1,
  MemoryEvaluationReportV1Schema,
  type MemoryEvaluationCaseV1,
  type MemoryEvaluationInputV1,
  type MemoryEvaluationReportV1,
  type MemoryEvaluationAblationVariantV1
} from "@cortex-eval/contracts/src/memory-evaluation-contracts.ts";
import {
  type CortexAgentMemoryEvaluationRunner,
  type CortexAgentMemoryEvaluationRunnerInput
} from "./cortex-agent-memory-evaluation-runner.ts";
import { scoreMemoryEvaluation, type MemoryEvaluationScore } from "./memory-evaluation-scorer.ts";

export interface MemoryEvaluationServiceResult {
  readonly input: MemoryEvaluationInputV1;
  readonly score: MemoryEvaluationScore;
  readonly report: MemoryEvaluationReportV1;
}

export interface MemoryEvaluationServiceDependencies {
  readonly runner: CortexAgentMemoryEvaluationRunner;
}

function costRisk(replayRequestCount: number): MemoryEvaluationReportV1["costRisk"] {
  if (replayRequestCount === 0) return "NONE";
  if (replayRequestCount <= 2) return "LOW";
  if (replayRequestCount <= 10) return "MEDIUM";
  return "HIGH";
}

/** One-call orchestration boundary for collecting and scoring Cortex-Agent memory state. */
export class MemoryEvaluationService {
  readonly #runner: CortexAgentMemoryEvaluationRunner;

  constructor(dependencies: MemoryEvaluationServiceDependencies) {
    this.#runner = dependencies.runner;
  }

  async evaluate(caseDefinition: MemoryEvaluationCaseV1): Promise<MemoryEvaluationServiceResult> {
    const input = await this.#runner.collect({
      caseDefinition
    } satisfies CortexAgentMemoryEvaluationRunnerInput);
    const score = scoreMemoryEvaluation(input);
    const report = MemoryEvaluationReportV1Schema.parse({
      contractVersion: MEMORY_EVALUATION_CONTRACT_V1,
      caseId: caseDefinition.caseId,
      ownerUserId: caseDefinition.ownerUserId,
      replayMode: this.#runner.replayMode,
      replayRequestCount: input.replayResults.length,
      costRisk: costRisk(input.replayResults.length),
      scores: score,
      warnings: input.warnings
    });
    return { input, score, report };
  }
}

export interface MemoryEvaluationAblationCase {
  readonly variant: MemoryEvaluationAblationVariantV1;
  readonly caseDefinition: MemoryEvaluationCaseV1;
}

export interface MemoryEvaluationAblationRun {
  readonly variant: MemoryEvaluationAblationVariantV1;
  readonly result: MemoryEvaluationServiceResult;
}

export interface MemoryEvaluationAblationSummary {
  readonly runs: readonly MemoryEvaluationAblationRun[];
  readonly memoryLift: {
    readonly retrievalF1: number;
    readonly consumptionF1: number;
    readonly memoryStateF1: number;
    readonly endToEndF1: number;
  };
}

function requireVariant(
  runs: readonly MemoryEvaluationAblationRun[],
  variant: MemoryEvaluationAblationVariantV1
): MemoryEvaluationAblationRun {
  const run = runs.find((item) => item.variant === variant);
  if (run === undefined) throw new Error(`MEMORY_ABLATION_VARIANT_MISSING:${variant}`);
  return run;
}

/** Runs pre-materialized FULL/NO/DISTRACTOR cases and reports deterministic memory lift. */
export async function evaluateMemoryAblation(
  service: MemoryEvaluationService,
  cases: readonly MemoryEvaluationAblationCase[]
): Promise<MemoryEvaluationAblationSummary> {
  const seen = new Set<MemoryEvaluationAblationVariantV1>();
  const runs: MemoryEvaluationAblationRun[] = [];
  for (const item of cases) {
    if (seen.has(item.variant))
      throw new Error(`MEMORY_ABLATION_VARIANT_DUPLICATE:${item.variant}`);
    seen.add(item.variant);
    runs.push({ variant: item.variant, result: await service.evaluate(item.caseDefinition) });
  }
  const full = requireVariant(runs, "FULL_MEMORY").result.score;
  const noMemory = requireVariant(runs, "NO_MEMORY").result.score;
  return {
    runs,
    memoryLift: {
      retrievalF1: full.retrieval.f1 - noMemory.retrieval.f1,
      consumptionF1: full.consumption.f1 - noMemory.consumption.f1,
      memoryStateF1: full.memoryState.f1 - noMemory.memoryState.f1,
      endToEndF1:
        (full.observationExtraction.f1 +
          full.consolidation.f1 +
          full.retrieval.f1 +
          full.consumption.f1) /
          4 -
        (noMemory.observationExtraction.f1 +
          noMemory.consolidation.f1 +
          noMemory.retrieval.f1 +
          noMemory.consumption.f1) /
          4
    }
  };
}
