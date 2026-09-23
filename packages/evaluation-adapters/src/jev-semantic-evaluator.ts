import { evaluateBrief } from "./brief-semantic-evaluator.ts";
import { SemanticEvaluationContractV1Schema } from "@cortex-eval/contracts/src/semantic-evaluation-contracts.ts";
import { compileJevDecisionPlan } from "@cortex-eval/authoring/src/jev-decision-plan.ts";
import type {
  PlatformSemanticEvaluator,
  PlatformSemanticEvaluation,
  ProviderOutput
} from "@cortex-eval/application/src/features/evaluation/semantic-evaluation-port.ts";

import { evaluateWithJev, type JevProvider, type JevRequestUsage } from "./jev-evaluator.ts";
import { normalizeAgentTrace } from "./jev-trace-normalizer.ts";

/** Build the application semantic-evaluation adapter backed by a JEV provider. */
export function createJevSemanticEvaluator(input: {
  readonly provider: JevProvider;
  readonly model?: string | undefined;
}): PlatformSemanticEvaluator {
  return {
    async evaluate({
      caseDefinition,
      providerOutput,
      durationMs,
      signal
    }): Promise<PlatformSemanticEvaluation> {
      const started = performance.now();
      const usages: JevRequestUsage[] = [];
      let requestCount = 0;
      // Per-evaluation wrapper: concurrent Cases must never share a last-usage slot.
      const provider: JevProvider = {
        ...input.provider,
        async evaluate(request, requestSignal) {
          requestCount += 1;
          let usage: JevRequestUsage = {};
          try {
            return await input.provider.evaluate(request, requestSignal, (value) => {
              usage = value;
            });
          } finally {
            usages.push(usage);
          }
        }
      };
      const contract = SemanticEvaluationContractV1Schema.parse(caseDefinition.semanticEvaluation);
      const plan = compileJevDecisionPlan(contract);
      const trace = normalizeAgentTrace(providerOutputForTrace(providerOutput, durationMs), {
        task:
          typeof caseDefinition.requestBody.text === "string"
            ? caseDefinition.requestBody.text
            : caseDefinition.task
      });
      const result = contract.brief
        ? await evaluateBrief({
            contract,
            plan,
            requestBody: caseDefinition.requestBody,
            parsedOutput: providerOutput.ok ? providerOutput.parsedOutput : null,
            provider,
            signal
          })
        : await evaluateWithJev({
            contract,
            plan,
            trace,
            provider,
            signal
          });
      return {
        provider: input.provider.id,
        model: contract.model ?? input.model ?? input.provider.model ?? "unknown",
        planVersion: contract.brief ? "cortex.brief-atomic-plan.v1" : contract.contractVersion,
        result,
        metrics: {
          durationMs: Math.round(performance.now() - started),
          requestCount,
          ...(usages.some((u) => u.inputTokens !== undefined)
            ? { inputTokens: usages.reduce((n, u) => n + (u.inputTokens ?? 0), 0) }
            : {}),
          ...(usages.some((u) => u.outputTokens !== undefined)
            ? { outputTokens: usages.reduce((n, u) => n + (u.outputTokens ?? 0), 0) }
            : {}),
          usageComplete:
            requestCount > 0 &&
            usages.every((u) => u.inputTokens !== undefined && u.outputTokens !== undefined)
        }
      };
    }
  };
}

function providerOutputForTrace(
  value: ProviderOutput,
  durationMs?: number
): Record<string, unknown> {
  if (!value.ok) {
    return {
      ok: false,
      ...(durationMs === undefined ? {} : { duration_ms: durationMs }),
      error_message: value.errorMessage,
      ...(value.parsedOutput === undefined ? {} : { parsed_output: value.parsedOutput })
    };
  }
  return {
    ok: true,
    ...(durationMs === undefined ? {} : { duration_ms: durationMs }),
    task_name: value.taskName,
    resolved_config: value.resolvedConfig,
    parsed_output: value.parsedOutput
  };
}
