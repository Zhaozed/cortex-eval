import type {
  FrozenRunEvaluator,
  FrozenRunRubricPrompt
} from "@cortex-eval/application/src/features/runs/platform-run-models.ts";
import type {
  FrozenRunCase,
  FrozenRunEndpoint
} from "@cortex-eval/application/src/features/runs/run-rest-models.ts";
import type {
  FrozenAnalysisAnalyzer,
  FrozenCaseAnalysisPrompt
} from "@cortex-eval/application/src/features/case-analysis/frozen-analysis-engine.ts";
import {
  CaseDefinitionV1Schema,
  type CaseDefinitionV1
} from "@cortex-eval/contracts/src/case-contracts.ts";
import {
  ReportContextV1Schema,
  type ReportContextV1
} from "@cortex-eval/contracts/src/artifact-contracts.ts";
import type { RunExecutionLimitsV1 } from "@cortex-eval/contracts/src/execution-limit-contracts.ts";
import {
  EndpointConfigV1Schema,
  LlmConfigV1Schema
} from "@cortex-eval/contracts/src/provider-contracts.ts";
import {
  AnalysisPromptDefinitionV1Schema,
  PromptDefinitionV1Schema
} from "@cortex-eval/contracts/src/resource-api-contracts.ts";
import type { WorkPackageManifestV2 } from "@cortex-eval/contracts/src/work-package-contracts.ts";
import { WORK_PACKAGE_RUNTIME_LIMITS } from "@cortex-eval/contracts/src/work-package-runtime-contracts.ts";

import { readCanonicalTests } from "./canonical-tests-stream-reader.ts";
import type { SecureWorkPackageDirectory } from "./secure-work-package-directory.ts";

/** Pure Case hash input after transport cleaning. */
export interface WorkPackageCaseDefinitionHashInput {
  /** Frozen hash contract version. */
  readonly contractVersion: "cortex.case-definition.v1";
  /** Stable Case key. */
  readonly caseKey: string;
  /** Complete clean Domain Case definition. */
  readonly definition: FrozenRunCase["definition"];
}

/** Pure Case Definition hash Port implemented by the Domain composition root. */
export interface WorkPackageCaseDefinitionHasher {
  /** Hash one clean Case definition. */
  readonly hash: (input: WorkPackageCaseDefinitionHashInput) => string;
}

/** Frozen non-Secret inputs required by one offline Evaluation stage. */
export interface WorkPackageEvaluationInputs {
  /** Frozen Evaluator configuration and semantic identity. */
  readonly evaluator: FrozenRunEvaluator;
  /** Complete referenced Rubric Prompt set. */
  readonly rubricPrompts: readonly FrozenRunRubricPrompt[];
}

/** Frozen non-Secret inputs required by one offline Analysis stage. */
export interface WorkPackageAnalysisInputs {
  /** Frozen Analyzer configuration and semantic identity. */
  readonly analyzer: FrozenAnalysisAnalyzer;
  /** Frozen Case Analysis Prompt and semantic identity. */
  readonly prompt: FrozenCaseAnalysisPrompt;
}

// Require every recursive Assertion prompt reference to resolve inside the frozen package.
async function validateEvaluationPromptReferences(
  cases: AsyncIterable<FrozenRunCase> | Iterable<FrozenRunCase>,
  promptKeys: ReadonlySet<string>
): Promise<void> {
  const validateAssertions = (assertions: FrozenRunCase["definition"]["assertions"]): void => {
    for (const assertion of assertions) {
      if (assertion.rubricPrompt !== undefined && !promptKeys.has(assertion.rubricPrompt)) {
        throw new Error("WORK_PACKAGE_INVALID");
      }
      if (assertion.assertions !== undefined) validateAssertions(assertion.assertions);
    }
  };
  for await (const testCase of cases) validateAssertions(testCase.definition.assertions);
}

// Map one recursive transport Assertion into its clean Domain form.
function mapAssertion(
  value: CaseDefinitionV1["assert"][number]
): FrozenRunCase["definition"]["assertions"][number] {
  return {
    type: value.type,
    metric: value.metric,
    weight: value.weight ?? 1,
    ...(value.value !== undefined ? { value: value.value } : {}),
    ...(value.threshold !== undefined ? { threshold: value.threshold } : {}),
    ...(value.config !== undefined ? { config: value.config } : {}),
    ...(value.rubricPrompt !== undefined ? { rubricPrompt: value.rubricPrompt } : {}),
    ...(value.transform !== undefined ? { transform: value.transform } : {}),
    ...(value.contextTransform !== undefined ? { contextTransform: value.contextTransform } : {}),
    ...(value.assert !== undefined ? { assertions: value.assert.map(mapAssertion) } : {})
  };
}

