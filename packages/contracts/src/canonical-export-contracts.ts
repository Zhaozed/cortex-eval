import { z } from "zod";

import {
  BusinessKeySchema,
  JsonObjectSchema,
  RelativePosixPathSchema,
  Sha256Schema,
  UtcDateTimeSchema,
  UuidV7Schema
} from "./contracts-primitives.ts";
import { CanonicalBase64ChunkSchema } from "./work-package-runtime-contracts.ts";

export const CanonicalEntityTypeV1Schema = z.enum([
  "TEST_SUITE",
  "TEST_CASE",
  "ENDPOINT_CONFIG",
  "LLM_CONFIG",
  "RUBRIC_PROMPT",
  "ANALYSIS_PROMPT",
  "RUN",
  "CASE_RESULT",
  "EVAL_RESULT",
  "CASE_ANALYSIS"
]);

/** Fixed byte-order and path identity for all Canonical Export entity files. */
export const CANONICAL_ENTITY_FILES_V1 = [
  { entityType: "TEST_SUITE", path: "entities/test-suites.jsonl" },
  { entityType: "TEST_CASE", path: "entities/test-cases.jsonl" },
  { entityType: "ENDPOINT_CONFIG", path: "entities/endpoint-configs.jsonl" },
  { entityType: "LLM_CONFIG", path: "entities/llm-configs.jsonl" },
  { entityType: "RUBRIC_PROMPT", path: "entities/rubric-prompts.jsonl" },
  { entityType: "ANALYSIS_PROMPT", path: "entities/analysis-prompts.jsonl" },
  { entityType: "RUN", path: "entities/runs.jsonl" },
  { entityType: "CASE_RESULT", path: "entities/case-results.jsonl" },
  { entityType: "EVAL_RESULT", path: "entities/eval-results.jsonl" },
  { entityType: "CASE_ANALYSIS", path: "entities/case-analyses.jsonl" }
] as const;

/** Exact successful response media type for the Canonical Export stream. */
export const CANONICAL_EXPORT_CONTENT_TYPE = "application/x-ndjson; charset=utf-8";

/** Canonical Export request; Raw Evidence is opt-in. */
export const CanonicalExportRequestV1Schema = z.strictObject({
  rawEvidenceIncluded: z.boolean().default(false)
});

const UuidCanonicalEntityTypeV1Schema = z.enum([
  "TEST_SUITE",
  "TEST_CASE",
  "ENDPOINT_CONFIG",
  "LLM_CONFIG",
  "RUBRIC_PROMPT",
  "ANALYSIS_PROMPT",
  "RUN",
  "CASE_ANALYSIS"
]);

const CanonicalReferenceV1Schema = z.union([
  z.strictObject({
    entityType: UuidCanonicalEntityTypeV1Schema,
    entityKey: z.strictObject({ id: UuidV7Schema })
  }),
  z.strictObject({
    entityType: z.enum(["CASE_RESULT", "EVAL_RESULT"]),
    entityKey: z.strictObject({ runId: UuidV7Schema, caseKey: BusinessKeySchema })
  })
]);

const CanonicalEntityRecordBaseV1Schema = z.strictObject({
  contractVersion: z.literal("cortex.canonical-entity-record.v1"),
  entityHash: Sha256Schema,
  payload: JsonObjectSchema,
  references: z.array(CanonicalReferenceV1Schema)
});

/** One stable RFC 8785-hashed JSONL entity record with an explicit natural key. */
export const CanonicalEntityRecordV1Schema = z.union([
  CanonicalEntityRecordBaseV1Schema.extend({
    entityType: UuidCanonicalEntityTypeV1Schema,
    entityKey: z.strictObject({ id: UuidV7Schema })
  }),
  CanonicalEntityRecordBaseV1Schema.extend({
    entityType: z.enum(["CASE_RESULT", "EVAL_RESULT"]),
    entityKey: z.strictObject({ runId: UuidV7Schema, caseKey: BusinessKeySchema })
  })
]);

