import {
  validateAnalysisResult,
  type AnalysisEvidenceDraft,
  type AnalysisProposalDraft,
  type AnalysisResultDraft
} from "@cortex-eval/domain/src/domain-analysis.ts";
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
  validateAnalysisPrompt,
  validateLlmConfig,
  type PromptMessage
} from "@cortex-eval/domain/src/domain-resource-models.ts";

import type { AnalysisModelRequest } from "./case-analysis-model-client.ts";
import type { FrozenAnalysisVariables } from "./case-analysis-input-builder.ts";

/** Recursive Assertion already cleaned by the protocol Adapter. */
export interface AnalysisBoundaryAssertion {
  /** Assertion type. */
  readonly type: string;
  /** Stable result Metric. */
  readonly metric: string;
  /** Optional expected value. */
  readonly value?: DomainJsonValue | undefined;
  /** Optional score or duration threshold. */
  readonly threshold?: number | undefined;
  /** Optional nonnegative aggregation weight. */
  readonly weight?: number | undefined;
  /** Optional Assertion configuration. */
  readonly config?: DomainJsonObject | undefined;
  /** Optional Rubric Prompt reference. */
  readonly rubricPrompt?: string | undefined;
  /** Optional trusted output transform. */
  readonly transform?: string | undefined;
  /** Optional trusted context transform. */
  readonly contextTransform?: string | undefined;
  /** Nested Assertion Set members. */
  readonly assert?: readonly AnalysisBoundaryAssertion[] | undefined;
}

/** Complete Case payload already cleaned by the protocol Adapter. */
export interface AnalysisBoundaryCase {
  /** Case protocol identity. */
  readonly contractVersion: "cortex.case-definition.v1";
  /** Human-readable Case description. */
  readonly description: string;
  /** Case pass threshold. */
  readonly threshold: number;
  /** Case variables. */
  readonly vars: {
    readonly task: string;
    readonly request_body: DomainJsonObject;
  };
  /** Stable Case business metadata. */
  readonly metadata: {
    readonly case_id: string;
    readonly req_id: string;
    readonly task_id: string;
    readonly business_module: string;
    readonly scenario_tag: string;
    readonly a2ui_capture?: boolean | undefined;
  };
  /** Complete ordered Assertions. */
  readonly assert: readonly AnalysisBoundaryAssertion[];
}

/** Single Proposal already cleaned by the protocol Adapter. */
export type AnalysisBoundaryProposal =
  | {
      readonly action: "REPLACE_CASE";
      readonly baseDefinitionHash: string;
      readonly casePayload: AnalysisBoundaryCase;
    }
  | {
      readonly action: "ADD_ASSERTION";
      readonly baseDefinitionHash: string;
      readonly targetAssertionIndex: number;
      readonly assertion: AnalysisBoundaryAssertion;
    }
  | {
      readonly action: "REPLACE_ASSERTION";
      readonly baseDefinitionHash: string;
      readonly targetAssertionIndex: number;
      readonly targetAssertionDefinitionHash: string;
      readonly assertion: AnalysisBoundaryAssertion;
    }
  | {
      readonly action: "REMOVE_ASSERTION";
      readonly baseDefinitionHash: string;
      readonly targetAssertionIndex: number;
      readonly targetAssertionDefinitionHash: string;
    };

/** Strict structured output already cleaned by the protocol Adapter. */
export interface AnalysisBoundaryOutput {
  /** Output protocol identity. */
  readonly contractVersion: "cortex.analysis-output.v1";
  /** Fixed diagnostic classification. */
  readonly classification:
    "LABEL_ERROR" | "ADDITIONAL_VALID_RESULT" | "NORMAL_FAILURE" | "PARAMETER_VARIANCE";
  /** Model self-assessed confidence. */
  readonly confidence: number;
  /** Ordered structured evidence. */
  readonly evidence: readonly AnalysisEvidenceDraft[];
  /** Human-readable explanation. */
  readonly explanation: string;
  /** Human-readable recommended action. */
  readonly recommendedAction: string;
  /** Optional single Proposal. */
  readonly proposal: AnalysisBoundaryProposal | null;
}

/** Validated and rendered provider-neutral messages. */
export type PreparedAnalysisModelRequest =
  { readonly ok: true; readonly messages: readonly PromptMessage[] } | { readonly ok: false };

const TEMPLATE_VARIABLE =
  /{{\s*(case_definition|provider_output|failed_assertions|expected_actual_diffs|llm_rubric_results|run_context)\s*}}/g;