// Map one strictly parsed Case DTO into its clean Domain model.
export function workPackageCaseDefinitionFromV1(
  value: CaseDefinitionV1
): FrozenRunCase["definition"] {
  return {
    caseKey: value.metadata.case_id,
    description: value.description,
    threshold: value.threshold,
    task: value.vars.task,
    requestBody: value.vars.request_body,
    metadata: {
      requestId: value.metadata.req_id,
      taskId: value.metadata.task_id,
      businessModule: value.metadata.business_module,
      scenarioTag: value.metadata.scenario_tag
    },
    assertions: value.assert.map(mapAssertion)
  };
}

// Decode one already byte-bounded JSON input before strict schema validation.
function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    throw new Error("WORK_PACKAGE_INVALID", { cause: error });
  }
}

/** Narrow read-only view of immutable inputs inside one locked package session. */
export class WorkPackageInputReader {
  /** Stable package directory. */
  readonly #directory: SecureWorkPackageDirectory;
  /** Fully validated immutable Manifest. */
  readonly #manifest: WorkPackageManifestV2;

  /** Bind one already validated package directory and Manifest. */
  public constructor(directory: SecureWorkPackageDirectory, manifest: WorkPackageManifestV2) {
    this.#directory = directory;
    this.#manifest = manifest;
  }

  /** Exact Case count frozen in the Manifest. */
  public get expectedCaseCount(): number {
    return this.#manifest.cases.length;
  }

  /** Return the frozen Case key at one ordinal without building another identity collection. */
  public expectedCaseKey(ordinal: number): string | null {
    return this.#manifest.cases[ordinal]?.caseKey ?? null;
  }

