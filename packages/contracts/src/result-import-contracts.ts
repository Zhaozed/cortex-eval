import { z } from "zod";

import { ArtifactIdentityV1Schema, FileIntegrityV1Schema } from "./artifact-contracts.ts";
import { Sha256Schema } from "./contracts-primitives.ts";

const ReportImportV1Schema = z.strictObject({
  contractVersion: z.literal("cortex.execution-result-import.v1"),
  importType: z.literal("REPORT"),
  ...ArtifactIdentityV1Schema.shape,
  resultSetHash: Sha256Schema,
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
