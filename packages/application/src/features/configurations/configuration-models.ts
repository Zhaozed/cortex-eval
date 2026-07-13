import type {
  AnalysisPromptDefinition,
  EndpointConfigDefinition,
  LlmConfigDefinition,
  PromptDefinition
} from "@cortex-eval/domain/src/domain-resource-models.ts";

/** Current Configuration resource family. */
export type ConfigurationResourceKind =
  "ENDPOINT" | "LLM" | "LLM_RUBRIC_PROMPT" | "CASE_ANALYSIS_PROMPT";

/** Current Case reference to one Rubric Prompt key. */
export interface RubricPromptReference {
  /** Referencing Test Suite identity. */
  readonly suiteId: string;
  /** Referencing Suite-local Case key. */
  readonly caseKey: string;
}

/** Exact Rubric Prompt reference query result. */
export type RubricPromptReferenceResult =
  | { readonly ok: true; readonly items: readonly RubricPromptReference[] }
  | { readonly ok: false; readonly error: { readonly code: "CONFIGURATION_NOT_FOUND" } };

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

/** Small current Configuration list projection. */
export interface ConfigurationResourceSummary {
  /** Resource family discriminator. */
  readonly kind: ConfigurationResourceKind;
  /** Internal identity. */
  readonly id: string;
  /** Display name. */
  readonly name: string;
  /** Optimistic-concurrency token. */
  readonly revision: number;
  /** Last update time. */
  readonly updatedAt: string;
}

/** Stable current Configuration list position. */
export interface ConfigurationPageCursor {
  /** Last display name. */
  readonly name: string;
  /** Last internal ID tie-breaker. */
  readonly id: string;
}

/** Current Configuration list query. */
export interface ConfigurationQuery {
  /** Resource family. */
  readonly kind: ConfigurationResourceKind;
  /** Maximum page size. */
  readonly limit: number;
  /** Return resources strictly after this stable sort tuple. */
  readonly afterCursor?: ConfigurationPageCursor | undefined;
}

/** Stable current Configuration page. */
export interface ConfigurationQueryPage {
  /** Small ordered list projections. */
  readonly items: readonly ConfigurationResourceSummary[];
  /** Next stable cursor when another page exists. */
  readonly nextCursor: ConfigurationPageCursor | null;
}

/** Validated Configuration list result. */
export type ConfigurationQueryResult =
  | { readonly ok: true; readonly page: ConfigurationQueryPage }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: "CONFIGURATION_QUERY_INVALID";
        readonly path: "limit" | "afterCursor.name" | "afterCursor.id";
      };
    };

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
