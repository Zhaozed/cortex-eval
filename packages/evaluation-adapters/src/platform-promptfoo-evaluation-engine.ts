import { createHash, randomBytes } from "node:crypto";

import {
  createFrozenEvaluationContextHash,
  disposeFrozenEvaluationRaw,
  type FrozenEvaluationBinding,
  type FrozenEvaluationCaseInput,
  type FrozenEvaluationCaseSource,
  type FrozenEvaluationEngine,
  type FrozenEvaluationEngineInput,
  type FrozenEvaluationEngineResult,
  type FrozenEvaluationRaw,
  type FrozenEvaluationJsonObject
} from "@cortex-eval/application/src/features/evaluation/frozen-evaluation-engine.ts";
import type {
  PlatformEvaluationEngine,
  PlatformEvaluationEngineInput,
  PlatformEvaluationEngineResult
} from "@cortex-eval/application/src/features/evaluation/platform-evaluation-engine.ts";

import { startEvaluatorBridgeV2, type EvaluatorModelClient } from "./evaluator-bridge-v2.ts";
import { createFrozenEvaluatorModelClient } from "./frozen-evaluator-model-client.ts";
import {
  countPromptfooCaseEvaluatorCalls,
  DEFAULT_BRIDGE_CAPABILITY_ENV_KEY,
  materializePromptfooTest,
  materializePromptfooConfigV1,
  type MaterializedPromptfooConfigV1,
  type MaterializePromptfooConfigV1Input,
  type PromptfooMaterializationCase
} from "./promptfoo-config-materializer.ts";
import {
  runPromptfooEvaluationProcess,
  type PromptfooConfigByteSource
} from "./promptfoo-evaluation-process.ts";

/** Explicit dependencies for the shared frozen Promptfoo engine. */
export interface FrozenPromptfooEvaluationEngineOptions {
  /** Absolute fixed Promptfoo executable path. */
  readonly promptfooBinary: string;
  /** Controlled parent for disposable process directories. */
  readonly temporaryParent: string;
  /** Explicit project root containing the disposable parent. */
  readonly temporaryContainmentRoot: string;
  /** Whole Promptfoo process timeout. */
  readonly promptfooTimeoutMs: number;
  /** Semantic identity of the locked Assertion capability matrix. */
  readonly capabilityMatrixHash: string;
  /** Matrix projection deciding which Assertion instances call Evaluator. */
  readonly requiresEvaluator: (assertionType: string) => boolean;
  /** Read one provider Secret at the infrastructure boundary. */
  readonly readSecret: (envKey: string) => string | undefined;
  /** Generate one UUIDv7 Bridge call identity. */
  readonly createCallId: () => string;
  /** Optional cryptographically random raw Capability source. */
  readonly createRawCapability?: (() => string) | undefined;
  /** Optional wall-clock source for capability expiry. */
  readonly now?: (() => Date) | undefined;
  /** Optional monotonic-enough duration source. */
  readonly nowMilliseconds?: (() => number) | undefined;
  /** Optional frozen model seam for deterministic integration tests. */
  readonly createEvaluatorClient?:
    ((input: FrozenEvaluationEngineInput) => EvaluatorModelClient) | undefined;
}

/** Platform construction uses the same fixed external dependencies. */
export type PlatformPromptfooEvaluationEngineOptions = FrozenPromptfooEvaluationEngineOptions;

type EvaluatorBinding = MaterializePromptfooConfigV1Input["binding"];
// Convert the internal owner identity to the frozen Bridge/config contract.
function evaluatorBinding(binding: FrozenEvaluationBinding): EvaluatorBinding {
  return binding.kind === "RUN"
    ? { kind: "RUN", runId: binding.id }
    : { kind: "EXECUTION", executionId: binding.id };
}

// Validate one joined input and convert it to the controlled Promptfoo generator shape.
function materializationCase(
  input: FrozenEvaluationCaseInput,
  previousOrdinal: number
): PromptfooMaterializationCase {
  const { testCase, restResult } = input;
  if (
    restResult.ordinal <= previousOrdinal ||
    testCase.caseKey !== restResult.caseKey ||
    testCase.ordinal !== restResult.ordinal ||
    testCase.definitionHash !== restResult.caseDefinitionHash
  ) {
    throw new Error("PROMPTFOO_ENGINE_REST_ALIGNMENT");
  }
  return {
    testCase,
    restResult:
      restResult.status === "SUCCEEDED"
        ? { status: "SUCCEEDED", providerOutput: restResult.providerOutput }
        : { status: "ERROR" }
  };
}

