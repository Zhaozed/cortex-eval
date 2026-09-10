import { materializeJavascriptSource } from "@cortex-eval/application/src/features/evaluation/promptfoo-javascript-source.ts";
import type { FrozenRunCase } from "@cortex-eval/application/src/features/runs/run-rest-models.ts";
import type {
  PlatformRun,
  StoredRestCaseResult
} from "@cortex-eval/application/src/features/runs/platform-run-models.ts";
import {
  assertionConfigEntryIsUnsafe,
  assertionExternalReferenceIsUnsafe
} from "@cortex-eval/contracts/src/assertion-config-safety.ts";

type AssertionDefinition = FrozenRunCase["definition"]["assertions"][number];
type ProviderOutput = Extract<
  StoredRestCaseResult,
  { readonly status: "SUCCEEDED" }
>["providerOutput"];
/** JSON object contract supplied by the Application-owned REST output port. */
type ProviderOutputJson = Extract<ProviderOutput, { readonly ok: true }>["resolvedConfig"];
type PromptMessage = PlatformRun["rubricPrompts"][number]["definition"]["messages"][number];

/** Environment variable carrying the raw Bridge capability to Promptfoo. */
export const DEFAULT_BRIDGE_CAPABILITY_ENV_KEY = "CORTEX_EVAL_BRIDGE_CAPABILITY";

/** Minimal REST fact consumed by controlled Promptfoo generation. */
export type PromptfooMaterializationRestResult =
  | { readonly status: "SUCCEEDED"; readonly providerOutput: ProviderOutput }
  | { readonly status: "ERROR" };

/** Frozen Case and corresponding REST fact. */
export interface PromptfooMaterializationCase {
  /** Frozen Case definition. */
  readonly testCase: FrozenRunCase;
  /** Exact REST outcome deciding whether Promptfoo receives the Case. */
  readonly restResult: PromptfooMaterializationRestResult;
}

/** Frozen Rubric Prompt needed by generated Assertions. */
export interface PromptfooMaterializationRubricPrompt {
  /** Stable Prompt key used by `prompt://` references. */
  readonly promptKey: string;
  /** Frozen ordered messages. */
  readonly messages: readonly PromptMessage[];
}

/** Controlled Promptfoo generation input. */
export interface MaterializePromptfooConfigV1Input {
  /** Immutable platform or offline execution binding. */
  readonly binding:
    | { readonly kind: "RUN"; readonly runId: string }
    | { readonly kind: "EXECUTION"; readonly executionId: string };
  /** Frozen Evaluation context identity. */
  readonly evaluationContextHash: string;
  /** Random loopback-only Bridge endpoint. */
  readonly bridgeUrl: string;
  /** Child environment key containing the raw capability. */
  readonly bridgeCapabilityEnvKey: string;
  /** Complete frozen Cases with REST facts. */
  readonly cases: readonly PromptfooMaterializationCase[];
  /** Complete referenced Rubric Prompt set. */
  readonly rubricPrompts: readonly PromptfooMaterializationRubricPrompt[];
  /** Exact capability-matrix dependency projection. */
  readonly requiresEvaluator: (assertionType: string) => boolean;
}

/** JSON-compatible generated Assertion shape. */
export interface MaterializedPromptfooAssertion {
  /** Original Promptfoo Assertion type. */
  readonly type: string;
  /** Stable Metric identity. */
  readonly metric: string;
  /** Frozen nonnegative aggregation weight. */
  readonly weight: number;
  /** Optional expected payload. */
  readonly value?: unknown;
  /** Optional score threshold. */
  readonly threshold?: number;
  /** Optional Assertion configuration. */
  readonly config?: Readonly<Record<string, unknown>>;
  /** Optional inline JSON rubric prompt. */
  readonly rubricPrompt?: string;
  /** Optional trusted inline output transform. */
  readonly transform?: string;
  /** Optional trusted inline context transform. */
  readonly contextTransform?: string;
  /** Nested Assertions for Assertion Set. */
  readonly assert?: readonly MaterializedPromptfooAssertion[];
}

/** One controlled Promptfoo test row. */
export interface MaterializedPromptfooTest {
  /** Frozen Case description. */
  readonly description: string;
  /** Exact Promptfoo template variables. */
  readonly vars: Readonly<Record<string, unknown>>;
  /** Stable Case identity metadata. */
  readonly metadata: Readonly<Record<string, string | boolean>>;
  /** Precomputed REST output. */
  readonly providerOutput: ProviderOutputJson;
  /** Original ordered Assertion tree. */
  readonly assert: readonly MaterializedPromptfooAssertion[];
  /** Frozen Case threshold. */
  readonly threshold: number;
}