  /** Return the frozen Secret key names for exactly one current stage. */
  public requiredEnvKeys(stage: "REST" | "EVALUATION" | "REPORT" | "ANALYSIS"): readonly string[] {
    return [...this.#manifest.requiredEnvKeys[stage]];
  }

  /** Stream, clean and hash-align Canonical Cases one at a time. */
  public async *streamCases(
    hasher: WorkPackageCaseDefinitionHasher,
    signal?: AbortSignal
  ): AsyncGenerator<FrozenRunCase> {
    let ordinal = 0;
    const bytes = this.#directory.streamFile(
      this.#manifest.inputs.tests.path,
      WORK_PACKAGE_RUNTIME_LIMITS.canonicalTestsBytes
    );
    for await (const value of readCanonicalTests(
      bytes,
      signal,
      this.#manifest.inputs.tests.sizeBytes
    )) {
      const expected = this.#manifest.cases[ordinal];
      if (expected?.caseKey !== value.metadata.case_id) {
        throw new Error("WORK_PACKAGE_INVALID");
      }
      const definition = workPackageCaseDefinitionFromV1(CaseDefinitionV1Schema.parse(value));
      const definitionHash = hasher.hash({
        contractVersion: "cortex.case-definition.v1",
        caseKey: definition.caseKey,
        definition
      });
      if (definitionHash !== expected.baseDefinitionHash) {
        throw new Error("WORK_PACKAGE_HASH_MISMATCH");
      }
      yield { caseKey: definition.caseKey, ordinal, definitionHash, definition };
      ordinal += 1;
    }
    if (ordinal !== this.#manifest.cases.length) throw new Error("WORK_PACKAGE_INVALID");
  }

  /** Read and clean the frozen Endpoint configuration under its fixed byte limit. */
  public async readEndpoint(): Promise<FrozenRunEndpoint> {
    const bytes = await this.#readVerifiedInput(
      this.#manifest.inputs.endpoint,
      WORK_PACKAGE_RUNTIME_LIMITS.configurationBytes
    );
    try {
      const value = EndpointConfigV1Schema.parse(parseJson(bytes));
      const { contractVersion: _contractVersion, ...definition } = value;
      void _contractVersion;
      return definition;
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === "WORK_PACKAGE_INVALID" || error.message === "WORK_PACKAGE_HASH_MISMATCH")
      ) {
        throw error;
      }
      throw new Error("WORK_PACKAGE_INVALID", { cause: error });
    }
  }

  /** Read and clean the frozen Evaluator and every referenced Rubric Prompt. */
  public async readEvaluationInputs(
    cases: AsyncIterable<FrozenRunCase> | Iterable<FrozenRunCase> = []
  ): Promise<WorkPackageEvaluationInputs> {
    try {
      const evaluatorBytes = await this.#readVerifiedInput(
        this.#manifest.inputs.evaluator,
        WORK_PACKAGE_RUNTIME_LIMITS.configurationBytes
      );
      const evaluatorValue = LlmConfigV1Schema.parse(parseJson(evaluatorBytes));
      const { contractVersion: _evaluatorVersion, ...evaluatorDefinition } = evaluatorValue;
      void _evaluatorVersion;
      const rubricPrompts: FrozenRunRubricPrompt[] = [];
      for (const descriptor of this.#manifest.inputs.rubricPrompts) {
        const promptBytes = await this.#readVerifiedInput(
          descriptor,
          WORK_PACKAGE_RUNTIME_LIMITS.configurationBytes
        );
        const promptValue = PromptDefinitionV1Schema.parse(parseJson(promptBytes));
        if (promptValue.promptKey !== descriptor.promptKey) {
          throw new Error("WORK_PACKAGE_INVALID");
        }
        const { contractVersion: _promptVersion, ...promptDefinition } = promptValue;
        void _promptVersion;
        rubricPrompts.push({
          sourceId: null,
          name: descriptor.promptKey,
          promptHash: descriptor.promptHash,
          definition: promptDefinition
        });
      }
      const inputs = {
        evaluator: {
          sourceId: null,
          name: "work-package-evaluator",
          configHash: this.#manifest.configurationHashes.evaluator,
          definition: evaluatorDefinition
        },
        rubricPrompts
      };
      await validateEvaluationPromptReferences(
        cases,
        new Set(rubricPrompts.map((prompt) => `prompt://${prompt.name}`))
      );
      return inputs;
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === "WORK_PACKAGE_INVALID" || error.message === "WORK_PACKAGE_HASH_MISMATCH")
      ) {
        throw error;
      }
      throw new Error("WORK_PACKAGE_INVALID", { cause: error });
    }
  }

  /** Read and clean the frozen Analyzer and Case Analysis Prompt. */
  public async readAnalysisInputs(): Promise<WorkPackageAnalysisInputs> {
    try {
      const [analyzerBytes, promptBytes] = await Promise.all([
        this.#readVerifiedInput(
          this.#manifest.inputs.analyzer,
          WORK_PACKAGE_RUNTIME_LIMITS.configurationBytes
        ),
        this.#readVerifiedInput(
          this.#manifest.inputs.analysisPrompt,
          WORK_PACKAGE_RUNTIME_LIMITS.configurationBytes
        )
      ]);
      const analyzerValue = LlmConfigV1Schema.parse(parseJson(analyzerBytes));
      const promptValue = AnalysisPromptDefinitionV1Schema.parse(parseJson(promptBytes));
      if (promptValue.promptKey !== this.#manifest.inputs.analysisPrompt.promptKey) {
        throw new Error("WORK_PACKAGE_INVALID");
      }
      const { contractVersion: _analyzerVersion, ...analyzerDefinition } = analyzerValue;
      const { contractVersion: _promptVersion, ...promptDefinition } = promptValue;
      void _analyzerVersion;
      void _promptVersion;
      return {
        analyzer: {
          configHash: this.#manifest.configurationHashes.analyzer,
          definition: analyzerDefinition
        },
        prompt: {
          promptHash: this.#manifest.configurationHashes.analysisPrompt,
          definition: promptDefinition
        }
      };
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === "WORK_PACKAGE_INVALID" || error.message === "WORK_PACKAGE_HASH_MISMATCH")
      ) {
        throw error;
      }
      throw new Error("WORK_PACKAGE_INVALID", { cause: error });
    }
  }

  /** Read and validate the complete safe context embedded in an offline Report. */
  public async readReportContext(
    runContextHash: string,
    runExecutionLimits: RunExecutionLimitsV1,
    cases: AsyncIterable<FrozenRunCase> | Iterable<FrozenRunCase>
  ): Promise<ReportContextV1> {
    const [endpoint, evaluation] = await Promise.all([
      this.readEndpoint(),
      this.readEvaluationInputs(cases)
    ]);
    return ReportContextV1Schema.parse({
      contractVersion: "cortex.report-context.v1",
      runContextHash,
      suite: {
        sourceId: this.#manifest.sourceSuite.suiteId,
        name: null,
        suiteHash: this.#manifest.sourceSuite.suiteHash
      },
      endpoint: {
        sourceId: null,
        name: null,
        configHash: this.#manifest.configurationHashes.endpoint,
        config: { contractVersion: "cortex.endpoint-config.v1", ...endpoint }
      },
      evaluator: {
        sourceId: null,
        name: null,
        configHash: this.#manifest.configurationHashes.evaluator,
        config: { contractVersion: "cortex.llm-config.v1", ...evaluation.evaluator.definition }
      },
      rubricPrompts: evaluation.rubricPrompts.map((prompt) => ({
        sourceId: null,
        promptKey: prompt.definition.promptKey,
        name: null,
        promptHash: prompt.promptHash
      })),
      promptfooVersion: this.#manifest.promptfoo.version,
      runExecutionLimits
    });
  }

  // Revalidate immutable bytes at their consumption boundary after the initial package scan.
  async #readVerifiedInput(
    descriptor: { readonly path: string; readonly sha256: string; readonly sizeBytes: number },
    maximumBytes: number
  ): Promise<Buffer> {
    const bytes = await this.#directory.readFileBounded(descriptor.path, maximumBytes);
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== descriptor.sizeBytes || actualHash !== descriptor.sha256) {
      throw new Error("WORK_PACKAGE_HASH_MISMATCH");
    }
    return bytes;
  }
}
import { createHash } from "node:crypto";
