import { z } from "zod";

import { FileIntegrityV1Schema } from "./artifact-contracts.ts";
import {
  BusinessKeySchema,
  Sha256Schema,
  UtcDateTimeSchema,
  UuidV7Schema
} from "./contracts-primitives.ts";
import {
  AnalysisExecutionLimitsV1Schema,
  RunExecutionLimitsV1Schema
} from "./execution-limit-contracts.ts";
import { ERROR_CODES } from "./error-contracts.ts";

/** Work Package stage names frozen in v1. */
export const WorkPackageStageSchema = z.enum(["REST", "EVALUATION", "REPORT", "ANALYSIS"]);

const PromptFileV1Schema = FileIntegrityV1Schema.extend({
  promptKey: BusinessKeySchema,
  promptHash: Sha256Schema
});

const StageGraphV1Schema = z.strictObject({
  REST: z.tuple([]),
  EVALUATION: z.tuple([z.literal("REST")]),
  REPORT: z.tuple([z.literal("REST"), z.literal("EVALUATION")]),
  ANALYSIS: z.tuple([z.literal("REPORT")])
});

// Freeze one exact Artifact slot without allowing later stages to mutate v1.
function artifactSlotV1Schema<const Path extends string, const Version extends string>(
  path: Path,
  contractVersion: Version
): z.ZodObject<{ path: z.ZodLiteral<Path>; contractVersion: z.ZodLiteral<Version> }> {
  return z.strictObject({ path: z.literal(path), contractVersion: z.literal(contractVersion) });
}

const ExecutionLimitPolicyV1Schema = z.strictObject({
  run: z.strictObject({
    defaults: RunExecutionLimitsV1Schema,
    ranges: z.strictObject({
      restConcurrency: z.strictObject({ min: z.literal(1), max: z.literal(64) }),
      evalConcurrency: z.strictObject({ min: z.literal(1), max: z.literal(16) })
    })
  }),
  analysis: z.strictObject({
    defaults: AnalysisExecutionLimitsV1Schema,
    ranges: z.strictObject({
      analysisConcurrency: z.strictObject({ min: z.literal(1), max: z.literal(8) })
    })
  })
});

