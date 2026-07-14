import type {
  PlatformRun,
  PlatformRunDetail,
  PlatformRunProgress,
  RunArtifactManifest,
  StoredRestCaseResult
} from "@cortex-eval/application/src/features/runs/platform-run-models.ts";
import type { RestExecutionErrorType } from "@cortex-eval/application/src/features/runs/run-rest-models.ts";
import {
  canonicalJson,
  type DomainJsonObject,
  type DomainJsonValue
} from "@cortex-eval/domain/src/domain-canonical-hash.ts";
import { caseDefinitionJson } from "@cortex-eval/domain/src/domain-case-projection.ts";
import type {
  AssertionDefinition,
  CaseDefinition,
  ProviderOutput
} from "@cortex-eval/domain/src/domain-evaluation.ts";
import {
  hashCaseDefinition,
  hashRestResult,
  hashRunContext
} from "@cortex-eval/domain/src/domain-hash-inputs.ts";
import {
  hashEndpointConfig,
  hashLlmConfig,
  hashPrompt,
  hashRubricPromptSet,
  hashSuite
} from "@cortex-eval/domain/src/domain-resource-hashes.ts";
import type {
  EndpointConfigDefinition,
  LlmConfigDefinition,
  PromptDefinition
} from "@cortex-eval/domain/src/domain-resource-models.ts";
import {
  validateEndpointConfig,
  validateLlmConfig,
  validatePrompt
} from "@cortex-eval/domain/src/domain-resource-models.ts";
import type { Insertable, Selectable } from "kysely";
import { z } from "zod";

