import { materializeJavascriptSource } from "./promptfoo-javascript-source.ts";
import { assertionDefinitionJson } from "@cortex-eval/domain/src/domain-case-projection.ts";
import {
  canonicalJson,
  type DomainJsonObject,
  type DomainJsonValue
} from "@cortex-eval/domain/src/domain-canonical-hash.ts";
import type {
  AssertionDefinition,
  CaseDefinition
} from "@cortex-eval/domain/src/domain-evaluation.ts";
import {
  hashAssertionDefinition,
  hashEvalResult,
  hashEvalResultSet,
  hashFinalCaseResult,
  type EvalAssertionHashFact,
  type EvalDiffHashFact,
  type EvalMetricHashFact
} from "@cortex-eval/domain/src/domain-hash-inputs.ts";
import { aggregateCaseMetrics } from "@cortex-eval/domain/src/domain-metrics.ts";
import { explainJsonSchemaResult } from "@cortex-eval/reporting/src/json-schema-diff.ts";
import { load as loadYaml } from "js-yaml";

import { validatePromptfooRowError } from "./promptfoo-row-error-parser.ts";

/** Raw Artifact integrity exposed in each evaluated Case. */
export interface PromptfooRawEvidence {
  /** Whether the immutable raw file exists. */
  readonly present: true;
  /** Controlled relative POSIX path. */
  readonly path: string;
  /** Expected raw file SHA-256. */
  readonly expectedSha256: string;
  /** Expected raw file size. */
  readonly expectedSizeBytes: number;
}

/** Successful REST fact consumed by Promptfoo. */
export interface PromptfooImportRestSuccess {
  /** Stable REST success discriminator. */
  readonly status: "SUCCEEDED";
  /** Semantic REST result hash. */
  readonly resultHash: string;
  /** Exact JSON value supplied as precomputed Provider Output. */
  readonly providerOutput: DomainJsonObject;
}

/** Failed REST fact skipped by Promptfoo. */
export interface PromptfooImportRestFailure {
  /** Stable REST failure discriminator. */
  readonly status: "ERROR";
  /** Semantic REST result hash. */
  readonly resultHash: string;
}

/** Frozen Case and REST facts expected by the Importer. */
export interface PromptfooImportCase {
  /** Stable Suite-local Case key. */
  readonly caseKey: string;
  /** Frozen zero-based Case order. */
  readonly ordinal: number;
  /** Frozen Case definition hash. */
  readonly caseDefinitionHash: string;
  /** Complete validated frozen definition. */
  readonly definition: CaseDefinition;
  /** Complete REST outcome. */
  readonly restResult: PromptfooImportRestSuccess | PromptfooImportRestFailure;
}

/** Complete fixed-version Promptfoo import input. */
export interface PromptfooImportInput {
  /** Exact executed Promptfoo package version. */
  readonly promptfooVersion: string;
  /** Untrusted Promptfoo JSON output. */
  readonly raw: unknown;
  /** Complete frozen Cases in exact order. */
  readonly cases: readonly PromptfooImportCase[];
  /** Immutable Raw Artifact integrity. */
  readonly rawEvidence: PromptfooRawEvidence;
  /** Frozen `prompt://` reference to exact generated inline Prompt JSON. */
  readonly rubricPromptMaterializations: Readonly<Record<string, string>>;
}

/** Complete import input with immutable execution-version identity. */
export interface CompletePromptfooImportInput extends PromptfooImportInput {
  /** Platform Run or offline Execution owning the result set. */
  readonly evaluationOwner:
    | { readonly kind: "RUN"; readonly id: string }
    | { readonly kind: "EXECUTION"; readonly id: string };
  /** Frozen Evaluation generation, matrix and Evaluator context. */
  readonly evaluationContextHash: string;
}

/** Stable token usage normalized from Promptfoo grading facts. */
export interface ImportedTokenUsage {
  /** Grader input tokens. */
  readonly inputTokens: number;
  /** Grader output tokens. */
  readonly outputTokens: number;
  /** Grader total tokens. */
  readonly totalTokens: number;
}

