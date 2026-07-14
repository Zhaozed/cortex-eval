import { createHash } from "node:crypto";

import {
  WorkPackageManifestV1Schema,
  type WorkPackageManifestV1
} from "@cortex-eval/contracts/src/work-package-contracts.ts";
import { WORK_PACKAGE_RUNTIME_LIMITS } from "@cortex-eval/contracts/src/work-package-runtime-contracts.ts";

import { validateMaterializedFilePaths } from "./work-package-path-policy.ts";

const FIXED_INPUT_PATHS = {
  tests: "inputs/tests.json",
  endpoint: "inputs/endpoint.json",
  evaluator: "inputs/evaluator.json",
  analyzer: "inputs/analyzer.json",
  analysisPrompt: "prompts/analysis.json",
  envExample: ".env.example"
} as const;

/** Derive a materializable Rubric Prompt path without exposing its business key. */
export function expectedRubricPromptPath(promptKey: string): string {
  const keyHash = createHash("sha256").update(promptKey, "utf8").digest("hex");
  return `prompts/rubric/${keyHash}.json`;
}

// Fail one role before any file-system side effect occurs.
function requireInputSize(sizeBytes: number, maximumBytes: number): void {
  if (sizeBytes > maximumBytes) throw new Error("WORK_PACKAGE_INPUT_TOO_LARGE");
}

/** Clean and enforce the deterministic materialization profile for Manifest v1. */
export function validateWorkPackageManifestPolicy(value: unknown): WorkPackageManifestV1 {
  const manifest = WorkPackageManifestV1Schema.parse(value);
  if (
    manifest.inputs.tests.path !== FIXED_INPUT_PATHS.tests ||
    manifest.inputs.endpoint.path !== FIXED_INPUT_PATHS.endpoint ||
    manifest.inputs.evaluator.path !== FIXED_INPUT_PATHS.evaluator ||
    manifest.inputs.analyzer.path !== FIXED_INPUT_PATHS.analyzer ||
    manifest.inputs.analysisPrompt.path !== FIXED_INPUT_PATHS.analysisPrompt ||
    manifest.inputs.envExample.path !== FIXED_INPUT_PATHS.envExample ||
    manifest.inputs.rubricPrompts.some(
      (prompt) => prompt.path !== expectedRubricPromptPath(prompt.promptKey)
    )
  ) {
    throw new Error("WORK_PACKAGE_LAYOUT_INVALID");
  }

  requireInputSize(
    manifest.inputs.tests.sizeBytes,
    WORK_PACKAGE_RUNTIME_LIMITS.canonicalTestsBytes
  );
  for (const input of [
    manifest.inputs.endpoint,
    manifest.inputs.evaluator,
    manifest.inputs.analyzer,
    manifest.inputs.analysisPrompt,
    manifest.inputs.envExample,
    ...manifest.inputs.rubricPrompts
  ]) {
    requireInputSize(input.sizeBytes, WORK_PACKAGE_RUNTIME_LIMITS.configurationBytes);
  }

  validateMaterializedFilePaths([
    "manifest.json",
    ".cortex-work-package.lock",
    manifest.inputs.tests.path,
    manifest.inputs.endpoint.path,
    manifest.inputs.evaluator.path,
    manifest.inputs.analyzer.path,
    manifest.inputs.analysisPrompt.path,
    manifest.inputs.envExample.path,
    ...manifest.inputs.rubricPrompts.map((prompt) => prompt.path)
  ]);
  return manifest;
}
