import type { DomainJsonObject, DomainJsonValue } from "./domain-canonical-hash.ts";

/** Domain Assertion after all boundary validation and mapping. */
export interface AssertionDefinition {
  /** Promptfoo assertion type. */
  readonly type: string;
  /** Stable metric name. */
  readonly metric: string;
  /** Nonnegative aggregate weight. */
  readonly weight: number;
  /** Optional expected payload. */
  readonly value?: DomainJsonValue | undefined;
  /** Optional score or duration threshold. */
  readonly threshold?: number | undefined;
  /** Optional normalized Assertion configuration. */
  readonly config?: DomainJsonObject | undefined;
  /** Optional normalized Rubric Prompt reference. */
  readonly rubricPrompt?: string | undefined;
  /** Optional trusted inline output transform. */
  readonly transform?: string | undefined;
  /** Optional trusted inline context transform. */
  readonly contextTransform?: string | undefined;
  /** Nested Assertions, present only for Assertion Set. */
  readonly assertions?: readonly AssertionDefinition[] | undefined;
}

/** Domain Case Definition without transport or runtime metadata. */
export interface CaseDefinition {
  /** Suite-local stable key. */
  readonly caseKey: string;
  /** Human-readable purpose. */
  readonly description: string;
  /** Suite pass threshold. */
  readonly threshold: number;
  /** Promptfoo task variable. */
  readonly task: string;
  /** Validated request body. */
  readonly requestBody: DomainJsonObject;
  /** Search and identity metadata. */
  readonly metadata: {
    /** Source request identity. */
    readonly requestId: string;
    /** Source task identity. */
    readonly taskId: string;
    /** Business module. */
    readonly businessModule: string;
    /** Scenario tag. */
    readonly scenarioTag: string;
  };
  /** Ordered Assertions. */
  readonly assertions: readonly AssertionDefinition[];
}

/** Domain validation error for a Case. */
export interface CaseDefinitionError {
  /** Stable error code. */
  readonly code: "CASE_DEFINITION_INVALID";
  /** Stable fact path. */
  readonly path: string;
}

/** Exact Case validation result. */
export type CaseDefinitionValidationResult =
  | { readonly ok: true; readonly value: CaseDefinition }
  | { readonly ok: false; readonly error: CaseDefinitionError };

// Validate one recursive Assertion and return the first stable fact path.
function validateAssertion(
  assertion: AssertionDefinition,
  path: string
): CaseDefinitionError | null {
  if (assertion.type.trim() === "") {
    return { code: "CASE_DEFINITION_INVALID", path: `${path}.type` };
  }
  if (assertion.metric.trim() === "") {
    return { code: "CASE_DEFINITION_INVALID", path: `${path}.metric` };
  }
  if (!Number.isFinite(assertion.weight) || assertion.weight < 0) {
    return { code: "CASE_DEFINITION_INVALID", path: `${path}.weight` };
  }
  if (
    assertion.threshold !== undefined &&
    (!Number.isFinite(assertion.threshold) || assertion.threshold < 0)
  ) {
    return { code: "CASE_DEFINITION_INVALID", path: `${path}.threshold` };
  }
  const nested = assertion.assertions;
  if ((assertion.type === "assert-set") !== (nested !== undefined)) {
    return { code: "CASE_DEFINITION_INVALID", path: `${path}.assertions` };
  }
  if (nested !== undefined) {
    if (nested.length === 0) {
      return { code: "CASE_DEFINITION_INVALID", path: `${path}.assertions` };
    }
    for (const [index, child] of nested.entries()) {
      const error = validateAssertion(child, `${path}.assertions[${index}]`);
      if (error !== null) return error;
    }
  }
  return null;
}

/** Validate one standalone recursive Assertion with a stable root path. */
export function validateAssertionDefinition(
  value: AssertionDefinition
): CaseDefinitionError | null {
  return validateAssertion(value, "assertion");
}

/** Validate pure Case identity and numerical invariants. */
export function validateCaseDefinition(value: CaseDefinition): CaseDefinitionValidationResult {
  if (value.caseKey.trim() === "") {
    return { ok: false, error: { code: "CASE_DEFINITION_INVALID", path: "caseKey" } };
  }
  if (value.description.trim() === "") {
    return { ok: false, error: { code: "CASE_DEFINITION_INVALID", path: "description" } };
  }
  if (!Number.isFinite(value.threshold) || value.threshold < 0 || value.threshold > 1) {
    return { ok: false, error: { code: "CASE_DEFINITION_INVALID", path: "threshold" } };
  }
  if (value.assertions.length === 0) {
    return { ok: false, error: { code: "CASE_DEFINITION_INVALID", path: "assertions" } };
  }
  if (value.task.trim() === "") {
    return { ok: false, error: { code: "CASE_DEFINITION_INVALID", path: "task" } };
  }
  const metadataValues = Object.values(value.metadata);
  if (metadataValues.some((item) => item.trim() === "")) {
    return { ok: false, error: { code: "CASE_DEFINITION_INVALID", path: "metadata" } };
  }
  for (const [index, assertion] of value.assertions.entries()) {
    const error = validateAssertion(assertion, `assertions[${index}]`);
    if (error !== null) return { ok: false, error };
  }
  return { ok: true, value };
}