/** One complete normalized Eval Case produced by the strict Importer. */
export interface ImportedEvalCase {
  /** Stable Case key. */
  readonly caseKey: string;
  /** Frozen zero-based Case order. */
  readonly ordinal: number;
  /** Normalized Case Evaluation status. */
  readonly status: "PASS" | "FAIL" | "EVALUATION_ERROR" | "NOT_EVALUATED";
  /** Promptfoo aggregate pass when evaluated. */
  readonly promptfooSuccess: boolean | null;
  /** Promptfoo aggregate score when evaluated. */
  readonly score: number | null;
  /** Promptfoo aggregate reason when evaluated. */
  readonly reason: string | null;
  /** Structured stage error when applicable. */
  readonly evaluationError: { readonly code: string } | null;
  /** Ordered normalized top-level Assertion results. */
  readonly assertions: readonly EvalAssertionHashFact[];
  /** Ordered JSON Schema explanation facts. */
  readonly diffs: readonly EvalDiffHashFact[];
  /** Deduplicated Case Metric results. */
  readonly metrics: readonly EvalMetricHashFact[];
  /** Promptfoo-observed latency. */
  readonly latencyMs: number | null;
  /** Promptfoo-observed grader token usage. */
  readonly tokenUsage: ImportedTokenUsage | null;
  /** Promptfoo-observed grader cost. */
  readonly cost: number | null;
  /** Immutable raw evidence reference for evaluated Cases. */
  readonly rawEvidence: PromptfooRawEvidence | null;
  /** Semantic normalized Eval result hash. */
  readonly evalResultHash: string;
  /** Hash binding frozen Case, REST and Eval facts. */
  readonly finalCaseResultHash: string;
  /** Reuse provenance is absent for a new P6 evaluation. */
  readonly provenance: null;
}

/** Complete normalized result set returned by the strict Importer. */
export interface PromptfooImportResult {
  /** Complete Cases in frozen order. */
  readonly cases: readonly ImportedEvalCase[];
  /** Semantic Eval result-set hash. */
  readonly resultSetHash: string;
}

// Narrow one untrusted value to a JSON-like record.
function record(value: unknown, code: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

// Read one exact finite number without accepting numeric strings.
function finiteNumber(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(code);
  return value;
}

// Read one exact nonnegative finite number.
function nonnegativeNumber(value: unknown, code: string): number {
  const number = finiteNumber(value, code);
  if (number < 0) throw new Error(code);
  return number;
}

// Validate and copy one untrusted value into the Domain JSON subset.
function domainJsonValue(value: unknown, code: string): DomainJsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return finiteNumber(value, code);
  if (Array.isArray(value)) return value.map((item) => domainJsonValue(item, code));
  const source = record(value, code);
  const prototype = Object.getPrototypeOf(source) as unknown;
  if (prototype !== Object.prototype && prototype !== null) throw new Error(code);
  const result: DomainJsonObject = {};
  for (const [key, item] of Object.entries(source)) result[key] = domainJsonValue(item, code);
  return result;
}

// Read the stable Promptfoo result array and reject incompatible output versions.
function rawRows(value: unknown): unknown[] {
  const root = record(value, "PROMPTFOO_IMPORT_ROOT");
  const results = record(root.results, "PROMPTFOO_IMPORT_RESULTS");
  if (results.version !== 3) throw new Error("PROMPTFOO_IMPORT_VERSION");
  if (!Array.isArray(results.results)) throw new Error("PROMPTFOO_IMPORT_ROWS");
  return results.results;
}

// Read one Raw result Case key from stable metadata.
function rawCaseKey(row: Record<string, unknown>, index: number): string {
  const metadata = record(row.metadata, `PROMPTFOO_IMPORT_METADATA:${index}`);
  if (typeof metadata.case_id !== "string" || metadata.case_id.trim() === "") {
    throw new Error(`PROMPTFOO_IMPORT_CASE_KEY:${index}`);
  }
  return metadata.case_id;
}

// Return the normalized expected Assertion weight.
function assertionWeight(value: unknown): number {
  if (value === undefined) return 1;
  return nonnegativeNumber(value, "PROMPTFOO_IMPORT_COMPONENT_WEIGHT");
}

const ASSERTION_KEYS = new Set([
  "type",
  "value",
  "config",
  "threshold",
  "weight",
  "rubricPrompt",
  "metric",
  "transform",
  "contextTransform"
]);

// Normalize one Promptfoo leaf Assertion into the frozen Domain hash shape.
function rawAssertionDefinition(
  value: unknown,
  caseKey: string,
  assertionIndex: number
): DomainJsonObject {
  const code = `PROMPTFOO_IMPORT_COMPONENT_ALIGNMENT:${caseKey}:${assertionIndex}`;
  const assertion = record(value, code);
  if (Object.keys(assertion).some((key) => !ASSERTION_KEYS.has(key))) throw new Error(code);
  if (
    typeof assertion.type !== "string" ||
    assertion.type.trim() === "" ||
    typeof assertion.metric !== "string" ||
    assertion.metric.trim() === ""
  ) {
    throw new Error(code);
  }
  const result: DomainJsonObject = {
    type: assertion.type,
    metric: assertion.metric,
    weight: assertionWeight(assertion.weight)
  };
  if (assertion.value !== undefined) result.value = domainJsonValue(assertion.value, code);
  if (assertion.config !== undefined) {
    const config = domainJsonValue(assertion.config, code);
    if (typeof config !== "object" || config === null || Array.isArray(config)) {
      throw new Error(code);
    }
    result.config = config;
  }
  if (assertion.threshold !== undefined) {
    result.threshold = nonnegativeNumber(assertion.threshold, code);
  }
  for (const key of ["rubricPrompt", "transform", "contextTransform"] as const) {
    const item = assertion[key];
    if (item === undefined) continue;
    if (typeof item !== "string") throw new Error(code);
    result[key] = item;
  }
  return result;
}

