import { z } from "zod";

import { UtcDateTimeSchema, UuidV7Schema } from "./contracts-primitives.ts";
import { CaseDefinitionV1Schema } from "./case-contracts.ts";
import { EndpointConfigV1Schema, LlmConfigV1Schema } from "./provider-contracts.ts";

/** Decoded stable current-resource cursor. */
export interface ResourceCursorV1 {
  /** Cursor protocol version. */
  readonly version: 1;
  /** Last resource display name. */
  readonly name: string;
  /** Last resource internal identity tie-breaker. */
  readonly id: string;
}

/** Strict resource cursor payload. */
export const ResourceCursorV1Schema = z.strictObject({
  version: z.literal(1),
  name: z.string(),
  id: UuidV7Schema
});

// Convert UTF-8 text to URL-safe Base64 without Node-only APIs.
function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

// Decode strict URL-safe Base64 text and reject malformed UTF-8.
function decodeBase64Url(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("CURSOR_INVALID");
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(`${base64}${padding}`);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** Encode one validated current-resource cursor. */
export function encodeResourceCursorV1(value: ResourceCursorV1): string {
  const payload = ResourceCursorV1Schema.parse(value);
  return `res_v1_${encodeBase64Url(JSON.stringify(payload))}`;
}

/** Decode one opaque current-resource cursor with stable failure codes. */
export function decodeResourceCursorV1(cursor: string): ResourceCursorV1 {
  if (!cursor.startsWith("res_v1_")) throw new Error("CURSOR_VERSION_UNSUPPORTED");
  try {
    const payload = JSON.parse(decodeBase64Url(cursor.slice("res_v1_".length))) as unknown;
    return ResourceCursorV1Schema.parse(payload);
  } catch {
    throw new Error("CURSOR_INVALID");
  }
}

/** Small Test Suite list projection; Case definitions are detail-only. */
export const TestSuiteSummaryV1Schema = z.strictObject({
  id: UuidV7Schema,
  name: z.string().trim().min(1),
  description: z.string(),
  caseCount: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  updatedAt: UtcDateTimeSchema
});

/** Test Suite list projection. */
export type TestSuiteSummaryV1 = z.infer<typeof TestSuiteSummaryV1Schema>;

const DisplayNameSchema = z.string().trim().min(1).max(256);
const RevisionSchema = z.number().int().nonnegative();
const SemanticHashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const CursorTokenSchema = z.string().min(1).nullable();

/** Create an empty current Test Suite. */
export const CreateTestSuiteRequestV1Schema = z.strictObject({
  name: DisplayNameSchema,
  description: z.string().max(10_000)
});

/** Conditionally update Test Suite display fields. */
export const UpdateTestSuiteRequestV1Schema = CreateTestSuiteRequestV1Schema.extend({
  expectedRevision: RevisionSchema
});

/** Create one current Case through the shared writer. */
export const CreateCaseRequestV1Schema = z.strictObject({
  expectedSuiteRevision: RevisionSchema,
  definition: CaseDefinitionV1Schema
});

/** Conditionally replace one current Case definition. */
export const UpdateCaseRequestV1Schema = z.strictObject({
  expectedSuiteRevision: RevisionSchema,
  expectedCaseRevision: RevisionSchema,
  definition: CaseDefinitionV1Schema
});

/** Copy one current Case under a new Suite-local key. */
export const CopyCaseRequestV1Schema = z.strictObject({
  expectedSuiteRevision: RevisionSchema,
  newCaseKey: z.string().trim().min(1).max(256)
});

/** Create one current Endpoint configuration. */
export const CreateEndpointConfigRequestV1Schema = z.strictObject({
  name: DisplayNameSchema,
  definition: EndpointConfigV1Schema
});

/** Conditionally replace one current Endpoint configuration. */
export const UpdateEndpointConfigRequestV1Schema = CreateEndpointConfigRequestV1Schema.extend({
  expectedRevision: RevisionSchema
});

/** Probe one unsaved Endpoint definition. */
export const ValidateEndpointConfigRequestV1Schema = z.strictObject({
  definition: EndpointConfigV1Schema
});

/** Create one current LLM configuration. */
export const CreateLlmConfigRequestV1Schema = z.strictObject({
  name: DisplayNameSchema,
  definition: LlmConfigV1Schema
});

/** Conditionally replace one current LLM configuration. */
export const UpdateLlmConfigRequestV1Schema = CreateLlmConfigRequestV1Schema.extend({
  expectedRevision: RevisionSchema
});

/** Probe one unsaved LLM definition. */
export const ValidateLlmConfigRequestV1Schema = z.strictObject({
  definition: LlmConfigV1Schema
});

const PromptMessageV1Schema = z.strictObject({
  role: z.enum(["SYSTEM", "USER", "ASSISTANT"]),
  content: z.string().min(1)
});

const PromptBaseShape = {
  contractVersion: z.literal("cortex.prompt.v1"),
  promptKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  messages: z.array(PromptMessageV1Schema).min(1)
} as const;

/** Current LLM Rubric Prompt transport definition. */
export const PromptDefinitionV1Schema = z.strictObject({
  ...PromptBaseShape,
  kind: z.literal("LLM_RUBRIC")
});

/** Current Case Analysis Prompt transport definition. */
export const AnalysisPromptDefinitionV1Schema = z.strictObject({
  ...PromptBaseShape,
  kind: z.literal("CASE_ANALYSIS")
});

/** Create one current LLM Rubric Prompt. */
export const CreateRubricPromptRequestV1Schema = z.strictObject({
  name: DisplayNameSchema,
  definition: PromptDefinitionV1Schema
});

/** Conditionally replace one current LLM Rubric Prompt. */
export const UpdateRubricPromptRequestV1Schema = CreateRubricPromptRequestV1Schema.extend({
  expectedRevision: RevisionSchema
});

/** Preview one unsaved LLM Rubric Prompt message sequence. */
export const PreviewRubricPromptRequestV1Schema = z.strictObject({
  definition: PromptDefinitionV1Schema
});

/** Create one current Case Analysis Prompt. */
export const CreateAnalysisPromptRequestV1Schema = z.strictObject({
  name: DisplayNameSchema,
  definition: AnalysisPromptDefinitionV1Schema
});

/** Conditionally replace one current Case Analysis Prompt. */
export const UpdateAnalysisPromptRequestV1Schema = CreateAnalysisPromptRequestV1Schema.extend({
  expectedRevision: RevisionSchema
});

/** Preview one unsaved Case Analysis Prompt variable set. */
export const PreviewAnalysisPromptRequestV1Schema = z.strictObject({
  definition: AnalysisPromptDefinitionV1Schema
});

/** Complete current Test Suite detail. */
export const TestSuiteDetailV1Schema = z.strictObject({
  id: UuidV7Schema,
  name: DisplayNameSchema,
  description: z.string(),
  caseCount: z.number().int().nonnegative(),
  suiteHash: SemanticHashSchema,
  revision: RevisionSchema,
  createdAt: UtcDateTimeSchema,
  updatedAt: UtcDateTimeSchema
});

/** Cursor-paged small Test Suite list. */
export const TestSuitePageV1Schema = z.strictObject({
  items: z.array(TestSuiteSummaryV1Schema),
  nextCursor: CursorTokenSchema
});

/** Current Test Suite deletion impact. */
export const TestSuiteImpactV1Schema = z.strictObject({
  caseCount: z.number().int().nonnegative(),
  activeRunReference: z.boolean()
});

/** Small current Case list projection. */
export const CaseSummaryV1Schema = z.strictObject({
  id: UuidV7Schema,
  suiteId: UuidV7Schema,
  caseKey: z.string().min(1).max(256),
  ordinal: z.number().int().nonnegative(),
  description: z.string(),
  businessModule: z.string(),
  scenarioTag: z.string(),
  assertionTypes: z.array(z.string()),
  metrics: z.array(z.string()),
  revision: RevisionSchema,
  updatedAt: UtcDateTimeSchema
});

/** Complete current Case detail. */
export const CaseDetailV1Schema = CaseSummaryV1Schema.extend({
  definition: CaseDefinitionV1Schema,
  definitionHash: SemanticHashSchema,
  rubricPromptKeys: z.array(z.string()),
  createdAt: UtcDateTimeSchema
});

/** One Case mutation and its updated aggregate root. */
export const CaseMutationV1Schema = z.strictObject({
  case: CaseDetailV1Schema,
  suite: TestSuiteDetailV1Schema
});

/** Cursor-paged small current Case list. */
export const CasePageV1Schema = z.strictObject({
  items: z.array(CaseSummaryV1Schema),
  nextCursor: CursorTokenSchema
});

const ConfigurationResourceBaseShape = {
  id: UuidV7Schema,
  name: DisplayNameSchema,
  semanticHash: SemanticHashSchema,
  revision: RevisionSchema,
  createdAt: UtcDateTimeSchema,
  updatedAt: UtcDateTimeSchema
} as const;

/** Complete versioned current Configuration detail union. */
export const ConfigurationResourceV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...ConfigurationResourceBaseShape,
    kind: z.literal("ENDPOINT"),
    definition: EndpointConfigV1Schema
  }),
  z.strictObject({
    ...ConfigurationResourceBaseShape,
    kind: z.literal("LLM"),
    definition: LlmConfigV1Schema
  }),
  z.strictObject({
    ...ConfigurationResourceBaseShape,
    kind: z.literal("LLM_RUBRIC_PROMPT"),
    definition: PromptDefinitionV1Schema
  }),
  z.strictObject({
    ...ConfigurationResourceBaseShape,
    kind: z.literal("CASE_ANALYSIS_PROMPT"),
    definition: AnalysisPromptDefinitionV1Schema
  })
]);

