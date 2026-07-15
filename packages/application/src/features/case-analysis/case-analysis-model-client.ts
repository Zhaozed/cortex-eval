import type { AnalysisResultDraft } from "@cortex-eval/domain/src/domain-analysis.ts";
import type {
  AnalysisPromptDefinition,
  LlmConfigDefinition
} from "@cortex-eval/domain/src/domain-resource-models.ts";

import type { FrozenAnalysisVariables } from "./case-analysis-input-builder.ts";

/** One frozen Analyzer request with unrendered structured variables. */
export interface AnalysisModelRequest {
  /** Validated frozen Analyzer configuration. */
  readonly analyzer: LlmConfigDefinition;
  /** Validated frozen Case Analysis Prompt. */
  readonly prompt: AnalysisPromptDefinition;
  /** Complete versioned Analysis variables. */
  readonly variables: FrozenAnalysisVariables;
  /** Owner cancellation signal. */
  readonly signal: AbortSignal;
}

/** Provider-neutral official-SDK Analyzer boundary. */
export interface AnalysisModelClient {
  /** Execute exactly one no-retry structured Analysis call. */
  readonly analyze: (request: AnalysisModelRequest) => Promise<AnalysisResultDraft>;
}