// Restore one controlled inline Rubric Prompt to its frozen `prompt://` identity.
function definitionForExpectedPrompt(
  rawDefinition: DomainJsonObject,
  expected: AssertionDefinition,
  rubricPromptMaterializations: Readonly<Record<string, string>>
): DomainJsonObject | null {
  // Accept only our exact deterministic source normalization, retaining frozen definition hashes.
  if (
    typeof expected.value === "string" &&
    rawDefinition.value === materializeJavascriptSource(expected.type, expected.value)
  ) {
    rawDefinition = { ...rawDefinition, value: expected.value };
  }
  const promptReference = expected.rubricPrompt;
  if (promptReference === undefined) return rawDefinition;
  if (rawDefinition.rubricPrompt === promptReference) return rawDefinition;
  const materialized = rubricPromptMaterializations[promptReference];
  if (materialized === undefined || rawDefinition.rubricPrompt !== materialized) return null;
  return { ...rawDefinition, rubricPrompt: promptReference };
}

// Validate a leaf component against the complete frozen Assertion definition hash.
function validateLeafComponentIdentity(
  component: Record<string, unknown>,
  expected: AssertionDefinition,
  caseKey: string,
  assertionIndex: number,
  rubricPromptMaterializations: Readonly<Record<string, string>>
): string {
  const rawDefinition = rawAssertionDefinition(component.assertion, caseKey, assertionIndex);
  const normalizedDefinition = definitionForExpectedPrompt(
    rawDefinition,
    expected,
    rubricPromptMaterializations
  );
  if (normalizedDefinition === null) {
    throw new Error(`PROMPTFOO_IMPORT_COMPONENT_ALIGNMENT:${caseKey}:${assertionIndex}`);
  }
  const rawHash = hashAssertionDefinition({
    contractVersion: "cortex.assertion-definition.v1",
    definition: normalizedDefinition
  });
  const expectedHash = hashAssertionDefinition({
    contractVersion: "cortex.assertion-definition.v1",
    definition: assertionDefinitionJson(expected)
  });
  if (rawHash !== expectedHash) {
    throw new Error(`PROMPTFOO_IMPORT_COMPONENT_ALIGNMENT:${caseKey}:${assertionIndex}`);
  }
  return expectedHash;
}

// Map Promptfoo grader token facts without inventing absent usage.
function mapTokenUsage(grading: Record<string, unknown>): ImportedTokenUsage | null {
  if (grading.tokensUsed === undefined) return null;
  const tokens = record(grading.tokensUsed, "PROMPTFOO_IMPORT_TOKEN_USAGE");
  const inputTokens = nonnegativeNumber(tokens.prompt, "PROMPTFOO_IMPORT_TOKEN_USAGE");
  const outputTokens = nonnegativeNumber(tokens.completion, "PROMPTFOO_IMPORT_TOKEN_USAGE");
  const totalTokens = nonnegativeNumber(tokens.total, "PROMPTFOO_IMPORT_TOKEN_USAGE");
  return { inputTokens, outputTokens, totalTokens };
}

// Build JSON Schema explanations for one aligned `is-json` component.
function normalizedJsonSchema(
  expected: AssertionDefinition,
  assertionIndex: number
): boolean | DomainJsonObject | null {
  if (expected.type !== "is-json") return null;
  if (expected.value === undefined) return {};
  let schema: DomainJsonValue;
  if (typeof expected.value === "string") {
    try {
      schema = domainJsonValue(loadYaml(expected.value), "PROMPTFOO_IMPORT_JSON_SCHEMA");
    } catch {
      throw new Error(`PROMPTFOO_IMPORT_JSON_SCHEMA:${assertionIndex}`);
    }
  } else {
    schema = expected.value;
  }
  if (typeof schema === "boolean") return schema;
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    throw new Error(`PROMPTFOO_IMPORT_JSON_SCHEMA:${assertionIndex}`);
  }
  return schema;
}