/** Immutable complete Work Package Manifest v1. */
export const WorkPackageManifestV1Schema = z
  .strictObject({
    contractVersion: z.literal("cortex.work-package-manifest.v1"),
    packageId: UuidV7Schema,
    createdAt: UtcDateTimeSchema,
    sourceSuite: z.strictObject({ suiteId: UuidV7Schema, suiteHash: Sha256Schema }),
    cases: z
      .array(
        z.strictObject({
          caseKey: BusinessKeySchema,
          ordinal: z.number().int().nonnegative(),
          baseDefinitionHash: Sha256Schema
        })
      )
      .min(1),
    inputs: z.strictObject({
      tests: FileIntegrityV1Schema,
      endpoint: FileIntegrityV1Schema,
      evaluator: FileIntegrityV1Schema,
      analyzer: FileIntegrityV1Schema,
      rubricPrompts: z.array(PromptFileV1Schema),
      analysisPrompt: PromptFileV1Schema,
      envExample: FileIntegrityV1Schema
    }),
    configurationHashes: z.strictObject({
      endpoint: Sha256Schema,
      evaluator: Sha256Schema,
      analyzer: Sha256Schema,
      analysisPrompt: Sha256Schema,
      rubricPrompts: Sha256Schema
    }),
    promptfoo: z.strictObject({
      version: z.literal("0.121.18"),
      generationContractVersion: z.literal("cortex.promptfoo-generation.v1")
    }),
    contractVersions: z.strictObject({
      caseDefinition: z.literal("cortex.case-definition.v1"),
      restResults: z.literal("cortex.rest-results.v1"),
      normalizedEval: z.literal("cortex.normalized-eval.v1"),
      report: z.literal("cortex.report.v1"),
      analysisInput: z.literal("cortex.analysis-input.v1"),
      analysisOutput: z.literal("cortex.analysis-output.v1")
    }),
    requiredEnvKeys: z.strictObject({
      REST: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)),
      EVALUATION: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)),
      REPORT: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)),
      ANALYSIS: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/))
    }),
    executionLimitPolicy: ExecutionLimitPolicyV1Schema,
    stageGraph: StageGraphV1Schema,
    artifactSlots: z.strictObject({
      REST_RESULTS: artifactSlotV1Schema(
        "executions/{execution_id}/rest-results.json",
        "cortex.rest-results.v1"
      ),
      RAW_PROMPTFOO_EVIDENCE: artifactSlotV1Schema(
        "executions/{execution_id}/promptfoo-raw.json",
        "promptfoo.0.121.18"
      ),
      NORMALIZED_EVAL_RESULTS: artifactSlotV1Schema(
        "executions/{execution_id}/normalized-eval.json",
        "cortex.normalized-eval.v1"
      ),
      REPORT_JSON: artifactSlotV1Schema(
        "executions/{execution_id}/report.json",
        "cortex.report.v1"
      ),
      REPORT_MARKDOWN: artifactSlotV1Schema(
        "executions/{execution_id}/report.md",
        "cortex.report-markdown.v1"
      ),
      ANALYSIS_RESULTS: artifactSlotV1Schema(
        "executions/{execution_id}/analysis-results.json",
        "cortex.analysis-results.v1"
      )
    })
  })
  .superRefine((manifest, context) => {
    const caseKeys = new Set<string>();
    const ordinals = new Set<number>();
    for (const [index, item] of manifest.cases.entries()) {
      if (caseKeys.has(item.caseKey) || ordinals.has(item.ordinal) || item.ordinal !== index) {
        context.addIssue({ code: "custom", path: ["cases", index], message: "CASE_ID_DUPLICATE" });
      }
      caseKeys.add(item.caseKey);
      ordinals.add(item.ordinal);
    }
    for (const keys of Object.values(manifest.requiredEnvKeys)) {
      if (new Set(keys).size !== keys.length) {
        context.addIssue({
          code: "custom",
          path: ["requiredEnvKeys"],
          message: "ENV_KEY_DUPLICATE"
        });
      }
    }
    const inputPaths = [
      manifest.inputs.tests.path,
      manifest.inputs.endpoint.path,
      manifest.inputs.evaluator.path,
      manifest.inputs.analyzer.path,
      manifest.inputs.analysisPrompt.path,
      manifest.inputs.envExample.path
    ];
    const promptKeys = new Set<string>();
    for (const [index, prompt] of manifest.inputs.rubricPrompts.entries()) {
      if (promptKeys.has(prompt.promptKey) || inputPaths.includes(prompt.path)) {
        context.addIssue({
          code: "custom",
          path: ["inputs", "rubricPrompts", index],
          message: "WORK_PACKAGE_INPUT_DUPLICATE"
        });
      }
      promptKeys.add(prompt.promptKey);
      inputPaths.push(prompt.path);
    }
    if (new Set(inputPaths).size !== inputPaths.length) {
      context.addIssue({
        code: "custom",
        path: ["inputs"],
        message: "WORK_PACKAGE_INPUT_DUPLICATE"
      });
    }
  });

const CommittedArtifactV1Schema = FileIntegrityV1Schema.extend({
  kind: z.enum([
    "REST_RESULTS",
    "RAW_PROMPTFOO_EVIDENCE",
    "NORMALIZED_EVAL_RESULTS",
    "REPORT_JSON",
    "REPORT_MARKDOWN",
    "ANALYSIS_RESULTS"
  ]),
  contractVersion: z.string().regex(/^[a-z0-9.-]+$/)
});