interface EvaluationCaseScan {
  /** Number of joined rows in the immutable source. */
  readonly rowCount: number;
  /** Number of REST-success rows that become Promptfoo tests. */
  readonly evaluableCount: number;
  /** Exact maximum Evaluator call count. */
  readonly evaluatorCallBudget: number;
}

// Re-read mutable cancellation state after asynchronous source passes.
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

// Preflight one complete source pass while retaining only scalar facts.
async function scanEvaluationCases(
  source: FrozenEvaluationCaseSource,
  requiresEvaluator: (assertionType: string) => boolean,
  signal: AbortSignal
): Promise<EvaluationCaseScan> {
  let previousOrdinal = -1;
  let rowCount = 0;
  let evaluableCount = 0;
  let evaluatorCallBudget = 0;
  for await (const raw of source.open()) {
    if (signal.aborted) throw new Error("PROMPTFOO_PROCESS_CANCELLED");
    const item = materializationCase(raw, previousOrdinal);
    previousOrdinal = item.testCase.ordinal;
    rowCount += 1;
    if (item.restResult.status === "SUCCEEDED") evaluableCount += 1;
    evaluatorCallBudget += countPromptfooCaseEvaluatorCalls(item, requiresEvaluator);
  }
  return { rowCount, evaluableCount, evaluatorCallBudget };
}

// Return one synthetic fixed-version empty result when no REST Case can be evaluated.
function emptyPromptfooRaw(): FrozenEvaluationJsonObject {
  return { results: { version: 3, results: [] } };
}

/** Shared Promptfoo/Bridge engine for platform Run and offline Execution bindings. */
export class FrozenPromptfooEvaluationEngine implements FrozenEvaluationEngine {
  /** Frozen construction options. */
  readonly #options: FrozenPromptfooEvaluationEngineOptions;

  /** Bind fixed process, matrix and secret boundaries. */
  public constructor(options: FrozenPromptfooEvaluationEngineOptions) {
    if (
      !/^[0-9a-f]{64}$/.test(options.capabilityMatrixHash) ||
      !Number.isInteger(options.promptfooTimeoutMs) ||
      options.promptfooTimeoutMs < 100
    ) {
      throw new Error("PROMPTFOO_ENGINE_OPTIONS_INVALID");
    }
    this.#options = options;
  }

