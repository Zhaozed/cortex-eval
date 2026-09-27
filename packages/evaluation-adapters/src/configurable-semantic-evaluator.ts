import type {
  PlatformSemanticEvaluator,
  PlatformSemanticEvaluation
} from "@cortex-eval/application/src/features/evaluation/semantic-evaluation-port.ts";
import { SemanticEvaluationContractV1Schema } from "@cortex-eval/contracts/src/semantic-evaluation-contracts.ts";
import {
  createFrozenEvaluatorModelClient,
  type CreateFrozenEvaluatorModelClientInput
} from "./frozen-evaluator-model-client.ts";
import type { EvaluatorModelClient } from "./evaluator-bridge-v2.ts";
import { createBriefLlmProvider } from "./brief-llm-provider.ts";
import { createJevSemanticEvaluator } from "./jev-semantic-evaluator.ts";
import type { JevProvider } from "./jev-evaluator.ts";

/** Select exactly the Case's judge; an unavailable provider is an error, never a fallback. */
export function createConfigurableSemanticEvaluator(input: {
  readonly jevProvider?: JevProvider;
  readonly readSecret: (key: string) => string | undefined;
  readonly createLlmClient?: (input: CreateFrozenEvaluatorModelClientInput) => EvaluatorModelClient;
}): PlatformSemanticEvaluator {
  return {
    async evaluate(request): Promise<PlatformSemanticEvaluation> {
      const contract = SemanticEvaluationContractV1Schema.parse(
        request.caseDefinition.semanticEvaluation
      );
      if (contract.brief?.judge !== "LLM") {
        if (!input.jevProvider) throw new Error("JEV_NOT_CONFIGURED");
        return createJevSemanticEvaluator({ provider: input.jevProvider }).evaluate(request);
      }
      if (!request.evaluator) throw new Error("BRIEF_LLM_NOT_CONFIGURED");
      const config = request.evaluator.definition;
      const client = (input.createLlmClient ?? createFrozenEvaluatorModelClient)({
        config,
        readSecret: input.readSecret
      });
      const provider = createBriefLlmProvider({
        client,
        model: config.model,
        providerType: config.providerType,
        timeoutMs: config.timeoutMs
      });
      return createJevSemanticEvaluator({ provider }).evaluate(request);
    }
  };
}