// Return one structured variable as canonical mutable JSON.
function promptVariable(
  variables: FrozenAnalysisVariables,
  name: keyof FrozenAnalysisVariables
): DomainJsonValue {
  if (name === "failed_assertions") return [...variables.failed_assertions];
  if (name === "expected_actual_diffs") return [...variables.expected_actual_diffs];
  if (name === "llm_rubric_results") return [...variables.llm_rubric_results];
  return variables[name];
}

/** Validate frozen resources and render only the six closed structured variables. */
export function prepareAnalysisModelRequest(
  request: AnalysisModelRequest
): PreparedAnalysisModelRequest {
  if (!validateLlmConfig(request.analyzer).ok || !validateAnalysisPrompt(request.prompt).ok) {
    return { ok: false };
  }
  const messages = request.prompt.messages.map((message) => ({
    role: message.role,
    content: message.content.replaceAll(TEMPLATE_VARIABLE, (_match, captured: string) => {
      const name = captured as keyof FrozenAnalysisVariables;
      return canonicalJson(promptVariable(request.variables, name));
    })
  }));
  return { ok: true, messages };
}

// Map one cleaned recursive Assertion into the pure Domain definition.
function assertionFromBoundary(value: AnalysisBoundaryAssertion): AssertionDefinition {
  return {
    type: value.type,
    metric: value.metric,
    weight: value.weight ?? 1,
    ...(value.value === undefined ? {} : { value: value.value }),
    ...(value.threshold === undefined ? {} : { threshold: value.threshold }),
    ...(value.config === undefined ? {} : { config: value.config }),
    ...(value.rubricPrompt === undefined ? {} : { rubricPrompt: value.rubricPrompt }),
    ...(value.transform === undefined ? {} : { transform: value.transform }),
    ...(value.contextTransform === undefined ? {} : { contextTransform: value.contextTransform }),
    ...(value.assert === undefined ? {} : { assertions: value.assert.map(assertionFromBoundary) })
  };
}

// Map one cleaned transport Case into the pure Domain definition.
function caseFromBoundary(value: AnalysisBoundaryCase): CaseDefinition {
  return {
    caseKey: value.metadata.case_id,
    description: value.description,
    threshold: value.threshold,
    task: value.vars.task,
    requestBody: value.vars.request_body,
    metadata: {
      requestId: value.metadata.req_id,
      taskId: value.metadata.task_id,
      businessModule: value.metadata.business_module,
      scenarioTag: value.metadata.scenario_tag,
      ...(value.metadata.a2ui_capture === undefined
        ? {}
        : { a2uiCapture: value.metadata.a2ui_capture })
    },
    assertions: value.assert.map(assertionFromBoundary)
  };
}

// Map one cleaned Proposal into the pure Domain discriminated union.
export function analysisProposalFromBoundary(
  value: AnalysisBoundaryProposal
): AnalysisProposalDraft {
  if (value.action === "REPLACE_CASE") {
    return {
      action: value.action,
      baseDefinitionHash: value.baseDefinitionHash,
      casePayload: caseFromBoundary(value.casePayload)
    };
  }
  if (value.action === "ADD_ASSERTION") {
    return {
      action: value.action,
      baseDefinitionHash: value.baseDefinitionHash,
      targetAssertionIndex: value.targetAssertionIndex,
      assertion: assertionFromBoundary(value.assertion)
    };
  }
  if (value.action === "REPLACE_ASSERTION") {
    return {
      action: value.action,
      baseDefinitionHash: value.baseDefinitionHash,
      targetAssertionIndex: value.targetAssertionIndex,
      targetAssertionDefinitionHash: value.targetAssertionDefinitionHash,
      assertion: assertionFromBoundary(value.assertion)
    };
  }
  return {
    action: value.action,
    baseDefinitionHash: value.baseDefinitionHash,
    targetAssertionIndex: value.targetAssertionIndex,
    targetAssertionDefinitionHash: value.targetAssertionDefinitionHash
  };
}

/** Map one cleaned protocol output into Domain and re-check all Domain invariants. */
export function analysisResultFromBoundary(
  value: AnalysisBoundaryOutput
): AnalysisResultDraft | null {
  const result: AnalysisResultDraft = {
    classification: value.classification,
    confidence: value.confidence,
    evidence: value.evidence.map((item) => ({ ...item })),
    explanation: value.explanation,
    recommendedAction: value.recommendedAction,
    ...(value.proposal === null ? {} : { proposal: analysisProposalFromBoundary(value.proposal) })
  };
  return validateAnalysisResult(result).ok ? result : null;
}