/** Complete JSON configuration passed to Promptfoo 0.121.18. */
export interface MaterializedPromptfooConfigV1 {
  /** Main prompt used only as a stable Promptfoo row identity. */
  readonly prompts: readonly [string];
  /** Echo main Provider; precomputed output prevents external execution. */
  readonly providers: readonly [{ readonly id: "echo" }];
  /** Shared controlled grading Provider. */
  readonly defaultTest: {
    readonly options: {
      readonly provider: {
        readonly id: "http";
        readonly config: Readonly<Record<string, unknown>>;
      };
    };
  };
  /** REST-success Cases only. */
  readonly tests: readonly MaterializedPromptfooTest[];
}

/** Generated config plus deterministic sidecar facts. */
export interface MaterializedPromptfooConfigResult {
  /** Secret-free Promptfoo JSON configuration. */
  readonly config: MaterializedPromptfooConfigV1;
  /** Exact upper budget derived from generated Assertion instances. */
  readonly evaluatorCallBudget: number;
  /** Frozen Prompt reference to exact inline materialization. */
  readonly rubricPromptMaterializations: Readonly<Record<string, string>>;
}

// Convert one frozen Prompt to the JSON chat-message string accepted by Promptfoo.
function materializeRubricPrompt(prompt: PromptfooMaterializationRubricPrompt): string {
  return JSON.stringify(
    prompt.messages.map((message) => ({
      role: message.role.toLowerCase(),
      content: message.content
    }))
  );
}

// Recursively count only Assertion instances whose fixed capability needs an Evaluator.
function evaluatorCallBudget(
  assertions: readonly AssertionDefinition[],
  requiresEvaluator: (assertionType: string) => boolean
): number {
  let total = 0;
  for (const assertion of assertions) {
    if (requiresEvaluator(assertion.type)) total += 1;
    if (assertion.assertions !== undefined) {
      total += evaluatorCallBudget(assertion.assertions, requiresEvaluator);
    }
  }
  return total;
}

/** Count Evaluator calls for one already aligned materialization Case. */
export function countPromptfooCaseEvaluatorCalls(
  item: PromptfooMaterializationCase,
  requiresEvaluator: (assertionType: string) => boolean
): number {
  return item.restResult.status === "ERROR"
    ? 0
    : evaluatorCallBudget(item.testCase.definition.assertions, requiresEvaluator);
}

/** Count the exact generated Evaluator calls without restricting Assertion types. */
export function countPromptfooEvaluatorCalls(
  cases: readonly PromptfooMaterializationCase[],
  requiresEvaluator: (assertionType: string) => boolean
): number {
  let total = 0;
  for (const item of cases) {
    total += countPromptfooCaseEvaluatorCalls(item, requiresEvaluator);
  }
  return total;
}

// Materialize one Assertion without interpreting or restricting its type.
function materializeAssertion(
  assertion: AssertionDefinition,
  prompts: ReadonlyMap<string, string>
): MaterializedPromptfooAssertion {
  const result: {
    type: string;
    metric: string;
    weight: number;
    value?: unknown;
    threshold?: number;
    config?: Readonly<Record<string, unknown>>;
    rubricPrompt?: string;
    transform?: string;
    contextTransform?: string;
    assert?: readonly MaterializedPromptfooAssertion[];
  } = { type: assertion.type, metric: assertion.metric, weight: assertion.weight };
  if (
    (assertion.value !== undefined && assertionExternalReferenceIsUnsafe(assertion.value)) ||
    (assertion.transform !== undefined &&
      assertionExternalReferenceIsUnsafe(assertion.transform)) ||
    (assertion.contextTransform !== undefined &&
      assertionExternalReferenceIsUnsafe(assertion.contextTransform))
  ) {
    throw new Error("PROMPTFOO_ASSERTION_REFERENCE_UNSAFE");
  }
  if (assertion.value !== undefined)
    result.value =
      typeof assertion.value === "string"
        ? materializeJavascriptSource(assertion.type, assertion.value)
        : assertion.value;
  if (assertion.threshold !== undefined) result.threshold = assertion.threshold;
  if (assertion.config !== undefined) {
    if (assertionConfigEntryIsUnsafe(assertion.config)) {
      throw new Error("PROMPTFOO_ASSERTION_CONFIG_UNSAFE");
    }
    result.config = assertion.config;
  }
  if (assertion.rubricPrompt !== undefined) {
    const prompt = prompts.get(assertion.rubricPrompt);
    if (prompt === undefined) throw new Error("PROMPTFOO_RUBRIC_PROMPT_MISSING");
    result.rubricPrompt = prompt;
  }
  if (assertion.transform !== undefined) result.transform = assertion.transform;
  if (assertion.contextTransform !== undefined) {
    result.contextTransform = assertion.contextTransform;
  }
  if (assertion.assertions !== undefined) {
    result.assert = assertion.assertions.map((child) => materializeAssertion(child, prompts));
  }
  return result;
}

