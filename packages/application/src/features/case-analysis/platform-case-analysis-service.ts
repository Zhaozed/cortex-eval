import { llmConfigJson } from "@cortex-eval/domain/src/domain-resource-hashes.ts";
import type { DomainJsonObject } from "@cortex-eval/domain/src/domain-canonical-hash.ts";

import type { IdGenerator, Clock } from "../../application-ports.ts";
import { hashAnalysisResult } from "@cortex-eval/domain/src/domain-hash-inputs.ts";
import type { PlatformReportArtifactCaseInput } from "../runs/run-artifact-port.ts";
import type { PlatformReportOverview } from "../reporting/platform-report-service.ts";
import type { AnalysisModelClient } from "./case-analysis-model-client.ts";
import type {
  CurrentCaseAnalysis,
  StoredAnalysisPromptSnapshot,
  StoredAnalyzerSnapshot
} from "./case-analysis-models.ts";
import type { CaseAnalysisTransactionManager } from "./case-analysis-ports.ts";
import type {
  AnalysisCaseFacts,
  FrozenAnalysisExecutionLimits
} from "./case-analysis-input-builder.ts";
import {
  AnalysisEngineError,
  FrozenAnalysisEngine,
  type FrozenAnalysisCaseResult,
  type FrozenAnalysisCaseStart,
  type FrozenAnalysisCaseSource,
  type FrozenAnalysisEngineSummary
} from "./frozen-analysis-engine.ts";
import type { AnalysisSelector } from "@cortex-eval/domain/src/domain-hash-inputs.ts";

/** Read-only complete Report boundary consumed by platform Analysis. */
export interface PlatformAnalysisReportSource {
  readonly get: (runId: string) => Promise<PlatformReportOverview | null>;
  readonly streamCases: (runId: string) => AsyncIterable<PlatformReportArtifactCaseInput>;
}

/** Explicit request that freezes current Analyzer, Prompt, selector and concurrency. */
export interface StartPlatformCaseAnalysisCommand {
  readonly runId: string;
  readonly analyzerConfigId: string;
  readonly analysisPromptId: string;
  readonly selector: AnalysisSelector;
  readonly analysisExecutionLimits: FrozenAnalysisExecutionLimits;
  readonly signal: AbortSignal;
}

/** Stable successful batch summary or precondition conflict. */
export type StartPlatformCaseAnalysisResult =
  | ({ readonly ok: true } & FrozenAnalysisEngineSummary)
  | {
      readonly ok: false;
      readonly error: {
        readonly code:
          | "RUN_NOT_FOUND"
          | "REPORT_RECONCILIATION_FAILED"
          | "CONFIGURATION_NOT_FOUND"
          | "CONFIGURATION_KIND_CONFLICT"
          | "ANALYSIS_STATE_CONFLICT";
      };
    };

/** Explicit dependencies for one platform Analysis lifecycle. */
export interface PlatformCaseAnalysisServiceDependencies {
  readonly transactionManager: CaseAnalysisTransactionManager;
  readonly reports: PlatformAnalysisReportSource;
  readonly modelClient: AnalysisModelClient;
  readonly idGenerator: IdGenerator;
  readonly clock: Clock;
  readonly errorMessage: (code: string) => string;
}

interface FrozenPlatformAnalysisResources {
  readonly analyzer: StoredAnalyzerSnapshot & {
    readonly definition: Parameters<AnalysisModelClient["analyze"]>[0]["analyzer"];
  };
  readonly prompt: StoredAnalysisPromptSnapshot & {
    readonly definition: Parameters<AnalysisModelClient["analyze"]>[0]["prompt"];
  };
}

interface ActivePlatformAnalysis {
  readonly id: string;
  readonly revision: number;
  readonly caseKey: string;
  readonly finalCaseResultHash: string;
  readonly analysisInputHash: string;
}

// Convert one complete Report row into the provider-neutral Analysis source.
function analysisCase(value: PlatformReportArtifactCaseInput): AnalysisCaseFacts {
  return {
    caseKey: value.testCase.caseKey,
    ordinal: value.testCase.ordinal,
    definitionHash: value.testCase.definitionHash,
    definition: value.testCase.definition,
    providerOutput:
      value.rest.status === "SUCCEEDED"
        ? value.rest.providerOutput
        : { ok: false, errorMessage: value.rest.errorMessage },
    evaluation: {
      status: value.evaluation.status,
      finalCaseResultHash: value.evaluation.finalCaseResultHash,
      assertions: value.evaluation.assertions,
      diffs: value.evaluation.diffs
    }
  };
}