  /** Execute one frozen Evaluation through the exact Promptfoo version. */
  public async execute(input: FrozenEvaluationEngineInput): Promise<FrozenEvaluationEngineResult> {
    if (input.signal.aborted) throw new Error("PROMPTFOO_PROCESS_CANCELLED");
    const scan = await scanEvaluationCases(
      input.caseSource,
      this.#options.requiresEvaluator,
      input.signal
    );
    const evaluatorCallBudget = scan.evaluatorCallBudget;
    const evaluationContextHash = createFrozenEvaluationContextHash({
      binding: input.binding,
      executionContextHash: input.executionContextHash,
      restResultSetHash: input.restResultSetHash,
      evaluatorConfigHash: input.evaluator.configHash,
      promptfooVersion: input.promptfooVersion,
      capabilityMatrixHash: this.#options.capabilityMatrixHash,
      evaluatorCallBudget
    });
    const binding = evaluatorBinding(input.binding);
    const rubricPrompts = input.rubricPrompts.map((item) => ({
      promptKey: item.definition.promptKey,
      messages: item.definition.messages
    }));
    if (scan.evaluableCount === 0) {
      const generated = this.#materializeConfig({
        binding,
        evaluationContextHash,
        bridgeUrl: "http://127.0.0.1:1/evaluate",
        cases: [],
        rubricPrompts
      });
      if (isAborted(input.signal)) throw new Error("PROMPTFOO_PROCESS_CANCELLED");
      return {
        promptfooVersion: "0.121.18",
        exitCode: 0,
        durationMs: 0,
        raw: emptyPromptfooRaw(),
        rubricPromptMaterializations: generated.rubricPromptMaterializations,
        evaluationContextHash
      };
    }

    const now = this.#options.now ?? ((): Date => new Date());
    const nowMilliseconds = this.#options.nowMilliseconds ?? Date.now;
    const rawCapability =
      this.#options.createRawCapability?.() ?? randomBytes(32).toString("base64url");
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(rawCapability)) {
      throw new Error("PROMPTFOO_ENGINE_CAPABILITY_INVALID");
    }
    const capabilityHash = createHash("sha256").update(rawCapability).digest("hex");
    const evaluator =
      evaluatorCallBudget === 0
        ? {
            generate: (): Promise<never> =>
              Promise.reject(new Error("PROMPTFOO_ENGINE_UNEXPECTED_EVALUATOR_CALL"))
          }
        : (this.#options.createEvaluatorClient?.(input) ??
          createFrozenEvaluatorModelClient({
            config: input.evaluator.definition,
            readSecret: this.#options.readSecret
          }));
    const startedAt = nowMilliseconds();
    const expiresAt = new Date(now().getTime() + this.#options.promptfooTimeoutMs).toISOString();
    const bridge = await startEvaluatorBridgeV2({
      rawCapability,
      capability: {
        contractVersion: "cortex.evaluator-bridge-capability.v2",
        capabilityHash,
        binding,
        evaluationContextHash,
        evaluatorConfigHash: input.evaluator.configHash,
        maxCalls: evaluatorCallBudget,
        maxConcurrency: input.evalConcurrency,
        timeoutMs: input.evaluator.definition.timeoutMs,
        expiresAt
      },
      evaluator,
      now,
      createCallId: this.#options.createCallId
    });
    let transferredRaw: FrozenEvaluationRaw | undefined;
    let closeAttempted = false;
    try {
      const generated = this.#materializeConfig({
        binding,
        evaluationContextHash,
        bridgeUrl: bridge.url,
        cases: [],
        rubricPrompts
      });
      const config = this.#streamConfig(
        input.caseSource,
        generated.config,
        generated.rubricPromptMaterializations,
        scan,
        input.signal
      );
      const elapsedBeforeProcess = Math.max(0, nowMilliseconds() - startedAt);
      const remainingProcessTimeout = Math.floor(
        this.#options.promptfooTimeoutMs - elapsedBeforeProcess
      );
      if (remainingProcessTimeout < 1) throw new Error("PROMPTFOO_PROCESS_TIMEOUT");
      const processResult = await runPromptfooEvaluationProcess({
        promptfooBinary: this.#options.promptfooBinary,
        config,
        capabilityEnvKey: DEFAULT_BRIDGE_CAPABILITY_ENV_KEY,
        rawCapability,
        temporaryContainmentRoot: this.#options.temporaryContainmentRoot,
        temporaryParent: this.#options.temporaryParent,
        timeoutMs: remainingProcessTimeout,
        signal: input.signal
      });
      transferredRaw = processResult.raw;
      const result: FrozenEvaluationEngineResult = {
        promptfooVersion: processResult.promptfooVersion,
        exitCode: processResult.exitCode,
        durationMs: Math.max(0, nowMilliseconds() - startedAt),
        raw: processResult.raw,
        rubricPromptMaterializations: generated.rubricPromptMaterializations,
        evaluationContextHash
      };
      closeAttempted = true;
      try {
        await bridge.close();
      } catch (error) {
        await disposeFrozenEvaluationRaw(processResult.raw);
        throw error;
      }
      return result;
    } catch (error) {
      if (!closeAttempted) {
        if (transferredRaw !== undefined) await disposeFrozenEvaluationRaw(transferredRaw);
        await bridge.close().catch(() => undefined);
      }
      throw error;
    }
  }

  // Re-open the immutable source and serialize each Promptfoo test with bounded memory.
  #streamConfig(
    source: FrozenEvaluationCaseSource,
    base: MaterializedPromptfooConfigV1,
    rubricPromptMaterializations: Readonly<Record<string, string>>,
    expected: EvaluationCaseScan,
    signal: AbortSignal
  ): PromptfooConfigByteSource {
    const requiresEvaluator = this.#options.requiresEvaluator;
    return {
      kind: "PROMPTFOO_CONFIG_BYTE_SOURCE",
      openBytes: async function* (): AsyncGenerator<Uint8Array> {
        const prefix =
          `{"prompts":${JSON.stringify(base.prompts)},` +
          `"providers":${JSON.stringify(base.providers)},` +
          `"defaultTest":${JSON.stringify(base.defaultTest)},"tests":[`;
        yield Buffer.from(prefix, "utf8");
        let previousOrdinal = -1;
        let rowCount = 0;
        let evaluableCount = 0;
        let evaluatorCallBudget = 0;
        for await (const raw of source.open()) {
          if (signal.aborted) throw new Error("PROMPTFOO_PROCESS_CANCELLED");
          const item = materializationCase(raw, previousOrdinal);
          previousOrdinal = item.testCase.ordinal;
          rowCount += 1;
          evaluatorCallBudget += countPromptfooCaseEvaluatorCalls(item, requiresEvaluator);
          const test = materializePromptfooTest(item, rubricPromptMaterializations);
          if (test === null) continue;
          if (evaluableCount > 0) yield Buffer.from(",", "utf8");
          yield Buffer.from(JSON.stringify(test), "utf8");
          evaluableCount += 1;
        }
        if (
          rowCount !== expected.rowCount ||
          evaluableCount !== expected.evaluableCount ||
          evaluatorCallBudget !== expected.evaluatorCallBudget
        ) {
          throw new Error("PROMPTFOO_ENGINE_SOURCE_CHANGED");
        }
        yield Buffer.from("]}\n", "utf8");
      }
    };
  }

  // Centralize generation so skipped and executed paths use the same exact contract.
  #materializeConfig(
    input: Omit<MaterializePromptfooConfigV1Input, "bridgeCapabilityEnvKey" | "requiresEvaluator">
  ): ReturnType<typeof materializePromptfooConfigV1> {
    return materializePromptfooConfigV1({
      ...input,
      bridgeCapabilityEnvKey: DEFAULT_BRIDGE_CAPABILITY_ENV_KEY,
      requiresEvaluator: this.#options.requiresEvaluator
    });
  }
}

