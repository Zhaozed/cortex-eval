import { caseDefinitionJson } from "@cortex-eval/domain/src/domain-case-projection.ts";
import type { DomainJsonObject } from "@cortex-eval/domain/src/domain-canonical-hash.ts";
import type {
  AssertionDefinition,
  CaseDefinition,
  ProviderOutput
} from "@cortex-eval/domain/src/domain-evaluation.ts";
import {
  hashAnalysisInput,
  type AnalysisSelector,
  type EvalAssertionHashFact,
  type EvalDiffHashFact
} from "@cortex-eval/domain/src/domain-hash-inputs.ts";

/** Evaluation facts required to select and construct one Analysis Input. */
export interface AnalysisEvaluationFacts {
  /** Normalized Evaluation status. */
  readonly status: "PASS" | "FAIL" | "EVALUATION_ERROR" | "NOT_EVALUATED";
  /** Hash binding frozen Case, REST and Evaluation facts. */
  readonly finalCaseResultHash: string;
  /** Ordered normalized Assertion results. */
  readonly assertions: readonly EvalAssertionHashFact[];
  /** Ordered expected/actual difference facts. */
  readonly diffs: readonly EvalDiffHashFact[];
}

/** Aligned immutable Case, REST and Evaluation facts available after Report completion. */
export interface AnalysisCaseFacts {
  /** Stable Suite-local Case key. */
  readonly caseKey: string;
  /** Original frozen Case ordinal. */
  readonly ordinal: number;
  /** Frozen Case Definition identity. */
  readonly definitionHash: string;
  /** Complete frozen Case Definition. */
  readonly definition: CaseDefinition;
  /** Strict successful Provider Output consumed by Evaluation. */
  readonly providerOutput: ProviderOutput;
  /** Complete normalized Evaluation facts. */
  readonly evaluation: AnalysisEvaluationFacts;
}

/** Versioned frozen Analysis limit accepted by both platform and offline execution. */
export interface FrozenAnalysisExecutionLimits {
  /** Limits contract identity. */
  readonly contractVersion: "cortex.analysis-execution-limits.v1";
  /** Maximum Analyzer calls in flight. */
  readonly analysisConcurrency: number;
}

/** Complete six-variable Analysis input before Prompt rendering. */
export interface FrozenAnalysisVariables {
  /** Frozen Case Definition v1 JSON. */
  readonly case_definition: DomainJsonObject;
  /** Strict Provider Output JSON. */
  readonly provider_output: DomainJsonObject;
  /** Failed or errored normalized Assertion facts. */
  readonly failed_assertions: readonly DomainJsonObject[];
  /** Ordered expected/actual difference facts. */
  readonly expected_actual_diffs: readonly DomainJsonObject[];
  /** Normalized results whose frozen Assertion references a Rubric Prompt. */
  readonly llm_rubric_results: readonly DomainJsonObject[];
  /** Entrypoint-provided redacted execution context. */
  readonly run_context: DomainJsonObject;
}

/** Protocol-neutral Application representation of Analysis Input v1. */
export interface FrozenAnalysisInput {
  /** Analysis Input contract identity. */
  readonly contractVersion: "cortex.analysis-input.v1";
  /** Stable Case key. */
  readonly caseKey: string;
  /** Complete unrendered variables. */
  readonly variables: FrozenAnalysisVariables;
  /** Bound final Case result. */
  readonly finalCaseResultHash: string;
  /** Bound frozen execution context. */
  readonly runContextHash: string;
  /** Diff interpretation identity. */
  readonly diffContractVersion: "cortex.assertion-diff.v1";
  /** Frozen Analysis Prompt identity. */
  readonly analysisPromptHash: string;
  /** Frozen Analyzer configuration identity. */
  readonly analyzerConfigHash: string;
  /** Required model output identity. */
  readonly analysisOutputContractVersion: "cortex.analysis-output.v1";
  /** Frozen Analysis execution limit. */
  readonly analysisExecutionLimits: FrozenAnalysisExecutionLimits;
}

/** Inputs required to construct one immutable Analysis identity. */
export interface BuildAnalysisInputCommand {
  /** Aligned immutable source Case facts. */
  readonly source: AnalysisCaseFacts;
  /** Frozen platform Run or offline Execution context hash. */
  readonly runContextHash: string;
  /** Redacted context exposed to the model. */
  readonly runContext: DomainJsonObject;
  /** Frozen Analysis Prompt semantic hash. */
  readonly analysisPromptHash: string;
  /** Frozen Analyzer semantic hash. */
  readonly analyzerConfigHash: string;
  /** Frozen Analysis execution limits. */
  readonly analysisExecutionLimits: FrozenAnalysisExecutionLimits;
}

