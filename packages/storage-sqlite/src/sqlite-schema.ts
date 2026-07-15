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
  /** Durable Evaluation PASS count. */
  eval_pass_count: Generated<number>;
  /** Durable Evaluation FAIL count. */
  eval_fail_count: Generated<number>;
  /** Durable Evaluation Error count. */
  eval_error_count: Generated<number>;
  /** Durable Not Evaluated count. */
  eval_not_evaluated_count: Generated<number>;
  /** Terminal report summary JSON. */
  summary_json: string | null;
  /** Complete stage result-set hash. */
  result_set_hash: string | null;
  /** Frozen Evaluation invocation identity. */
  evaluation_context_hash: string | null;
  /** Complete Evaluation result-set identity. */
  evaluation_result_set_hash: string | null;
  /** Complete Report result-set identity. */
  report_result_set_hash: string | null;
  /** Complete Artifact manifest JSON. */
  artifact_manifest_json: string;
  /** Latest offline Analysis Artifact import identity, preserved across platform reanalysis. */
  analysis_import_identity_json: Generated<string | null>;
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

/** SQLite row for one Run/Case current Analysis and decision. */
export interface CaseAnalysisTable {
  /** Current Analysis instance identity, replaced by reanalysis. */
  id: string;
  /** Owning immutable Run version. */
  run_id: string;
  /** Frozen Suite-local Case key. */
  case_key: string;
  /** Bound final Case result identity. */
  final_case_result_hash: string;
  /** Optimistic current Analysis revision. */
  analysis_revision: number;
  /** Frozen Analysis Prompt business key. */
  analysis_prompt_key: string;
  /** Frozen Analysis Prompt semantic hash. */
  analysis_prompt_hash: string;
  /** Frozen redacted Analysis Prompt snapshot JSON. */
  analysis_prompt_snapshot_json: string;
  /** Current Prompt resource identity when started on the platform. */
  analysis_prompt_id: Generated<string | null>;
  /** Frozen Analyzer semantic hash. */
  analyzer_config_hash: string;
  /** Current Analyzer resource identity when started on the platform. */
  analyzer_config_id: Generated<string | null>;
  /** Frozen Analyzer provider. */
  analyzer_provider: "GOOGLE_GEMINI" | "OPENAI_COMPATIBLE";
  /** Frozen Analyzer model. */
  analyzer_model: string;
  /** Frozen redacted Analyzer snapshot JSON. */
  analyzer_snapshot_json: string;
  /** Analysis Input contract identity. */
  analysis_input_contract_version: string;
  /** Analysis Output contract identity. */
  analysis_output_contract_version: string;
  /** Complete Analysis Input identity. */
  analysis_input_hash: string;
  /** Frozen Analysis execution limits JSON. */
  analysis_execution_limits_json: string;
  /** Current Analysis lifecycle status. */
  analysis_status: "PENDING" | "RUNNING" | "SUCCEEDED" | "ERROR";
  /** Successful Analysis classification. */
  classification:
    "LABEL_ERROR" | "ADDITIONAL_VALID_RESULT" | "NORMAL_FAILURE" | "PARAMETER_VARIANCE" | null;
  /** Model self-assessed confidence. */
  confidence: number | null;
  /** Structured Evidence JSON. */
  evidence_json: string | null;
  /** Successful Analysis explanation. */
  explanation: string | null;
  /** Successful Analysis recommended action. */
  recommended_action: string | null;
  /** Optional single Proposal JSON. */
  proposal_json: string | null;
  /** Current user decision. */
  decision: "NO_PROPOSAL" | "PENDING" | "ACCEPTED" | "REJECTED" | "EDITED_AND_ACCEPTED";
  /** Current Proposal application result. */
  apply_status: "NOT_APPLICABLE" | "NOT_APPLIED" | "APPLIED" | "CONFLICT";
  /** Proposal base Case Definition identity. */
  base_definition_hash: string | null;
  /** Applied Case Definition identity. */
  applied_definition_hash: string | null;
  /** Complete semantic Analysis result identity. */
  analysis_result_hash: Generated<string | null>;
  /** Stable current Analysis error code. */
  error_code: string | null;
  /** Safe externalized current Analysis error message. */
  error_message: string | null;
  /** Current Analysis creation time. */
  created_at: string;
  /** Latest current Analysis update time. */
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

/** SQLite row for one normalized Evaluation Case result. */
export interface EvalResultTable {
  /** Owning Run identity. */
  run_id: string;
  /** Frozen Case key. */
  case_key: string;
  /** Normalized Eval status. */
  eval_status: "PASS" | "FAIL" | "EVALUATION_ERROR" | "NOT_EVALUATED";
  /** Promptfoo aggregate success encoded as SQLite boolean. */
  promptfoo_success: number | null;
  /** Promptfoo aggregate score. */
  score: number | null;
  /** Promptfoo aggregate reason. */
  reason: string | null;
  /** Structured Evaluation error JSON. */
  evaluation_error: string | null;
  /** Ordered Assertion result JSON. */
  assertion_results_json: string;
  /** Ordered Assertion Diff JSON. */
  expected_actual_diffs_json: string;
  /** Deduplicated Metric result JSON. */
  metric_results_json: string;
  /** Promptfoo-observed latency. */
  latency_ms: number | null;
  /** Promptfoo grader token usage JSON. */
  token_usage_json: string | null;
  /** Promptfoo grader cost. */
  cost: number | null;
  /** Allowlisted raw evidence reference JSON. */
  allowlist_raw_evidence_json: string;
  /** Semantic normalized Eval hash. */
  eval_result_hash: string;
  /** Hash binding Case, REST and Eval. */
  final_case_result_hash: string;
  /** Source Run provenance. */
  reused_from_run_id: string | null;
  /** Source Execution provenance. */
  reused_from_execution_id: string | null;
  /** Exact reused Eval result hash. */
  reused_eval_result_hash: string | null;
  /** First persistence time. */
  created_at: string;
  /** Latest persistence time. */
  updated_at: string;
}

/** Complete current SQLite database type map. */
export interface SqliteDatabaseSchema {
  /** Current analyses. */
  case_analysis: CaseAnalysisTable;
  /** Current Analysis Prompts. */
  case_analysis_prompt: CaseAnalysisPromptTable;
  /** Frozen REST Case results. */
  case_result: CaseResultTable;
  /** Current Endpoint configurations. */
  endpoint_config: EndpointConfigTable;
  /** Normalized evaluation results. */
  eval_result: EvalResultTable;
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
