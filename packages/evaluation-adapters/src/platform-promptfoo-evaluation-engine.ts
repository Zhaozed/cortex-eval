import { createHash, randomBytes } from "node:crypto";

import type {
  PlatformEvaluationEngine,
  PlatformEvaluationEngineInput,
  PlatformEvaluationEngineResult,
  PlatformEvaluationJsonObject
} from "@cortex-eval/application/src/features/evaluation/platform-evaluation-engine.ts";
import { createPlatformEvaluationContextHash } from "@cortex-eval/application/src/features/evaluation/platform-evaluation-engine.ts";
import { JsonObjectSchema } from "@cortex-eval/contracts/src/contracts-primitives.ts";

import { startEvaluatorBridgeV2, type EvaluatorModelClient } from "./evaluator-bridge-v2.ts";
import { createFrozenEvaluatorModelClient } from "./frozen-evaluator-model-client.ts";
import {
  countPromptfooEvaluatorCalls,
  DEFAULT_BRIDGE_CAPABILITY_ENV_KEY,
  materializePromptfooConfigV1,
  type PromptfooMaterializationCase
} from "./promptfoo-config-materializer.ts";
import { runPromptfooEvaluationProcess } from "./promptfoo-evaluation-process.ts";

/** Explicit dependencies for the concrete platform Promptfoo engine. */
export interface PlatformPromptfooEvaluationEngineOptions {
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
    ((input: PlatformEvaluationEngineInput) => EvaluatorModelClient) | undefined;
}

// Convert frozen Run and REST facts into the controlled Promptfoo generator shape.
function materializationCases(
  input: PlatformEvaluationEngineInput
): PromptfooMaterializationCase[] {
  let previousOrdinal = -1;
  return input.restResults.map((result) => {
    const testCase = input.run.suite.cases[result.ordinal];
    if (
      result.ordinal <= previousOrdinal ||
      testCase?.caseKey !== result.caseKey ||
      testCase.ordinal !== result.ordinal ||
      testCase.definitionHash !== result.caseDefinitionHash
    ) {
      throw new Error("PROMPTFOO_ENGINE_REST_ALIGNMENT");
    }
    previousOrdinal = result.ordinal;
    return {
      testCase,
      restResult:
        result.status === "SUCCEEDED"
          ? { status: "SUCCEEDED" as const, providerOutput: result.providerOutput }
          : { status: "ERROR" as const }
    };
  });
}

// Return one synthetic fixed-version empty result when no REST Case can be evaluated.
function emptyPromptfooRaw(): PlatformEvaluationJsonObject {
  return { results: { version: 3, results: [] } };
}

/** Concrete Promptfoo/Bridge engine using one non-persistent Evaluation call lifetime. */
export class PlatformPromptfooEvaluationEngine implements PlatformEvaluationEngine {
  /** Frozen construction options. */
  readonly #options: PlatformPromptfooEvaluationEngineOptions;

  /** Bind fixed process, matrix and secret boundaries. */
  public constructor(options: PlatformPromptfooEvaluationEngineOptions) {
    if (
      !/^[0-9a-f]{64}$/.test(options.capabilityMatrixHash) ||
      !Number.isInteger(options.promptfooTimeoutMs) ||
      options.promptfooTimeoutMs < 100
    ) {
      throw new Error("PROMPTFOO_ENGINE_OPTIONS_INVALID");
    }
    this.#options = options;
  }

  /** Execute one frozen platform Evaluation through the exact Promptfoo version. */
  public async execute(
    input: PlatformEvaluationEngineInput
  ): Promise<PlatformEvaluationEngineResult> {
    if (
      input.run.id !== input.run.artifactManifest.owner.id ||
      input.run.resultSetHash !== input.restResultSetHash
    ) {
      throw new Error("PROMPTFOO_ENGINE_CONTEXT_INVALID");
    }
    const cases = materializationCases(input);
    const evaluatorCallBudget = countPromptfooEvaluatorCalls(
      cases,
      this.#options.requiresEvaluator
    );
    const evaluationContextHash = createPlatformEvaluationContextHash({
      run: input.run,
      restResultSetHash: input.restResultSetHash,
      capabilityMatrixHash: this.#options.capabilityMatrixHash,
      evaluatorCallBudget
    });
    const rubricPrompts = input.run.rubricPrompts.map((item) => ({
      promptKey: item.definition.promptKey,
      messages: item.definition.messages
    }));
    if (cases.every((item) => item.restResult.status === "ERROR")) {
      const generated = materializePromptfooConfigV1({
        binding: { kind: "RUN", runId: input.run.id },
        evaluationContextHash,
        bridgeUrl: "http://127.0.0.1:1/evaluate",
        bridgeCapabilityEnvKey: DEFAULT_BRIDGE_CAPABILITY_ENV_KEY,
        cases,
        rubricPrompts,
        requiresEvaluator: this.#options.requiresEvaluator
      });
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
            config: input.run.evaluator.definition,
            readSecret: this.#options.readSecret
          }));
    const startedAt = nowMilliseconds();
    const expiresAt = new Date(now().getTime() + this.#options.promptfooTimeoutMs).toISOString();
    const bridge = await startEvaluatorBridgeV2({
      rawCapability,
      capability: {
        contractVersion: "cortex.evaluator-bridge-capability.v2",
        capabilityHash,
        binding: { kind: "RUN", runId: input.run.id },
        evaluationContextHash,
        evaluatorConfigHash: input.run.evaluator.configHash,
        maxCalls: evaluatorCallBudget,
        maxConcurrency: input.run.runExecutionLimits.evalConcurrency,
        timeoutMs: input.run.evaluator.definition.timeoutMs,
        expiresAt
      },
      evaluator,
      now,
      createCallId: this.#options.createCallId
    });
    try {
      const generated = materializePromptfooConfigV1({
        binding: { kind: "RUN", runId: input.run.id },
        evaluationContextHash,
        bridgeUrl: bridge.url,
        bridgeCapabilityEnvKey: DEFAULT_BRIDGE_CAPABILITY_ENV_KEY,
        cases,
        rubricPrompts,
        requiresEvaluator: this.#options.requiresEvaluator
      });
      if (generated.evaluatorCallBudget !== evaluatorCallBudget) {
        throw new Error("PROMPTFOO_ENGINE_BUDGET_MISMATCH");
      }
      const elapsedBeforeProcess = Math.max(0, nowMilliseconds() - startedAt);
      const remainingProcessTimeout = Math.floor(
        this.#options.promptfooTimeoutMs - elapsedBeforeProcess
      );
      if (remainingProcessTimeout < 1) throw new Error("PROMPTFOO_PROCESS_TIMEOUT");
      const processResult = await runPromptfooEvaluationProcess({
        promptfooBinary: this.#options.promptfooBinary,
        config: generated.config,
        capabilityEnvKey: DEFAULT_BRIDGE_CAPABILITY_ENV_KEY,
        rawCapability,
        temporaryContainmentRoot: this.#options.temporaryContainmentRoot,
        temporaryParent: this.#options.temporaryParent,
        timeoutMs: remainingProcessTimeout,
        signal: input.signal
      });
      const raw = JsonObjectSchema.parse(processResult.raw);
      return {
        promptfooVersion: processResult.promptfooVersion,
        exitCode: processResult.exitCode,
        durationMs: Math.max(0, nowMilliseconds() - startedAt),
        raw,
        rubricPromptMaterializations: generated.rubricPromptMaterializations,
        evaluationContextHash
      };
    } finally {
      await bridge.close();
    }
  }
}