const ExecutionStageStateV1Schema = z
  .strictObject({
    status: z.enum(["PENDING", "RUNNING", "SUCCEEDED", "ERROR", "SKIPPED"]),
    startedAt: UtcDateTimeSchema.nullable(),
    completedAt: UtcDateTimeSchema.nullable(),
    errorCode: z.enum(ERROR_CODES).nullable(),
    artifacts: z.array(CommittedArtifactV1Schema)
  })
  .superRefine((stage, context) => {
    const pendingShape =
      stage.startedAt === null &&
      stage.completedAt === null &&
      stage.errorCode === null &&
      stage.artifacts.length === 0;
    const runningShape =
      stage.startedAt !== null && stage.completedAt === null && stage.errorCode === null;
    const succeededShape =
      stage.startedAt !== null &&
      stage.completedAt !== null &&
      stage.errorCode === null &&
      stage.artifacts.length > 0;
    const errorShape =
      stage.startedAt !== null && stage.completedAt !== null && stage.errorCode !== null;
    const skippedShape =
      stage.startedAt === null &&
      stage.completedAt !== null &&
      stage.errorCode === null &&
      stage.artifacts.length === 0;
    const valid =
      (stage.status === "PENDING" && pendingShape) ||
      (stage.status === "RUNNING" && runningShape) ||
      (stage.status === "SUCCEEDED" && succeededShape) ||
      (stage.status === "ERROR" && errorShape) ||
      (stage.status === "SKIPPED" && skippedShape);
    if (!valid) {
      context.addIssue({ code: "custom", message: "EXECUTION_STAGE_STATE_INVALID" });
    }
  });

const ExecutionRerunV1Schema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("NEW") }),
  z.strictObject({ mode: z.literal("RETRY_FAILED"), sourceExecutionId: UuidV7Schema }),
  z.strictObject({ mode: z.literal("FORCE"), sourceExecutionId: UuidV7Schema })
]);

const EXECUTION_STAGE_ARTIFACTS = {
  REST: [
    {
      kind: "REST_RESULTS",
      fileName: "rest-results.json",
      contractVersion: "cortex.rest-results.v1"
    }
  ],
  EVALUATION: [
    {
      kind: "RAW_PROMPTFOO_EVIDENCE",
      fileName: "promptfoo-raw.json",
      contractVersion: "promptfoo.0.121.18"
    },
    {
      kind: "NORMALIZED_EVAL_RESULTS",
      fileName: "normalized-eval.json",
      contractVersion: "cortex.normalized-eval.v1"
    }
  ],
  REPORT: [
    { kind: "REPORT_JSON", fileName: "report.json", contractVersion: "cortex.report.v1" },
    {
      kind: "REPORT_MARKDOWN",
      fileName: "report.md",
      contractVersion: "cortex.report-markdown.v1"
    }
  ],
  ANALYSIS: [
    {
      kind: "ANALYSIS_RESULTS",
      fileName: "analysis-results.json",
      contractVersion: "cortex.analysis-results.v1"
    }
  ]
} as const;

