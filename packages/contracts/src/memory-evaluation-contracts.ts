import { z } from "zod";

import { JsonObjectSchema, JsonValueSchema } from "./contracts-primitives.ts";

/** Versioned contract for evaluating Cortex-Agent long-term memory end to end. */
export const MEMORY_EVALUATION_CONTRACT_V1 = "cortex.memory-evaluation-contract.v1" as const;

const NonEmptyString = z.string().trim().min(1);
const DomainSchema = z.enum(["USER", "PERSON", "PROJECT"]);
const MutationTypeSchema = z.enum(["MEMORY_CREATE", "MEMORY_UPDATE", "MEMORY_ARCHIVE"]);
const DispositionSchema = z.enum(["CREATE", "UPDATE", "MERGE", "IGNORE"]);

/** One source item used to build a memory evaluation case. */
export const MemoryEvaluationSourceRecordV1Schema = z.strictObject({
  sourceRecordId: NonEmptyString,
  sourceType: NonEmptyString,
  content: JsonValueSchema,
  observedAt: NonEmptyString.optional(),
  metadata: JsonObjectSchema.optional()
});
export type MemoryEvaluationSourceRecordV1 = z.infer<typeof MemoryEvaluationSourceRecordV1Schema>;

/** One expected Observation fact. */
export const MemoryEvaluationExpectedObservationV1Schema = z.strictObject({
  observationId: NonEmptyString,
  domain: DomainSchema,
  memoryKind: NonEmptyString.optional(),
  fact: NonEmptyString,
  personEmails: z.array(NonEmptyString).default([]),
  projectClue: NonEmptyString.optional(),
  sourceRecordId: NonEmptyString.optional()
});
export type MemoryEvaluationExpectedObservationV1 = z.infer<
  typeof MemoryEvaluationExpectedObservationV1Schema
>;

/** Expected Observation-to-PERSON resolution. */
export const MemoryEvaluationExpectedPersonLinkV1Schema = z.strictObject({
  observationId: NonEmptyString,
  emails: z.array(NonEmptyString).min(1),
  personRef: NonEmptyString.optional(),
  shouldResolve: z.boolean().default(true)
});
export type MemoryEvaluationExpectedPersonLinkV1 = z.infer<
  typeof MemoryEvaluationExpectedPersonLinkV1Schema
>;

/** Expected Observation-to-PROJECT resolution. */
export const MemoryEvaluationExpectedProjectLinkV1Schema = z.strictObject({
  observationId: NonEmptyString,
  projectClue: NonEmptyString,
  projectRef: NonEmptyString.optional(),
  shouldResolve: z.boolean().default(true)
});
export type MemoryEvaluationExpectedProjectLinkV1 = z.infer<
  typeof MemoryEvaluationExpectedProjectLinkV1Schema
>;

/** Expected Project-Person relation. */
export const MemoryEvaluationExpectedProjectPersonLinkV1Schema = z.strictObject({
  projectRef: NonEmptyString,
  personRef: NonEmptyString
});
export type MemoryEvaluationExpectedProjectPersonLinkV1 = z.infer<
  typeof MemoryEvaluationExpectedProjectPersonLinkV1Schema
>;

/** Expected state mutation emitted by Global Consolidate. */
export const MemoryEvaluationExpectedConsolidationV1Schema = z.strictObject({
  mutationId: NonEmptyString,
  domain: DomainSchema,
  memoryKind: NonEmptyString.optional(),
  disposition: DispositionSchema.optional(),
  mutationType: MutationTypeSchema.optional(),
  memoryRef: NonEmptyString.optional(),
  content: NonEmptyString.optional(),
  shouldApply: z.boolean().default(true)
});
export type MemoryEvaluationExpectedConsolidationV1 = z.infer<
  typeof MemoryEvaluationExpectedConsolidationV1Schema
>;

/** Expected final memory state after consolidation. */
export const MemoryEvaluationExpectedMemoryV1Schema = z.strictObject({
  memoryRef: NonEmptyString.optional(),
  domain: DomainSchema,
  memoryKind: NonEmptyString,
  content: NonEmptyString,
  subjectRef: NonEmptyString.optional(),
  status: z.enum(["ACTIVE", "ARCHIVED"]).default("ACTIVE")
});
export type MemoryEvaluationExpectedMemoryV1 = z.infer<
  typeof MemoryEvaluationExpectedMemoryV1Schema
