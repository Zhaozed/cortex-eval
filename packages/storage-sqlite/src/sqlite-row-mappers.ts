import type { StoredTestCase } from "@cortex-eval/application/src/features/test-suites/test-suite-models.ts";
import { deriveCaseSearchProjection } from "@cortex-eval/domain/src/domain-case-projection.ts";
import {
  canonicalJson,
  type DomainJsonObject,
  type DomainJsonValue
} from "@cortex-eval/domain/src/domain-canonical-hash.ts";
import type {
  AssertionDefinition,
  CaseDefinition
} from "@cortex-eval/domain/src/domain-evaluation.ts";
import { validateCaseDefinition } from "@cortex-eval/domain/src/domain-evaluation.ts";
import { hashCaseDefinition } from "@cortex-eval/domain/src/domain-hash-inputs.ts";
import { collectRubricPromptKeys } from "@cortex-eval/domain/src/domain-resource-models.ts";
import type { Selectable } from "kysely";

import type { TestCaseTable } from "./sqlite-schema.ts";

/** Stable corrupt-row failure raised before Application receives dirty data. */
export class SqliteRowInvalidError extends Error {
  /** Stable machine-readable error code. */
  public readonly code = "SQLITE_ROW_INVALID" as const;

  /** Create one path-safe persistence-boundary failure. */
  public constructor() {
    super("SQLITE_ROW_INVALID");
    this.name = "SqliteRowInvalidError";
  }
}

// Narrow one unknown value to a plain record.
function record(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SqliteRowInvalidError();
  }
  return value as Readonly<Record<string, unknown>>;
}

// Require a versioned persisted object to contain exactly its declared members.
function requireExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[]
): void {
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) {
    throw new SqliteRowInvalidError();
  }
}

// Reject unknown Assertion members while allowing its declared optional fields.
function requireAssertionKeys(value: Readonly<Record<string, unknown>>): void {
  const allowed = [
    "type",
    "metric",
    "weight",
    "value",
    "threshold",
    "config",
    "rubricPrompt",
    "transform",
    "contextTransform",
    "assert"
  ];
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new SqliteRowInvalidError();
  }
}

// Read one required string member.
function stringMember(value: Readonly<Record<string, unknown>>, key: string): string {
  const member = value[key];
  if (typeof member !== "string") throw new SqliteRowInvalidError();
  return member;
}

// Read one required finite number member.
function numberMember(value: Readonly<Record<string, unknown>>, key: string): number {
  const member = value[key];
  if (typeof member !== "number" || !Number.isFinite(member)) throw new SqliteRowInvalidError();
  return member;
}

// Read one optional number without silently discarding a wrong persisted type.
function optionalNumber(value: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const member = value[key];
  if (member === undefined) return undefined;
  if (typeof member !== "number" || !Number.isFinite(member)) throw new SqliteRowInvalidError();
  return member;
}

// Read one optional string without silently discarding a wrong persisted type.
function optionalString(value: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const member = value[key];
  if (member === undefined) return undefined;
  if (typeof member !== "string") throw new SqliteRowInvalidError();
  return member;
}

// Parse validated canonical JSON and require an object root.
function jsonObject(serialized: string): DomainJsonObject {
  try {
    const parsed: unknown = JSON.parse(serialized);
    canonicalJson(parsed as DomainJsonValue);
    return record(parsed) as DomainJsonObject;
  } catch {
    throw new SqliteRowInvalidError();
  }
}

// Parse one exact string array used by derived filter columns.
function stringArray(serialized: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
      throw new SqliteRowInvalidError();
    }
    return parsed;
  } catch (error) {
    if (error instanceof SqliteRowInvalidError) throw error;
    throw new SqliteRowInvalidError();
  }
}