import { SqliteRowInvalidError } from "./sqlite-row-mappers.ts";
import type { CaseResultTable, RunLogTable } from "./sqlite-schema.ts";

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const UtcDateTimeSchema = z.string().refine((value) => {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
});
const JsonValueSchema: z.ZodType<DomainJsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema)
  ])
);
const JsonObjectSchema = z.record(z.string(), JsonValueSchema);
interface PersistedAssertionV1 {
  /** Assertion type. */
  readonly type: string;
  /** Stable metric name. */
  readonly metric: string;
  /** Optional expected value. */
  readonly value?: DomainJsonValue | undefined;
  /** Optional threshold. */
  readonly threshold?: number | undefined;
  /** Optional aggregation weight. */
  readonly weight?: number | undefined;
  /** Optional assertion configuration. */
  readonly config?: DomainJsonObject | undefined;
  /** Optional Rubric Prompt reference. */
  readonly rubricPrompt?: string | undefined;
  /** Optional trusted output transform. */
  readonly transform?: string | undefined;
  /** Optional trusted context transform. */
  readonly contextTransform?: string | undefined;
  /** Nested Assertion Set members. */
  readonly assert?: readonly PersistedAssertionV1[] | undefined;
}
const PersistedAssertionSchema: z.ZodType<PersistedAssertionV1> = z.lazy(() =>
  z.strictObject({
    type: z.string().trim().min(1),
    metric: z.string().trim().min(1),
    value: JsonValueSchema.optional(),
    threshold: z.number().optional(),
    weight: z.number().nonnegative().optional(),
    config: JsonObjectSchema.optional(),
    rubricPrompt: z.string().optional(),
    transform: z.string().optional(),
    contextTransform: z.string().optional(),
    assert: z.array(PersistedAssertionSchema).min(1).optional()
  })
);
const CaseDefinitionV1Schema = z.strictObject({
  contractVersion: z.literal("cortex.case-definition.v1"),
  description: z.string().trim().min(1),
  threshold: z.number().min(0).max(1),
  vars: z.strictObject({ task: z.string().trim().min(1), request_body: JsonObjectSchema }),
  metadata: z.strictObject({
    case_id: z.string().trim().min(1),
    req_id: z.string().trim().min(1),
    task_id: z.string().trim().min(1),
    business_module: z.string().trim().min(1),
    scenario_tag: z.string().trim().min(1)
  }),
  assert: z.array(PersistedAssertionSchema).min(1)
});
type CaseDefinitionV1 = z.infer<typeof CaseDefinitionV1Schema>;
const EnvSecretSchema = z.strictObject({
  kind: z.literal("ENV_SECRET"),
  envKey: z.string().regex(/^[A-Z][A-Z0-9_]*$/)
});
const HeaderValueSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("LITERAL"), value: z.string() }),
  EnvSecretSchema
]);
const EndpointConfigV1Schema = z.strictObject({
  contractVersion: z.literal("cortex.endpoint-config.v1"),
  urlTemplate: z.string().min(1),
  method: z.literal("POST"),
  headers: z.record(z.string().min(1), HeaderValueSchema),
  bodySelector: z.string(),
  timeoutMs: z.number().int().min(100).max(600_000),
  defaultConcurrency: z.number().int().min(1).max(64)
});
const LlmCommon = {
  contractVersion: z.literal("cortex.llm-config.v1"),
  model: z.string().trim().min(1),
  thinkingLevel: z.enum(["OFF", "LOW", "MEDIUM", "HIGH"]),
  temperature: z.number(),
  topP: z.number(),
  maxOutputTokens: z.number().int(),
  timeoutMs: z.number().int(),
  structuredOutput: z.enum(["JSON_SCHEMA", "JSON_OBJECT"])
} as const;
const LlmConfigV1Schema = z.discriminatedUnion("providerType", [
  z.strictObject({
    ...LlmCommon,
    providerType: z.literal("GOOGLE_GEMINI"),
    apiKey: EnvSecretSchema
  }),
  z.strictObject({
    ...LlmCommon,
    providerType: z.literal("OPENAI_COMPATIBLE"),
    baseUrl: z.string().min(1),
    auth: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("NONE") }),
      z.strictObject({ kind: z.literal("BEARER_ENV"), secret: EnvSecretSchema })
    ])
  })
]);
const PromptDefinitionV1Schema = z.strictObject({
  contractVersion: z.literal("cortex.prompt.v1"),
  kind: z.literal("LLM_RUBRIC"),
  promptKey: z.string().trim().min(1),
  messages: z
    .array(z.strictObject({ role: z.enum(["SYSTEM", "USER", "ASSISTANT"]), content: z.string() }))
    .min(1)
});
const ProviderOutputV1Schema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    task_name: z.string().trim().min(1),
    resolved_config: JsonObjectSchema,
    parsed_output: JsonObjectSchema
  }),
  z.strictObject({ ok: z.literal(false), err_msg: z.string().trim().min(1) })
]);
const RelativePathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
const ArtifactManifestV1Schema = z
  .strictObject({
    contractVersion: z.literal("cortex.artifact-manifest.v1"),
    owner: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("RUN"), id: z.string().trim().min(1) }),
      z.strictObject({ kind: z.literal("EXECUTION"), id: z.string().trim().min(1) })
    ]),
    artifacts: z.array(
      z.strictObject({
        kind: z.enum([
          "REST_RESULTS",
          "RAW_PROMPTFOO_EVIDENCE",
          "NORMALIZED_EVAL_RESULTS",
          "REPORT_JSON",
          "REPORT_MARKDOWN",
          "ANALYSIS_RESULTS"
        ]),
        path: RelativePathSchema,
        expectedSha256: Sha256Schema,
        expectedSizeBytes: z.number().int().nonnegative(),
        contractVersion: z.string().regex(/^[a-z0-9.-]+$/)
      })
    )
  })
  .superRefine((manifest, context) => {
    const kinds = new Set<string>();
    const paths = new Set<string>();
    for (const [index, artifact] of manifest.artifacts.entries()) {
      if (kinds.has(artifact.kind) || paths.has(artifact.path)) {
        context.addIssue({ code: "custom", path: ["artifacts", index], message: "DUPLICATE" });
      }
      kinds.add(artifact.kind);
      paths.add(artifact.path);
    }
  });

