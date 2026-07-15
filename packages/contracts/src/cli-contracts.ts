import { z } from "zod";

import { Sha256Schema, UuidV7Schema } from "./contracts-primitives.ts";
import { ERROR_CODES } from "./error-contracts.ts";
import { ReportSummaryV1Schema } from "./artifact-contracts.ts";

const PackageExportedEventV1Schema = z.strictObject({
  contractVersion: z.literal("cortex.cli-package-event.v1"),
  type: z.literal("PACKAGE_EXPORTED"),
  packageId: UuidV7Schema,
  manifestSha256: Sha256Schema,
  targetPath: z.string().min(1)
});

const PackageValidatedEventV1Schema = z.strictObject({
  contractVersion: z.literal("cortex.cli-package-event.v1"),
  type: z.literal("PACKAGE_VALIDATED"),
  packageId: UuidV7Schema,
  manifestSha256: Sha256Schema,
  executionCount: z.number().int().nonnegative()
});

const PackageCommandErrorEventV1Schema = z.strictObject({
  contractVersion: z.literal("cortex.cli-package-event.v1"),
  type: z.literal("COMMAND_ERROR"),
  command: z.enum(["package export", "package validate"]),
  code: z.enum(ERROR_CODES),
  exitCode: z.union([z.literal(2), z.literal(3), z.literal(4), z.literal(130)])
});

/** Stable NDJSON events for the currently closed package CLI commands. */
export const CliPackageEventV1Schema = z.discriminatedUnion("type", [
  PackageExportedEventV1Schema,
  PackageValidatedEventV1Schema,
  PackageCommandErrorEventV1Schema
]);

/** Package command machine-output event. */
export type CliPackageEventV1 = z.infer<typeof CliPackageEventV1Schema>;

const RestCompletedEventV1Schema = z.strictObject({
  contractVersion: z.literal("cortex.cli-execution-event.v1"),
  type: z.literal("REST_COMPLETED"),
  packageId: UuidV7Schema,
  executionId: UuidV7Schema,
  restErrorCount: z.number().int().nonnegative(),
  resultSetHash: Sha256Schema,
  artifactPath: z
    .string()
    .regex(
      /^executions\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/rest-results\.json$/
    )
});

const EvaluationCompletedEventV1Schema = z.strictObject({
  contractVersion: z.literal("cortex.cli-execution-event.v1"),
  type: z.literal("EVALUATION_COMPLETED"),
  packageId: UuidV7Schema,
  executionId: UuidV7Schema,
  promptfooExitCode: z.union([z.literal(0), z.literal(100)]),
  evalFailCount: z.number().int().nonnegative(),
  evalErrorCount: z.number().int().nonnegative(),
  resultSetHash: Sha256Schema,
  rawArtifactPath: z
    .string()
    .regex(
      /^executions\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/promptfoo-raw\.json$/
    ),
  normalizedArtifactPath: z
    .string()
    .regex(
      /^executions\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/normalized-eval\.json$/
    )
});

const AnalysisCompletionV1Schema = z.strictObject({
  packageId: UuidV7Schema,
  executionId: UuidV7Schema,
  selector: z.enum(["failed", "errors", "all"]),
  selectedCount: z.number().int().nonnegative(),
  succeededCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  finalCaseResultSetHash: Sha256Schema,
  analysisResultSetHash: Sha256Schema,
  artifactPath: z
    .string()
    .regex(
      /^executions\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/analysis-results\.json$/
    )
});

const PipelineCompletedEventV1Schema = z.strictObject({
  contractVersion: z.literal("cortex.cli-execution-event.v1"),
  type: z.literal("PIPELINE_COMPLETED"),
  packageId: UuidV7Schema,
  executionId: UuidV7Schema,
  restErrorCount: z.number().int().nonnegative(),
  restResultSetHash: Sha256Schema,
  restArtifactPath: z
    .string()
    .regex(
      /^executions\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/rest-results\.json$/
    ),
  promptfooExitCode: z.union([z.literal(0), z.literal(100)]),
  evalFailCount: z.number().int().nonnegative(),
  evalErrorCount: z.number().int().nonnegative(),
  evaluationResultSetHash: Sha256Schema,
  rawArtifactPath: z
    .string()
    .regex(
      /^executions\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/promptfoo-raw\.json$/
    ),
  normalizedArtifactPath: z
    .string()
    .regex(
      /^executions\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/normalized-eval\.json$/
    ),
  reportResultSetHash: Sha256Schema,
  reportSummary: ReportSummaryV1Schema,
  reportJsonPath: z
    .string()
    .regex(
      /^executions\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/report\.json$/
    ),
  reportMarkdownPath: z
    .string()
    .regex(
      /^executions\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/report\.md$/
    ),
  analysis: AnalysisCompletionV1Schema.optional()
});

const ReportCompletedEventV1Schema = z.strictObject({
  contractVersion: z.literal("cortex.cli-execution-event.v1"),
  type: z.literal("REPORT_COMPLETED"),
  packageId: UuidV7Schema,
  executionId: UuidV7Schema,
  evaluationResultSetHash: Sha256Schema,
  reportResultSetHash: Sha256Schema,
  summary: ReportSummaryV1Schema,
  reportJsonPath: z
    .string()
    .regex(
      /^executions\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/report\.json$/
    ),
  reportMarkdownPath: z
    .string()
    .regex(
      /^executions\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/report\.md$/
    )
});

const AnalysisCompletedEventV1Schema = z.strictObject({
  contractVersion: z.literal("cortex.cli-execution-event.v1"),
  type: z.literal("ANALYSIS_COMPLETED"),
  ...AnalysisCompletionV1Schema.shape
});

const ReportImportedEventV1Schema = z.strictObject({
  contractVersion: z.literal("cortex.cli-execution-event.v1"),
  type: z.literal("REPORT_IMPORTED"),
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

const AnalysisImportedEventV1Schema = z.strictObject({
  contractVersion: z.literal("cortex.cli-execution-event.v1"),
  type: z.literal("ANALYSIS_IMPORTED"),
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

const ExecutionCommandErrorEventV1Schema = z.strictObject({
  contractVersion: z.literal("cortex.cli-execution-event.v1"),
  type: z.literal("COMMAND_ERROR"),
  command: z.enum([
    "rest run",
    "eval run",
    "report build",
    "analyze run",
    "pipeline run",
    "result import"
  ]),
  code: z.enum(ERROR_CODES),
  exitCode: z.union([z.literal(2), z.literal(3), z.literal(4), z.literal(130)])
});

/** Stable NDJSON events for currently closed offline execution commands. */
export const CliExecutionEventV1Schema = z.discriminatedUnion("type", [
  RestCompletedEventV1Schema,
  EvaluationCompletedEventV1Schema,
  ReportCompletedEventV1Schema,
  AnalysisCompletedEventV1Schema,
  ReportImportedEventV1Schema,
  AnalysisImportedEventV1Schema,
  PipelineCompletedEventV1Schema,
  ExecutionCommandErrorEventV1Schema
]);

/** Offline execution command machine-output event. */
export type CliExecutionEventV1 = z.infer<typeof CliExecutionEventV1Schema>;
