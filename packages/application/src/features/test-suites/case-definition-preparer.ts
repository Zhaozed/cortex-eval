import {
  caseDefinitionJson,
  deriveCaseSearchProjection
} from "@cortex-eval/domain/src/domain-case-projection.ts";
import {
  validateCaseDefinition,
  type CaseDefinition
} from "@cortex-eval/domain/src/domain-evaluation.ts";
import { hashCaseDefinition } from "@cortex-eval/domain/src/domain-hash-inputs.ts";
import { collectRubricPromptKeys } from "@cortex-eval/domain/src/domain-resource-models.ts";

import type { CaseWriteError, StoredTestCase } from "./test-suite-models.ts";

/** Pure prepared Case facts before a Suite and Ordinal are assigned. */
export interface PreparedCaseDefinition {
  /** New internal identity. */
  readonly id: string;
  /** Complete clean definition. */
  readonly definition: CaseDefinition;
  /** Stable persisted projection. */
  readonly definitionJson: ReturnType<typeof caseDefinitionJson>;
  /** Referenced Rubric Prompt keys. */
  readonly rubricPromptKeys: readonly string[];
  /** Semantic definition hash. */
  readonly definitionHash: string;
  /** Derived filter facts. */
  readonly projection: ReturnType<typeof deriveCaseSearchProjection>;
  /** Shared write timestamp. */
  readonly timestamp: string;
}

/** Validate and derive one Case before any persistence side effect. */
export function prepareCaseDefinition(
  definition: CaseDefinition,
  id: string,
  timestamp: string
): PreparedCaseDefinition | CaseWriteError {
  const validation = validateCaseDefinition(definition);
  if (!validation.ok) return validation.error;
  const definitionJson = caseDefinitionJson(definition);
  return {
    id,
    definition,
    definitionJson,
    rubricPromptKeys: collectRubricPromptKeys(definition),
    definitionHash: hashCaseDefinition({
      contractVersion: "cortex.case-definition.v1",
      caseKey: definition.caseKey,
      definition: definitionJson
    }),
    projection: deriveCaseSearchProjection(definition),
    timestamp
  };
}

/** Assign one prepared Case to its current Suite and exact Ordinal. */
export function materializeStoredCase(
  value: PreparedCaseDefinition,
  suiteId: string,
  ordinal: number
): StoredTestCase {
  return {
    id: value.id,
    suiteId,
    caseKey: value.definition.caseKey,
    ordinal,
    description: value.definition.description,
    businessModule: value.definition.metadata.businessModule,
    scenarioTag: value.definition.metadata.scenarioTag,
    assertionTypes: value.projection.assertionTypes,
    metrics: value.projection.metrics,
    definition: value.definition,
    definitionJson: value.definitionJson,
    rubricPromptKeys: value.rubricPromptKeys,
    definitionHash: value.definitionHash,
    revision: 0,
    createdAt: value.timestamp,
    updatedAt: value.timestamp
  };
}