const SnapshotIdentitySchema = z.string().trim().min(1);
const FrozenCaseSchema = z.strictObject({
  caseKey: z.string().trim().min(1),
  ordinal: z.number().int().nonnegative(),
  definitionHash: Sha256Schema,
  definition: CaseDefinitionV1Schema
});
const SuiteSnapshotSchema = z.strictObject({
  contractVersion: z.literal("cortex.run-snapshot.v1"),
  kind: z.literal("SUITE"),
  id: SnapshotIdentitySchema,
  name: z.string().trim().min(1),
  suiteHash: Sha256Schema,
  cases: z.array(FrozenCaseSchema).min(1)
});
const EndpointSnapshotSchema = z.strictObject({
  contractVersion: z.literal("cortex.run-snapshot.v1"),
  kind: z.literal("ENDPOINT"),
  sourceId: SnapshotIdentitySchema.nullable(),
  name: z.string().trim().min(1),
  configHash: Sha256Schema,
  definition: EndpointConfigV1Schema
});
const EvaluatorSnapshotSchema = z.strictObject({
  contractVersion: z.literal("cortex.run-snapshot.v1"),
  kind: z.literal("EVALUATOR"),
  sourceId: SnapshotIdentitySchema.nullable(),
  name: z.string().trim().min(1),
  configHash: Sha256Schema,
  definition: LlmConfigV1Schema
});
const RubricPromptsSnapshotSchema = z.strictObject({
  contractVersion: z.literal("cortex.run-snapshot.v1"),
  kind: z.literal("RUBRIC_PROMPTS"),
  items: z.array(
    z.strictObject({
      sourceId: SnapshotIdentitySchema.nullable(),
      name: z.string().trim().min(1),
      promptHash: Sha256Schema,
      definition: PromptDefinitionV1Schema
    })
  )
});
const ContractVersionsSchema = z.strictObject({
  runSnapshot: z.literal("cortex.run-snapshot.v1"),
  caseDefinition: z.literal("cortex.case-definition.v1"),
  platformRestResults: z.literal("cortex.platform-rest-results.v1")
});
const ExecutionLimitsSchema = z.strictObject({
  contractVersion: z.literal("cortex.run-execution-limits.v1"),
  restConcurrency: z.number().int().min(1).max(64),
  evalConcurrency: z.number().int().min(1).max(16)
});
const RubricPromptSummariesSchema = z.array(
  z.strictObject({
    sourceId: SnapshotIdentitySchema.nullable(),
    name: z.string().trim().min(1),
    promptHash: Sha256Schema,
    promptKey: z.string().trim().min(1)
  })
);

/** Selected small Run state columns without frozen JSON payloads. */
export interface PlatformRunProgressRowProjection {
  readonly id: string;
  readonly source_type: string;
  readonly status: PlatformRun["status"];
  readonly stage: PlatformRun["stage"];
  readonly lock_revision: number;
  readonly cancel_requested_at: string | null;
  readonly snapshot_case_count: number;
  readonly rest_completed_count: number;
  readonly rest_error_count: number;
  readonly eval_completed_count: number;
  readonly eval_pass_count: number;
  readonly eval_fail_count: number;
  readonly eval_error_count: number;
  readonly eval_not_evaluated_count: number;
  readonly result_set_hash: string | null;
  readonly artifact_manifest_json: string;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** Selected bounded Run detail columns without Case arrays or Prompt bodies. */
export interface PlatformRunDetailRowProjection extends PlatformRunProgressRowProjection {
  readonly source_run_id: string | null;
  readonly rerun_mode: PlatformRun["rerunMode"];
  readonly snapshot_suite_id: string;
  readonly snapshot_suite_name: string;
  readonly snapshot_suite_hash: string;
  readonly endpoint_snapshot_json: string;
  readonly evaluator_snapshot_json: string;
  readonly rubric_prompt_summaries_json: string;
  readonly run_context_hash: string;
  readonly promptfoo_version: string;
  readonly contract_versions_json: string;
  readonly run_execution_limits_json: string;
  readonly run_mode: PlatformRun["runMode"];
}

interface EvaluationCounterProjection {
  /** Atomically committed Evaluation total. */
  readonly eval_completed_count: number;
  /** Committed PASS count. */
  readonly eval_pass_count: number;
  /** Committed FAIL count. */
  readonly eval_fail_count: number;
  /** Committed Evaluation Error count. */
  readonly eval_error_count: number;
  /** Committed Not Evaluated count. */
  readonly eval_not_evaluated_count: number;
}

// Validate one dirty persistence-boundary Evaluation summary against its frozen total.
function hasValidEvaluationCounters(row: EvaluationCounterProjection, total: number): boolean {
  const counters = [
    row.eval_completed_count,
    row.eval_pass_count,
    row.eval_fail_count,
    row.eval_error_count,
    row.eval_not_evaluated_count
  ];
  const classified =
    row.eval_pass_count + row.eval_fail_count + row.eval_error_count + row.eval_not_evaluated_count;
  return (
    counters.every((value) => Number.isInteger(value) && value >= 0) &&
    row.eval_completed_count === classified &&
    row.eval_completed_count <= total
  );
}

// Parse one strict JSON boundary contract without exposing Zod details upstream.
function parseJson<T>(schema: z.ZodType<T>, serialized: string): T {
  try {
    return schema.parse(JSON.parse(serialized) as unknown);
  } catch {
    throw new SqliteRowInvalidError();
  }
}

// Map one recursive transport Assertion into the clean Domain model.
function assertionFromV1(value: CaseDefinitionV1["assert"][number]): AssertionDefinition {
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
    ...(value.assert === undefined ? {} : { assertions: value.assert.map(assertionFromV1) })
  };
}

