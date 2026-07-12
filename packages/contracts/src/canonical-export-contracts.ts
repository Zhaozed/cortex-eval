import { z } from "zod";

import {
  BusinessKeySchema,
  JsonObjectSchema,
  RelativePosixPathSchema,
  Sha256Schema,
  UtcDateTimeSchema,
  UuidV7Schema
} from "./contracts-primitives.ts";

const CanonicalEntityTypeV1Schema = z.enum([
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

/** Canonical Export request; Raw Evidence is opt-in. */
export const CanonicalExportRequestV1Schema = z.strictObject({
  rawEvidenceIncluded: z.boolean().default(false)
});

/** One stable RFC 8785-hashed JSONL entity record. */
export const CanonicalEntityRecordV1Schema = z.strictObject({
  contractVersion: z.literal("cortex.canonical-entity-record.v1"),
  entityType: CanonicalEntityTypeV1Schema,
  entityId: UuidV7Schema,
  entityHash: Sha256Schema,
  payload: JsonObjectSchema
});

const CanonicalEntityFileV1Schema = z.strictObject({
  entityType: CanonicalEntityTypeV1Schema,
  path: RelativePosixPathSchema.refine((path) => path.endsWith(".jsonl"), "JSONL_PATH_REQUIRED"),
  count: z.number().int().nonnegative(),
  sha256: Sha256Schema,
  sizeBytes: z.number().int().nonnegative()
});

const CanonicalArtifactV1Schema = z
  .strictObject({
    ownerType: z.enum(["RUN", "EVAL_RESULT"]),
    ownerId: UuidV7Schema,
    kind: BusinessKeySchema,
    path: RelativePosixPathSchema,
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
  });

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
    const entityTypes = new Set<string>();
    const filePaths = new Set<string>();
    for (const [index, file] of manifest.entityFiles.entries()) {
      if (entityTypes.has(file.entityType) || filePaths.has(file.path)) {
        context.addIssue({
          code: "custom",
          path: ["entityFiles", index],
          message: "CANONICAL_FILE_DUPLICATE"
        });
      }
      entityTypes.add(file.entityType);
      filePaths.add(file.path);
    }
    const artifactIdentities = new Set<string>();
    for (const [index, artifact] of manifest.artifacts.entries()) {
      const identity = `${artifact.ownerType}\u0000${artifact.ownerId}\u0000${artifact.kind}`;
      if (artifactIdentities.has(identity) || filePaths.has(artifact.path)) {
        context.addIssue({
          code: "custom",
          path: ["artifacts", index],
          message: "CANONICAL_ARTIFACT_DUPLICATE"
        });
      }
      artifactIdentities.add(identity);
      filePaths.add(artifact.path);
    }
  });

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
