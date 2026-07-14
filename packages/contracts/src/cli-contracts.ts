import { z } from "zod";

import { Sha256Schema, UuidV7Schema } from "./contracts-primitives.ts";
import { ERROR_CODES } from "./error-contracts.ts";

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
    )
});

const ExecutionCommandErrorEventV1Schema = z.strictObject({
  contractVersion: z.literal("cortex.cli-execution-event.v1"),
  type: z.literal("COMMAND_ERROR"),
  command: z.enum(["rest run", "eval run", "pipeline run"]),
  code: z.enum(ERROR_CODES),
  exitCode: z.union([z.literal(2), z.literal(3), z.literal(4), z.literal(130)])
});

/** Stable NDJSON events for currently closed offline execution commands. */
export const CliExecutionEventV1Schema = z.discriminatedUnion("type", [
  RestCompletedEventV1Schema,
  EvaluationCompletedEventV1Schema,
  PipelineCompletedEventV1Schema,
  ExecutionCommandErrorEventV1Schema
]);

/** Offline execution command machine-output event. */
export type CliExecutionEventV1 = z.infer<typeof CliExecutionEventV1Schema>;