/** Business-success Provider Output. */
export interface ProviderOutputSuccess {
  /** Business result. */
  readonly ok: true;
  /** Frozen task name. */
  readonly taskName: string;
  /** Validated configuration fact. */
  readonly resolvedConfig: Readonly<DomainJsonObject>;
  /** Validated parsed output fact. */
  readonly parsedOutput: Readonly<DomainJsonObject>;
}

/** Business-failure Provider Output that is still a valid REST response. */
export interface ProviderOutputFailure {
  /** Business result. */
  readonly ok: false;
  /** Business error message. */
  readonly errorMessage: string;
}

/** Valid Provider Output union. */
export type ProviderOutput = ProviderOutputSuccess | ProviderOutputFailure;

/** Clean REST execution outcome before classification. */
export type RestExecutionOutcome =
  | { readonly kind: "HTTP_2XX"; readonly providerOutput: ProviderOutput }
  | {
      readonly kind:
        | "TIMEOUT"
        | "NETWORK"
        | "HTTP_STATUS"
        | "RESPONSE_PARSE"
        | "PROVIDER_OUTPUT_INVALID"
        | "TEMPLATE_INPUT"
        | "CANCELLED";
    };

/** Normalized REST fact. */
export type RestResult =
  | { readonly status: "SUCCEEDED"; readonly providerOutput: ProviderOutput }
  | {
      readonly status: "ERROR";
      readonly errorType: Exclude<RestExecutionOutcome["kind"], "HTTP_2XX">;
    };

/** Classify a validated REST outcome without interpreting business `ok`. */
export function classifyRestResult(outcome: RestExecutionOutcome): RestResult {
  if (outcome.kind === "HTTP_2XX") {
    return { status: "SUCCEEDED", providerOutput: outcome.providerOutput };
  }
  return { status: "ERROR", errorType: outcome.kind };
}

/** Domain Eval status. */
export type EvalStatus = "PASS" | "FAIL" | "EVALUATION_ERROR" | "NOT_EVALUATED";

/** Clean Eval result with explicit absent facts. */
export interface EvalResult {
  /** Normalized status. */
  readonly status: EvalStatus;
  /** Score exists only for observed PASS/FAIL. */
  readonly score: number | null;
  /** Evaluation reason when supplied. */
  readonly reason: string | null;
  /** System error exists only for EVALUATION_ERROR. */
  readonly error: string | null;
  /** Hash of normalized evaluation facts. */
  readonly evalResultHash: string;
  /** Hash binding REST and Eval facts. */
  readonly finalCaseResultHash: string;
}

/** Exact Eval validation result. */
export type EvalResultValidationResult =
  | { readonly ok: true; readonly value: EvalResult }
  | {
      readonly ok: false;
      readonly error: { readonly code: "EVAL_RESULT_INVALID"; readonly path: string };
    };

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** Validate status-dependent Eval fact presence. */
export function validateEvalResult(value: EvalResult): EvalResultValidationResult {
  if (!SHA256_PATTERN.test(value.evalResultHash)) {
    return { ok: false, error: { code: "EVAL_RESULT_INVALID", path: "evalResultHash" } };
  }
  if (!SHA256_PATTERN.test(value.finalCaseResultHash)) {
    return { ok: false, error: { code: "EVAL_RESULT_INVALID", path: "finalCaseResultHash" } };
  }
  const observed = value.status === "PASS" || value.status === "FAIL";
  if (observed && (value.score === null || !Number.isFinite(value.score) || value.error !== null)) {
    return { ok: false, error: { code: "EVAL_RESULT_INVALID", path: "score" } };
  }
  if (!observed && value.score !== null) {
    return { ok: false, error: { code: "EVAL_RESULT_INVALID", path: "score" } };
  }
  if (value.status === "EVALUATION_ERROR" && value.error === null) {
    return { ok: false, error: { code: "EVAL_RESULT_INVALID", path: "error" } };
  }
  if (value.status !== "EVALUATION_ERROR" && value.error !== null) {
    return { ok: false, error: { code: "EVAL_RESULT_INVALID", path: "error" } };
  }
  return { ok: true, value };
}