>;

/** Expected retrieval behavior. */
export const MemoryEvaluationExpectedRetrievalV1Schema = z.strictObject({
  requiredMemoryRefs: z.array(NonEmptyString).default([]),
  forbiddenMemoryRefs: z.array(NonEmptyString).default([]),
  requiredKeywords: z.array(NonEmptyString).default([]),
  forbiddenKeywords: z.array(NonEmptyString).default([])
});
export type MemoryEvaluationExpectedRetrievalV1 = z.infer<
  typeof MemoryEvaluationExpectedRetrievalV1Schema
>;

/** Expected final-answer claims and prohibited memory use. */
export const MemoryEvaluationExpectedConsumptionV1Schema = z.strictObject({
  requiredClaims: z.array(NonEmptyString).default([]),
  forbiddenClaims: z.array(NonEmptyString).default([]),
  requiredMemoryRefs: z.array(NonEmptyString).default([]),
  forbiddenMemoryRefs: z.array(NonEmptyString).default([])
});
export type MemoryEvaluationExpectedConsumptionV1 = z.infer<
  typeof MemoryEvaluationExpectedConsumptionV1Schema
>;

/** Complete case definition. All fields are stable and serializable. */
export const MemoryEvaluationCaseV1Schema = z.strictObject({
  contractVersion: z.literal(MEMORY_EVALUATION_CONTRACT_V1),
  caseId: NonEmptyString,
  ownerUserId: z.number().int().positive(),
  candidateId: NonEmptyString.optional(),
  runId: NonEmptyString.optional(),
  sourceRecords: z.array(MemoryEvaluationSourceRecordV1Schema).min(1),
  expectedObservations: z.array(MemoryEvaluationExpectedObservationV1Schema),
  expectedPersonLinks: z.array(MemoryEvaluationExpectedPersonLinkV1Schema).default([]),
  expectedProjectLinks: z.array(MemoryEvaluationExpectedProjectLinkV1Schema).default([]),
  expectedProjectPersonLinks: z
    .array(MemoryEvaluationExpectedProjectPersonLinkV1Schema)
    .default([]),
  expectedConsolidation: z.array(MemoryEvaluationExpectedConsolidationV1Schema).default([]),
  expectedMemoryState: z.array(MemoryEvaluationExpectedMemoryV1Schema).default([]),
  expectedRetrieval: MemoryEvaluationExpectedRetrievalV1Schema.default({
    requiredMemoryRefs: [],
    forbiddenMemoryRefs: [],
    requiredKeywords: [],
    forbiddenKeywords: []
  }),
  expectedConsumption: MemoryEvaluationExpectedConsumptionV1Schema.default({
    requiredClaims: [],
    forbiddenClaims: [],
    requiredMemoryRefs: [],
    forbiddenMemoryRefs: []
  }),
  metadata: JsonObjectSchema.optional()
});
export type MemoryEvaluationCaseV1 = z.infer<typeof MemoryEvaluationCaseV1Schema>;

/** Full-memory list item returned by the Cortex-Agent admin API. */
export const LiveMemoryMemoryDirectoryItemV1Schema = z.strictObject({
  memory_ref: NonEmptyString,
  domain: DomainSchema,
  subject_ref: NonEmptyString.nullish(),
  subject_label: z.string().nullish(),
  subject_last_interaction_at: z.string().nullish(),
  person_name: z.string().nullish(),
  person_emails: z.array(z.string()),
  person_sources: z.array(
    z.strictObject({
      provider: NonEmptyString,
      account_id: NonEmptyString
    })
  ),
  memory_kind: NonEmptyString,
  content: NonEmptyString,
  status: z.enum(["ACTIVE", "ARCHIVED"]),
  revision: z.number().int().positive(),
  created_at: NonEmptyString,
  updated_at: NonEmptyString
});
export type LiveMemoryMemoryDirectoryItemV1 = z.infer<typeof LiveMemoryMemoryDirectoryItemV1Schema>;

