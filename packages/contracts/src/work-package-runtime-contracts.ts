import { z } from "zod";

import { Sha256Schema, UuidV7Schema } from "./contracts-primitives.ts";

/** User-confirmed byte ceilings for materialized Work Package runtime values. */
export const WORK_PACKAGE_RUNTIME_LIMITS = {
  manifestBytes: 256 * 1024 * 1024,
  executionBytes: 4 * 1024 * 1024,
  configurationBytes: 8 * 1024 * 1024,
  canonicalTestsBytes: 1_280 * 1024 * 1024,
  canonicalCaseBytes: 16 * 1024 * 1024,
  restResultCaseBytes: 32 * 1024 * 1024,
  normalizedEvalCaseBytes: 32 * 1024 * 1024,
  jsonlControlLineBytes: 16 * 1024,
  reportCaseBytes: 80 * 1024 * 1024,
  analysisResultCaseBytes: 80 * 1024 * 1024,
  promptfooRawRowBytes: 64 * 1024 * 1024,
  decodedJsonStringBytes: 16 * 1024 * 1024,
  decodedChunkBytes: 1024 * 1024,
  relativePathBytes: 1024,
  pathComponentBytes: 255
} as const;

/** Maximum encoded bytes for one canonical 1 MiB Base64 payload. */
export const WORK_PACKAGE_BASE64_CHUNK_MAX_BYTES = 1_398_104;

/** Maximum raw NDJSON line bytes before parsing, including the trailing LF. */
export const WORK_PACKAGE_EXPORT_LINE_MAX_BYTES = 1_399_204;

const RUNTIME_PATH_CHARACTERS = /^[A-Za-z0-9._/-]+$/;

/** Complete current-resource selection required to export one immutable Work Package. */
export const WorkPackageExportRequestV1Schema = z.strictObject({
  suiteId: UuidV7Schema,
  endpointConfigId: UuidV7Schema,
  evaluatorConfigId: UuidV7Schema,
  analyzerConfigId: UuidV7Schema,
  analysisPromptId: UuidV7Schema
});

/** Work Package export request DTO. */
export type WorkPackageExportRequestV1 = z.infer<typeof WorkPackageExportRequestV1Schema>;

/** ASCII-only Work Package path profile that can be materialized safely on macOS. */
export const WorkPackageRuntimePathSchema = z.string().superRefine((value, context) => {
  const components = value.split("/");
  const invalidComponent = components.some(
    (component) =>
      component.length === 0 ||
      component === "." ||
      component === ".." ||
      Buffer.byteLength(component, "utf8") > WORK_PACKAGE_RUNTIME_LIMITS.pathComponentBytes
  );
  if (
    !RUNTIME_PATH_CHARACTERS.test(value) ||
    value.startsWith("/") ||
    value.includes("\\") ||
    invalidComponent ||
    Buffer.byteLength(value, "utf8") > WORK_PACKAGE_RUNTIME_LIMITS.relativePathBytes
  ) {
    context.addIssue({ code: "custom", message: "WORK_PACKAGE_PATH_INVALID" });
  }
});

const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

// Derive decoded length without allocating the decoded payload.
function decodedBase64Bytes(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

/** One canonical non-empty Base64 chunk whose decoded value is at most 1 MiB. */
export const CanonicalBase64ChunkSchema = z
  .string()
  .min(4)
  .max(WORK_PACKAGE_BASE64_CHUNK_MAX_BYTES)
  .regex(CANONICAL_BASE64, "BASE64_INVALID")
  .refine(
    (value) => decodedBase64Bytes(value) <= WORK_PACKAGE_RUNTIME_LIMITS.decodedChunkBytes,
    "BASE64_CHUNK_TOO_LARGE"
  );

const ExportFileDescriptorV1Schema = z.strictObject({
  path: WorkPackageRuntimePathSchema,
  sha256: Sha256Schema,
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
});

const PackageStartEventV1Schema = z.strictObject({
  type: z.literal("PACKAGE_START"),
  manifest: z.strictObject({
    path: z.literal("manifest.json"),
    sha256: Sha256Schema,
    sizeBytes: z.number().int().positive().max(WORK_PACKAGE_RUNTIME_LIMITS.manifestBytes)
  })
});

const FileStartEventV1Schema = z.strictObject({
  type: z.literal("FILE_START"),
  file: ExportFileDescriptorV1Schema
});

const FileChunkEventV1Schema = z.strictObject({
  type: z.literal("FILE_CHUNK"),
  path: WorkPackageRuntimePathSchema,
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  dataBase64: CanonicalBase64ChunkSchema
});

const FileEndEventV1Schema = z.strictObject({
  type: z.literal("FILE_END"),
  path: WorkPackageRuntimePathSchema
});

const PackageEndEventV1Schema = z.strictObject({
  type: z.literal("PACKAGE_END"),
  packageId: UuidV7Schema
});

/** Manifest-first NDJSON events emitted by the P7 Work Package export API. */
export const WorkPackageExportEventV1Schema = z.discriminatedUnion("type", [
  PackageStartEventV1Schema,
  FileStartEventV1Schema,
  FileChunkEventV1Schema,
  FileEndEventV1Schema,
  PackageEndEventV1Schema
]);

/** Exported Work Package export event. */
export type WorkPackageExportEventV1 = z.infer<typeof WorkPackageExportEventV1Schema>;