const CanonicalEntityFileV1Schema = z.strictObject({
  entityType: CanonicalEntityTypeV1Schema,
  path: RelativePosixPathSchema.refine((path) => path.endsWith(".jsonl"), "JSONL_PATH_REQUIRED"),
  count: z.number().int().nonnegative(),
  sha256: Sha256Schema,
  sizeBytes: z.number().int().nonnegative()
});

const CanonicalArtifactOwnerV1Schema = z.union([
  z.strictObject({ type: z.literal("RUN"), key: z.strictObject({ id: UuidV7Schema }) }),
  z.strictObject({
    type: z.literal("EVAL_RESULT"),
    key: z.strictObject({ runId: UuidV7Schema, caseKey: BusinessKeySchema })
  })
]);

/** Exact export-relative destination for one opted-in Run Raw Evidence file. */
export function canonicalRunRawEvidenceExportPath(runId: string): string {
  return `artifacts/runs/${runId}/raw-promptfoo-evidence.bin`;
}

const CanonicalArtifactV1Schema = z
  .strictObject({
    owner: CanonicalArtifactOwnerV1Schema,
    kind: BusinessKeySchema,
    sourcePath: RelativePosixPathSchema,
    included: z.boolean(),
    exportPath: RelativePosixPathSchema.nullable(),
    expectedSha256: Sha256Schema,
    expectedSizeBytes: z.number().int().nonnegative(),
    present: z.boolean(),
    actualSha256: Sha256Schema.nullable(),
    actualSizeBytes: z.number().int().nonnegative().nullable()
  })
  .superRefine((artifact, context) => {
    const hasActual = artifact.actualSha256 !== null && artifact.actualSizeBytes !== null;
    if (artifact.present !== hasActual) {
      context.addIssue({ code: "custom", message: "ARTIFACT_PRESENCE_MISMATCH" });
    }
    if (artifact.included !== (artifact.exportPath !== null) || (artifact.included && !hasActual)) {
      context.addIssue({ code: "custom", message: "ARTIFACT_INCLUSION_MISMATCH" });
    }
  });

// Build one deterministic identity without locale-sensitive comparison.
function artifactIdentity(value: z.infer<typeof CanonicalArtifactV1Schema>): string {
  const ownerKey =
    value.owner.type === "RUN"
      ? value.owner.key.id
      : `${value.owner.key.runId}\u0000${value.owner.key.caseKey}`;
  return `${value.owner.type}\u0000${ownerKey}\u0000${value.kind}`;
}

/** Readable manifest for stable Canonical JSONL files. */
export const CanonicalExportManifestV1Schema = z
  .strictObject({
    contractVersion: z.literal("cortex.canonical-export-manifest.v1"),
    exportId: UuidV7Schema,
    createdAt: UtcDateTimeSchema,
    rawEvidenceIncluded: z.boolean(),
    contractVersions: z.record(BusinessKeySchema, z.string().regex(/^[a-z0-9.-]+$/)),
    entityFiles: z.array(CanonicalEntityFileV1Schema),
    artifacts: z.array(CanonicalArtifactV1Schema)
  })
  .superRefine((manifest, context) => {
    const filePaths = new Set<string>();
    if (manifest.entityFiles.length !== CANONICAL_ENTITY_FILES_V1.length) {
      context.addIssue({
        code: "custom",
        path: ["entityFiles"],
        message: "CANONICAL_FILES_REQUIRED"
      });
    }
    for (const [index, expected] of CANONICAL_ENTITY_FILES_V1.entries()) {
      const file = manifest.entityFiles[index];
      const identity = file === undefined ? null : `${file.entityType}\u0000${file.path}`;
      if (identity !== `${expected.entityType}\u0000${expected.path}`) {
        context.addIssue({
          code: "custom",
          path: ["entityFiles", index],
          message: "CANONICAL_FILE_ORDER_INVALID"
        });
        continue;
      }
      filePaths.add(expected.path);
    }
    const artifactIdentities = new Set<string>();
    let previousIdentity: string | null = null;
    for (const [index, artifact] of manifest.artifacts.entries()) {
      const identity = artifactIdentity(artifact);
      const exportedPathConflict =
        artifact.exportPath !== null && filePaths.has(artifact.exportPath);
      if (
        artifactIdentities.has(identity) ||
        exportedPathConflict ||
        (previousIdentity !== null && identity <= previousIdentity)
      ) {
        context.addIssue({
          code: "custom",
          path: ["artifacts", index],
          message: "CANONICAL_ARTIFACT_ORDER_INVALID"
        });
      }
      const authorizedRawPath =
        artifact.owner.type === "RUN"
          ? canonicalRunRawEvidenceExportPath(artifact.owner.key.id)
          : null;
      if (
        artifact.included &&
        (!manifest.rawEvidenceIncluded ||
          artifact.kind !== "RAW_PROMPTFOO_EVIDENCE" ||
          artifact.exportPath !== authorizedRawPath)
      ) {
        context.addIssue({
          code: "custom",
          path: ["artifacts", index],
          message: "CANONICAL_ARTIFACT_AUTHORIZATION_INVALID"
        });
      }
      artifactIdentities.add(identity);
      if (artifact.exportPath !== null) filePaths.add(artifact.exportPath);
      previousIdentity = identity;
    }
  });

