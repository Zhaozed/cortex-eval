import { createHash } from "node:crypto";

import {
  CaseDefinitionV1Schema,
  type CaseDefinitionV1
} from "@cortex-eval/contracts/src/case-contracts.ts";
import {
  DEFAULT_ANALYSIS_EXECUTION_LIMITS_V1,
  DEFAULT_RUN_EXECUTION_LIMITS_V1
} from "@cortex-eval/contracts/src/execution-limit-contracts.ts";
import {
  EndpointConfigV1Schema,
  LlmConfigV1Schema,
  type EndpointConfigV1,
  type LlmConfigV1
} from "@cortex-eval/contracts/src/provider-contracts.ts";
import {
  AnalysisPromptDefinitionV1Schema,
  PromptDefinitionV1Schema,
  type AnalysisPromptDefinitionV1,
  type PromptDefinitionV1
} from "@cortex-eval/contracts/src/resource-api-contracts.ts";
import type { WorkPackageManifestV2 } from "@cortex-eval/contracts/src/work-package-contracts.ts";
import { WORK_PACKAGE_RUNTIME_LIMITS } from "@cortex-eval/contracts/src/work-package-runtime-contracts.ts";

import {
  type ImmutableFileExpectation,
  type SecureWorkPackageDirectory
} from "./secure-work-package-directory.ts";
import {
  expectedRubricPromptPath,
  validateWorkPackageManifestPolicy
} from "./work-package-manifest-policy.ts";

interface HashedDefinition<Value> {
  readonly semanticHash: string;
  readonly definition: Value;
}

/** Pure semantic Hash boundary supplied by the Application composition root. */
export interface RubricPromptSetHasher {
  /** Hash the exact referenced Prompt facts in Prompt Key order. */
  readonly hash: (
    prompts: readonly { readonly promptKey: string; readonly promptHash: string }[]
  ) => string;
}

/** One ordered source Case and its platform Base Definition Hash. */
export interface WorkPackageExportCase {
  /** Complete versioned Case definition. */
  readonly definition: CaseDefinitionV1;
  /** Platform semantic hash used for later import alignment. */
  readonly baseDefinitionHash: string;
}

/** Complete cleaned source facts needed to assemble immutable v1 inputs. */
export interface WorkPackageInputAssembly {
  /** New immutable Package identity. */
  readonly packageId: string;
  /** Snapshot creation timestamp. */
  readonly createdAt: string;
  /** Frozen Suite identity, Hash and expected Case count. */
  readonly sourceSuite: {
    readonly suiteId: string;
    readonly suiteHash: string;
    readonly caseCount: number;
  };
  /** Backpressure-aware Cases in exact Ordinal order. */
  readonly cases: AsyncIterable<WorkPackageExportCase>;
  /** Frozen Endpoint definition and semantic Hash. */
  readonly endpoint: HashedDefinition<EndpointConfigV1>;
  /** Frozen Evaluator definition and semantic Hash. */
  readonly evaluator: HashedDefinition<LlmConfigV1>;
  /** Frozen Analyzer definition and semantic Hash. */
  readonly analyzer: HashedDefinition<LlmConfigV1>;
  /** Rubric Prompt candidates frozen at snapshot start; only referenced entries are exported. */
  readonly rubricPrompts: readonly HashedDefinition<PromptDefinitionV1>[];
  /** Domain-owned pure Rubric Prompt set Hash adapter. */
  readonly rubricPromptSetHasher: RubricPromptSetHasher;
  /** Frozen Analysis Prompt. */
  readonly analysisPrompt: HashedDefinition<AnalysisPromptDefinitionV1>;
  /** Optional transport cancellation. */
  readonly signal?: AbortSignal | undefined;
}

function writerNonce(nonce: string, role: string): string {
  return createHash("sha256").update(`${nonce}:${role}`).digest("hex");
}

function requireActive(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new Error("REQUEST_ABORTED");
}

async function writeJson(
  directory: SecureWorkPackageDirectory,
  path: string,
  value: unknown,
  nonce: string
): Promise<ImmutableFileExpectation> {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (bytes.byteLength > WORK_PACKAGE_RUNTIME_LIMITS.configurationBytes) {
    throw new Error("WORK_PACKAGE_INPUT_TOO_LARGE");
  }
  const writer = await directory.createComputedFileWriter(
    path,
    WORK_PACKAGE_RUNTIME_LIMITS.configurationBytes,
    writerNonce(nonce, path)
  );
  await writer.append(bytes);
  return (await writer.commit()).integrity;
}