export const LiveMemoryMemoryPageV1Schema = z.strictObject({
  items: z.array(LiveMemoryMemoryDirectoryItemV1Schema),
  next_cursor: NonEmptyString.nullish(),
  catalog_marker: NonEmptyString
});
export type LiveMemoryMemoryPageV1 = z.infer<typeof LiveMemoryMemoryPageV1Schema>;

/** Unified data fetched from Cortex-Agent before scoring. */
export const MemoryEvaluationInputV1Schema = z.strictObject({
  caseDefinition: MemoryEvaluationCaseV1Schema,
  candidate: z.unknown().nullish(),
  observations: z.array(z.unknown()),
  memories: z.array(LiveMemoryMemoryDirectoryItemV1Schema),
  entities: z.unknown().nullish(),
  replaySnapshots: z.array(z.unknown()),
  replayResults: z.array(z.unknown()),
  warnings: z.array(NonEmptyString)
});
export type MemoryEvaluationInputV1 = z.infer<typeof MemoryEvaluationInputV1Schema>;

/** Replay execution mode used by the evaluation runner. */
export const MemoryEvaluationReplayModeV1Schema = z.enum(["NONE", "EXTRACT", "CONSOLIDATE", "ALL"]);
export type MemoryEvaluationReplayModeV1 = z.infer<typeof MemoryEvaluationReplayModeV1Schema>;

/** Deterministic metric emitted for one memory evaluation dimension. */
export const MemoryEvaluationMetricV1Schema = z.strictObject({
  precision: z.number().min(0).max(1),
  recall: z.number().min(0).max(1),
  f1: z.number().min(0).max(1),
  expected: z.number().int().nonnegative(),
  actual: z.number().int().nonnegative(),
  matched: z.number().int().nonnegative()
});
export type MemoryEvaluationMetricV1 = z.infer<typeof MemoryEvaluationMetricV1Schema>;

export const MemoryEvaluationSafetyV1Schema = z.strictObject({
  passed: z.boolean(),
  violations: z.array(NonEmptyString)
});
export type MemoryEvaluationSafetyV1 = z.infer<typeof MemoryEvaluationSafetyV1Schema>;

/** Stable score payload shared by adapters, reports and future application persistence. */
export const MemoryEvaluationScoreV1Schema = z.strictObject({
  observationExtraction: MemoryEvaluationMetricV1Schema,
  personResolution: MemoryEvaluationMetricV1Schema,
  projectResolution: MemoryEvaluationMetricV1Schema,
  consolidation: MemoryEvaluationMetricV1Schema,
  memoryState: MemoryEvaluationMetricV1Schema,
  retrieval: MemoryEvaluationMetricV1Schema,
  consumption: MemoryEvaluationMetricV1Schema,
  safety: MemoryEvaluationSafetyV1Schema
});
export type MemoryEvaluationScoreV1 = z.infer<typeof MemoryEvaluationScoreV1Schema>;

/** Durable report envelope for one end-to-end long-term-memory evaluation. */
export const MemoryEvaluationReportV1Schema = z.strictObject({
  contractVersion: z.literal(MEMORY_EVALUATION_CONTRACT_V1),
  caseId: NonEmptyString,
  ownerUserId: z.number().int().positive(),
  replayMode: MemoryEvaluationReplayModeV1Schema,
  replayRequestCount: z.number().int().nonnegative(),
  costRisk: z.enum(["NONE", "LOW", "MEDIUM", "HIGH"]),
  scores: MemoryEvaluationScoreV1Schema,
  warnings: z.array(NonEmptyString)
});
export type MemoryEvaluationReportV1 = z.infer<typeof MemoryEvaluationReportV1Schema>;

/** Controlled ablation variants for measuring memory lift. */
export const MemoryEvaluationAblationVariantV1Schema = z.enum([
  "FULL_MEMORY",
  "NO_MEMORY",
  "DISTRACTOR_MEMORY"
]);
export type MemoryEvaluationAblationVariantV1 = z.infer<
  typeof MemoryEvaluationAblationVariantV1Schema
>;
