import { describe, expect, it } from "vitest";
import type { input } from "zod";

import { ExecutionV2Schema, WorkPackageManifestV2Schema } from "../src/work-package-contracts.ts";

const ID = "018f1e2d-3c4b-7abc-8def-0123456789ab";
const HASH = "a".repeat(64);
const TIME = "2026-07-13T01:02:03.004Z";

function file(path: string): { path: string; sha256: string; sizeBytes: number } {
  return { path, sha256: HASH, sizeBytes: 10 };
}

function manifest(): input<typeof WorkPackageManifestV2Schema> {
  return {
    contractVersion: "cortex.work-package-manifest.v2",
    packageId: ID,
    createdAt: TIME,
    sourceSuite: { suiteId: ID, suiteHash: HASH },
    cases: [{ caseKey: "case-1", ordinal: 0, baseDefinitionHash: HASH }],
    inputs: {
      tests: file("inputs/tests.jsonl"),
      endpoint: file("inputs/endpoint.json"),
      evaluator: file("inputs/evaluator.json"),
      analyzer: file("inputs/analyzer.json"),
      rubricPrompts: [
        { promptKey: "rubric-1", promptHash: HASH, ...file("inputs/rubrics/rubric-1.json") }
      ],
      analysisPrompt: {
        promptKey: "analysis-1",
        promptHash: HASH,
        ...file("inputs/analysis-prompt.json")
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
    promptfoo: { version: "0.121.18", generationContractVersion: "cortex.promptfoo-generation.v1" },
    contractVersions: {
      caseDefinition: "cortex.case-definition.v1",
      restResults: "cortex.rest-results-jsonl.v1",
      normalizedEval: "cortex.normalized-eval-jsonl.v1",
      report: "cortex.report.v1",
      analysisInput: "cortex.analysis-input.v1",
      analysisOutput: "cortex.analysis-output.v1"
    },
    requiredEnvKeys: {
      REST: ["ENDPOINT_TOKEN"],
      EVALUATION: ["GEMINI_API_KEY"],
      REPORT: [],
      ANALYSIS: ["ANALYZER_API_KEY"]
    },
    executionLimitPolicy: {
      run: {
        defaults: {
          contractVersion: "cortex.run-execution-limits.v1",
          restConcurrency: 4,
          evalConcurrency: 2
        },
        ranges: { restConcurrency: { min: 1, max: 64 }, evalConcurrency: { min: 1, max: 16 } }
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
        path: "executions/{execution_id}/rest-results.jsonl",
        contractVersion: "cortex.rest-results-jsonl.v1"
      },
      RAW_PROMPTFOO_EVIDENCE: {
        path: "executions/{execution_id}/promptfoo-raw.json",
        contractVersion: "promptfoo.0.121.18"
      },
      NORMALIZED_EVAL_RESULTS: {
        path: "executions/{execution_id}/normalized-eval.jsonl",
        contractVersion: "cortex.normalized-eval-jsonl.v1"
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

describe("Work Package v2", () => {
  it("一次冻结四阶段输入、依赖图和全部产物槽位", () => {
    expect(WorkPackageManifestV2Schema.parse(manifest()).packageId).toBe(ID);
  });

  it("拒绝未知版本、逃逸路径、重复 Case 和展开 Secret", () => {
    const valid = manifest();
    expect(
      WorkPackageManifestV2Schema.safeParse({
        ...valid,
        contractVersion: "cortex.work-package-manifest.v1"
      }).success
    ).toBe(false);
    const firstCase = valid.cases.at(0);
    if (firstCase === undefined) throw new Error("fixture case missing");
    const value = {
      ...valid,
      contractVersion: "cortex.work-package-manifest.v2",
      inputs: { ...valid.inputs, tests: { ...valid.inputs.tests, path: "../tests.json" } },
      cases: [...valid.cases, firstCase],
      apiKey: "secret"
    };
    expect(WorkPackageManifestV2Schema.safeParse(value).success).toBe(false);
  });

  it("拒绝输入文件路径和 Rubric Prompt 身份重复", () => {
    const duplicatePath = manifest();
    duplicatePath.inputs.evaluator.path = duplicatePath.inputs.endpoint.path;
    expect(WorkPackageManifestV2Schema.safeParse(duplicatePath).success).toBe(false);

    const duplicatePrompt = manifest();
    const firstPrompt = duplicatePrompt.inputs.rubricPrompts[0];
    if (firstPrompt === undefined) throw new Error("fixture prompt missing");
    duplicatePrompt.inputs.rubricPrompts.push({
      ...firstPrompt,
      path: "inputs/rubrics/duplicate.json"
    });
    expect(WorkPackageManifestV2Schema.safeParse(duplicatePrompt).success).toBe(false);
  });
});

describe("Execution v2", () => {
  it("冻结身份、限制、上下文哈希、阶段状态和输出文件", () => {
    const value = {
      contractVersion: "cortex.execution.v2",
      packageId: ID,
      executionId: ID,
      createdAt: TIME,
      startedAt: null,
      completedAt: null,
      rerun: { mode: "NEW" },
      runExecutionLimits: {
        contractVersion: "cortex.run-execution-limits.v1",
        restConcurrency: 4,
        evalConcurrency: 2
      },
      analysisExecutionLimits: {
        contractVersion: "cortex.analysis-execution-limits.v1",
        analysisConcurrency: 1
      },
      executionContextHash: HASH,
      stages: {
        REST: {
          status: "PENDING",
          startedAt: null,
          completedAt: null,
          errorCode: null,
          artifacts: []
        },
        EVALUATION: {
          status: "PENDING",
          startedAt: null,
          completedAt: null,
          errorCode: null,
          artifacts: []
        },
        REPORT: {
          status: "PENDING",
          startedAt: null,
          completedAt: null,
          errorCode: null,
          artifacts: []
        },
        ANALYSIS: {
          status: "PENDING",
          startedAt: null,
          completedAt: null,
          errorCode: null,
          artifacts: []
        }
      }
    };
    expect(ExecutionV2Schema.parse(value).executionContextHash).toBe(HASH);
    expect(
      ExecutionV2Schema.safeParse({
        ...value,
        runExecutionLimits: { ...value.runExecutionLimits, restConcurrency: 65 }
      }).success
    ).toBe(false);
    const restArtifact = {
      kind: "REST_RESULTS",
      path: `executions/${ID}/rest-results.jsonl`,
      sha256: HASH,
      sizeBytes: 1,
      contractVersion: "cortex.rest-results-jsonl.v1"
    } as const;
    expect(
      ExecutionV2Schema.safeParse({
        ...value,
        startedAt: TIME,
        stages: {
          ...value.stages,
          REST: {
            status: "RUNNING",
            startedAt: TIME,
            completedAt: null,
            errorCode: null,
            artifacts: [restArtifact]
          }
        }
      }).success
    ).toBe(false);
    expect(
      ExecutionV2Schema.safeParse({
        ...value,
        startedAt: TIME,
        completedAt: TIME,
        stages: {
          ...value.stages,
          REST: {
            status: "ERROR",
            startedAt: TIME,
            completedAt: TIME,
            errorCode: "REST_REQUEST_FAILED",
            artifacts: [restArtifact]
          }
        }
      }).success
    ).toBe(false);
    expect(
      ExecutionV2Schema.safeParse({
        ...value,
        startedAt: TIME,
        stages: {
          ...value.stages,
          EVALUATION: {
            status: "SUCCEEDED",
            startedAt: TIME,
            completedAt: TIME,
            errorCode: null,
            artifacts: [
              {
                kind: "RAW_PROMPTFOO_EVIDENCE",
                path: `executions/${ID}/promptfoo-raw.json`,
                sha256: HASH,
                sizeBytes: 1,
                contractVersion: "promptfoo.0.121.18"
              },
              {
                kind: "NORMALIZED_EVAL_RESULTS",
                path: `executions/${ID}/normalized-eval.jsonl`,
                sha256: HASH,
                sizeBytes: 1,
                contractVersion: "cortex.normalized-eval-jsonl.v1"
              }
            ]
          }
        }
      }).success
    ).toBe(false);
    expect(
      ExecutionV2Schema.safeParse({
        ...value,
        rerun: { mode: "FORCE", sourceExecutionId: ID }
      }).success
    ).toBe(false);
    expect(
      ExecutionV2Schema.safeParse({
        ...value,
        stages: {
          ...value.stages,
          REST: {
            status: "SUCCEEDED",
            startedAt: TIME,
            completedAt: TIME,
            errorCode: null,
            artifacts: [
              {
                kind: "ANALYSIS_RESULTS",
                path: `executions/${ID}/arbitrary.json`,
                sha256: HASH,
                sizeBytes: 1,
                contractVersion: "wrong.version"
              }
            ]
          }
        }
      }).success
    ).toBe(false);
    expect(
      ExecutionV2Schema.safeParse({
        ...value,
        stages: {
          ...value.stages,
          REST: {
            ...value.stages.REST,
            status: "ERROR",
            startedAt: TIME,
            completedAt: TIME,
            errorCode: "TYPO_ERROR"
          }
        }
      }).success
    ).toBe(false);
    expect(
      ExecutionV2Schema.safeParse({
        ...value,
        stages: {
          ...value.stages,
          REST: { ...value.stages.REST, completedAt: TIME }
        }
      }).success
    ).toBe(false);
  });
});