// Build one Assertion's JSON Schema explanations when that capability applies.
function componentDiffs(
  expected: AssertionDefinition,
  componentPassed: boolean,
  assertionIndex: number,
  actual: DomainJsonObject
): readonly EvalDiffHashFact[] {
  const schema = normalizedJsonSchema(expected, assertionIndex);
  if (schema === null) return [];
  const explained = explainJsonSchemaResult({
    assertionIndex,
    promptfooPassed: componentPassed,
    schema,
    actual
  });
  if (!explained.ok && expected.weight === 0) return [];
  if (!explained.ok) throw new Error(explained.error.code);
  return explained.diffs;
}

interface ComponentOutcome {
  /** Structured pass fact. */
  readonly pass: boolean;
  /** Structured score fact. */
  readonly score: number;
  /** Stable nullable reason. */
  readonly reason: string | null;
}

interface WeightedComponentOutcome extends ComponentOutcome {
  /** Promptfoo aggregation weight. */
  readonly weight: number;
}

interface DefinitionComponentOutcome extends WeightedComponentOutcome {
  /** Frozen Assertion definition associated with the component. */
  readonly definition: AssertionDefinition;
}

// Read the common stable outcome fields from one Promptfoo component.
function componentOutcome(
  component: Record<string, unknown>,
  caseKey: string,
  assertionIndex: number
): ComponentOutcome {
  if (typeof component.pass !== "boolean") {
    throw new Error(`PROMPTFOO_IMPORT_COMPONENT_PASS:${caseKey}:${assertionIndex}`);
  }
  const score = finiteNumber(
    component.score,
    `PROMPTFOO_IMPORT_COMPONENT_SCORE:${caseKey}:${assertionIndex}`
  );
  const reason = component.reason;
  if (reason !== null && typeof reason !== "string") {
    throw new Error(`PROMPTFOO_IMPORT_COMPONENT_REASON:${caseKey}:${assertionIndex}`);
  }
  return { pass: component.pass, score, reason };
}

// Promptfoo 0.121.18 encodes inline interpreter faults only through fixed component reasons.
function isAssertionExecutionFailure(
  definition: AssertionDefinition,
  component: Record<string, unknown>
): boolean {
  if (component.pass !== false || component.score !== 0 || typeof component.reason !== "string") {
    return false;
  }
  const type = definition.type.startsWith("not-")
    ? definition.type.slice("not-".length)
    : definition.type;
  if (type === "javascript") {
    return (
      component.reason.startsWith("Custom function threw error:") &&
      component.reason.includes("\nStack Trace:")
    );
  }
  if (type === "python") return component.reason.startsWith("Python code execution failed:");
  if (type === "ruby") return component.reason.startsWith("Ruby code execution failed:");
  return false;
}

// Build a sanitized system-error result without retaining provider paths, stacks or messages.
function importEvaluationErrorCase(
  expected: PromptfooImportCase,
  evidence: PromptfooRawEvidence,
  assertions: readonly EvalAssertionHashFact[],
  latencyMs: number | null,
  tokenUsage: ImportedTokenUsage | null,
  cost: number | null
): ImportedEvalCase {
  if (expected.restResult.status !== "SUCCEEDED") throw new Error("PROMPTFOO_IMPORT_REST_STATE");
  const sanitizedAssertions = assertions;
  const errorReason = "部分评测器执行异常；已完成的分项结论保留，整体不能判定通过。";
  const metrics = aggregateCaseMetrics(
    sanitizedAssertions.map((assertion) => ({ metric: assertion.metric, status: assertion.status }))
  );
  const evaluationError = { code: "PROMPTFOO_ASSERTION_EXECUTION_ERROR" } as const;
  const evalResultHash = hashEvalResult({
    contractVersion: "cortex.eval-result.v1",
    caseKey: expected.caseKey,
    status: "EVALUATION_ERROR",
    promptfooSuccess: null,
    score: null,
    reason: errorReason,
    evaluationError,
    assertions: sanitizedAssertions,
    diffs: [],
    metrics
  });
  return {
    caseKey: expected.caseKey,
    ordinal: expected.ordinal,
    status: "EVALUATION_ERROR",
    promptfooSuccess: null,
    score: null,
    reason: errorReason,
    evaluationError,
    assertions: sanitizedAssertions,
    diffs: [],
    metrics,
    latencyMs,
    tokenUsage,
    cost,
    rawEvidence: evidence,
    evalResultHash,
    finalCaseResultHash: hashFinalCaseResult({
      contractVersion: "cortex.final-case-result.v1",
      caseDefinitionHash: expected.caseDefinitionHash,
      restResultHash: expected.restResult.resultHash,
      evalResultHash
    }),
    provenance: null
  };
}

// Reproduce Promptfoo's native weighted-score calculation for strict reconciliation.
function aggregateScore(outcomes: readonly WeightedComponentOutcome[]): number {
  const totalWeight = outcomes.reduce((total, item) => total + item.weight, 0);
  if (totalWeight === 0) return 0;
  const totalScore = outcomes.reduce((total, item) => total + item.score * item.weight, 0);
  return totalScore / totalWeight;
}

