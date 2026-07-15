import { spawnSync } from "node:child_process";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { cpus, freemem, platform, arch, totalmem, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { FrozenAnalysisVariables } from "@cortex-eval/application/src/features/case-analysis/case-analysis-input-builder.ts";
import {
  disposeFrozenEvaluationRaw,
  isFrozenEvaluationRawSource,
  type FrozenEvaluationCaseInput
} from "@cortex-eval/application/src/features/evaluation/frozen-evaluation-engine.ts";
import type { FrozenRunCase } from "@cortex-eval/application/src/features/runs/run-rest-models.ts";
import {
  ReleaseLiveConfigV1Schema,
  type ReleaseLiveConfigV1
} from "@cortex-eval/contracts/src/release-gate-contracts.ts";
import { caseDefinitionJson } from "@cortex-eval/domain/src/domain-case-projection.ts";
import type { CaseDefinition } from "@cortex-eval/domain/src/domain-evaluation.ts";
import {
  hashCaseDefinition,
  hashRestResultSet
} from "@cortex-eval/domain/src/domain-hash-inputs.ts";
import { hashLlmConfig, hashPrompt } from "@cortex-eval/domain/src/domain-resource-hashes.ts";
import type {
  AnalysisPromptDefinition,
  LlmConfigDefinition,
  PromptDefinition
} from "@cortex-eval/domain/src/domain-resource-models.ts";
import { FrozenPromptfooEvaluationEngine } from "@cortex-eval/evaluation-adapters/src/platform-promptfoo-evaluation-engine.ts";
import {
  PROMPTFOO_CAPABILITY_MATRIX_HASH,
  promptfooAssertionRequiresEvaluator
} from "@cortex-eval/evaluation-adapters/src/promptfoo-capability-projection.ts";
import { createFrozenAnalyzerModelClient } from "@cortex-eval/evaluation-adapters/src/frozen-analyzer-model-client.ts";
import { createFrozenEvaluatorModelClient } from "@cortex-eval/evaluation-adapters/src/frozen-evaluator-model-client.ts";
import type {
  EvaluatorModelClient,
  EvaluatorModelResult
} from "@cortex-eval/evaluation-adapters/src/evaluator-bridge-v2.ts";
import type {
  GeminiAnalyzerSmokeFact,
  GeminiRubricSmokeFact,
  ProductionAuditFact,
  ReleaseEnvironmentFact,
  ReleaseGateDependencies
} from "./release-gate.ts";
import { runRuntimeDoctorWithSmoke } from "./runtime-doctor.ts";

const LIVE_CONFIG_PATH = "tooling/facts/p10-live-gemini.json";
const LIVE_BINDING_ID = "019f0000-0000-7000-8000-000000000001";
const LIVE_CALL_ID = "019f0000-0000-7000-8000-000000000002";
const HASH_A = "a".repeat(64);
const HASH_C = "c".repeat(64);

// Return whether dirty JSON is a plain object before reading audit fields.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Parse one nonnegative advisory count without accepting coercions.
function vulnerabilityCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Parse only aggregate production audit counts and discard advisory bodies. */
export function parseProductionAuditOutput(output: string): ProductionAuditFact {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output) as unknown;
  } catch {
    throw new Error("RELEASE_AUDIT_OUTPUT_INVALID");
  }
  const metadata = isRecord(parsed) && isRecord(parsed.metadata) ? parsed.metadata : null;
  const source =
    metadata !== null && isRecord(metadata.vulnerabilities) ? metadata.vulnerabilities : null;
  if (source === null) throw new Error("RELEASE_AUDIT_OUTPUT_INVALID");
  const low = vulnerabilityCount(source.low);
  const moderate = vulnerabilityCount(source.moderate);
  const high = vulnerabilityCount(source.high);
  const critical = vulnerabilityCount(source.critical);
  if (low === null || moderate === null || high === null || critical === null) {
    throw new Error("RELEASE_AUDIT_OUTPUT_INVALID");
  }
  return {
    command: "pnpm audit --prod --audit-level=high --json --registry=https://registry.npmjs.org",
    vulnerabilities: { low, moderate, high, critical }
  };
}

