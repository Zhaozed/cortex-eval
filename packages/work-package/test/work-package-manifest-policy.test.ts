import { createHash } from "node:crypto";

import type { WorkPackageManifestV1 } from "../../contracts/src/work-package-contracts.ts";
import { describe, expect, it } from "vitest";

import {
  expectedRubricPromptPath,
  validateWorkPackageManifestPolicy
} from "../src/work-package-manifest-policy.ts";

const ID = "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeeee";
const HASH = "a".repeat(64);

function rubricPath(promptKey: string): string {
  return `prompts/rubric/${createHash("sha256").update(promptKey).digest("hex")}.json`;
}

function file(path: string, sizeBytes = 1): { path: string; sha256: string; sizeBytes: number } {
  return { path, sha256: HASH, sizeBytes };
}

function manifest(): WorkPackageManifestV1 {
  return {
    contractVersion: "cortex.work-package-manifest.v1",
    packageId: ID,
    createdAt: "2026-07-14T00:00:00.000Z",
    sourceSuite: { suiteId: ID, suiteHash: HASH },
    cases: [{ caseKey: "case-1", ordinal: 0, baseDefinitionHash: HASH }],
    inputs: {
      tests: file("inputs/tests.json"),
      endpoint: file("inputs/endpoint.json"),
      evaluator: file("inputs/evaluator.json"),
      analyzer: file("inputs/analyzer.json"),
      rubricPrompts: [
        {
          ...file(rubricPath("quality")),
          promptKey: "quality",
          promptHash: HASH
        }
      ],
      analysisPrompt: {
        ...file("prompts/analysis.json"),
        promptKey: "analysis",
        promptHash: HASH
      },
      envExample: file(".env.example")
    },
    configurationHashes: {
      endpoint: HASH,
      evaluator: HASH,
      analyzer: HASH,
      analysisPrompt: HASH,
      rubricPrompts: HASH
    },
    promptfoo: {
      version: "0.121.18",
      generationContractVersion: "cortex.promptfoo-generation.v1"
    },
    contractVersions: {
      caseDefinition: "cortex.case-definition.v1",
      restResults: "cortex.rest-results.v1",
      normalizedEval: "cortex.normalized-eval.v1",
      report: "cortex.report.v1",
      analysisInput: "cortex.analysis-input.v1",
      analysisOutput: "cortex.analysis-output.v1"
    },
    requiredEnvKeys: { REST: [], EVALUATION: [], REPORT: [], ANALYSIS: [] },
    executionLimitPolicy: {
      run: {
        defaults: {
          contractVersion: "cortex.run-execution-limits.v1",
          restConcurrency: 4,
          evalConcurrency: 2
        },
        ranges: {
          restConcurrency: { min: 1, max: 64 },
          evalConcurrency: { min: 1, max: 16 }
        }
      },
      analysis: {
        defaults: {
          contractVersion: "cortex.analysis-execution-limits.v1",
          analysisConcurrency: 1
        },
        ranges: { analysisConcurrency: { min: 1, max: 8 } }
      }
    },
    stageGraph: {
      REST: [],
      EVALUATION: ["REST"],
      REPORT: ["REST", "EVALUATION"],
      ANALYSIS: ["REPORT"]
    },
    artifactSlots: {
      REST_RESULTS: {
        path: "executions/{execution_id}/rest-results.json",
        contractVersion: "cortex.rest-results.v1"
      },
      RAW_PROMPTFOO_EVIDENCE: {
        path: "executions/{execution_id}/promptfoo-raw.json",
        contractVersion: "promptfoo.0.121.18"
      },
      NORMALIZED_EVAL_RESULTS: {
        path: "executions/{execution_id}/normalized-eval.json",
        contractVersion: "cortex.normalized-eval.v1"
      },
      REPORT_JSON: {
        path: "executions/{execution_id}/report.json",
        contractVersion: "cortex.report.v1"
      },
      REPORT_MARKDOWN: {
        path: "executions/{execution_id}/report.md",
        contractVersion: "cortex.report-markdown.v1"
      },
      ANALYSIS_RESULTS: {
        path: "executions/{execution_id}/analysis-results.json",
        contractVersion: "cortex.analysis-results.v1"
      }
    }
  };
}

describe("Work Package manifest runtime policy", () => {
  it("accepts the deterministic v1 runtime layout", () => {
    const value = manifest();
    expect(validateWorkPackageManifestPolicy(value)).toEqual(value);
    expect(expectedRubricPromptPath("quality")).toBe(rubricPath("quality"));
  });

  it.each([
    ["tests", "canonicalTestsBytes", 1_280 * 1024 * 1024 + 1],
    ["endpoint", "configurationBytes", 8 * 1024 * 1024 + 1],
    ["evaluator", "configurationBytes", 8 * 1024 * 1024 + 1],
    ["analyzer", "configurationBytes", 8 * 1024 * 1024 + 1],
    ["analysisPrompt", "configurationBytes", 8 * 1024 * 1024 + 1],
    ["envExample", "configurationBytes", 8 * 1024 * 1024 + 1]
  ] as const)("rejects oversized %s", (input, _limit, sizeBytes) => {
    const value = manifest();
    value.inputs[input].sizeBytes = sizeBytes;
    expect(() => validateWorkPackageManifestPolicy(value)).toThrow("WORK_PACKAGE_INPUT_TOO_LARGE");
  });

  it("rejects an oversized Rubric Prompt", () => {
    const value = manifest();
    const prompt = value.inputs.rubricPrompts[0];
    if (prompt === undefined) throw new Error("TEST_FIXTURE_INVALID");
    prompt.sizeBytes = 8 * 1024 * 1024 + 1;
    expect(() => validateWorkPackageManifestPolicy(value)).toThrow("WORK_PACKAGE_INPUT_TOO_LARGE");
  });

  it.each([
    ["tests", "tests-copy.json"],
    ["endpoint", "inputs/ENDPOINT.json"],
    ["analysisPrompt", "prompts/other.json"],
    ["envExample", "inputs/env.json"]
  ] as const)("rejects non-deterministic %s path", (input, path) => {
    const value = manifest();
    value.inputs[input].path = path;
    expect(() => validateWorkPackageManifestPolicy(value)).toThrow("WORK_PACKAGE_LAYOUT_INVALID");
  });

  it("rejects a Rubric Prompt path not derived from its key", () => {
    const value = manifest();
    const prompt = value.inputs.rubricPrompts[0];
    if (prompt === undefined) throw new Error("TEST_FIXTURE_INVALID");
    prompt.path = rubricPath("another-key");
    expect(() => validateWorkPackageManifestPolicy(value)).toThrow("WORK_PACKAGE_LAYOUT_INVALID");
  });
});