// Reproduce Promptfoo's threshold or all-components pass rule.
function aggregatePass(
  outcomes: readonly WeightedComponentOutcome[],
  score: number,
  threshold: number | undefined,
  guardrailBlocked = false
): boolean {
  if (guardrailBlocked) return true;
  return threshold === undefined ? outcomes.every((item) => item.pass) : score >= threshold;
}

// Return whether one component triggers Promptfoo's redteam safety override in this scope.
function isRedteamGuardrailBlock(outcome: DefinitionComponentOutcome): boolean {
  return (
    outcome.definition.type === "guardrails" &&
    outcome.definition.config?.purpose === "redteam" &&
    !outcome.pass
  );
}

// Return Assertions in stable pre-order, including each set aggregate and its children.
function flattenAssertions(assertions: readonly AssertionDefinition[]): AssertionDefinition[] {
  const flattened: AssertionDefinition[] = [];
  for (const assertion of assertions) {
    flattened.push(assertion);
    if (assertion.assertions !== undefined) {
      flattened.push(...flattenAssertions(assertion.assertions));
    }
  }
  return flattened;
}

// Align reordered leaf components by their complete frozen Definition Hash.
function alignLeafDefinitions(
  components: readonly unknown[],
  definitions: readonly AssertionDefinition[],
  caseKey: string,
  rubricPromptMaterializations: Readonly<Record<string, string>>
): readonly AssertionDefinition[] {
  if (definitions.some((definition) => definition.assertions !== undefined)) return definitions;
  const remaining = definitions.map((definition) => ({
    definition,
    hash: hashAssertionDefinition({
      contractVersion: "cortex.assertion-definition.v1",
      definition: assertionDefinitionJson(definition)
    })
  }));
  return components.map((rawComponent, assertionIndex) => {
    const component = record(
      rawComponent,
      `PROMPTFOO_IMPORT_COMPONENT:${caseKey}:${assertionIndex}`
    );
    const rawDefinition = rawAssertionDefinition(component.assertion, caseKey, assertionIndex);
    const matchIndex = remaining.findIndex((candidate) => {
      const normalizedDefinition = definitionForExpectedPrompt(
        rawDefinition,
        candidate.definition,
        rubricPromptMaterializations
      );
      if (normalizedDefinition === null) return false;
      return (
        candidate.hash ===
        hashAssertionDefinition({
          contractVersion: "cortex.assertion-definition.v1",
          definition: normalizedDefinition
        })
      );
    });
    const match = remaining[matchIndex];
    if (match === undefined) {
      throw new Error(`PROMPTFOO_IMPORT_COMPONENT_ALIGNMENT:${caseKey}:${assertionIndex}`);
    }
    remaining.splice(matchIndex, 1);
    return match.definition;
  });
}

// Validate the synthetic Promptfoo component that represents one Assertion Set aggregate.
function validateAssertionSetComponent(
  component: Record<string, unknown>,
  expected: AssertionDefinition,
  caseKey: string,
  assertionIndex: number,
  followingChildren: readonly unknown[]
): string {
  const code = `PROMPTFOO_IMPORT_COMPONENT_ALIGNMENT:${caseKey}:${assertionIndex}`;
  const metadata = record(component.metadata, code);
  const set = record(metadata.assertionSet, code);
  const children = expected.assertions;
  if (
    expected.type !== "assert-set" ||
    children === undefined ||
    set.type !== "assert-set" ||
    set.assertionCount !== children.length ||
    set.metric !== expected.metric ||
    assertionWeight(set.weight) !== expected.weight ||
    set.threshold !== expected.threshold ||
    !Array.isArray(component.componentResults) ||
    component.componentResults.length !== children.length ||
    followingChildren.length !== children.length
  ) {
    throw new Error(code);
  }
  const nested = domainJsonValue(component.componentResults, code);
  const flattened = domainJsonValue(followingChildren, code);
  if (canonicalJson(nested) !== canonicalJson(flattened)) throw new Error(code);
  return hashAssertionDefinition({
    contractVersion: "cortex.assertion-definition.v1",
    definition: assertionDefinitionJson(expected)
  });
}

