import { z } from "zod";

/** Default platform and offline Run execution limits. */
export const DEFAULT_RUN_EXECUTION_LIMITS_V1 = {
  contractVersion: "cortex.run-execution-limits.v1",
  restConcurrency: 4,
  evalConcurrency: 2
} as const;

/** Default platform and offline Analysis execution limits. */
export const DEFAULT_ANALYSIS_EXECUTION_LIMITS_V1 = {
  contractVersion: "cortex.analysis-execution-limits.v1",
  analysisConcurrency: 1
} as const;

/** Frozen REST and Evaluation concurrency values. */
export const RunExecutionLimitsV1Schema = z.strictObject({
  contractVersion: z.literal("cortex.run-execution-limits.v1"),
  restConcurrency: z.number().int().min(1).max(64),
  evalConcurrency: z.number().int().min(1).max(16)
});

/** Frozen Analysis concurrency value. */
export const AnalysisExecutionLimitsV1Schema = z.strictObject({
  contractVersion: z.literal("cortex.analysis-execution-limits.v1"),
  analysisConcurrency: z.number().int().min(1).max(8)
});

/** Run execution limits. */
export type RunExecutionLimitsV1 = z.infer<typeof RunExecutionLimitsV1Schema>;

/** Analysis execution limits. */
export type AnalysisExecutionLimitsV1 = z.infer<typeof AnalysisExecutionLimitsV1Schema>;
