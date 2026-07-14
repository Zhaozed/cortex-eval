import { z } from "zod";

import {
  assertionConfigEntryIsUnsafe,
  assertionExternalReferenceIsUnsafe
} from "./assertion-config-safety.ts";
import {
  BusinessKeySchema,
  JsonObjectSchema,
  JsonValueSchema,
  type JsonValue
} from "./contracts-primitives.ts";

/** Case Definition protocol version. */
export const CASE_DEFINITION_V1 = "cortex.case-definition.v1" as const;

/** Prompt Key reference used inside the platform. */
export const PromptReferenceSchema = z
  .string()
  .regex(/^prompt:\/\/[A-Za-z0-9][A-Za-z0-9._-]*$/, "PROMPT_REFERENCE_INVALID");

/** Serialized Assertion structure accepted at the current boundary. */
export interface AssertionDefinitionV1 {
  /** Promptfoo assertion type. */
  type: string;
  /** Stable metric name. */
  metric: string;
  /** Optional expected value. */
  value?: JsonValue | undefined;
  /** Optional score or duration threshold. */
  threshold?: number | undefined;
  /** Optional nonnegative aggregation weight. */
  weight?: number | undefined;
  /** Optional assertion configuration. */
  config?: Record<string, JsonValue> | undefined;
  /** Optional normalized Rubric Prompt reference. */
  rubricPrompt?: string | undefined;
  /** Optional trusted inline output transform. */
  transform?: string | undefined;
  /** Optional trusted inline context transform. */
  contextTransform?: string | undefined;
  /** Nested assertions for Assertion Set only. */
  assert?: AssertionDefinitionV1[] | undefined;
}

const AssertionDefinitionV1SchemaInternal: z.ZodType<AssertionDefinitionV1> = z.lazy(() =>
  z
    .strictObject({
      type: z.string().trim().min(1),
      metric: z.string().trim().min(1),
      value: JsonValueSchema.optional(),
      threshold: z.number().optional(),
      weight: z.number().nonnegative().optional(),
      config: JsonObjectSchema.optional(),
      rubricPrompt: PromptReferenceSchema.optional(),
      transform: z.string().min(1).optional(),
      contextTransform: z.string().min(1).optional(),
      assert: z.array(AssertionDefinitionV1SchemaInternal).min(1).optional()
    })
    .superRefine((assertion, context) => {
      const isSet = assertion.type === "assert-set";
      if (isSet !== (assertion.assert !== undefined)) {
        context.addIssue({ code: "custom", message: "ASSERTION_SET_SHAPE" });
      }
      if (assertion.value !== undefined && assertionExternalReferenceIsUnsafe(assertion.value)) {
        context.addIssue({ code: "custom", message: "ASSERTION_EXTERNAL_REFERENCE" });
      }
      if (assertion.config !== undefined && assertionConfigEntryIsUnsafe(assertion.config)) {
        context.addIssue({ code: "custom", message: "ASSERTION_CONFIG_UNSAFE" });
      }
      for (const field of [assertion.transform, assertion.contextTransform]) {
        if (field !== undefined && assertionExternalReferenceIsUnsafe(field)) {
          context.addIssue({ code: "custom", message: "ASSERTION_EXTERNAL_REFERENCE" });
        }
      }
    })
);

/** Recursive Assertion boundary Schema. */
export const AssertionDefinitionV1Schema = AssertionDefinitionV1SchemaInternal;

/** Full current Case Definition without runtime output. */
export const CaseDefinitionV1Schema = z.strictObject({
  contractVersion: z.literal(CASE_DEFINITION_V1),
  description: z.string().trim().min(1),
  threshold: z.number().min(0).max(1),
  vars: z.strictObject({
    task: z.string().trim().min(1),
    request_body: JsonObjectSchema
  }),
  metadata: z.strictObject({
    case_id: BusinessKeySchema,
    req_id: z.string().trim().min(1),
    task_id: z.string().trim().min(1),
    business_module: z.string().trim().min(1),
    scenario_tag: z.string().trim().min(1)
  }),
  assert: z.array(AssertionDefinitionV1Schema).min(1)
});

/** Case Definition DTO. */
export type CaseDefinitionV1 = z.infer<typeof CaseDefinitionV1Schema>;

/** Normalize the one legacy Fixture alias into the platform Prompt reference. */
export function normalizeRubricPromptReference(reference: string): string {
  if (PromptReferenceSchema.safeParse(reference).success) {
    return reference;
  }
  const legacy = /^file:\/\/rubric_prompt\/([A-Za-z0-9][A-Za-z0-9._-]*)\.json$/.exec(reference);
  if (legacy?.[1] !== undefined) {
    return `prompt://${legacy[1]}`;
  }
  throw new Error("RUBRIC_REFERENCE_INVALID");
}

// Normalize only the controlled legacy Rubric alias before strict Assertion validation.
function normalizeFixtureAssertion(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return input;
  }
  const source = input as Readonly<Record<string, unknown>>;
  const normalized: Record<string, unknown> = { ...source };
  if (typeof source.rubricPrompt === "string") {
    normalized.rubricPrompt = normalizeRubricPromptReference(source.rubricPrompt);
  }
  if (Array.isArray(source.assert)) {
    normalized.assert = source.assert.map(normalizeFixtureAssertion);
  }
  return normalized;
}

const CurrentFixtureAssertionV1Schema = z.preprocess(
  normalizeFixtureAssertion,
  AssertionDefinitionV1Schema
);

const CurrentFixtureCaseV1Schema = CaseDefinitionV1Schema.omit({ contractVersion: true }).extend({
  assert: z.array(CurrentFixtureAssertionV1Schema).min(1)
});

/** Validate the current controlled fixture and attach its explicit target protocol version. */
export function parseCaseDefinitionV1FromFixture(input: unknown): CaseDefinitionV1 {
  const fixture = CurrentFixtureCaseV1Schema.parse(input);
  return CaseDefinitionV1Schema.parse({ ...fixture, contractVersion: CASE_DEFINITION_V1 });
}