const CanonicalExportFileDescriptorV1Schema = z.strictObject({
  path: RelativePosixPathSchema,
  sha256: Sha256Schema,
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
});

const CanonicalExportStartEventV1Schema = z.strictObject({
  type: z.literal("EXPORT_START"),
  exportId: UuidV7Schema,
  manifest: CanonicalExportFileDescriptorV1Schema.extend({ path: z.literal("manifest.json") })
});

const CanonicalExportFileStartEventV1Schema = z.strictObject({
  type: z.literal("FILE_START"),
  file: CanonicalExportFileDescriptorV1Schema
});

const CanonicalExportFileChunkEventV1Schema = z.strictObject({
  type: z.literal("FILE_CHUNK"),
  path: RelativePosixPathSchema,
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  dataBase64: CanonicalBase64ChunkSchema
});

const CanonicalExportFileEndEventV1Schema = z.strictObject({
  type: z.literal("FILE_END"),
  path: RelativePosixPathSchema
});

const CanonicalExportEndEventV1Schema = z.strictObject({
  type: z.literal("EXPORT_END"),
  exportId: UuidV7Schema,
  reconciliation: CanonicalExportFileDescriptorV1Schema.extend({
    path: z.literal("reconciliation.json")
  })
});

/** Independent Manifest-first NDJSON transport for one completed Canonical Export. */
export const CanonicalExportEventV1Schema = z.discriminatedUnion("type", [
  CanonicalExportStartEventV1Schema,
  CanonicalExportFileStartEventV1Schema,
  CanonicalExportFileChunkEventV1Schema,
  CanonicalExportFileEndEventV1Schema,
  CanonicalExportEndEventV1Schema
]);

const ReconciliationCheckV1Schema = z.strictObject({
  status: z.enum(["PASS", "FAIL"]),
  checked: z.number().int().nonnegative()
});

/** Mandatory four-way read-back reconciliation result. */
export const CanonicalExportReconciliationV1Schema = z.strictObject({
  contractVersion: z.literal("cortex.canonical-export-reconciliation.v1"),
  exportId: UuidV7Schema,
  checks: z.strictObject({
    counts: ReconciliationCheckV1Schema,
    references: ReconciliationCheckV1Schema,
    entityHashes: ReconciliationCheckV1Schema,
    fileHashes: ReconciliationCheckV1Schema
  })
});

/** Canonical Export request DTO. */
export type CanonicalExportRequestV1 = z.infer<typeof CanonicalExportRequestV1Schema>;

/** One exact Canonical JSONL record. */
export type CanonicalEntityRecordV1 = z.infer<typeof CanonicalEntityRecordV1Schema>;

/** Completed Canonical Export Manifest. */
export type CanonicalExportManifestV1 = z.infer<typeof CanonicalExportManifestV1Schema>;

/** Four-way read-back result. */
export type CanonicalExportReconciliationV1 = z.infer<typeof CanonicalExportReconciliationV1Schema>;

/** One typed Canonical Export transport event. */
export type CanonicalExportEventV1 = z.infer<typeof CanonicalExportEventV1Schema>;