/** Mutable state for one immutable Execution identity. */
export const ExecutionV1Schema = z
  .strictObject({
    contractVersion: z.literal("cortex.execution.v1"),
    packageId: UuidV7Schema,
    executionId: UuidV7Schema,
    createdAt: UtcDateTimeSchema,
    startedAt: UtcDateTimeSchema.nullable(),
    completedAt: UtcDateTimeSchema.nullable(),
    rerun: ExecutionRerunV1Schema,
    runExecutionLimits: RunExecutionLimitsV1Schema,
    analysisExecutionLimits: AnalysisExecutionLimitsV1Schema,
    executionContextHash: Sha256Schema,
    stages: z.strictObject({
      REST: ExecutionStageStateV1Schema,
      EVALUATION: ExecutionStageStateV1Schema,
      REPORT: ExecutionStageStateV1Schema,
      ANALYSIS: ExecutionStageStateV1Schema
    })
  })
  .superRefine((execution, context) => {
    const stageNames = ["REST", "EVALUATION", "REPORT", "ANALYSIS"] as const;
    for (const stageName of stageNames) {
      const stage = execution.stages[stageName];
      const expected = EXECUTION_STAGE_ARTIFACTS[stageName];
      const seenKinds = new Set<string>();
      for (const [index, artifact] of stage.artifacts.entries()) {
        const slot = expected.find((item) => item.kind === artifact.kind);
        const expectedPath =
          slot === undefined ? null : `executions/${execution.executionId}/${slot.fileName}`;
        if (
          slot === undefined ||
          seenKinds.has(artifact.kind) ||
          artifact.path !== expectedPath ||
          artifact.contractVersion !== slot.contractVersion
        ) {
          context.addIssue({
            code: "custom",
            path: ["stages", stageName, "artifacts", index],
            message: "EXECUTION_ARTIFACT_SLOT_MISMATCH"
          });
        }
        seenKinds.add(artifact.kind);
      }
      if (
        stage.status === "SUCCEEDED" &&
        (stage.artifacts.length !== expected.length ||
          expected.some((item) => !seenKinds.has(item.kind)))
      ) {
        context.addIssue({
          code: "custom",
          path: ["stages", stageName, "artifacts"],
          message: "EXECUTION_ARTIFACT_SET_INCOMPLETE"
        });
      }
    }
    if (
      execution.rerun.mode !== "NEW" &&
      execution.rerun.sourceExecutionId === execution.executionId
    ) {
      context.addIssue({ code: "custom", path: ["rerun"], message: "EXECUTION_SOURCE_SELF" });
    }
    const stages = execution.stages;
    const isActive = (status: (typeof stages.REST)["status"]): boolean =>
      status === "RUNNING" || status === "SUCCEEDED" || status === "ERROR";
    const runningCount = Object.values(stages).filter((stage) => stage.status === "RUNNING").length;
    if (runningCount > 1) {
      context.addIssue({ code: "custom", path: ["stages"], message: "EXECUTION_MULTIPLE_RUNNING" });
    }
    const hasActivity = Object.values(stages).some((stage) => isActive(stage.status));
    if ((execution.startedAt === null) === hasActivity) {
      context.addIssue({ code: "custom", path: ["startedAt"], message: "EXECUTION_LIFECYCLE" });
    }
    const hasIncompleteStage = Object.values(stages).some(
      (stage) => stage.status === "PENDING" || stage.status === "RUNNING"
    );
    if (execution.completedAt !== null && (execution.startedAt === null || hasIncompleteStage)) {
      context.addIssue({ code: "custom", path: ["completedAt"], message: "EXECUTION_LIFECYCLE" });
    }
    if (isActive(stages.EVALUATION.status) && stages.REST.status !== "SUCCEEDED") {
      context.addIssue({
        code: "custom",
        path: ["stages", "EVALUATION"],
        message: "EXECUTION_STAGE_DEPENDENCY"
      });
    }
    if (
      isActive(stages.REPORT.status) &&
      (stages.REST.status !== "SUCCEEDED" || stages.EVALUATION.status !== "SUCCEEDED")
    ) {
      context.addIssue({
        code: "custom",
        path: ["stages", "REPORT"],
        message: "EXECUTION_STAGE_DEPENDENCY"
      });
    }
    if (isActive(stages.ANALYSIS.status) && stages.REPORT.status !== "SUCCEEDED") {
      context.addIssue({
        code: "custom",
        path: ["stages", "ANALYSIS"],
        message: "EXECUTION_STAGE_DEPENDENCY"
      });
    }
  });

/** Exported Manifest DTO. */
export type WorkPackageManifestV1 = z.infer<typeof WorkPackageManifestV1Schema>;

/** Exported Execution DTO. */
export type ExecutionV1 = z.infer<typeof ExecutionV1Schema>;