// Execute the exact production-only audit and preserve a high-vulnerability result for validation.
function auditProductionDependencies(root: string): Promise<ProductionAuditFact> {
  const result = spawnSync(
    "pnpm",
    ["audit", "--prod", "--audit-level=high", "--json", "--registry=https://registry.npmjs.org"],
    {
      cwd: root,
      encoding: "utf8",
      shell: false,
      maxBuffer: 16 * 1024 * 1024
    }
  );
  if (result.error !== undefined || result.signal !== null || result.stdout.trim() === "") {
    throw new Error("RELEASE_AUDIT_UNAVAILABLE");
  }
  const audit = parseProductionAuditOutput(result.stdout);
  if (
    result.status !== 0 &&
    audit.vulnerabilities.high === 0 &&
    audit.vulnerabilities.critical === 0
  ) {
    throw new Error("RELEASE_AUDIT_UNAVAILABLE");
  }
  return Promise.resolve(audit);
}

// Execute a safe version command and return its bounded first line.
function commandVersion(command: string, arguments_: readonly string[]): string {
  const result = spawnSync(command, arguments_, { encoding: "utf8", shell: false });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("RELEASE_ENVIRONMENT_COMMAND_FAILED");
  }
  const version = `${result.stdout}${result.stderr}`.trim().split(/\r?\n/, 1)[0]?.trim();
  if (version === undefined || version === "" || version.length > 256) {
    throw new Error("RELEASE_ENVIRONMENT_COMMAND_FAILED");
  }
  return version;
}

// Read the exact native SQLite version used by the current Node process.
function sqliteVersion(): string {
  const database = new DatabaseSync(":memory:");
  try {
    const row = database.prepare("SELECT sqlite_version() AS version").get() as {
      readonly version?: unknown;
    };
    if (typeof row.version !== "string" || row.version === "") {
      throw new Error("RELEASE_SQLITE_VERSION_INVALID");
    }
    return row.version;
  } finally {
    database.close();
  }
}

// Inspect only the committed package version, never package contents or environment values.
async function promptfooVersion(root: string): Promise<string> {
  const raw = JSON.parse(
    await readFile(resolve(root, "node_modules/promptfoo/package.json"), "utf8")
  ) as unknown;
  if (!isRecord(raw) || typeof raw.version !== "string") {
    throw new Error("RELEASE_PROMPTFOO_VERSION_INVALID");
  }
  return raw.version;
}

// Capture the exact supported host and locked toolchain at release-gate start.
async function collectEnvironment(root: string): Promise<ReleaseEnvironmentFact> {
  return {
    platform: platform(),
    architecture: arch(),
    osVersion: commandVersion("sw_vers", ["-productVersion"]),
    cpu: cpus()[0]?.model ?? "unknown",
    logicalCores: cpus().length,
    totalMemoryBytes: totalmem(),
    freeMemoryBytes: freemem(),
    nodeVersion: process.version.replace(/^v/, ""),
    pnpmVersion: commandVersion("pnpm", ["--version"]),
    sqliteVersion: sqliteVersion(),
    promptfooVersion: await promptfooVersion(root)
  };
}

// Load the one committed, Secret-free live configuration through a strict shared schema.
async function loadLiveConfig(root: string): Promise<ReleaseLiveConfigV1> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(resolve(root, LIVE_CONFIG_PATH), "utf8")) as unknown;
  } catch {
    throw new Error("RELEASE_LIVE_CONFIG_UNAVAILABLE");
  }
  const result = ReleaseLiveConfigV1Schema.safeParse(parsed);
  if (!result.success) throw new Error("RELEASE_LIVE_CONFIG_INVALID");
  return result.data;
}

// Strip the transport contract marker before entering the pure Domain definition.
function llmDefinition(value: ReleaseLiveConfigV1["evaluator"]): LlmConfigDefinition {
  const { contractVersion: _contractVersion, ...definition } = value;
  void _contractVersion;
  return definition;
}

