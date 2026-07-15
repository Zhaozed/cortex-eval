import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { WorkPackageManifestV1 } from "../../contracts/src/work-package-contracts.ts";
import type { CaseDefinition } from "../../domain/src/domain-evaluation.ts";
import { workPackageCaseDefinitionHasher } from "../src/work-package-domain-hashing.ts";
import { expectedRubricPromptPath } from "../src/work-package-manifest-policy.ts";

/** Stable UUIDv7 shared by Work Package tests. */
export const WORK_PACKAGE_FIXTURE_ID = "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeeee";

/** Optional deterministic fixture variants. */
export interface MaterializeWorkPackageFixtureOptions {
  /** Override the only Case hash for single-Case boundary tests. */
  readonly baseDefinitionHash?: string | undefined;
  /** Environment keys needed by the REST stage. */
  readonly restEnvKeys?: readonly string[] | undefined;
  /** Number of generated ordered Cases. */
  readonly caseCount?: number | undefined;
}

// Compute one lowercase content hash.
function hash(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Materialize one owner-only, input-complete Work Package fixture. */
export async function materializeWorkPackageFixture(
  root: string,
  options: MaterializeWorkPackageFixtureOptions = {}
): Promise<WorkPackageManifestV1> {
  const caseCount = options.caseCount ?? 1;
  if (!Number.isInteger(caseCount) || caseCount < 1 || caseCount > 1_000) {
    throw new Error("WORK_PACKAGE_FIXTURE_CASE_COUNT_INVALID");
  }
  const cases = Array.from({ length: caseCount }, (_, ordinal) => {
    const number = String(ordinal + 1).padStart(4, "0");
    const caseKey = caseCount === 1 ? "case-1" : `case-${number}`;
    const requestId = caseCount === 1 ? "req-1" : `req-${number}`;
    const taskId = caseCount === 1 ? "task-1" : `task-${number}`;
    const definition: CaseDefinition = {
      caseKey,
      description: "fixture",
      threshold: 1,
      task: "reply",
      requestBody: { text: "hello" },
      metadata: {
        requestId,
        taskId,
        businessModule: "fixture",
        scenarioTag: "fixture"
      },
      assertions: [{ type: "equals", metric: "exact", weight: 1, value: "hello" }]
    };
    return {
      definition,
      transport: {
        contractVersion: "cortex.case-definition.v1" as const,
        description: "fixture",
        threshold: 1,
        vars: { task: "reply", request_body: { text: "hello" } },
        metadata: {
          case_id: caseKey,
          req_id: requestId,
          task_id: taskId,
          business_module: "fixture",
          scenario_tag: "fixture"
        },
        assert: [{ type: "equals", metric: "exact", weight: 1, value: "hello" }]
      }
    };
  });
  const files = {
    tests: Buffer.from(`${JSON.stringify(cases.map((item) => item.transport))}\n`),
    endpoint: Buffer.from(
      `${JSON.stringify({
        contractVersion: "cortex.endpoint-config.v1",
        urlTemplate: "https://example.com/evaluate",
        method: "POST",
        headers: { "Content-Type": { kind: "LITERAL", value: "application/json" } },
        bodySelector: "/request_body",
        timeoutMs: 60_000,
        defaultConcurrency: 4
      })}\n`
    ),
    evaluator: Buffer.from(
      `${JSON.stringify({
        contractVersion: "cortex.llm-config.v1",
        providerType: "GOOGLE_GEMINI",
        model: "gemini-2.5-flash",
        apiKey: { kind: "ENV_SECRET", envKey: "GEMINI_API_KEY" },
        thinkingLevel: "OFF",
        temperature: 0,
        topP: 1,
        maxOutputTokens: 1024,
        timeoutMs: 60_000,
        structuredOutput: "JSON_SCHEMA"
      })}\n`
    ),
    analyzer: Buffer.from(
      `${JSON.stringify({
        contractVersion: "cortex.llm-config.v1",
        providerType: "GOOGLE_GEMINI",
        model: "gemini-2.5-flash",
        apiKey: { kind: "ENV_SECRET", envKey: "GEMINI_API_KEY" },
        thinkingLevel: "OFF",
        temperature: 0,
        topP: 1,
        maxOutputTokens: 1024,
        timeoutMs: 60_000,
        structuredOutput: "JSON_SCHEMA"
      })}\n`
    ),
    rubric: Buffer.from(
      `${JSON.stringify({
        contractVersion: "cortex.prompt.v1",
        kind: "LLM_RUBRIC",
        promptKey: "quality",
        messages: [{ role: "USER", content: "Evaluate exactness." }]
      })}\n`
    ),
    analysisPrompt: Buffer.from(
      `${JSON.stringify({
        contractVersion: "cortex.prompt.v1",
        kind: "CASE_ANALYSIS",
        promptKey: "analysis",
        messages: [{ role: "USER", content: "Analyze failures." }]
      })}\n`
    ),
    envExample: Buffer.from("GEMINI_API_KEY=\n")
  } as const;
  const rubricPath = expectedRubricPromptPath("quality");
  const descriptors = {
    tests: {
      path: "inputs/tests.json",
      sha256: hash(files.tests),
      sizeBytes: files.tests.byteLength
    },
    endpoint: {
      path: "inputs/endpoint.json",
      sha256: hash(files.endpoint),
      sizeBytes: files.endpoint.byteLength
    },
    evaluator: {
      path: "inputs/evaluator.json",
      sha256: hash(files.evaluator),
      sizeBytes: files.evaluator.byteLength
    },
    analyzer: {
      path: "inputs/analyzer.json",
      sha256: hash(files.analyzer),
      sizeBytes: files.analyzer.byteLength
    },
    rubric: { path: rubricPath, sha256: hash(files.rubric), sizeBytes: files.rubric.byteLength },
    analysisPrompt: {
      path: "prompts/analysis.json",
      sha256: hash(files.analysisPrompt),
      sizeBytes: files.analysisPrompt.byteLength
    },
    envExample: {
      path: ".env.example",
      sha256: hash(files.envExample),
      sizeBytes: files.envExample.byteLength
    }
  } as const;
  const manifest: WorkPackageManifestV1 = {
    contractVersion: "cortex.work-package-manifest.v1",
    packageId: WORK_PACKAGE_FIXTURE_ID,
    createdAt: "2026-07-14T00:00:00.000Z",
    sourceSuite: { suiteId: WORK_PACKAGE_FIXTURE_ID, suiteHash: hash(files.tests) },
    cases: cases.map((item, ordinal) => ({
      caseKey: item.definition.caseKey,
      ordinal,
      baseDefinitionHash:
        caseCount === 1
          ? (options.baseDefinitionHash ?? "a".repeat(64))
          : workPackageCaseDefinitionHasher.hash({
              contractVersion: "cortex.case-definition.v1",
              caseKey: item.definition.caseKey,
              definition: item.definition
            })
    })),
    inputs: {
      tests: descriptors.tests,
      endpoint: descriptors.endpoint,
      evaluator: descriptors.evaluator,
      analyzer: descriptors.analyzer,
      rubricPrompts: [
        {
          ...descriptors.rubric,
          promptKey: "quality",
          promptHash: descriptors.rubric.sha256
        }
      ],
      analysisPrompt: {
        ...descriptors.analysisPrompt,
        promptKey: "analysis",
        promptHash: descriptors.analysisPrompt.sha256
      },
      envExample: descriptors.envExample
    },
    configurationHashes: {
      endpoint: descriptors.endpoint.sha256,
      evaluator: descriptors.evaluator.sha256,
      analyzer: descriptors.analyzer.sha256,
      analysisPrompt: descriptors.analysisPrompt.sha256,
      rubricPrompts: descriptors.rubric.sha256
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
    requiredEnvKeys: {
      REST: [...(options.restEnvKeys ?? [])],
      EVALUATION: ["GEMINI_API_KEY"],
      REPORT: [],
      ANALYSIS: ["GEMINI_API_KEY"]
    },
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
  await mkdir(join(root, "inputs"), { mode: 0o700 });
  await mkdir(join(root, "prompts", "rubric"), { mode: 0o700, recursive: true });
  await Promise.all([
    writeFile(join(root, descriptors.tests.path), files.tests, { mode: 0o600 }),
    writeFile(join(root, descriptors.endpoint.path), files.endpoint, { mode: 0o600 }),
    writeFile(join(root, descriptors.evaluator.path), files.evaluator, { mode: 0o600 }),
    writeFile(join(root, descriptors.analyzer.path), files.analyzer, { mode: 0o600 }),
    writeFile(join(root, descriptors.rubric.path), files.rubric, { mode: 0o600 }),
    writeFile(join(root, descriptors.analysisPrompt.path), files.analysisPrompt, { mode: 0o600 }),
    writeFile(join(root, descriptors.envExample.path), files.envExample, { mode: 0o600 })
  ]);
  await writeFile(join(root, "manifest.json"), `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  return manifest;
}