/** Built Analysis Input and its semantic identity. */
export interface BuiltAnalysisInput {
  /** Complete input before Prompt rendering. */
  readonly input: FrozenAnalysisInput;
  /** SHA-256 over the complete input identity. */
  readonly analysisInputHash: string;
}

// Copy the closed Provider Output union into JSON without exposing transport objects.
function providerOutputJson(value: ProviderOutput): DomainJsonObject {
  if (!value.ok) return { ok: false, errorMessage: value.errorMessage };
  return {
    ok: true,
    taskName: value.taskName,
    resolvedConfig: value.resolvedConfig,
    parsedOutput: value.parsedOutput
  };
}

// Project one normalized Assertion result into stable structured Prompt input.
function assertionResultJson(value: EvalAssertionHashFact): DomainJsonObject {
  return {
    index: value.index,
    definitionHash: value.definitionHash,
    type: value.type,
    metric: value.metric,
    weight: value.weight,
    status: value.status,
    score: value.score,
    reason: value.reason
  };
}

// Project one stable expected/actual difference into structured Prompt input.
function diffJson(value: EvalDiffHashFact): DomainJsonObject {
  return {
    assertionIndex: value.assertionIndex,
    instancePath: value.instancePath,
    schemaPath: value.schemaPath,
    keyword: value.keyword,
    expectedConstraint: value.expectedConstraint,
    actual: value.actual,
    reason: value.reason,
    validatorVersion: value.validatorVersion,
    schemaDialect: value.schemaDialect,
    diffContractVersion: value.diffContractVersion
  };
}

// Flatten the frozen recursive Assertion tree in Promptfoo component order.
function flattenAssertions(values: readonly AssertionDefinition[]): readonly AssertionDefinition[] {
  const result: AssertionDefinition[] = [];
  const visit = (assertions: readonly AssertionDefinition[]): void => {
    for (const assertion of assertions) {
      result.push(assertion);
      if (assertion.assertions !== undefined) visit(assertion.assertions);
    }
  };
  visit(values);
  return result;
}

/** Select only analyzable Evaluation outcomes in original frozen Case order. */
export function selectAnalysisCases(
  cases: readonly AnalysisCaseFacts[],
  selector: AnalysisSelector
): readonly AnalysisCaseFacts[] {
  const selected = cases.filter((item) => {
    if (selector === "failed") return item.evaluation.status === "FAIL";
    if (selector === "errors") return item.evaluation.status === "EVALUATION_ERROR";
    return item.evaluation.status === "FAIL" || item.evaluation.status === "EVALUATION_ERROR";
  });
  return selected.sort((left, right) => left.ordinal - right.ordinal);
}

/** Build the complete redacted Analysis Input and its version identity. */
export function buildAnalysisInput(command: BuildAnalysisInputCommand): BuiltAnalysisInput {
  const source = command.source;
  const assertionDefinitions = flattenAssertions(source.definition.assertions);
  const failedAssertions = source.evaluation.assertions
    .filter((item) => item.status === "FAIL" || item.status === "ERROR")
    .map(assertionResultJson);
  const llmRubricResults = source.evaluation.assertions
    .filter((item) => assertionDefinitions[item.index]?.rubricPrompt !== undefined)
    .map(assertionResultJson);
  const variables: FrozenAnalysisVariables = {
    case_definition: caseDefinitionJson(source.definition),
    provider_output: providerOutputJson(source.providerOutput),
    failed_assertions: failedAssertions,
    expected_actual_diffs: source.evaluation.diffs.map(diffJson),
    llm_rubric_results: llmRubricResults,
    run_context: command.runContext
  };
  const input: FrozenAnalysisInput = {
    contractVersion: "cortex.analysis-input.v1",
    caseKey: source.caseKey,
    variables,
    finalCaseResultHash: source.evaluation.finalCaseResultHash,
    runContextHash: command.runContextHash,
    diffContractVersion: "cortex.assertion-diff.v1",
    analysisPromptHash: command.analysisPromptHash,
    analyzerConfigHash: command.analyzerConfigHash,
    analysisOutputContractVersion: "cortex.analysis-output.v1",
    analysisExecutionLimits: command.analysisExecutionLimits
  };
  const analysisInputHash = hashAnalysisInput({
    ...input,
    variables: {
      case_definition: variables.case_definition,
      provider_output: variables.provider_output,
      failed_assertions: [...variables.failed_assertions],
      expected_actual_diffs: [...variables.expected_actual_diffs],
      llm_rubric_results: [...variables.llm_rubric_results],
      run_context: variables.run_context
    },
    analysisExecutionLimits: {
      analysisConcurrency: input.analysisExecutionLimits.analysisConcurrency
    }
  });
  return { input, analysisInputHash };
}