function collectPromptReferences(
  assertions: CaseDefinitionV1["assert"],
  result: Set<string>
): void {
  for (const assertion of assertions) {
    if (assertion.rubricPrompt !== undefined) {
      result.add(assertion.rubricPrompt.slice("prompt://".length));
    }
    if (assertion.assert !== undefined) collectPromptReferences(assertion.assert, result);
  }
}

function llmEnvKeys(value: LlmConfigV1): readonly string[] {
  if (value.providerType === "GOOGLE_GEMINI") return [value.apiKey.envKey];
  return value.auth.kind === "BEARER_ENV" ? [value.auth.secret.envKey] : [];
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function envExample(required: WorkPackageManifestV2["requiredEnvKeys"]): Buffer {
  const keys = sortedUnique(Object.values(required).flat());
  return Buffer.from(keys.map((key) => `${key}=\n`).join(""), "utf8");
}

function staticManifestFields(): Pick<
  WorkPackageManifestV2,
  "promptfoo" | "contractVersions" | "stageGraph" | "artifactSlots"
> {
  return {
    promptfoo: {
      version: "0.121.18",
      generationContractVersion: "cortex.promptfoo-generation.v1"
    },
    contractVersions: {
      caseDefinition: "cortex.case-definition.v1",
      restResults: "cortex.rest-results-jsonl.v1",
      normalizedEval: "cortex.normalized-eval-jsonl.v1",
      report: "cortex.report.v1",
      analysisInput: "cortex.analysis-input.v1",
      analysisOutput: "cortex.analysis-output.v1"
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

/** Assemble complete immutable v2 inputs without retaining the Tests file in memory. */
export async function assembleWorkPackageInputs(
  directory: SecureWorkPackageDirectory,
  source: WorkPackageInputAssembly,
  nonce: string
): Promise<WorkPackageManifestV2> {
  const endpoint = EndpointConfigV1Schema.parse(source.endpoint.definition);
  const evaluator = LlmConfigV1Schema.parse(source.evaluator.definition);
  const analyzer = LlmConfigV1Schema.parse(source.analyzer.definition);
  const analysisPrompt = AnalysisPromptDefinitionV1Schema.parse(source.analysisPrompt.definition);
  const promptCandidates = source.rubricPrompts
    .map((prompt) => ({
      semanticHash: prompt.semanticHash,
      definition: PromptDefinitionV1Schema.parse(prompt.definition)
    }))
    .sort((left, right) => left.definition.promptKey.localeCompare(right.definition.promptKey));
  if (
    new Set(promptCandidates.map((prompt) => prompt.definition.promptKey)).size !==
    promptCandidates.length
  ) {
    throw new Error("WORK_PACKAGE_INVALID");
  }

  const testsWriter = await directory.createComputedFileWriter(
    "inputs/tests.jsonl",
    WORK_PACKAGE_RUNTIME_LIMITS.canonicalTestsBytes,
    writerNonce(nonce, "tests")
  );
  const manifestCases: WorkPackageManifestV2["cases"] = [];
  const caseKeys = new Set<string>();
  const referencedPrompts = new Set<string>();
  try {
    for await (const item of source.cases) {
      requireActive(source.signal);
      const definition = CaseDefinitionV1Schema.parse(item.definition);
      const ordinal = manifestCases.length;
      const caseBytes = Buffer.from(`${JSON.stringify(definition)}\n`, "utf8");
      if (caseBytes.byteLength > WORK_PACKAGE_RUNTIME_LIMITS.canonicalCaseBytes + 1) {
        throw new Error("WORK_PACKAGE_INVALID");
      }
      if (caseKeys.has(definition.metadata.case_id)) throw new Error("WORK_PACKAGE_INVALID");
      caseKeys.add(definition.metadata.case_id);
      await testsWriter.append(caseBytes);
      manifestCases.push({
        caseKey: definition.metadata.case_id,
        ordinal,
        baseDefinitionHash: item.baseDefinitionHash
      });
      collectPromptReferences(definition.assert, referencedPrompts);
    }
  } catch (error) {
    await testsWriter.abort();
    throw error;
  }
  if (manifestCases.length !== source.sourceSuite.caseCount || manifestCases.length === 0) {
    await testsWriter.abort();
    throw new Error("EXPORT_REVISION_CONFLICT");
  }
  const candidatesByKey = new Map(
    promptCandidates.map((prompt) => [prompt.definition.promptKey, prompt] as const)
  );
  let prompts: typeof promptCandidates;
  try {
    prompts = sortedUnique(referencedPrompts).map((key) => {
      const prompt = candidatesByKey.get(key);
      if (prompt === undefined) throw new Error("RUBRIC_PROMPT_NOT_FOUND");
      return prompt;
    });
  } catch (error) {
    await testsWriter.abort();
    throw error;
  }
  const tests = (await testsWriter.commit()).integrity;

  const endpointFile = await writeJson(directory, "inputs/endpoint.json", endpoint, nonce);
  const evaluatorFile = await writeJson(directory, "inputs/evaluator.json", evaluator, nonce);
  const analyzerFile = await writeJson(directory, "inputs/analyzer.json", analyzer, nonce);
  const analysisPromptFile = await writeJson(
    directory,
    "prompts/analysis.json",
    analysisPrompt,
    nonce
  );
  const rubricPromptFiles = [];
  for (const prompt of prompts) {
    const file = await writeJson(
      directory,
      expectedRubricPromptPath(prompt.definition.promptKey),
      prompt.definition,
      nonce
    );
    rubricPromptFiles.push({
      ...file,
      promptKey: prompt.definition.promptKey,
      promptHash: prompt.semanticHash
    });
  }
  const requiredEnvKeys = {
    REST: sortedUnique(
      Object.values(endpoint.headers).flatMap((header) =>
        header.kind === "ENV_SECRET" ? [header.envKey] : []
      )
    ),
    EVALUATION: sortedUnique(llmEnvKeys(evaluator)),
    REPORT: [] as string[],
    ANALYSIS: sortedUnique(llmEnvKeys(analyzer))
  };
  const envWriter = await directory.createComputedFileWriter(
    ".env.example",
    WORK_PACKAGE_RUNTIME_LIMITS.configurationBytes,
    writerNonce(nonce, "env")
  );
  await envWriter.append(envExample(requiredEnvKeys));
  const envExampleFile = (await envWriter.commit()).integrity;

  const manifest = validateWorkPackageManifestPolicy({
    contractVersion: "cortex.work-package-manifest.v2",
    packageId: source.packageId,
    createdAt: source.createdAt,
    sourceSuite: {
      suiteId: source.sourceSuite.suiteId,
      suiteHash: source.sourceSuite.suiteHash
    },
    cases: manifestCases,
    inputs: {
      tests,
      endpoint: endpointFile,
      evaluator: evaluatorFile,
      analyzer: analyzerFile,
      rubricPrompts: rubricPromptFiles,
      analysisPrompt: {
        ...analysisPromptFile,
        promptKey: analysisPrompt.promptKey,
        promptHash: source.analysisPrompt.semanticHash
      },
      envExample: envExampleFile
    },
    configurationHashes: {
      endpoint: source.endpoint.semanticHash,
      evaluator: source.evaluator.semanticHash,
      analyzer: source.analyzer.semanticHash,
      analysisPrompt: source.analysisPrompt.semanticHash,
      rubricPrompts: source.rubricPromptSetHasher.hash(
        prompts.map((prompt) => ({
          promptKey: prompt.definition.promptKey,
          promptHash: prompt.semanticHash
        }))
      )
    },
    requiredEnvKeys,
    executionLimitPolicy: {
      run: {
        defaults: {
          ...DEFAULT_RUN_EXECUTION_LIMITS_V1,
          restConcurrency: endpoint.defaultConcurrency
        },
        ranges: {
          restConcurrency: { min: 1, max: 64 },
          evalConcurrency: { min: 1, max: 16 }
        }
      },
      analysis: {
        defaults: DEFAULT_ANALYSIS_EXECUTION_LIMITS_V1,
        ranges: { analysisConcurrency: { min: 1, max: 8 } }
      }
    },
    ...staticManifestFields()
  });
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
  if (manifestBytes.byteLength > WORK_PACKAGE_RUNTIME_LIMITS.manifestBytes) {
    throw new Error("WORK_PACKAGE_INVALID");
  }
  requireActive(source.signal);
  await directory.writeImmutableFile(
    "manifest.json",
    manifestBytes,
    writerNonce(nonce, "manifest")
  );
  return manifest;
}