// Expose a fresh complete Report pass for both Engine preflight and execution.
function analysisSource(
  reports: PlatformAnalysisReportSource,
  runId: string
): FrozenAnalysisCaseSource {
  return {
    open: async function* (): AsyncGenerator<AnalysisCaseFacts> {
      for await (const value of reports.streamCases(runId)) yield analysisCase(value);
    }
  };
}

// Create one redacted stable Prompt snapshot from a clean current resource.
function promptSnapshot(
  sourceId: string,
  promptHash: string,
  definition: FrozenPlatformAnalysisResources["prompt"]["definition"]
): StoredAnalysisPromptSnapshot {
  return {
    sourceId,
    promptKey: definition.promptKey,
    promptHash,
    snapshot: {
      kind: definition.kind,
      promptKey: definition.promptKey,
      messages: definition.messages.map((message) => ({ ...message }))
    }
  };
}

/** Platform Report-to-current-Analysis orchestration with no transaction around model calls. */
export class PlatformCaseAnalysisService {
  readonly #dependencies: PlatformCaseAnalysisServiceDependencies;

  /** Bind Report, current configuration, model and current Analysis boundaries. */
  public constructor(dependencies: PlatformCaseAnalysisServiceDependencies) {
    this.#dependencies = dependencies;
  }