// Map one strict transport Case into the clean Domain model.
function caseFromV1(value: CaseDefinitionV1): CaseDefinition {
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
    assertions: value.assert.map(assertionFromV1)
  };
}

// Remove one validated transport version at the persistence boundary.
function endpointFromV1(value: z.infer<typeof EndpointConfigV1Schema>): EndpointConfigDefinition {
  const { contractVersion: _contractVersion, ...definition } = value;
  void _contractVersion;
  return definition;
}

// Remove one validated transport version at the persistence boundary.
function evaluatorFromV1(value: z.infer<typeof LlmConfigV1Schema>): LlmConfigDefinition {
  const { contractVersion: _contractVersion, ...definition } = value;
  void _contractVersion;
  return definition;
}

// Remove one validated Prompt transport version at the persistence boundary.
function promptFromV1(value: z.infer<typeof PromptDefinitionV1Schema>): PromptDefinition {
  const { contractVersion: _contractVersion, ...definition } = value;
  void _contractVersion;
  return definition;
}

// Map a transport Provider Output to clean Domain names.
function providerOutputFromV1(value: z.infer<typeof ProviderOutputV1Schema>): ProviderOutput {
  if (!value.ok) return { ok: false, errorMessage: value.err_msg };
  return {
    ok: true,
    taskName: value.task_name,
    resolvedConfig: value.resolved_config,
    parsedOutput: value.parsed_output
  };
}

// Map a clean Provider Output to the persisted strict transport projection.
function providerOutputToV1(value: ProviderOutput): DomainJsonObject {
  return value.ok
    ? {
        ok: true,
        task_name: value.taskName,
        resolved_config: value.resolvedConfig,
        parsed_output: value.parsedOutput
      }
    : { ok: false, err_msg: value.errorMessage };
}

// Convert Endpoint headers to a mutable canonical JSON record.
function endpointToV1(value: EndpointConfigDefinition): DomainJsonObject {
  const headers = Object.fromEntries(
    Object.entries(value.headers).map(([name, header]) => [
      name,
      header.kind === "LITERAL"
        ? { kind: header.kind, value: header.value }
        : { kind: header.kind, envKey: header.envKey }
    ])
  );
  return { contractVersion: "cortex.endpoint-config.v1", ...value, headers };
}

// Convert one clean LLM definition to the strict transport projection.
function evaluatorToV1(value: LlmConfigDefinition): DomainJsonObject {
  if (value.providerType === "GOOGLE_GEMINI") {
    return {
      contractVersion: "cortex.llm-config.v1",
      ...value,
      apiKey: { kind: value.apiKey.kind, envKey: value.apiKey.envKey }
    };
  }
  const auth =
    value.auth.kind === "NONE"
      ? { kind: value.auth.kind }
      : {
          kind: value.auth.kind,
          secret: { kind: value.auth.secret.kind, envKey: value.auth.secret.envKey }
        };
  return { contractVersion: "cortex.llm-config.v1", ...value, auth };
}

// Convert one clean Prompt to the strict transport projection.
function promptToV1(value: PromptDefinition): DomainJsonObject {
  return {
    contractVersion: "cortex.prompt.v1",
    kind: value.kind,
    promptKey: value.promptKey,
    messages: value.messages.map((message) => ({ ...message }))
  };
}

// Require frozen Case order, keys and semantic hashes to agree.
function mapSuite(serialized: string): PlatformRun["suite"] {
  const value = parseJson(SuiteSnapshotSchema, serialized);
  const cases = value.cases.map((item) => {
    const definition = caseFromV1(item.definition);
    const definitionJson = caseDefinitionJson(definition);
    const expectedHash = hashCaseDefinition({
      contractVersion: "cortex.case-definition.v1",
      caseKey: definition.caseKey,
      definition: definitionJson
    });
    if (definition.caseKey !== item.caseKey || expectedHash !== item.definitionHash) {
      throw new SqliteRowInvalidError();
    }
    return {
      caseKey: item.caseKey,
      ordinal: item.ordinal,
      definitionHash: item.definitionHash,
      definition
    };
  });
  const aligned = cases.every((item, index) => item.ordinal === index);
  const suiteHash = hashSuite({
    contractVersion: "cortex.suite.v1",
    cases: cases.map((item) => ({
      caseKey: item.caseKey,
      ordinal: item.ordinal,
      definitionHash: item.definitionHash
    }))
  });
  if (!aligned || suiteHash !== value.suiteHash) throw new SqliteRowInvalidError();
  return { id: value.id, name: value.name, suiteHash: value.suiteHash, cases };
}

