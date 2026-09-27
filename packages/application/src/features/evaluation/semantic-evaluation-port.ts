import type { FrozenRunEvaluator } from "../runs/platform-run-models.ts";
import type { CaseDefinition, ProviderOutput } from "@cortex-eval/domain/src/domain-evaluation.ts";

export type { CaseDefinition, ProviderOutput } from "@cortex-eval/domain/src/domain-evaluation.ts";

/** Provider-neutral semantic decision evidence stored with one Eval Case. */
export interface PlatformSemanticDecision {
  readonly questionId: string;
  readonly question?: string | undefined;
  readonly blocking?: boolean | undefined;
  readonly verdict?: "PASS" | "FAIL" | "NA" | undefined;
  readonly passThreshold?: number | undefined;
  readonly kind: "BOOLEAN" | "CHOICE" | "SCORE";
  readonly value: boolean | number | string;
  readonly probability?: number | undefined;
  readonly confidence?: number | undefined;
  readonly applicable: boolean;
  readonly reason?: string | undefined;
  readonly evidence: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly providerReason?: string | undefined;
  readonly providerResponse?: Readonly<Record<string, unknown>> | undefined;
  readonly platformReason?: string | undefined;
}

/** Aggregated semantic evaluation result independent of the external JEV SDK. */
export interface PlatformSemanticEvaluationResult {
  readonly contractVersion: string;
  readonly passed: boolean;
  readonly score: number;
  readonly decisions: readonly PlatformSemanticDecision[];
  readonly blockingFailures: readonly string[];
  readonly warnings: readonly string[];
}

/** Complete per-Case semantic evaluator evidence. */
export interface PlatformSemanticEvaluation {
  readonly provider: string;
  readonly model: string;
  readonly planVersion: string;
  readonly result: PlatformSemanticEvaluationResult;
  readonly metrics?:
    | {
        readonly durationMs: number;
        readonly requestCount: number;
        readonly inputTokens?: number | undefined;
        readonly outputTokens?: number | undefined;
        readonly usageComplete: boolean;
      }
    | undefined;
}

/** Infrastructure port for optional case-level semantic evaluation. */
export interface PlatformSemanticEvaluator {
  /** Evaluate only a successful REST output; the port must not execute Agent tools. */
  readonly evaluate: (input: {
    readonly caseDefinition: CaseDefinition;
    readonly providerOutput: ProviderOutput;
    /** Frozen Run evaluator, used only when the Case selects the LLM judge. */
    readonly evaluator?: FrozenRunEvaluator;
    /** REST wall-clock duration, supplied separately because it is not part of ProviderOutput. */
    readonly durationMs?: number;
    readonly signal: AbortSignal;
  }) => Promise<PlatformSemanticEvaluation>;
}
