import type { DomainJsonObject, DomainJsonValue } from "./domain-canonical-hash.ts";
import type { AssertionDefinition, CaseDefinition } from "./domain-evaluation.ts";

/** Search facts derived from a complete Case Definition. */
export interface CaseSearchProjection {
  /** Unique recursive Assertion types. */
  readonly assertionTypes: readonly string[];
  /** Unique recursive Metric names. */
  readonly metrics: readonly string[];
}

/** Map one clean recursive Assertion into its stable v1 JSON definition. */
export function assertionDefinitionJson(assertion: AssertionDefinition): DomainJsonObject {
  const result: DomainJsonObject = {
    type: assertion.type,
    metric: assertion.metric,
    weight: assertion.weight
  };
  const optionalValues: readonly (readonly [string, DomainJsonValue | undefined])[] = [
    ["value", assertion.value],
    ["threshold", assertion.threshold],
    ["config", assertion.config],
    ["rubricPrompt", assertion.rubricPrompt],
    ["transform", assertion.transform],
    ["contextTransform", assertion.contextTransform]
  ];
  for (const [key, value] of optionalValues) {
    if (value !== undefined) result[key] = value;
  }
  if (assertion.assertions !== undefined) {
    result.assert = assertion.assertions.map(assertionDefinitionJson);
  }
  return result;
}

/** Convert a clean Domain Case to the stable v1 persisted definition. */
export function caseDefinitionJson(definition: CaseDefinition): DomainJsonObject {
  return {
    contractVersion: "cortex.case-definition.v1",
    description: definition.description,
    threshold: definition.threshold,
    vars: { task: definition.task, request_body: definition.requestBody },
    metadata: {
      case_id: definition.caseKey,
      req_id: definition.metadata.requestId,
      task_id: definition.metadata.taskId,
      business_module: definition.metadata.businessModule,
      scenario_tag: definition.metadata.scenarioTag
    },
    assert: definition.assertions.map(assertionDefinitionJson)
  };
}

/** Derive stable recursive Assertion and Metric filter facts. */
export function deriveCaseSearchProjection(definition: CaseDefinition): CaseSearchProjection {
  const assertionTypes = new Set<string>();
  const metrics = new Set<string>();
  const visit = (assertions: CaseDefinition["assertions"]): void => {
    for (const assertion of assertions) {
      assertionTypes.add(assertion.type);
      metrics.add(assertion.metric);
      if (assertion.assertions !== undefined) visit(assertion.assertions);
    }
  };
  visit(definition.assertions);
  const sort = (values: Set<string>): readonly string[] =>
    [...values].sort((left, right) => left.localeCompare(right));
  return { assertionTypes: sort(assertionTypes), metrics: sort(metrics) };
}