/** Small current Configuration list projection. */
export const ConfigurationSummaryV1Schema = z.strictObject({
  kind: z.enum(["ENDPOINT", "LLM", "LLM_RUBRIC_PROMPT", "CASE_ANALYSIS_PROMPT"]),
  id: UuidV7Schema,
  name: DisplayNameSchema,
  revision: RevisionSchema,
  updatedAt: UtcDateTimeSchema
});

/** Cursor-paged small current Configuration list. */
export const ConfigurationPageV1Schema = z.strictObject({
  items: z.array(ConfigurationSummaryV1Schema),
  nextCursor: CursorTokenSchema
});

/** Successful availability probe response. */
export const ConfigurationProbeSuccessV1Schema = z.strictObject({ ok: z.literal(true) });

/** Current Case references to one Rubric Prompt. */
export const RubricPromptReferencesV1Schema = z.strictObject({
  items: z.array(z.strictObject({ suiteId: UuidV7Schema, caseKey: z.string().min(1).max(256) }))
});

/** Unsaved Rubric Prompt preview. */
export const RubricPromptPreviewV1Schema = z.strictObject({
  promptKey: z.string().min(1),
  messages: z.array(PromptMessageV1Schema)
});

/** Unsaved Analysis Prompt variable preview. */
export const AnalysisPromptPreviewV1Schema = z.strictObject({
  variables: z.array(
    z.enum([
      "case_definition",
      "provider_output",
      "failed_assertions",
      "expected_actual_diffs",
      "llm_rubric_results",
      "run_context"
    ])
  )
});