  /** Read one current Run/Case Analysis. */
  public getCurrent(runId: string, caseKey: string): Promise<CurrentCaseAnalysis | null> {
    return this.#dependencies.transactionManager.execute((transaction) =>
      transaction.analyses.getCurrent(runId, caseKey)
    );
  }

  /** Analyze the explicitly selected Report outcomes and replace only their current records. */
  public async start(
    command: StartPlatformCaseAnalysisCommand
  ): Promise<StartPlatformCaseAnalysisResult> {
    if (command.signal.aborted) throw new Error("REQUEST_ABORTED");
    const report = await this.#dependencies.reports.get(command.runId);
    if (report === null) return { ok: false, error: { code: "RUN_NOT_FOUND" } };
    const run = report.run;
    if (run.reportResultSetHash === null) {
      return { ok: false, error: { code: "REPORT_RECONCILIATION_FAILED" } };
    }
    const resources = await this.#freezeResources(command);
    if (!resources.ok) return resources;
    const active = new Map<string, ActivePlatformAnalysis>();
    const runContext: DomainJsonObject = {
      runId: run.id,
      sourceType: run.sourceType,
      runContextHash: run.runContextHash,
      reportResultSetHash: run.reportResultSetHash
    };
    const engine = new FrozenAnalysisEngine(this.#dependencies.modelClient);
    try {
      const summary = await engine.execute({
        binding: { kind: "RUN", id: run.id },
        source: analysisSource(this.#dependencies.reports, run.id),
        selector: command.selector,
        runContextHash: run.runContextHash,
        runContext,
        analyzer: {
          configHash: resources.value.analyzer.configHash,
          definition: resources.value.analyzer.definition
        },
        prompt: {
          promptHash: resources.value.prompt.promptHash,
          definition: resources.value.prompt.definition
        },
        analysisExecutionLimits: command.analysisExecutionLimits,
        signal: command.signal,
        onCaseStart: (started) =>
          this.#startCase(run.id, started, resources.value, command, active),
        onResult: (result) => this.#completeCase(result, active)
      });
      return { ok: true, ...summary };
    } catch (error) {
      await this.#recoverOwned(active);
      if (
        error instanceof AnalysisEngineError &&
        (error.code === "ANALYSIS_PRECONDITION_FAILED" || error.code === "ANALYSIS_STATE_CONFLICT")
      ) {
        return { ok: false, error: { code: "ANALYSIS_STATE_CONFLICT" } };
      }
      throw error;
    }
  }

  async #freezeResources(command: StartPlatformCaseAnalysisCommand): Promise<
    | { readonly ok: true; readonly value: FrozenPlatformAnalysisResources }
    | {
        readonly ok: false;
        readonly error: {
          readonly code: "CONFIGURATION_NOT_FOUND" | "CONFIGURATION_KIND_CONFLICT";
        };
      }
  > {
    return this.#dependencies.transactionManager.execute(async (transaction) => {
      const [analyzer, prompt] = await Promise.all([
        transaction.configurations.getResource("LLM", command.analyzerConfigId),
        transaction.configurations.getResource("CASE_ANALYSIS_PROMPT", command.analysisPromptId)
      ]);
      if (analyzer === null || prompt === null) {
        return { ok: false, error: { code: "CONFIGURATION_NOT_FOUND" as const } };
      }
      if (analyzer.kind !== "LLM" || prompt.kind !== "CASE_ANALYSIS_PROMPT") {
        return { ok: false, error: { code: "CONFIGURATION_KIND_CONFLICT" as const } };
      }
      return {
        ok: true,
        value: {
          analyzer: {
            sourceId: analyzer.id,
            configHash: analyzer.semanticHash,
            provider: analyzer.definition.providerType,
            model: analyzer.definition.model,
            snapshot: llmConfigJson(analyzer.definition),
            definition: analyzer.definition
          },
          prompt: {
            ...promptSnapshot(prompt.id, prompt.semanticHash, prompt.definition),
            definition: prompt.definition
          }
        }
      };
    });
  }

  async #startCase(
    runId: string,
    started: FrozenAnalysisCaseStart,
    resources: FrozenPlatformAnalysisResources,
    command: StartPlatformCaseAnalysisCommand,
    active: Map<string, ActivePlatformAnalysis>
  ): Promise<void> {
    const claimed = await this.#dependencies.transactionManager.execute(async (transaction) => {
      const current = await transaction.analyses.getCurrent(runId, started.caseKey);
      const replacement = await transaction.analyses.replaceCurrent({
        id: this.#dependencies.idGenerator.nextId(),
        runId,
        caseKey: started.caseKey,
        finalCaseResultHash: started.finalCaseResultHash,
        expectedRevision: current?.revision ?? null,
        prompt: resources.prompt,
        analyzer: resources.analyzer,
        analysisInputHash: started.analysisInputHash,
        analysisExecutionLimits: command.analysisExecutionLimits,
        timestamp: this.#dependencies.clock.now()
      });
      if (!replacement.ok) return null;
      const result = await transaction.analyses.claim(
        replacement.analysis.id,
        replacement.analysis.revision,
        this.#dependencies.clock.now()
      );
      return result.ok ? result.analysis : null;
    });
    if (claimed === null) throw new AnalysisEngineError("ANALYSIS_STATE_CONFLICT");
    active.set(started.caseKey, {
      id: claimed.id,
      revision: claimed.revision,
      caseKey: started.caseKey,
      finalCaseResultHash: started.finalCaseResultHash,
      analysisInputHash: started.analysisInputHash
    });
  }

  async #completeCase(
    value: FrozenAnalysisCaseResult,
    active: Map<string, ActivePlatformAnalysis>
  ): Promise<void> {
    const owner = active.get(value.caseKey);
    if (owner === undefined) throw new AnalysisEngineError("ANALYSIS_RESULT_SINK_FAILED");
    const completed = await this.#dependencies.transactionManager.execute((transaction) =>
      transaction.analyses.complete(
        value.status === "ERROR"
          ? {
              id: owner.id,
              expectedRevision: owner.revision,
              analysisResultHash: value.analysisResultHash,
              result: { status: "ERROR", errorCode: value.errorCode },
              errorMessage: this.#dependencies.errorMessage(value.errorCode),
              timestamp: this.#dependencies.clock.now()
            }
          : {
              id: owner.id,
              expectedRevision: owner.revision,
              analysisResultHash: value.analysisResultHash,
              result: {
                status: "SUCCEEDED",
                output: {
                  classification: value.classification,
                  confidence: value.confidence,
                  evidence: value.evidence,
                  explanation: value.explanation,
                  recommendedAction: value.recommendedAction,
                  ...(value.proposal === null ? {} : { proposal: value.proposal })
                }
              },
              errorMessage: null,
              timestamp: this.#dependencies.clock.now()
            }
      )
    );
    if (!completed.ok) throw new AnalysisEngineError("ANALYSIS_RESULT_SINK_FAILED");
    active.delete(value.caseKey);
  }

  // Settle only invocations claimed by this request; never recover another concurrent batch.
  async #recoverOwned(active: Map<string, ActivePlatformAnalysis>): Promise<void> {
    if (active.size === 0) return;
    const timestamp = this.#dependencies.clock.now();
    const errorCode = "ANALYSIS_STAGE_FAILED";
    const errorMessage = this.#dependencies.errorMessage(errorCode);
    await this.#dependencies.transactionManager.execute(async (transaction) => {
      for (const owner of active.values()) {
        const analysisResultHash = hashAnalysisResult({
          contractVersion: "cortex.analysis-result.v1",
          caseKey: owner.caseKey,
          finalCaseResultHash: owner.finalCaseResultHash,
          analysisInputHash: owner.analysisInputHash,
          result: { status: "ERROR", errorCode }
        });
        await transaction.analyses.complete({
          id: owner.id,
          expectedRevision: owner.revision,
          analysisResultHash,
          result: { status: "ERROR", errorCode },
          errorMessage,
          timestamp
        });
      }
    });
    active.clear();
  }
}