// Normalize one complete evaluated Raw row after identity alignment.
function importEvaluatedCase(
  expected: PromptfooImportCase,
  row: Record<string, unknown>,
  evidence: PromptfooRawEvidence,
  rubricPromptMaterializations: Readonly<Record<string, string>>
): ImportedEvalCase {
  if (expected.restResult.status !== "SUCCEEDED") throw new Error("PROMPTFOO_IMPORT_REST_STATE");
  if (typeof row.success !== "boolean")
    throw new Error(`PROMPTFOO_IMPORT_SUCCESS:${expected.caseKey}`);
  if (row.failureReason === 2) {
    validatePromptfooRowError(row, expected.caseKey);
    const assertions = flattenAssertions(expected.definition.assertions).map(
      (definition, index): EvalAssertionHashFact => ({
        index,
        definitionHash: hashAssertionDefinition({
          contractVersion: "cortex.assertion-definition.v1",
          definition: assertionDefinitionJson(definition)
        }),
        type: definition.type,
        metric: definition.metric,
        weight: definition.weight,
        status: "ERROR",
        score: null,
        reason: null
      })
    );
    return importEvaluationErrorCase(expected, evidence, assertions, null, null, null);
  }
  if (row.failureReason !== undefined && row.failureReason !== 0 && row.failureReason !== 1) {
    throw new Error(`PROMPTFOO_IMPORT_FAILURE_REASON:${expected.caseKey}`);
  }
  const outputCode = `PROMPTFOO_IMPORT_PROVIDER_OUTPUT:${expected.caseKey}`;
  const response = record(row.response, outputCode);
  const evaluatedOutput = domainJsonValue(response.output, outputCode);
  if (canonicalJson(evaluatedOutput) !== canonicalJson(expected.restResult.providerOutput)) {
    throw new Error(outputCode);
  }
  const score = finiteNumber(row.score, `PROMPTFOO_IMPORT_SCORE:${expected.caseKey}`);
  const grading = record(row.gradingResult, `PROMPTFOO_IMPORT_GRADING:${expected.caseKey}`);
  if (
    grading.pass !== row.success ||
    grading.score !== score ||
    typeof grading.reason !== "string"
  ) {
    throw new Error(`PROMPTFOO_IMPORT_AGGREGATE:${expected.caseKey}`);
  }
  if (!Array.isArray(grading.componentResults)) {
    throw new Error(`PROMPTFOO_IMPORT_COMPONENTS:${expected.caseKey}`);
  }
  const expectedComponentCount = flattenAssertions(expected.definition.assertions).length;
  if (grading.componentResults.length !== expectedComponentCount) {
    throw new Error(`PROMPTFOO_IMPORT_COMPONENT_COUNT:${expected.caseKey}`);
  }
  const orderedComponents = grading.componentResults;
  const assertions: EvalAssertionHashFact[] = [];
  const diffs: EvalDiffHashFact[] = [];
  const topLevelOutcomes: DefinitionComponentOutcome[] = [];
  let assertionExecutionFailed = false;
  let assertionIndex = 0;
  const alignedDefinitions = alignLeafDefinitions(
    orderedComponents,
    expected.definition.assertions,
    expected.caseKey,
    rubricPromptMaterializations
  );
  for (const definition of alignedDefinitions) {
    const rawComponent: unknown = orderedComponents[assertionIndex];
    const component = record(
      rawComponent,
      `PROMPTFOO_IMPORT_COMPONENT:${expected.caseKey}:${assertionIndex}`
    );
    if (definition.type === "assert-set") {
      const children = definition.assertions;
      if (children === undefined || children.some((child) => child.type === "assert-set")) {
        throw new Error(
          `PROMPTFOO_IMPORT_COMPONENT_ALIGNMENT:${expected.caseKey}:${assertionIndex}`
        );
      }
      const followingChildren = orderedComponents.slice(
        assertionIndex + 1,
        assertionIndex + 1 + children.length
      );
      const definitionHash = validateAssertionSetComponent(
        component,
        definition,
        expected.caseKey,
        assertionIndex,
        followingChildren
      );
      const outcome = componentOutcome(component, expected.caseKey, assertionIndex);
      const componentError = isAssertionExecutionFailure(definition, component);
      assertionExecutionFailed ||= componentError;
      const setIndex = assertionIndex;
      const childOutcomes: WeightedComponentOutcome[] = [];
      assertions.push({
        index: assertionIndex,
        definitionHash,
        type: definition.type,
        metric: definition.metric,
        weight: definition.weight,
        status: componentError ? "ERROR" : outcome.pass ? "PASS" : "FAIL",
        score: componentError ? null : outcome.score,
        reason: componentError ? "断言脚本执行异常，请检查脚本语法和运行环境。" : outcome.reason
      });
      assertionIndex += 1;
      for (const child of children) {
        const childComponent = record(
          orderedComponents[assertionIndex],
          `PROMPTFOO_IMPORT_COMPONENT:${expected.caseKey}:${assertionIndex}`
        );
        const childHash = validateLeafComponentIdentity(
          childComponent,
          child,
          expected.caseKey,
          assertionIndex,
          rubricPromptMaterializations
        );
        const childOutcome = componentOutcome(childComponent, expected.caseKey, assertionIndex);
        const childError = isAssertionExecutionFailure(child, childComponent);
        assertionExecutionFailed ||= childError;
        childOutcomes.push({ ...childOutcome, weight: child.weight });
        assertions.push({
          index: assertionIndex,
          definitionHash: childHash,
          type: child.type,
          metric: child.metric,
          weight: child.weight,
          status: childError ? "ERROR" : childOutcome.pass ? "PASS" : "FAIL",
          score: childError ? null : childOutcome.score,
          reason: childError ? "断言脚本执行异常，请检查脚本语法和运行环境。" : childOutcome.reason
        });
        diffs.push(
          ...componentDiffs(
            child,
            childOutcome.pass,
            assertionIndex,
            expected.restResult.providerOutput
          )
        );
        assertionIndex += 1;
      }
      const expectedSetScore = aggregateScore(childOutcomes);
      const expectedSetPass = aggregatePass(
        childOutcomes,
        expectedSetScore,
        definition.threshold,
        children.some(
          (child, index) =>
            child.type === "guardrails" &&
            child.config?.purpose === "redteam" &&
            childOutcomes[index]?.pass === false
        )
      );
      if (outcome.score !== expectedSetScore || outcome.pass !== expectedSetPass) {
        throw new Error(`PROMPTFOO_IMPORT_COMPONENT_AGGREGATE:${expected.caseKey}:${setIndex}`);
      }
      topLevelOutcomes.push({ ...outcome, weight: definition.weight, definition });
      continue;
    }
    const definitionHash = validateLeafComponentIdentity(
      component,
      definition,
      expected.caseKey,
      assertionIndex,
      rubricPromptMaterializations
    );
    const outcome = componentOutcome(component, expected.caseKey, assertionIndex);
    const componentError = isAssertionExecutionFailure(definition, component);
    assertionExecutionFailed ||= componentError;
    topLevelOutcomes.push({ ...outcome, weight: definition.weight, definition });
    assertions.push({
      index: assertionIndex,
      definitionHash,
      type: definition.type,
      metric: definition.metric,
      weight: definition.weight,
      status: componentError ? "ERROR" : outcome.pass ? "PASS" : "FAIL",
      score: componentError ? null : outcome.score,
      reason: componentError ? "断言脚本执行异常，请检查脚本语法和运行环境。" : outcome.reason
    });
    diffs.push(
      ...componentDiffs(
        definition,
        outcome.pass,
        assertionIndex,
        expected.restResult.providerOutput
      )
    );
    assertionIndex += 1;
  }
  if (assertionExecutionFailed) {
    return importEvaluationErrorCase(
      expected,
      evidence,
      assertions,
      nonnegativeNumber(row.latencyMs, `PROMPTFOO_IMPORT_LATENCY:${expected.caseKey}`),
      mapTokenUsage(grading),
      nonnegativeNumber(row.cost, `PROMPTFOO_IMPORT_COST:${expected.caseKey}`)
    );
  }
  const expectedScore = aggregateScore(topLevelOutcomes);
  const guardrailBlocked = topLevelOutcomes.some(isRedteamGuardrailBlock);
  const expectedPass = aggregatePass(
    topLevelOutcomes,
    expectedScore,
    expected.definition.threshold,
    guardrailBlocked
  );
  const expectedReason = guardrailBlocked ? "Content failed guardrail safety checks" : undefined;
  if (
    score !== expectedScore ||
    row.success !== expectedPass ||
    (expectedReason !== undefined && grading.reason !== expectedReason)
  ) {
    throw new Error(`PROMPTFOO_IMPORT_AGGREGATE:${expected.caseKey}`);
  }
  const metrics = aggregateCaseMetrics(
    assertions.map((item) => ({ metric: item.metric, status: item.status }))
  );
  const latencyMs = nonnegativeNumber(
    row.latencyMs,
    `PROMPTFOO_IMPORT_LATENCY:${expected.caseKey}`
  );
  const cost = nonnegativeNumber(row.cost, `PROMPTFOO_IMPORT_COST:${expected.caseKey}`);
  const tokenUsage = mapTokenUsage(grading);
  const status = row.success ? "PASS" : "FAIL";
  const evalResultHash = hashEvalResult({
    contractVersion: "cortex.eval-result.v1",
    caseKey: expected.caseKey,
    status,
    promptfooSuccess: row.success,
    score,
    reason: grading.reason,
    evaluationError: null,
    assertions,
    diffs,
    metrics
  });
  return {
    caseKey: expected.caseKey,
    ordinal: expected.ordinal,
    status,
    promptfooSuccess: row.success,
    score,
    reason: grading.reason,
    evaluationError: null,
    assertions,
    diffs,
    metrics,
    latencyMs,
    tokenUsage,
    cost,
    rawEvidence: evidence,
    evalResultHash,
    finalCaseResultHash: hashFinalCaseResult({
      contractVersion: "cortex.final-case-result.v1",
      caseDefinitionHash: expected.caseDefinitionHash,
      restResultHash: expected.restResult.resultHash,
      evalResultHash
    }),
    provenance: null
  };
}