// Strip the transport contract marker before entering the pure Rubric Prompt definition.
function rubricDefinition(value: ReleaseLiveConfigV1["rubricPrompt"]): PromptDefinition {
  const { contractVersion: _contractVersion, ...definition } = value;
  void _contractVersion;
  return definition;
}

// Strip the transport contract marker before entering the pure Analysis Prompt definition.
function analysisDefinition(
  value: ReleaseLiveConfigV1["analysisPrompt"]
): AnalysisPromptDefinition {
  const { contractVersion: _contractVersion, ...definition } = value;
  void _contractVersion;
  return definition;
}

// Build the single immutable llm-rubric Case used only by the release smoke.
function releaseCase(promptKey: string): CaseDefinition {
  return {
    caseKey: "release-live-rubric",
    description: "P10 live rubric",
    threshold: 0,
    task: "release-live",
    requestBody: { input: "release" },
    metadata: {
      requestId: "release-request",
      taskId: "release-task",
      businessModule: "release",
      scenarioTag: "live-smoke"
    },
    assertions: [
      {
        type: "llm-rubric",
        metric: "release-rubric",
        weight: 1,
        rubricPrompt: `prompt://${promptKey}`
      }
    ]
  };
}

// Count only components that prove the expected Promptfoo assertion actually executed.
function rubricComponents(row: unknown): number {
  if (!isRecord(row) || !isRecord(row.gradingResult)) return 0;
  const components = row.gradingResult.componentResults;
  if (!Array.isArray(components)) return 0;
  return components.filter((component) => {
    if (!isRecord(component) || !isRecord(component.assertion)) return false;
    return component.assertion.type === "llm-rubric";
  }).length;
}

// Run one real Promptfoo process whose only Evaluator call uses the frozen Gemini adapter.
async function runRubricSmoke(
  root: string,
  config: ReleaseLiveConfigV1,
  environment: NodeJS.ProcessEnv
): Promise<GeminiRubricSmokeFact> {
  const evaluatorDefinition = llmDefinition(config.evaluator);
  const prompt = rubricDefinition(config.rubricPrompt);
  const definition = releaseCase(prompt.promptKey);
  const definitionHash = hashCaseDefinition({
    contractVersion: "cortex.case-definition.v1",
    caseKey: definition.caseKey,
    definition: caseDefinitionJson(definition)
  });
  const testCase: FrozenRunCase = {
    caseKey: definition.caseKey,
    ordinal: 0,
    definitionHash,
    definition
  };
  const sourceItem: FrozenEvaluationCaseInput = {
    testCase,
    restResult: {
      caseKey: definition.caseKey,
      ordinal: 0,
      caseDefinitionHash: definitionHash,
      status: "SUCCEEDED",
      providerOutput: {
        ok: true,
        taskName: "release-live",
        resolvedConfig: { mode: "smoke" },
        parsedOutput: { status: "success" }
      }
    }
  };
  const temporaryParent = await mkdtemp(join(tmpdir(), "cortex-release-rubric-"));
  let providerAttempts = 0;
  const baseEvaluator = createFrozenEvaluatorModelClient({
    config: evaluatorDefinition,
    readSecret: (key): string | undefined => environment[key]
  });
  const engine = new FrozenPromptfooEvaluationEngine({
    promptfooBinary: resolve(root, "node_modules/.bin/promptfoo"),
    temporaryContainmentRoot: tmpdir(),
    temporaryParent,
    promptfooTimeoutMs: evaluatorDefinition.timeoutMs,
    capabilityMatrixHash: PROMPTFOO_CAPABILITY_MATRIX_HASH,
    requiresEvaluator: promptfooAssertionRequiresEvaluator,
    readSecret: (key): string | undefined => environment[key],
    createCallId: (): string => LIVE_CALL_ID,
    createEvaluatorClient: (): EvaluatorModelClient => ({
      generate: async (request): Promise<EvaluatorModelResult> => {
        providerAttempts += 1;
        return baseEvaluator.generate(request);
      }
    })
  });
  let raw: Awaited<ReturnType<typeof engine.execute>>["raw"] | undefined;
  try {
    const result = await engine.execute({
      binding: { kind: "EXECUTION", id: LIVE_BINDING_ID },
      executionContextHash: HASH_A,
      caseSource: {
        open: async function* (): AsyncGenerator<FrozenEvaluationCaseInput> {
          yield await Promise.resolve(sourceItem);
        }
      },
      evaluator: {
        sourceId: null,
        name: "P10 Live Evaluator",
        configHash: hashLlmConfig({
          contractVersion: "cortex.llm-config.v1",
          config: evaluatorDefinition
        }),
        definition: evaluatorDefinition
      },
      rubricPrompts: [
        {
          sourceId: null,
          name: "P10 Live Rubric",
          promptHash: hashPrompt({
            contractVersion: "cortex.prompt.v1",
            kind: prompt.kind,
            promptKey: prompt.promptKey,
            messages: prompt.messages
          }),
          definition: prompt
        }
      ],
      promptfooVersion: "0.121.18",
      evalConcurrency: 1,
      restResultSetHash: hashRestResultSet({
        contractVersion: "cortex.rest-result-set.v1",
        cases: [{ caseKey: definition.caseKey, ordinal: 0, resultHash: HASH_C }]
      }),
      signal: new AbortController().signal
    });
    raw = result.raw;
    if (!isFrozenEvaluationRawSource(result.raw)) throw new Error("RELEASE_RUBRIC_RAW_INVALID");
    let componentResults = 0;
    for await (const row of result.raw.openRows()) componentResults += rubricComponents(row);
    return {
      provider: "GOOGLE_GEMINI",
      model: evaluatorDefinition.model,
      assertionType: "llm-rubric",
      promptfooVersion: result.promptfooVersion,
      providerAttempts,
      componentResults,
      exitCode: result.exitCode
    };
  } finally {
    if (raw !== undefined) await disposeFrozenEvaluationRaw(raw).catch(() => undefined);
    await rm(temporaryParent, { recursive: true, force: true });
  }
}