/** Successful bounded full Case import response. */
export const CaseImportSuccessV1Schema = z.strictObject({
  count: z.number().int().nonnegative(),
  suite: TestSuiteDetailV1Schema
});

/** Complete current Case Definition export. */
export const CaseExportV1Schema = z.array(CaseDefinitionV1Schema);

const QueryValuesSchema = z.preprocess(
  (value) => (value === undefined ? undefined : Array.isArray(value) ? value : [value]),
  z.array(z.string().min(1)).max(50).optional()
);

/** Common small resource list query. */
export const ResourceListQueryV1Schema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional()
});

/** Current Case list query with OR within a field and AND between fields. */
export const CaseListQueryV1Schema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional(),
  caseKey: z.string().optional(),
  description: z.string().optional(),
  businessModule: QueryValuesSchema,
  scenarioTag: QueryValuesSchema,
  assertionType: QueryValuesSchema,
  metric: QueryValuesSchema
});

/** Conditional delete query. */
export const RevisionQueryV1Schema = z.strictObject({
  expectedRevision: z.coerce.number().int().nonnegative()
});

/** Conditional Case delete query. */
export const CaseRevisionQueryV1Schema = z.strictObject({
  expectedSuiteRevision: z.coerce.number().int().nonnegative(),
  expectedCaseRevision: z.coerce.number().int().nonnegative()
});