// Generate one explicit NOT_EVALUATED Case for a real REST failure.
function importNotEvaluatedCase(expected: PromptfooImportCase): ImportedEvalCase {
  const metrics = aggregateCaseMetrics(
    flattenAssertions(expected.definition.assertions).map((assertion) => ({
      metric: assertion.metric,
      status: "NOT_EVALUATED" as const
    }))
  );
  const evalResultHash = hashEvalResult({
    contractVersion: "cortex.eval-result.v1",
    caseKey: expected.caseKey,
    status: "NOT_EVALUATED",
    promptfooSuccess: null,
    score: null,
    reason: null,
    evaluationError: null,
    assertions: [],
    diffs: [],
    metrics
  });
  return {
    caseKey: expected.caseKey,
    ordinal: expected.ordinal,
    status: "NOT_EVALUATED",
    promptfooSuccess: null,
    score: null,
    reason: null,
    evaluationError: null,
    assertions: [],
    diffs: [],
    metrics,
    latencyMs: null,
    tokenUsage: null,
    cost: null,
    rawEvidence: null,
    evalResultHash,
    finalCaseResultHash: hashFinalCaseResult({
      contractVersion: "cortex.final-case-result.v1",
      caseDefinitionHash: expected.caseDefinitionHash,
      restResultHash: expected.restResult.resultHash,
      evalResultHash
    }),
    provenance: null
  };
}

