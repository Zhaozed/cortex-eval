import type { Generated } from "kysely";

/** SQLite row for current Test Suite facts. */
export interface TestSuiteTable {
  /** Internal identity. */
  id: string;
  /** Unique display name. */
  name: string;
  /** Display description. */
  description: string;
  /** Derived Case count. */
  case_count: number;
  /** Semantic Suite hash. */
  suite_hash: string;
  /** Optimistic concurrency token. */
  revision: Generated<number>;
  /** Creation time. */
  created_at: string;
  /** Last update time. */
  updated_at: string;
}

/** SQLite row for current Test Case facts. */
export interface TestCaseTable {
  /** Internal identity. */
  id: string;
  /** Owning Suite. */
  suite_id: string;
  /** Stable Case key. */
  case_key: string;
  /** Zero-based order. */
  ordinal: number;
  /** Display description. */
  description: string;
  /** Derived business module. */
  business_module: string;
  /** Derived scenario tag. */
  scenario_tag: string;
  /** Derived Assertion type array JSON. */
  assertion_types_json: string;
  /** Derived Metric array JSON. */
  metrics_json: string;
  /** Complete Case Definition JSON. */
  definition_json: string;
  /** Referenced Rubric Prompt key array JSON. */
  rubric_prompt_keys_json: string;
  /** Case Definition hash. */
  definition_hash: string;
  /** Optimistic concurrency token. */
  revision: Generated<number>;
  /** Creation time. */
  created_at: string;
  /** Last update time. */
  updated_at: string;
}

/** SQLite row subset needed for Rubric reference checks. */
export interface LlmRubricPromptTable {
  /** Internal identity. */
  id: string;
  /** Stable Prompt key. */
  prompt_key: string;
  /** Display name. */
  name: string;
  /** Ordered message JSON. */
  messages_json: string;
  /** Prompt hash. */
  prompt_hash: string;
  /** Optimistic concurrency token. */
  revision: Generated<number>;
  /** Creation time. */
  created_at: string;
  /** Last update time. */
  updated_at: string;
}

/** SQLite row for current Endpoint configuration facts. */
export interface EndpointConfigTable {
  /** Internal identity. */
  id: string;
  /** Unique display name. */
  name: string;
  /** URL template. */
  url_template: string;
  /** Fixed HTTP method. */
  method: "POST";
  /** Header union map JSON. */
  headers_json: string;
  /** RFC 6901 body selector. */
  body_selector: string;
  /** Request timeout. */
  timeout_ms: number;
  /** Default REST concurrency. */
  default_concurrency: number;
  /** Semantic configuration hash. */
  config_hash: string;
  /** Optimistic concurrency token. */
  revision: Generated<number>;
  /** Creation time. */
  created_at: string;
  /** Last update time. */
  updated_at: string;
}

/** SQLite row for current LLM configuration facts. */
export interface LlmConfigTable {
  /** Internal identity. */
  id: string;
  /** Unique display name. */
  name: string;
  /** Provider discriminator. */
  provider_type: "GOOGLE_GEMINI" | "OPENAI_COMPATIBLE";
  /** Model identifier. */
  model: string;
  /** Non-secret provider option JSON. */
  options_json: string;
  /** Environment Secret reference JSON. */
  secret_refs_json: string;
  /** Semantic configuration hash. */
  config_hash: string;
  /** Optimistic concurrency token. */
  revision: Generated<number>;
  /** Creation time. */
  created_at: string;
  /** Last update time. */
  updated_at: string;
}

/** SQLite row for current Analysis Prompt facts. */
export interface CaseAnalysisPromptTable {
  /** Internal identity. */
  id: string;
  /** Stable Prompt key. */
  prompt_key: string;
  /** Display name. */
  name: string;
  /** Ordered template message JSON. */
  messages_template_json: string;
  /** Prompt hash. */
  prompt_hash: string;
  /** Optimistic concurrency token. */
  revision: Generated<number>;
  /** Creation time. */
  created_at: string;
  /** Last update time. */
  updated_at: string;
}

/** Placeholder row for tables whose repositories land later in P2. */
export interface DeferredTable {
  /** Prevent accidental query construction before the table mapper exists. */
  readonly __not_queryable_yet: never;
}

/** Complete current SQLite database type map. */
export interface SqliteDatabaseSchema {
  /** Current analyses. */
  case_analysis: DeferredTable;
  /** Current Analysis Prompts. */
  case_analysis_prompt: CaseAnalysisPromptTable;
  /** Frozen REST Case results. */
  case_result: DeferredTable;
  /** Current Endpoint configurations. */
  endpoint_config: EndpointConfigTable;
  /** Normalized evaluation results. */
  eval_result: DeferredTable;
  /** Current LLM configurations. */
  llm_config: LlmConfigTable;
  /** Current Rubric Prompts. */
  llm_rubric_prompt: LlmRubricPromptTable;
  /** Run aggregate roots. */
  run_log: DeferredTable;
  /** Current Cases. */
  test_case: TestCaseTable;
  /** Current Suites. */
  test_suite: TestSuiteTable;
}