// Parse and revalidate one frozen Endpoint snapshot.
function mapEndpoint(serialized: string): PlatformRun["endpoint"] {
  const value = parseJson(EndpointSnapshotSchema, serialized);
  const definition = endpointFromV1(value.definition);
  if (!validateEndpointConfig(definition).ok) throw new SqliteRowInvalidError();
  const hash = hashEndpointConfig({
    contractVersion: "cortex.endpoint-config.v1",
    config: definition
  });
  if (hash !== value.configHash) throw new SqliteRowInvalidError();
  return { sourceId: value.sourceId, name: value.name, configHash: value.configHash, definition };
}

// Parse and revalidate one frozen Evaluator snapshot.
function mapEvaluator(serialized: string): PlatformRun["evaluator"] {
  const value = parseJson(EvaluatorSnapshotSchema, serialized);
  const definition = evaluatorFromV1(value.definition);
  if (!validateLlmConfig(definition).ok) throw new SqliteRowInvalidError();
  const hash = hashLlmConfig({ contractVersion: "cortex.llm-config.v1", config: definition });
  if (hash !== value.configHash) throw new SqliteRowInvalidError();
  return { sourceId: value.sourceId, name: value.name, configHash: value.configHash, definition };
}

// Parse and revalidate the complete frozen Rubric Prompt set.
function mapRubricPrompts(serialized: string): PlatformRun["rubricPrompts"] {
  const value = parseJson(RubricPromptsSnapshotSchema, serialized);
  return value.items.map((item) => {
    const definition = promptFromV1(item.definition);
    if (!validatePrompt(definition).ok) throw new SqliteRowInvalidError();
    const hash = hashPrompt({
      contractVersion: "cortex.prompt.v1",
      kind: definition.kind,
      promptKey: definition.promptKey,
      messages: definition.messages
    });
    if (hash !== item.promptHash) throw new SqliteRowInvalidError();
    return {
      sourceId: item.sourceId,
      name: item.name,
      promptHash: item.promptHash,
      definition
    };
  });
}

// Parse one complete Run-owned Manifest and reject an owner mismatch.
export function mapRunManifest(serialized: string, runId: string): RunArtifactManifest {
  const value = parseJson(ArtifactManifestV1Schema, serialized);
  if (value.owner.kind !== "RUN" || value.owner.id !== runId) throw new SqliteRowInvalidError();
  return {
    contractVersion: value.contractVersion,
    owner: value.owner,
    artifacts: value.artifacts
  };
}

