import { z } from "zod";

import { ArtifactIdentityV1Schema, FileIntegrityV1Schema } from "./artifact-contracts.ts";
import { Sha256Schema, UuidV7Schema } from "./contracts-primitives.ts";

const ReportImportV1Schema = z.strictObject({
  contractVersion: z.literal("cortex.execution-result-import.v1"),
  importType: z.literal("REPORT"),
  ...ArtifactIdentityV1Schema.shape,
  restResultSetHash: Sha256Schema,
  evaluationContextHash: Sha256Schema,
  evaluationResultSetHash: Sha256Schema,
  reportResultSetHash: Sha256Schema,
  restResultsFile: FileIntegrityV1Schema,
  normalizedEvalFile: FileIntegrityV1Schema,
  reportJsonFile: FileIntegrityV1Schema,
  reportMarkdownFile: FileIntegrityV1Schema,
  rawPromptfooEvidenceFile: FileIntegrityV1Schema.nullable()
});

const AnalysisImportV1Schema = z.strictObject({
  contractVersion: z.literal("cortex.execution-result-import.v1"),
  importType: z.literal("ANALYSIS"),
  ...ArtifactIdentityV1Schema.shape,
  finalCaseResultSetHash: Sha256Schema,
  analysisResultSetHash: Sha256Schema,
  analysisFile: FileIntegrityV1Schema
});

/** Report and Analysis are intentionally importable in separate requests. */
export const ExecutionResultImportV1Schema = z.discriminatedUnion("importType", [
  ReportImportV1Schema,
  AnalysisImportV1Schema
]);

/** Versioned result-import request. */
export type ExecutionResultImportV1 = z.infer<typeof ExecutionResultImportV1Schema>;

/** Local-only request that selects one locked Work Package Execution for Report import. */
export const ExecutionReportImportRequestV1Schema = z.strictObject({
  contractVersion: z.literal("cortex.execution-report-import-request.v1"),
  packagePath: z.string().trim().min(1).max(4_096),
  executionId: UuidV7Schema
});

/** Stable completed imported-Run identity returned for first and idempotent imports. */
export const ExecutionReportImportResultV1Schema = z.strictObject({
  contractVersion: z.literal("cortex.execution-report-import-result.v1"),
  runId: UuidV7Schema,
  packageId: UuidV7Schema,
  executionId: UuidV7Schema,
  idempotent: z.boolean(),
  sourceType: z.literal("OFFLINE_IMPORT"),
  status: z.enum(["COMPLETED", "COMPLETED_WITH_ERRORS"]),
  stage: z.literal("DONE"),
  restResultSetHash: Sha256Schema,
  evaluationContextHash: Sha256Schema,
  evaluationResultSetHash: Sha256Schema,
  reportResultSetHash: Sha256Schema
});

/** Local Report import request DTO. */
export type ExecutionReportImportRequestV1 = z.infer<typeof ExecutionReportImportRequestV1Schema>;

/** Local Report import success DTO. */
export type ExecutionReportImportResultV1 = z.infer<typeof ExecutionReportImportResultV1Schema>;

/** Local-only request that selects one locked Work Package Execution for Analysis import. */
export const ExecutionAnalysisImportRequestV1Schema = z.strictObject({
  contractVersion: z.literal("cortex.execution-analysis-import-request.v1"),
  packagePath: z.string().trim().min(1).max(4_096),
  executionId: UuidV7Schema
});

/** Stable current-Analysis import result returned after atomic persistence. */
export const ExecutionAnalysisImportResultV1Schema = z.strictObject({
  contractVersion: z.literal("cortex.execution-analysis-import-result.v1"),
  runId: UuidV7Schema,
  packageId: UuidV7Schema,
  executionId: UuidV7Schema,
  idempotent: z.boolean(),
  selector: z.enum(["failed", "errors", "all"]),
  selectedCount: z.number().int().nonnegative(),
  importedCount: z.number().int().nonnegative(),
  finalCaseResultSetHash: Sha256Schema,
  analysisResultSetHash: Sha256Schema
});

/** Local Analysis import request DTO. */
export type ExecutionAnalysisImportRequestV1 = z.infer<
  typeof ExecutionAnalysisImportRequestV1Schema
>;

/** Local Analysis import success DTO. */
export type ExecutionAnalysisImportResultV1 = z.infer<typeof ExecutionAnalysisImportResultV1Schema>;
