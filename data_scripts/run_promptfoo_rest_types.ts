/** JSON-compatible primitive value. */
export type JsonPrimitive = boolean | number | string | null;

/** JSON-compatible value. */
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** Metadata describing one failed REST execution. */
export interface RestRunErrorMetadata {
  /** Human-readable failure reason. */
  message: string;
  /** HTTP status when a response was received. */
  status?: number;
  /** ISO timestamp for the failed execution. */
  occurred_at: string;
}

/** Metadata describing one successful REST execution. */
export interface RestRunMetadata {
  /** HTTP response status. */
  status: number;
  /** Request duration in milliseconds. */
  duration_ms: number;
  /** ISO timestamp for the successful execution. */
  completed_at: string;
}

/** Promptfoo metadata with runner-owned fields. */
export interface PromptfooMetadata {
  /** Stable source case identifier. */
  case_id?: string;
  /** Last successful REST execution metadata. */
  rest_run?: RestRunMetadata;
  /** Last failed REST execution metadata. */
  rest_run_error?: RestRunErrorMetadata;
  /** Additional promptfoo metadata. */
  [key: string]: unknown;
}

/** Promptfoo test case accepted and emitted by the runner. */
export interface PromptfooTestCase {
  /** Human-readable test description. */
  description?: string;
  /** Variables used by provider templates. */
  vars?: Record<string, unknown>;
  /** Test metadata. */
  metadata?: PromptfooMetadata;
  /** Promptfoo assertion definitions. */
  assert?: unknown[];
  /** Precomputed output consumed directly by promptfoo eval. */
  providerOutput?: unknown;
  /** Additional promptfoo test fields. */
  [key: string]: unknown;
}

/** REST provider configuration supported by this runner. */
export interface RestProviderConfig {
  /** URL template. */
  url: string;
  /** HTTP method. */
  method: string;
  /** Optional request headers with variable templates. */
  headers: Record<string, string>;
  /** Optional request body or variable reference. */
  body?: unknown;
}

/** Public options for CLI and module execution. */
export interface RunPromptfooRestSuiteOptions {
  /** Input promptfoo test file, relative to cwd unless absolute. */
  inputPath?: string;
  /** REST provider configuration file, relative to cwd unless absolute. */
  providerPath?: string;
  /** Generated promptfoo test file, relative to cwd unless absolute. */
  outputPath?: string;
  /** Maximum number of simultaneous REST requests. */
  maxConcurrency?: number;
  /** Timeout for each REST request in milliseconds. */
  timeoutMs?: number;
  /** Whether to rerun cases that already have providerOutput. */
  force?: boolean;
  /** Base directory for relative paths. */
  cwd?: string;
}

/** Aggregate result returned by module execution. */
export interface RunPromptfooRestSuiteResult {
  /** Number of current input cases. */
  total: number;
  /** Number of cases reused from the existing output. */
  skipped: number;
  /** Number of successful REST requests in this run. */
  succeeded: number;
  /** Number of failed REST requests in this run. */
  failed: number;
  /** Absolute generated output path. */
  outputPath: string;
}
