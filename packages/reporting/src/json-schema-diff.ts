import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import type {
  DomainJsonObject,
  DomainJsonValue
} from "@cortex-eval/domain/src/domain-canonical-hash.ts";
import type { EvalDiffHashFact } from "@cortex-eval/domain/src/domain-hash-inputs.ts";

/** Frozen JSON Schema dialect used for P6 evaluation explanations. */
export const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

/** Direct dependency version whose error structure is part of the Diff contract. */
export const JSON_SCHEMA_VALIDATOR_VERSION = "8.20.0";

/** Input facts for one Promptfoo `is-json` explanation. */
export interface JsonSchemaResultInput {
  /** Frozen Assertion index. */
  readonly assertionIndex: number;
  /** Promptfoo aggregate fact that remains authoritative. */
  readonly promptfooPassed: boolean;
  /** Validated JSON Schema candidate. */
  readonly schema: boolean | DomainJsonObject;
  /** Parsed Provider Output value checked by Promptfoo. */
  readonly actual: DomainJsonValue;
}

/** Stable explanation or an importer-stopping validator error. */
export type JsonSchemaResult =
  | { readonly ok: true; readonly diffs: readonly EvalDiffHashFact[] }
  | {
      readonly ok: false;
      readonly error:
        | { readonly code: "JSON_SCHEMA_INVALID" }
        | {
            readonly code: "JSON_SCHEMA_VALIDATOR_DISAGREEMENT";
            readonly promptfooPassed: boolean;
            readonly validatorPassed: boolean;
          };
    };

const MISSING_VALUE = { kind: "MISSING" } as const;

// Decode one RFC 6901 path segment.
function decodePointerSegment(value: string): string {
  return value.replace(/~1/g, "/").replace(/~0/g, "~");
}

// Encode one RFC 6901 path segment.
function encodePointerSegment(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

// Resolve one JSON Pointer, returning an explicit missing fact when traversal fails.
function resolvePointer(value: DomainJsonValue, pointer: string): DomainJsonValue {
  const normalized = pointer.startsWith("#") ? pointer.slice(1) : pointer;
  if (normalized === "") return value;
  if (!normalized.startsWith("/")) return MISSING_VALUE;
  let current: DomainJsonValue = value;
  for (const rawSegment of normalized.slice(1).split("/")) {
    const segment = decodePointerSegment(rawSegment);
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return MISSING_VALUE;
      current = current[index] ?? null;
      continue;
    }
    if (typeof current !== "object" || current === null || !Object.hasOwn(current, segment)) {
      return MISSING_VALUE;
    }
    current = current[segment] ?? null;
  }
  return current;
}

// Read one string property from Ajv's validated JSON error parameters.
function errorParameter(error: ErrorObject, key: string): string | null {
  const value = (error.params as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

// Add the property identified by a parent-scoped Ajv keyword to the instance path.
function exactInstancePath(error: ErrorObject): string {
  const property =
    error.keyword === "required"
      ? errorParameter(error, "missingProperty")
      : error.keyword === "additionalProperties"
        ? errorParameter(error, "additionalProperty")
        : null;
  if (property === null) return error.instancePath;
  return `${error.instancePath}/${encodePointerSegment(property)}`;
}

// Extract the expected keyword value from the frozen Schema without guessing from prose.
function expectedConstraint(
  schema: boolean | DomainJsonObject,
  error: ErrorObject
): DomainJsonValue {
  if (error.keyword === "required") {
    return errorParameter(error, "missingProperty") ?? MISSING_VALUE;
  }
  const resolved = resolvePointer(schema, error.schemaPath);
  if (resolved !== MISSING_VALUE) return resolved;
  return error.params as DomainJsonObject;
}

// Convert one Ajv error into the frozen Cortex Diff shape.
function mapError(input: JsonSchemaResultInput, error: ErrorObject): EvalDiffHashFact {
  const instancePath = exactInstancePath(error);
  return {
    assertionIndex: input.assertionIndex,
    instancePath,
    schemaPath: error.schemaPath,
    keyword: error.keyword,
    expectedConstraint: expectedConstraint(input.schema, error),
    actual: resolvePointer(input.actual, instancePath),
    reason: error.message ?? error.keyword,
    validatorVersion: JSON_SCHEMA_VALIDATOR_VERSION,
    schemaDialect: JSON_SCHEMA_DIALECT,
    diffContractVersion: "cortex.assertion-diff.v1"
  };
}

/** Explain one Promptfoo JSON Schema fact without changing Promptfoo's pass/fail decision. */
export function explainJsonSchemaResult(input: JsonSchemaResultInput): JsonSchemaResult {
  const validator = new Ajv2020({
    allErrors: true,
    strictSchema: true,
    strictTypes: false,
    strictTuples: false
  });
  let validate: ValidateFunction;
  try {
    validate = validator.compile(input.schema);
  } catch {
    return { ok: false, error: { code: "JSON_SCHEMA_INVALID" } };
  }
  const validatorPassed = validate(input.actual);
  if (validatorPassed !== input.promptfooPassed) {
    return {
      ok: false,
      error: {
        code: "JSON_SCHEMA_VALIDATOR_DISAGREEMENT",
        promptfooPassed: input.promptfooPassed,
        validatorPassed
      }
    };
  }
  if (validatorPassed) return { ok: true, diffs: [] };
  const errors = validate.errors;
  if (errors === null || errors === undefined) {
    return { ok: false, error: { code: "JSON_SCHEMA_INVALID" } };
  }
  return { ok: true, diffs: errors.map((error) => mapError(input, error)) };
}