// Map one validated persisted Assertion recursively.
function assertion(value: unknown): AssertionDefinition {
  const source = record(value);
  requireAssertionKeys(source);
  const result: AssertionDefinition = {
    type: stringMember(source, "type"),
    metric: stringMember(source, "metric"),
    weight: numberMember(source, "weight")
  };
  const nested = source.assert;
  if (nested !== undefined && !Array.isArray(nested)) throw new SqliteRowInvalidError();
  const threshold = optionalNumber(source, "threshold");
  const rubricPrompt = optionalString(source, "rubricPrompt");
  const transform = optionalString(source, "transform");
  const contextTransform = optionalString(source, "contextTransform");
  return {
    ...result,
    ...(source.value === undefined ? {} : { value: source.value as DomainJsonValue }),
    ...(threshold === undefined ? {} : { threshold }),
    ...(source.config === undefined ? {} : { config: record(source.config) as DomainJsonObject }),
    ...(rubricPrompt === undefined ? {} : { rubricPrompt }),
    ...(transform === undefined ? {} : { transform }),
    ...(contextTransform === undefined ? {} : { contextTransform }),
    ...(Array.isArray(nested) ? { assertions: nested.map(assertion) } : {})
  };
}

// Map the stable persisted v1 Case projection into the clean Domain model.
function caseDefinition(source: DomainJsonObject): CaseDefinition {
  const root = record(source);
  requireExactKeys(root, [
    "contractVersion",
    "description",
    "threshold",
    "vars",
    "metadata",
    "assert"
  ]);
  if (root.contractVersion !== "cortex.case-definition.v1") throw new SqliteRowInvalidError();
  const variables = record(root.vars);
  const metadata = record(root.metadata);
  requireExactKeys(variables, ["task", "request_body"]);
  requireExactKeys(metadata, ["case_id", "req_id", "task_id", "business_module", "scenario_tag"]);
  const assertions = root.assert;
  if (!Array.isArray(assertions)) throw new SqliteRowInvalidError();
  const definition: CaseDefinition = {
    caseKey: stringMember(metadata, "case_id"),
    description: stringMember(root, "description"),
    threshold: numberMember(root, "threshold"),
    task: stringMember(variables, "task"),
    requestBody: record(variables.request_body) as DomainJsonObject,
    metadata: {
      requestId: stringMember(metadata, "req_id"),
      taskId: stringMember(metadata, "task_id"),
      businessModule: stringMember(metadata, "business_module"),
      scenarioTag: stringMember(metadata, "scenario_tag")
    },
    assertions: assertions.map(assertion)
  };
  const validation = validateCaseDefinition(definition);
  if (!validation.ok) throw new SqliteRowInvalidError();
  return definition;
}

/** Map and validate one persisted Case row. */
export function mapStoredTestCase(row: Selectable<TestCaseTable>): StoredTestCase {
  const definitionJson = jsonObject(row.definition_json);
  const definition = caseDefinition(definitionJson);
  const projection = deriveCaseSearchProjection(definition);
  const assertionTypes = stringArray(row.assertion_types_json);
  const metrics = stringArray(row.metrics_json);
  const rubricPromptKeys = stringArray(row.rubric_prompt_keys_json);
  const expectedRubricPromptKeys = collectRubricPromptKeys(definition);
  const expectedHash = hashCaseDefinition({
    contractVersion: "cortex.case-definition.v1",
    caseKey: definition.caseKey,
    definition: definitionJson
  });
  const aligned =
    definition.caseKey === row.case_key &&
    definition.description === row.description &&
    definition.metadata.businessModule === row.business_module &&
    definition.metadata.scenarioTag === row.scenario_tag &&
    sameStrings(assertionTypes, projection.assertionTypes) &&
    sameStrings(metrics, projection.metrics) &&
    sameStrings(rubricPromptKeys, expectedRubricPromptKeys) &&
    row.definition_hash === expectedHash;
  if (!aligned) throw new SqliteRowInvalidError();
  return {
    id: row.id,
    suiteId: row.suite_id,
    caseKey: row.case_key,
    ordinal: row.ordinal,
    description: row.description,
    businessModule: row.business_module,
    scenarioTag: row.scenario_tag,
    assertionTypes,
    metrics,
    definition,
    definitionJson,
    rubricPromptKeys,
    definitionHash: row.definition_hash,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// Compare normalized string arrays without coercion or reordering.
function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}