const ErrorBaseShape = {
  message: z.string().min(1),
  requestId: UuidV7Schema
} as const;

const PathErrorSchema = z.strictObject({
  code: z.enum([
    "VALIDATION_FAILED",
    "CASE_DEFINITION_INVALID",
    "ENDPOINT_CONFIG_INVALID",
    "LLM_CONFIG_INVALID",
    "PROMPT_INVALID",
    "ANALYSIS_PROMPT_INVALID"
  ]),
  ...ErrorBaseShape,
  path: z.string().min(1)
});

const RevisionErrorSchema = z.strictObject({
  code: z.literal("RESOURCE_REVISION_CONFLICT"),
  ...ErrorBaseShape,
  expectedRevision: z.number().int().nonnegative(),
  actualRevision: z.number().int().nonnegative()
});

const UniqueErrorSchema = z.strictObject({
  code: z.literal("RESOURCE_UNIQUE_CONFLICT"),
  ...ErrorBaseShape,
  field: z.enum(["name", "promptKey"])
});

const ImportItemErrorSchema = z.strictObject({
  code: z.literal("CASE_IMPORT_ITEM_INVALID"),
  ...ErrorBaseShape,
  index: z.number().int().nonnegative(),
  caseKey: z.string(),
  causeCode: z.enum([
    "SUITE_NOT_FOUND",
    "CASE_NOT_FOUND",
    "CASE_IDENTITY_CONFLICT",
    "CASE_DEFINITION_INVALID",
    "CASE_ID_DUPLICATE",
    "RUBRIC_PROMPT_NOT_FOUND",
    "RESOURCE_REVISION_CONFLICT"
  ]),
  path: z.string().min(1).optional()
});

const PromptReferenceErrorSchema = z.strictObject({
  code: z.enum(["RUBRIC_PROMPT_IN_USE", "RUBRIC_PROMPT_NOT_FOUND"]),
  ...ErrorBaseShape,
  promptKey: z.string().min(1)
});

const ConfigurationProbeErrorSchema = z.strictObject({
  code: z.literal("CONFIGURATION_PROBE_FAILED"),
  ...ErrorBaseShape,
  reason: z.enum(["UNAVAILABLE", "TIMEOUT", "CANCELLED", "CAPABILITY_UNSUPPORTED"])
});

const PlainErrorSchema = z.strictObject({
  code: z.enum([
    "CURSOR_INVALID",
    "CURSOR_VERSION_UNSUPPORTED",
    "HOST_NOT_ALLOWED",
    "ORIGIN_NOT_ALLOWED",
    "REQUEST_BODY_TOO_LARGE",
    "REQUEST_ABORTED",
    "CASE_IMPORT_TOO_LARGE",
    "CASE_IMPORT_CANCELLED",
    "CASE_ID_DUPLICATE",
    "CASE_IDENTITY_CONFLICT",
    "CASE_NOT_FOUND",
    "SUITE_NOT_FOUND",
    "CONFIGURATION_NOT_FOUND",
    "CONFIGURATION_KIND_CONFLICT",
    "RESOURCE_IN_ACTIVE_RUN",
    "STORAGE_TRANSACTION_CONFLICT",
    "EXPORT_REVISION_CONFLICT",
    "INTERNAL_ERROR",
    "ROUTE_NOT_FOUND"
  ]),
  ...ErrorBaseShape
});

/** Exact API error payload union; no stack, SQL or third-party body can pass it. */
export const ApiErrorV1Schema = z.discriminatedUnion("code", [
  PathErrorSchema,
  RevisionErrorSchema,
  UniqueErrorSchema,
  ImportItemErrorSchema,
  PromptReferenceErrorSchema,
  ConfigurationProbeErrorSchema,
  PlainErrorSchema
]);

/** Uniform API error response envelope. */
export const ApiErrorResponseV1Schema = z.strictObject({ error: ApiErrorV1Schema });

/** Uniform API error response. */
export type ApiErrorResponseV1 = z.infer<typeof ApiErrorResponseV1Schema>;
