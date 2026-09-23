/** Closed diagnostics only: never persist arbitrary SDK messages, prompts or credentials. */
const SAFE_CODES = new Set([
  "ARTIFACT_WRITE_FAILED",
  "PROMPTFOO_RESPONSE_PARSER_ERROR",
  "PROMPTFOO_LOGGER_WRITE_AFTER_END",
  "EVALUATOR_TIMEOUT",
  "PROMPTFOO_PROCESS_TIMEOUT",
  "PROMPTFOO_PROCESS_CANCELLED",
  "PROMPTFOO_PROCESS_DIAGNOSTIC_LIMIT",
  "PROMPTFOO_PROCESS_OUTPUT_INVALID",
  "PROMPTFOO_PROCESS_ERROR",
  "PROMPTFOO_VERSION_MISMATCH",
  "PROMPTFOO_CAPABILITY_EXPOSED",
  "PROMPTFOO_CONFIG_SECRET_EXPOSED",
  "PROMPTFOO_CONFIG_INVALID",
  "PROMPTFOO_RUBRIC_PROMPT_MISSING",
  "PROMPTFOO_ENGINE_REST_ALIGNMENT",
  "PROMPTFOO_ENGINE_CONTEXT_INVALID",
  "PROMPTFOO_ENGINE_SOURCE_CHANGED",
  "PROMPTFOO_IMPORT_VERSION",
  "PROMPTFOO_IMPORT_ROWS",
  "PROMPTFOO_IMPORT_CASE_MISSING",
  "PROMPTFOO_IMPORT_CASE_UNKNOWN",
  "PROMPTFOO_IMPORT_CASE_DUPLICATE",
  "PROMPTFOO_IMPORT_COMPONENT_PASS",
  "PROMPTFOO_IMPORT_COMPONENT_SCORE",
  "PROMPTFOO_IMPORT_COMPONENT_REASON",
  "PROMPTFOO_PROCESS_GROUP_NOT_REAPED",
  "EVALUATOR_SECRET_MISSING",
  "EVALUATOR_CONFIG_INVALID",
  "EVALUATOR_PROVIDER_RESPONSE_INVALID",
  "JEV_PROVIDER_FAILED",
  "PROVIDER_CAPABILITY_UNSUPPORTED",
  "PROVIDER_REQUEST_FAILED",
  "RUN_EVALUATION_REST_HASH_MISSING",
  "RUN_EVALUATION_REST_INCOMPLETE",
  "RUN_EVALUATION_CASE_ALIGNMENT",
  "RUN_EVALUATION_RESULT_ALIGNMENT",
  "RUN_EVALUATION_CANCELLATION_POLL_FAILED",
  "EVALUATION_PREFLIGHT_PROMPTFOO",
  "EVALUATION_PREFLIGHT_PYTHON",
  "EVALUATION_PREFLIGHT_RUBY",
  "EVALUATION_START_REJECTED",
  "EVALUATION_RESULT_COMMIT_CONFLICT",
  "PROMPTFOO_GRADER_RESPONSE_INVALID"
]);

/** Extract bounded machine diagnostics, without exposing an untrusted exception message. */
function safeCode(error: unknown): string {
  if (!(error instanceof Error)) return "UNKNOWN_EVALUATION_ERROR";
  if (/^PROMPTFOO_PROCESS_EXIT:-?\d{1,3}$/.test(error.message)) return error.message;
  if (/^JEV_HTTP_FAILED:\d{3}:[A-Z0-9_]{1,64}$/.test(error.message)) return error.message;
  // Prefer an explicit closed code field: a decorated message must not lose the diagnosis.
  const explicit = "code" in error ? error.code : undefined;
  if (typeof explicit === "string" && SAFE_CODES.has(explicit)) return explicit;
  const code = error.message.split(":", 1)[0] ?? "";
  if (SAFE_CODES.has(code)) return code;
  if (error instanceof SyntaxError) return "EVALUATION_SYNTAX_ERROR";
  if (error instanceof TypeError) return "EVALUATION_TYPE_ERROR";
  const systemCode = "code" in error ? error.code : undefined;
  if (["ENOENT", "EACCES", "ENOSPC", "SQLITE_BUSY", "SQLITE_FULL"].includes(String(systemCode))) {
    return `EVALUATION_IO_${String(systemCode)}`;
  }
  return "UNKNOWN_EVALUATION_ERROR";
}

/** Preserve a bounded chain of recognized causes, not raw messages or stack traces. */
export function evaluationFailureDiagnostic(error: unknown): string {
  const codes: string[] = [];
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    const code = safeCode(current);
    if (!codes.includes(code)) codes.push(code);
    if (!(current instanceof Error) || current.cause === undefined) break;
    current = current.cause;
  }
  return codes.join(" → ");
}