// Build a compact six-variable input whose result must contain structured Evidence.
function analysisVariables(): FrozenAnalysisVariables {
  return {
    case_definition: {
      contractVersion: "cortex.case-definition.v1",
      metadata: { case_id: "release-live-analysis" },
      assert: [{ type: "equals", metric: "status", value: "success" }]
    },
    provider_output: { ok: true, parsed_output: { status: "failure" } },
    failed_assertions: [
      { index: 0, type: "equals", metric: "status", status: "FAIL", reason: "mismatch" }
    ],
    expected_actual_diffs: [
      { assertionIndex: 0, expectedConstraint: "success", actual: "failure" }
    ],
    llm_rubric_results: [],
    run_context: { stage: "P10_RELEASE", retries: 0 }
  };
}

// Run exactly one real direct Gemini Analyzer call through the strict JSON-Schema adapter.
async function runAnalyzerSmoke(
  config: ReleaseLiveConfigV1,
  environment: NodeJS.ProcessEnv
): Promise<GeminiAnalyzerSmokeFact> {
  const analyzer = llmDefinition(config.analyzer);
  const client = createFrozenAnalyzerModelClient({
    readSecret: (key): string | undefined => environment[key]
  });
  const result = await client.analyze({
    analyzer,
    prompt: analysisDefinition(config.analysisPrompt),
    variables: analysisVariables(),
    signal: new AbortController().signal
  });
  return {
    provider: "GOOGLE_GEMINI",
    model: analyzer.model,
    providerAttempts: 1,
    outputContractVersion: "cortex.analysis-output.v1",
    structuredEvidenceCount: result.evidence.length
  };
}

/** Compose real release operations without reading Live Secrets until their owned boundary. */
export function createProductionReleaseGateDependencies(root: string): ReleaseGateDependencies {
  const config = loadLiveConfig(root);
  return {
    environment: () => collectEnvironment(root),
    audit: () => auditProductionDependencies(root),
    runtimeDoctor: () => runRuntimeDoctorWithSmoke(root),
    rubric: async () => runRubricSmoke(root, await config, process.env),
    analyzer: async () => runAnalyzerSmoke(await config, process.env)
  };
}