/** Map one small state projection without parsing any frozen Case definition. */
export function mapPlatformRunProgressRow(
  row: PlatformRunProgressRowProjection
): PlatformRunProgress {
  if (
    row.source_type !== "PLATFORM" ||
    !Number.isInteger(row.snapshot_case_count) ||
    row.snapshot_case_count < 1 ||
    !Number.isInteger(row.rest_completed_count) ||
    row.rest_completed_count < 0 ||
    !Number.isInteger(row.rest_error_count) ||
    row.rest_error_count < 0 ||
    row.rest_error_count > row.rest_completed_count ||
    row.rest_completed_count > row.snapshot_case_count ||
    !hasValidEvaluationCounters(row, row.snapshot_case_count)
  ) {
    throw new SqliteRowInvalidError();
  }
  return {
    id: row.id,
    sourceType: "PLATFORM",
    status: row.status,
    stage: row.stage,
    lockRevision: row.lock_revision,
    cancelRequestedAt: row.cancel_requested_at,
    restTotalCount: row.snapshot_case_count,
    restCompletedCount: row.rest_completed_count,
    restErrorCount: row.rest_error_count,
    evalCompletedCount: row.eval_completed_count,
    evalPassCount: row.eval_pass_count,
    evalFailCount: row.eval_fail_count,
    evalErrorCount: row.eval_error_count,
    evalNotEvaluatedCount: row.eval_not_evaluated_count,
    resultSetHash: row.result_set_hash,
    artifactManifest: mapRunManifest(row.artifact_manifest_json, row.id),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/** Map one bounded detail projection and revalidate all included semantic identities. */
export function mapPlatformRunDetailRow(row: PlatformRunDetailRowProjection): PlatformRunDetail {
  if (
    !Sha256Schema.safeParse(row.snapshot_suite_hash).success ||
    row.snapshot_suite_id.trim() === "" ||
    row.snapshot_suite_name.trim() === ""
  ) {
    throw new SqliteRowInvalidError();
  }
  const endpoint = mapEndpoint(row.endpoint_snapshot_json);
  const evaluator = mapEvaluator(row.evaluator_snapshot_json);
  const rubricPrompts = parseJson(RubricPromptSummariesSchema, row.rubric_prompt_summaries_json);
  const contractVersions = parseJson(ContractVersionsSchema, row.contract_versions_json);
  const runExecutionLimits = parseJson(ExecutionLimitsSchema, row.run_execution_limits_json);
  const rubricPromptSetHash = hashRubricPromptSet({
    contractVersion: "cortex.rubric-prompt-set.v1",
    prompts: rubricPrompts.map((item) => ({
      promptKey: item.promptKey,
      promptHash: item.promptHash
    }))
  });
  const contextHash = hashRunContext({
    contractVersion: "cortex.run-context.v1",
    suiteHash: row.snapshot_suite_hash,
    endpointConfigHash: endpoint.configHash,
    evaluatorConfigHash: evaluator.configHash,
    rubricPromptSetHash,
    promptfooVersion: row.promptfoo_version,
    runExecutionLimits
  });
  if (
    contextHash !== row.run_context_hash ||
    row.promptfoo_version !== "0.121.18" ||
    !hasValidEvaluationCounters(row, row.snapshot_case_count)
  ) {
    throw new SqliteRowInvalidError();
  }
  return {
    ...mapPlatformRunProgressRow(row),
    sourceRunId: row.source_run_id,
    rerunMode: row.rerun_mode,
    suite: {
      id: row.snapshot_suite_id,
      name: row.snapshot_suite_name,
      suiteHash: row.snapshot_suite_hash,
      caseCount: row.snapshot_case_count
    },
    endpoint,
    evaluator,
    rubricPrompts,
    runContextHash: row.run_context_hash,
    promptfooVersion: row.promptfoo_version,
    contractVersions,
    runExecutionLimits,
    runMode: row.run_mode
  };
}

/** Map one strict platform Run row and revalidate every frozen semantic identity. */
export function mapPlatformRunRow(row: Selectable<RunLogTable>): PlatformRun {
  if (
    row.source_type !== "PLATFORM" ||
    row.execution_id !== null ||
    row.source_package_id !== null
  ) {
    throw new SqliteRowInvalidError();
  }
  const suite = mapSuite(row.suite_snapshot_json);
  const endpoint = mapEndpoint(row.endpoint_snapshot_json);
  const evaluator = mapEvaluator(row.evaluator_snapshot_json);
  const rubricPrompts = mapRubricPrompts(row.rubric_prompts_snapshot_json);
  const contractVersions = parseJson(ContractVersionsSchema, row.contract_versions_json);
  const runExecutionLimits = parseJson(ExecutionLimitsSchema, row.run_execution_limits_json);
  const rubricPromptSetHash = hashRubricPromptSet({
    contractVersion: "cortex.rubric-prompt-set.v1",
    prompts: rubricPrompts.map((item) => ({
      promptKey: item.definition.promptKey,
      promptHash: item.promptHash
    }))
  });
  const contextHash = hashRunContext({
    contractVersion: "cortex.run-context.v1",
    suiteHash: suite.suiteHash,
    endpointConfigHash: endpoint.configHash,
    evaluatorConfigHash: evaluator.configHash,
    rubricPromptSetHash,
    promptfooVersion: row.promptfoo_version,
    runExecutionLimits
  });
  if (
    contextHash !== row.run_context_hash ||
    row.promptfoo_version !== "0.121.18" ||
    !hasValidEvaluationCounters(row, suite.cases.length)
  ) {
    throw new SqliteRowInvalidError();
  }
  return {
    id: row.id,
    sourceType: row.source_type,
    sourceRunId: row.source_run_id,
    rerunMode: row.rerun_mode,
    suite,
    endpoint,
    evaluator,
    rubricPrompts,
    runContextHash: row.run_context_hash,
    promptfooVersion: row.promptfoo_version,
    contractVersions,
    runExecutionLimits,
    runMode: row.run_mode,
    status: row.status,
    stage: row.stage,
    lockRevision: row.lock_revision,
    cancelRequestedAt: row.cancel_requested_at,
    restCompletedCount: row.rest_completed_count,
    restErrorCount: row.rest_error_count,
    evalCompletedCount: row.eval_completed_count,
    evalPassCount: row.eval_pass_count,
    evalFailCount: row.eval_fail_count,
    evalErrorCount: row.eval_error_count,
    evalNotEvaluatedCount: row.eval_not_evaluated_count,
    resultSetHash: row.result_set_hash,
    artifactManifest: mapRunManifest(row.artifact_manifest_json, row.id),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/** Convert one already-valid platform Run into exact insert values. */
export function platformRunInsertValues(value: PlatformRun): Insertable<RunLogTable> {
  return {
    id: value.id,
    source_type: value.sourceType,
    source_package_id: null,
    execution_id: null,
    source_run_id: value.sourceRunId,
    rerun_mode: value.rerunMode,
    suite_id: value.suite.id,
    endpoint_config_id: value.endpoint.sourceId,
    evaluator_config_id: value.evaluator.sourceId,
    suite_snapshot_json: canonicalJson({
      contractVersion: "cortex.run-snapshot.v1",
      kind: "SUITE",
      id: value.suite.id,
      name: value.suite.name,
      suiteHash: value.suite.suiteHash,
      cases: value.suite.cases.map((item) => ({
        caseKey: item.caseKey,
        ordinal: item.ordinal,
        definitionHash: item.definitionHash,
        definition: caseDefinitionJson(item.definition)
      }))
    }),
    endpoint_snapshot_json: canonicalJson({
      contractVersion: "cortex.run-snapshot.v1",
      kind: "ENDPOINT",
      sourceId: value.endpoint.sourceId,
      name: value.endpoint.name,
      configHash: value.endpoint.configHash,
      definition: endpointToV1(value.endpoint.definition)
    }),
    evaluator_snapshot_json: canonicalJson({
      contractVersion: "cortex.run-snapshot.v1",
      kind: "EVALUATOR",
      sourceId: value.evaluator.sourceId,
      name: value.evaluator.name,
      configHash: value.evaluator.configHash,
      definition: evaluatorToV1(value.evaluator.definition)
    }),
    rubric_prompts_snapshot_json: canonicalJson({
      contractVersion: "cortex.run-snapshot.v1",
      kind: "RUBRIC_PROMPTS",
      items: value.rubricPrompts.map((item) => ({
        sourceId: item.sourceId,
        name: item.name,
        promptHash: item.promptHash,
        definition: promptToV1(item.definition)
      }))
    }),
    run_context_hash: value.runContextHash,
    promptfoo_version: value.promptfooVersion,
    contract_versions_json: canonicalJson({ ...value.contractVersions }),
    run_execution_limits_json: canonicalJson({ ...value.runExecutionLimits }),
    run_mode: value.runMode,
    status: value.status,
    stage: value.stage,
    lock_revision: value.lockRevision,
    cancel_requested_at: value.cancelRequestedAt,
    rest_completed_count: value.restCompletedCount,
    rest_error_count: value.restErrorCount,
    eval_completed_count: value.evalCompletedCount,
    eval_pass_count: value.evalPassCount,
    eval_fail_count: value.evalFailCount,
    eval_error_count: value.evalErrorCount,
    eval_not_evaluated_count: value.evalNotEvaluatedCount,
    summary_json: null,
    result_set_hash: value.resultSetHash,
    artifact_manifest_json: canonicalJson({
      contractVersion: value.artifactManifest.contractVersion,
      owner: { ...value.artifactManifest.owner },
      artifacts: value.artifactManifest.artifacts.map((item) => ({ ...item }))
    }),
    error_code: value.errorCode,
    error_message: value.errorMessage,
    started_at: value.startedAt,
    completed_at: value.completedAt,
    created_at: value.createdAt,
    updated_at: value.updatedAt
  };
}

/** Map and validate one persisted REST Case result row. */
export function mapStoredRestResult(row: Selectable<CaseResultTable>): StoredRestCaseResult {
  const definitionV1 = parseJson(CaseDefinitionV1Schema, row.case_definition_json);
  const definition = caseFromV1(definitionV1);
  if (definition.caseKey !== row.case_key) throw new SqliteRowInvalidError();
  const provenance = mapRestProvenance(row);
  if (row.rest_status === "SUCCEEDED") {
    if (
      row.provider_output_json === null ||
      row.http_status === null ||
      row.error_type !== null ||
      row.error_message !== null
    ) {
      throw new SqliteRowInvalidError();
    }
    const providerOutput = providerOutputFromV1(
      parseJson(ProviderOutputV1Schema, row.provider_output_json)
    );
    const result: StoredRestCaseResult = {
      runId: row.run_id,
      caseKey: row.case_key,
      ordinal: row.ordinal,
      definition,
      caseDefinitionHash: row.case_definition_hash,
      status: "SUCCEEDED",
      httpStatus: row.http_status,
      providerOutput,
      errorType: null,
      errorMessage: null,
      durationMs: row.duration_ms,
      completedAt: row.completed_at,
      resultHash: row.run_result_hash,
      provenance
    };
    if (!platformRestResultHashMatches(result)) throw new SqliteRowInvalidError();
    return result;
  }
  const errorType = restErrorType(row.error_type);
  if (row.provider_output_json !== null || row.error_message === null) {
    throw new SqliteRowInvalidError();
  }
  const result: StoredRestCaseResult = {
    runId: row.run_id,
    caseKey: row.case_key,
    ordinal: row.ordinal,
    definition,
    caseDefinitionHash: row.case_definition_hash,
    status: "ERROR",
    httpStatus: row.http_status,
    providerOutput: null,
    errorType,
    errorMessage: row.error_message,
    durationMs: row.duration_ms,
    completedAt: row.completed_at,
    resultHash: row.run_result_hash,
    provenance
  };
  if (!platformRestResultHashMatches(result)) throw new SqliteRowInvalidError();
  return result;
}

/** Recompute one REST semantic hash before accepting a caller or persisted row. */
export function platformRestResultHashMatches(value: StoredRestCaseResult): boolean {
  const resultHash =
    value.status === "SUCCEEDED"
      ? hashRestResult({
          contractVersion: "cortex.rest-result.v1",
          caseKey: value.caseKey,
          caseDefinitionHash: value.caseDefinitionHash,
          result: {
            status: "SUCCEEDED",
            httpStatus: value.httpStatus,
            providerOutput: value.providerOutput
          }
        })
      : hashRestResult({
          contractVersion: "cortex.rest-result.v1",
          caseKey: value.caseKey,
          caseDefinitionHash: value.caseDefinitionHash,
          result: {
            status: "ERROR",
            httpStatus: value.httpStatus,
            errorType: value.errorType
          }
        });
  return resultHash === value.resultHash;
}

// Convert the three nullable persistence columns into one closed provenance fact.
function mapRestProvenance(row: Selectable<CaseResultTable>): StoredRestCaseResult["provenance"] {
  const sourceHash = row.reused_result_hash;
  const runId = row.reused_from_run_id;
  const executionId = row.reused_from_execution_id;
  if (sourceHash === null) {
    if (runId !== null || executionId !== null) throw new SqliteRowInvalidError();
    return null;
  }
  if (!Sha256Schema.safeParse(sourceHash).success || (runId === null) === (executionId === null)) {
    throw new SqliteRowInvalidError();
  }
  if (runId !== null) {
    return { sourceKind: "RUN", sourceId: runId, sourceResultHash: sourceHash };
  }
  if (executionId === null) throw new SqliteRowInvalidError();
  return { sourceKind: "EXECUTION", sourceId: executionId, sourceResultHash: sourceHash };
}

// Narrow one persisted error type into the closed Application union.
function restErrorType(value: string | null): RestExecutionErrorType {
  const supported = new Set([
    "TIMEOUT",
    "NETWORK",
    "HTTP_STATUS",
    "RESPONSE_PARSE",
    "PROVIDER_OUTPUT_INVALID",
    "TEMPLATE_INPUT",
    "CANCELLED"
  ]);
  if (value === null || !supported.has(value)) throw new SqliteRowInvalidError();
  return value as RestExecutionErrorType;
}

/** Convert one already-valid REST result into exact insert values. */
export function restResultInsertValues(value: StoredRestCaseResult): Insertable<CaseResultTable> {
  return {
    run_id: value.runId,
    case_key: value.caseKey,
    ordinal: value.ordinal,
    case_definition_json: canonicalJson(caseDefinitionJson(value.definition)),
    case_definition_hash: value.caseDefinitionHash,
    rest_status: value.status,
    http_status: value.httpStatus,
    provider_output_json:
      value.status === "SUCCEEDED" ? canonicalJson(providerOutputToV1(value.providerOutput)) : null,
    duration_ms: value.durationMs,
    error_type: value.errorType,
    error_message: value.errorMessage,
    completed_at: value.completedAt,
    run_result_hash: value.resultHash,
    reused_from_run_id: value.provenance?.sourceKind === "RUN" ? value.provenance.sourceId : null,
    reused_from_execution_id:
      value.provenance?.sourceKind === "EXECUTION" ? value.provenance.sourceId : null,
    reused_result_hash: value.provenance?.sourceResultHash ?? null
  };
}

/** Validate one complete timestamp before a Run write is attempted. */
export function requireRunTimestamp(value: string): void {
  if (!UtcDateTimeSchema.safeParse(value).success) throw new SqliteRowInvalidError();
}
