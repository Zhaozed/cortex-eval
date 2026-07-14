import type { CaseDefinitionV1 } from "@cortex-eval/contracts/src/case-contracts.ts";
import type {
  EndpointConfigV1Schema,
  LlmConfigV1Schema
} from "@cortex-eval/contracts/src/provider-contracts.ts";
import type { ConfigurationResource } from "@cortex-eval/application/src/features/configurations/configuration-models.ts";
import type {
  AssertionDefinition,
  CaseDefinition
} from "@cortex-eval/domain/src/domain-evaluation.ts";
import type {
  AnalysisPromptDefinition,
  EndpointConfigDefinition,
  LlmConfigDefinition,
  PromptDefinition
} from "@cortex-eval/domain/src/domain-resource-models.ts";
import type {
  AnalysisPromptDefinitionV1Schema,
  PromptDefinitionV1Schema
} from "@cortex-eval/contracts/src/resource-api-contracts.ts";
import type { z } from "zod";

type EndpointConfigV1 = z.infer<typeof EndpointConfigV1Schema>;
type LlmConfigV1 = z.infer<typeof LlmConfigV1Schema>;
type PromptDefinitionV1 = z.infer<typeof PromptDefinitionV1Schema>;
type AnalysisPromptDefinitionV1 = z.infer<typeof AnalysisPromptDefinitionV1Schema>;

// Map one recursive transport Assertion into its clean Domain form.
function mapAssertionFromV1(value: CaseDefinitionV1["assert"][number]): AssertionDefinition {
  return {
    type: value.type,
    metric: value.metric,
    weight: value.weight ?? 1,
    ...(value.value !== undefined ? { value: value.value } : {}),
    ...(value.threshold !== undefined ? { threshold: value.threshold } : {}),
    ...(value.config !== undefined ? { config: value.config } : {}),
    ...(value.rubricPrompt !== undefined ? { rubricPrompt: value.rubricPrompt } : {}),
    ...(value.transform !== undefined ? { transform: value.transform } : {}),
    ...(value.contextTransform !== undefined ? { contextTransform: value.contextTransform } : {}),
    ...(value.assert !== undefined ? { assertions: value.assert.map(mapAssertionFromV1) } : {})
  };
}

// Map one recursive Domain Assertion into the public v1 projection.
function mapAssertionToV1(value: AssertionDefinition): CaseDefinitionV1["assert"][number] {
  return {
    type: value.type,
    metric: value.metric,
    weight: value.weight,
    ...(value.value !== undefined ? { value: value.value } : {}),
    ...(value.threshold !== undefined ? { threshold: value.threshold } : {}),
    ...(value.config !== undefined ? { config: value.config } : {}),
    ...(value.rubricPrompt !== undefined ? { rubricPrompt: value.rubricPrompt } : {}),
    ...(value.transform !== undefined ? { transform: value.transform } : {}),
    ...(value.contextTransform !== undefined ? { contextTransform: value.contextTransform } : {}),
    ...(value.assertions !== undefined ? { assert: value.assertions.map(mapAssertionToV1) } : {})
  };
}

/** Map a strictly parsed Case Definition v1 into the Domain model. */
export function mapCaseDefinitionFromV1(value: CaseDefinitionV1): CaseDefinition {
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
      scenarioTag: value.metadata.scenario_tag
    },
    assertions: value.assert.map(mapAssertionFromV1)
  };
}

/** Map a clean Domain Case Definition into its strict public v1 projection. */
export function mapCaseDefinitionToV1(value: CaseDefinition): CaseDefinitionV1 {
  return {
    contractVersion: "cortex.case-definition.v1",
    description: value.description,
    threshold: value.threshold,
    vars: { task: value.task, request_body: value.requestBody },
    metadata: {
      case_id: value.caseKey,
      req_id: value.metadata.requestId,
      task_id: value.metadata.taskId,
      business_module: value.metadata.businessModule,
      scenario_tag: value.metadata.scenarioTag
    },
    assert: value.assertions.map(mapAssertionToV1)
  };
}

/** Remove the Endpoint transport version after strict parsing. */
export function mapEndpointDefinitionFromV1(value: EndpointConfigV1): EndpointConfigDefinition {
  const { contractVersion: _contractVersion, ...definition } = value;
  void _contractVersion;
  return definition;
}

/** Remove the LLM transport version after strict parsing. */
export function mapLlmDefinitionFromV1(value: LlmConfigV1): LlmConfigDefinition {
  const { contractVersion: _contractVersion, ...definition } = value;
  void _contractVersion;
  return definition;
}

/** Remove the shared Prompt transport version after strict parsing. */
export function mapPromptDefinitionFromV1(value: PromptDefinitionV1): PromptDefinition {
  const { contractVersion: _contractVersion, ...definition } = value;
  void _contractVersion;
  return definition;
}

/** Remove the Analysis Prompt transport version after strict parsing. */
export function mapAnalysisPromptDefinitionFromV1(
  value: AnalysisPromptDefinitionV1
): AnalysisPromptDefinition {
  const { contractVersion: _contractVersion, ...definition } = value;
  void _contractVersion;
  return definition;
}

/** Add the Endpoint transport version to one clean Domain definition. */
export function mapEndpointDefinitionToV1(value: EndpointConfigDefinition): EndpointConfigV1 {
  return { contractVersion: "cortex.endpoint-config.v1", ...value };
}

/** Add the LLM transport version to one clean Domain definition. */
export function mapLlmDefinitionToV1(value: LlmConfigDefinition): LlmConfigV1 {
  return { contractVersion: "cortex.llm-config.v1", ...value };
}

/** Add the shared Prompt transport version to one Rubric Prompt definition. */
export function mapPromptDefinitionToV1(value: PromptDefinition): PromptDefinitionV1 {
  return {
    contractVersion: "cortex.prompt.v1",
    ...value,
    messages: value.messages.map((message) => ({ ...message }))
  };
}

/** Add the shared Prompt transport version to one Analysis Prompt definition. */
export function mapAnalysisPromptDefinitionToV1(
  value: AnalysisPromptDefinition
): AnalysisPromptDefinitionV1 {
  return {
    contractVersion: "cortex.prompt.v1",
    ...value,
    messages: value.messages.map((message) => ({ ...message }))
  };
}

/** Map one clean Configuration resource into its versioned public detail DTO. */
export function mapConfigurationResourceToV1(
  value: ConfigurationResource
): Record<string, unknown> {
  if (value.kind === "ENDPOINT") {
    return {
      ...value,
      definition: { contractVersion: "cortex.endpoint-config.v1", ...value.definition }
    };
  }
  if (value.kind === "LLM") {
    return {
      ...value,
      definition: { contractVersion: "cortex.llm-config.v1", ...value.definition }
    };
  }
  return {
    ...value,
    definition: { contractVersion: "cortex.prompt.v1", ...value.definition }
  };
}
