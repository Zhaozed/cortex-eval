import type {
  AnalysisPromptDefinition,
  EndpointConfigDefinition,
  LlmConfigDefinition,
  PromptDefinition
} from "@cortex-eval/domain/src/domain-resource-models.ts";

/** Current Configuration resource family. */
export type ConfigurationResourceKind =
  "ENDPOINT" | "LLM" | "LLM_RUBRIC_PROMPT" | "CASE_ANALYSIS_PROMPT";

/** Fields shared by all current Configuration resources. */
interface ConfigurationResourceBase {
  /** Internal identity. */
  readonly id: string;
  /** Display name. */
  readonly name: string;
  /** Semantic configuration or Prompt hash. */
  readonly semanticHash: string;
  /** Optimistic-concurrency token. */
  readonly revision: number;
  /** Creation time. */
  readonly createdAt: string;
  /** Last update time. */
  readonly updatedAt: string;
}

/** Current Endpoint resource. */
export interface EndpointConfigurationResource extends ConfigurationResourceBase {
  /** Resource discriminator. */
  readonly kind: "ENDPOINT";
  /** Complete clean Endpoint definition. */
  readonly definition: EndpointConfigDefinition;
}

/** Current LLM resource without a fixed execution role. */
export interface LlmConfigurationResource extends ConfigurationResourceBase {
  /** Resource discriminator. */
  readonly kind: "LLM";
  /** Complete clean LLM definition. */
  readonly definition: LlmConfigDefinition;
}

/** Current LLM Rubric Prompt resource. */
export interface RubricPromptResource extends ConfigurationResourceBase {
  /** Resource discriminator. */
  readonly kind: "LLM_RUBRIC_PROMPT";
  /** Complete clean Prompt definition. */
  readonly definition: PromptDefinition;
}

/** Current Case Analysis Prompt resource. */
export interface AnalysisPromptResource extends ConfigurationResourceBase {
  /** Resource discriminator. */
  readonly kind: "CASE_ANALYSIS_PROMPT";
  /** Complete clean Prompt definition. */
  readonly definition: AnalysisPromptDefinition;
}

/** Closed current Configuration resource union. */
export type ConfigurationResource =
  | EndpointConfigurationResource
  | LlmConfigurationResource
  | RubricPromptResource
  | AnalysisPromptResource;

/** Stable Configuration use-case error. */
export type ConfigurationError =
  | {
      readonly code:
        | "ENDPOINT_CONFIG_INVALID"
        | "LLM_CONFIG_INVALID"
        | "PROMPT_INVALID"
        | "ANALYSIS_PROMPT_INVALID";
      readonly path: string;
    }
  | { readonly code: "CONFIGURATION_NOT_FOUND" }
  | { readonly code: "CONFIGURATION_KIND_CONFLICT" }
  | { readonly code: "RESOURCE_IN_ACTIVE_RUN" }
  | {
      readonly code: "RESOURCE_UNIQUE_CONFLICT";
      readonly field: "name" | "promptKey";
    }
  | { readonly code: "RUBRIC_PROMPT_IN_USE"; readonly promptKey: string }
  | {
      readonly code: "RESOURCE_REVISION_CONFLICT";
      readonly actualRevision: number;
      readonly expectedRevision: number;
    };

/** Exact Configuration mutation result. */
export type ConfigurationMutationResult =
  | { readonly ok: true; readonly resource: ConfigurationResource }
  | { readonly ok: false; readonly error: ConfigurationError };

/** Exact Configuration deletion result. */
export type ConfigurationDeleteResult =
  { readonly ok: true } | { readonly ok: false; readonly error: ConfigurationError };