/** Strictly import an ordered Evaluation subset without manufacturing a partial set hash. */
export function importPartialPromptfooResults(
  input: PromptfooImportInput
): readonly ImportedEvalCase[] {
  if (input.promptfooVersion !== "0.121.18") throw new Error("PROMPTFOO_IMPORT_VERSION");
  const expectedByKey = new Map(input.cases.map((item) => [item.caseKey, item]));
  if (
    expectedByKey.size !== input.cases.length ||
    input.cases.some(
      (item, index) =>
        item.ordinal < 0 ||
        (index > 0 && item.ordinal <= (input.cases[index - 1]?.ordinal ?? -1)) ||
        item.definition.caseKey !== item.caseKey
    )
  ) {
    throw new Error("PROMPTFOO_IMPORT_EXPECTED_ALIGNMENT");
  }
  const rowsByKey = new Map<string, Record<string, unknown>>();
  for (const [index, rawRow] of rawRows(input.raw).entries()) {
    const row = record(rawRow, `PROMPTFOO_IMPORT_ROW:${index}`);
    const caseKey = rawCaseKey(row, index);
    if (!expectedByKey.has(caseKey)) throw new Error("PROMPTFOO_IMPORT_CASE_UNKNOWN");
    if (rowsByKey.has(caseKey)) throw new Error("PROMPTFOO_IMPORT_CASE_DUPLICATE");
    rowsByKey.set(caseKey, row);
  }
  return input.cases.map((expected) => {
    const row = rowsByKey.get(expected.caseKey);
    if (expected.restResult.status === "ERROR") {
      if (row !== undefined) throw new Error(`PROMPTFOO_IMPORT_REST_ERROR_ROW:${expected.caseKey}`);
      return importNotEvaluatedCase(expected);
    }
    if (row === undefined) throw new Error(`PROMPTFOO_IMPORT_CASE_MISSING:${expected.caseKey}`);
    return importEvaluatedCase(
      expected,
      row,
      input.rawEvidence,
      input.rubricPromptMaterializations
    );
  });
}

/** Strictly import one complete Promptfoo stage at the Application boundary. */
export function importPromptfooResults(input: CompletePromptfooImportInput): PromptfooImportResult {
  if (input.cases.some((item, index) => item.ordinal !== index)) {
    throw new Error("PROMPTFOO_IMPORT_EXPECTED_ALIGNMENT");
  }
  const cases = importPartialPromptfooResults(input);
  return {
    cases,
    resultSetHash: hashEvalResultSet({
      contractVersion: "cortex.eval-result-set.v1",
      owner: input.evaluationOwner,
      evaluationContextHash: input.evaluationContextHash,
      cases: cases.map((item) => ({
        caseKey: item.caseKey,
        ordinal: item.ordinal,
        evalResultHash: item.evalResultHash
      }))
    })
  };
}
