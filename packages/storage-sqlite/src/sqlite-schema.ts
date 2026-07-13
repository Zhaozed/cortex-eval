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

/** SQLite row for one immutable Run aggregate and progress facts. */
export interface RunLogTable {
  /** Internal Run identity. */
  id: string;
  /** Platform or imported source. */
  source_type: "PLATFORM" | "OFFLINE_IMPORT";
  /** Offline Work Package identity. */
  source_package_id: string | null;
  /** Offline Execution identity. */
  execution_id: string | null;
  /** Source Run for rerun flows. */
  source_run_id: string | null;
  /** Rerun behavior. */
  rerun_mode: "NONE" | "RETRY_FAILED" | "FORCE";
  /** Current Suite reference while it exists. */
  suite_id: string | null;
  /** Current Endpoint reference while it exists. */
  endpoint_config_id: string | null;
  /** Current Evaluator reference while it exists. */
  evaluator_config_id: string | null;
  /** Frozen Suite snapshot JSON. */
  suite_snapshot_json: string;
  /** Frozen Endpoint snapshot JSON. */
  endpoint_snapshot_json: string;
  /** Frozen Evaluator snapshot JSON. */
  evaluator_snapshot_json: string;
  /** Frozen Rubric Prompt set JSON. */
  rubric_prompts_snapshot_json: string;
  /** Frozen Run context hash. */
  run_context_hash: string;
  /** Exact Promptfoo version. */
  promptfoo_version: string;
  /** Frozen contract version JSON. */
  contract_versions_json: string;
  /** Frozen execution limits JSON. */
  run_execution_limits_json: string;
  /** Staged or pipeline execution. */
  run_mode: "STAGED" | "PIPELINE";
  /** Run lifecycle status. */
  status:
    | "READY"
    | "RUNNING"
    | "COMPLETED"
    | "COMPLETED_WITH_ERRORS"
    | "FAILED"
    | "CANCELLED"
    | "INTERRUPTED";
  /** Current or terminal stage. */
  stage: "REST" | "EVALUATION" | "REPORT" | "DONE";
  /** Optimistic state and progress token. */
  lock_revision: Generated<number>;
  /** Explicit cancellation request time. */
  cancel_requested_at: string | null;
  /** Durable REST completion count. */
  rest_completed_count: Generated<number>;
  /** Durable REST Error count. */
  rest_error_count: Generated<number>;
  /** Durable Evaluation completion count. */
  eval_completed_count: Generated<number>;
  /** Durable Evaluation Error count. */
  eval_error_count: Generated<number>;
  /** Terminal report summary JSON. */
  summary_json: string | null;
  /** Complete stage result-set hash. */
  result_set_hash: string | null;
  /** Complete Artifact manifest JSON. */
  artifact_manifest_json: string;
  /** Stable terminal system error. */
  error_code: string | null;
  /** Safe externalized terminal error message. */
  error_message: string | null;
  /** First stage start time. */
  started_at: string | null;
  /** Terminal completion time. */
  completed_at: string | null;
  /** Creation time. */
  created_at: string;
  /** Last update time. */
  updated_at: string;
}

/** SQLite row for one real REST Case result. */
export interface CaseResultTable {
  /** Owning Run identity. */
  run_id: string;
  /** Frozen Case key. */
  case_key: string;
  /** Frozen Case ordinal. */
  ordinal: number;
  /** Frozen Case definition JSON. */
  case_definition_json: string;
  /** Frozen Case definition hash. */
  case_definition_hash: string;
  /** Normalized REST status. */
  rest_status: "SUCCEEDED" | "ERROR";
  /** HTTP status when observed. */
  http_status: number | null;
  /** Strict Provider Output JSON for success only. */
  provider_output_json: string | null;
  /** Rounded request duration. */
  duration_ms: number;
  /** Stable REST failure classification. */
  error_type: string | null;
  /** Safe externalized REST error message. */
  error_message: string | null;
  /** Completion time. */
  completed_at: string;
  /** Semantic REST result hash. */
  run_result_hash: string;
  /** Source Run provenance. */
  reused_from_run_id: string | null;
  /** Source Execution provenance. */
  reused_from_execution_id: string | null;
  /** Source result hash provenance. */
  reused_result_hash: string | null;
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
  case_result: CaseResultTable;
  /** Current Endpoint configurations. */
  endpoint_config: EndpointConfigTable;
  /** Normalized evaluation results. */
  eval_result: DeferredTable;
  /** Current LLM configurations. */
  llm_config: LlmConfigTable;
  /** Current Rubric Prompts. */
  llm_rubric_prompt: LlmRubricPromptTable;
  /** Run aggregate roots. */
  run_log: RunLogTable;
  /** Current Cases. */
  test_case: TestCaseTable;
  /** Current Suites. */
  test_suite: TestSuiteTable;
}