/** P6-compatible platform adapter that projects one immutable Run to the shared engine. */
export class PlatformPromptfooEvaluationEngine implements PlatformEvaluationEngine {
  /** Shared frozen engine. */
  readonly #engine: FrozenPromptfooEvaluationEngine;

  /** Bind fixed process, matrix and secret boundaries. */
  public constructor(options: PlatformPromptfooEvaluationEngineOptions) {
    this.#engine = new FrozenPromptfooEvaluationEngine(options);
  }

  /** Validate platform-only owner facts, then execute through the shared engine. */
  public execute(input: PlatformEvaluationEngineInput): Promise<PlatformEvaluationEngineResult> {
    if (
      input.run.id !== input.run.artifactManifest.owner.id ||
      input.run.resultSetHash !== input.restResultSetHash
    ) {
      return Promise.reject(new Error("PROMPTFOO_ENGINE_CONTEXT_INVALID"));
    }
    const caseSource: FrozenEvaluationCaseSource = {
      open: async function* (): AsyncGenerator<FrozenEvaluationCaseInput> {
        let previousOrdinal = -1;
        for (const result of input.restResults) {
          const testCase = input.run.suite.cases[result.ordinal];
          if (
            result.ordinal <= previousOrdinal ||
            testCase?.caseKey !== result.caseKey ||
            testCase.definitionHash !== result.caseDefinitionHash
          ) {
            throw new Error("PROMPTFOO_ENGINE_REST_ALIGNMENT");
          }
          previousOrdinal = result.ordinal;
          yield await Promise.resolve({
            testCase,
            restResult:
              result.status === "SUCCEEDED"
                ? {
                    caseKey: result.caseKey,
                    ordinal: result.ordinal,
                    caseDefinitionHash: result.caseDefinitionHash,
                    status: "SUCCEEDED",
                    providerOutput: result.providerOutput
                  }
                : {
                    caseKey: result.caseKey,
                    ordinal: result.ordinal,
                    caseDefinitionHash: result.caseDefinitionHash,
                    status: "ERROR",
                    providerOutput: null
                  }
          });
        }
      }
    };
    return this.#engine.execute({
      binding: { kind: "RUN", id: input.run.id },
      executionContextHash: input.run.runContextHash,
      caseSource,
      evaluator: input.run.evaluator,
      rubricPrompts: input.run.rubricPrompts,
      promptfooVersion: input.run.promptfooVersion,
      evalConcurrency: input.run.runExecutionLimits.evalConcurrency,
      restResultSetHash: input.restResultSetHash,
      signal: input.signal
    });
  }
}