// Expose REST success to Promptfoo in the same public shape used by REST artifacts.
function providerOutputJson(value: ProviderOutput): ProviderOutputJson {
  if (!value.ok) return { ok: false, errorMessage: value.errorMessage };
  return {
    ok: true,
    task_name: value.taskName,
    resolved_config: value.resolvedConfig,
    parsed_output: value.parsedOutput
  };
}

/** Materialize one REST-success Case without retaining the complete test collection. */
function materializePromptfooTestWithPrompts(
  item: PromptfooMaterializationCase,
  prompts: ReadonlyMap<string, string>
): MaterializedPromptfooTest | null {
  if (item.restResult.status === "ERROR") return null;
  return {
    description: item.testCase.definition.description,
    vars: {
      task: item.testCase.definition.task,
      request_body: item.testCase.definition.requestBody
    },
    metadata: {
      case_id: item.testCase.caseKey,
      req_id: item.testCase.definition.metadata.requestId,
      task_id: item.testCase.definition.metadata.taskId,
      business_module: item.testCase.definition.metadata.businessModule,
      scenario_tag: item.testCase.definition.metadata.scenarioTag,
      ...(item.testCase.definition.metadata.a2uiCapture === undefined
        ? {}
        : { a2ui_capture: item.testCase.definition.metadata.a2uiCapture })
    },
    providerOutput: providerOutputJson(item.restResult.providerOutput),
    assert: item.testCase.definition.assertions.map((assertion) =>
      materializeAssertion(assertion, prompts)
    ),
    threshold: item.testCase.definition.threshold
  };
}

/** Materialize one REST-success Case from already frozen prompt materializations. */
export function materializePromptfooTest(
  item: PromptfooMaterializationCase,
  rubricPromptMaterializations: Readonly<Record<string, string>>
): MaterializedPromptfooTest | null {
  return materializePromptfooTestWithPrompts(
    item,
    new Map(Object.entries(rubricPromptMaterializations))
  );
}

/** Materialize one secret-free, fixed-version Promptfoo configuration. */
export function materializePromptfooConfigV1(
  input: MaterializePromptfooConfigV1Input
): MaterializedPromptfooConfigResult {
  const bridgeUrl = new URL(input.bridgeUrl);
  if (
    bridgeUrl.protocol !== "http:" ||
    bridgeUrl.hostname !== "127.0.0.1" ||
    bridgeUrl.username !== "" ||
    bridgeUrl.password !== ""
  ) {
    throw new Error("PROMPTFOO_BRIDGE_URL_INVALID");
  }
  if (!/^[A-Z][A-Z0-9_]*$/.test(input.bridgeCapabilityEnvKey)) {
    throw new Error("PROMPTFOO_BRIDGE_ENV_KEY_INVALID");
  }

  const promptEntries = input.rubricPrompts.map(
    (prompt) => [`prompt://${prompt.promptKey}`, materializeRubricPrompt(prompt)] as const
  );
  const prompts = new Map(promptEntries);
  if (prompts.size !== promptEntries.length) throw new Error("PROMPTFOO_RUBRIC_PROMPT_DUPLICATE");

  const callBudget = countPromptfooEvaluatorCalls(input.cases, input.requiresEvaluator);
  const tests: MaterializedPromptfooTest[] = [];
  for (const item of input.cases) {
    const test = materializePromptfooTestWithPrompts(item, prompts);
    if (test !== null) tests.push(test);
  }

  return {
    config: {
      prompts: ["{{ task }}"],
      providers: [{ id: "echo" }],
      defaultTest: {
        options: {
          provider: {
            id: "http",
            config: {
              url: input.bridgeUrl,
              method: "POST",
              headers: {
                authorization: `Bearer {{ env.${input.bridgeCapabilityEnvKey} }}`,
                "content-type": "application/json"
              },
              body: {
                contractVersion: "cortex.evaluator-bridge-request.v2",
                binding: input.binding,
                evaluationContextHash: input.evaluationContextHash,
                prompt: "{{ prompt }}"
              },
              responseParser:
                "json.output.tokenUsage === null ? ({ output: json.output.text }) : ({ output: json.output.text, tokenUsage: ({ prompt: json.output.tokenUsage.inputTokens, completion: json.output.tokenUsage.outputTokens, total: json.output.tokenUsage.totalTokens, numRequests: 1 }) })",
              maxRetries: 0
            }
          }
        }
      },
      tests
    },
    evaluatorCallBudget: callBudget,
    rubricPromptMaterializations: Object.fromEntries(promptEntries)
  };
}
