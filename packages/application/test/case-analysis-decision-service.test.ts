import type { AnalysisResultDraft } from "@cortex-eval/domain/src/domain-analysis.ts";
import type { CaseDefinition } from "@cortex-eval/domain/src/domain-evaluation.ts";
import { describe, expect, it } from "vitest";

import type {
  CurrentAnalysisMutationResult,
  CurrentCaseAnalysis,
  RecordProposalApplicationInput
} from "../src/features/case-analysis/case-analysis-models.ts";
import type {
  CaseAnalysisRepository,
  CaseAnalysisTransactionManager
} from "../src/features/case-analysis/case-analysis-ports.ts";
import {
  CaseAnalysisDecisionService,
  type AcceptAnalysisProposalCommand
} from "../src/features/case-analysis/case-analysis-decision-service.ts";
import { CaseDefinitionWriter } from "../src/features/test-suites/case-definition-writer.ts";
import { InMemoryApplicationStore } from "./test-support/in-memory-application-store.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function definition(): CaseDefinition {
  return {
    caseKey: "case-1",
    description: "Case",
    threshold: 1,
    task: "reply",
    requestBody: { input: "hello" },
    metadata: {
      requestId: "req-1",
      taskId: "task-1",
      businessModule: "chat",
      scenarioTag: "normal"
    },
    assertions: [{ type: "equals", metric: "answer", weight: 1, value: "old" }]
  };
}

function analysisOutput(baseDefinitionHash: string): AnalysisResultDraft {
  return {
    classification: "LABEL_ERROR",
    confidence: 0.9,
    evidence: [
      {
        source: "case_definition",
        fieldPath: "/assert/0/value",
        conclusion: "冻结期望值错误"
      }
    ],
    explanation: "Case 标注与业务事实不一致",
    recommendedAction: "新增合法结果断言",
    proposal: {
      action: "ADD_ASSERTION",
      baseDefinitionHash,
      targetAssertionIndex: 1,
      assertion: { type: "equals", metric: "answer", weight: 1, value: "new" }
    }
  };
}

class MemoryAnalysisRepository implements CaseAnalysisRepository {
  public current: CurrentCaseAnalysis;

  public constructor(current: CurrentCaseAnalysis) {
    this.current = current;
  }

  public getImportedRunContext(): Promise<null> {
    return Promise.resolve(null);
  }

  public setImportedAnalysisIdentity(): Promise<boolean> {
    return Promise.resolve(false);
  }

  public getCurrent(runId: string, caseKey: string): Promise<CurrentCaseAnalysis | null> {
    return Promise.resolve(
      this.current.runId === runId && this.current.caseKey === caseKey ? this.current : null
    );
  }

  public rejectProposal(
    id: string,
    expectedRevision: number,
    timestamp: string
  ): Promise<CurrentAnalysisMutationResult> {
    if (id !== this.current.id || expectedRevision !== this.current.revision) {
      return Promise.resolve({
        ok: false,
        reason: "ANALYSIS_REVISION_CONFLICT",
        current: this.current
      });
    }
    this.current = {
      ...this.current,
      revision: expectedRevision + 1,
      decision: "REJECTED",
      updatedAt: timestamp
    };
    return Promise.resolve({ ok: true, analysis: this.current });
  }

  public recordProposalApplication(
    input: RecordProposalApplicationInput
  ): Promise<CurrentAnalysisMutationResult> {
    if (input.id !== this.current.id || input.expectedRevision !== this.current.revision) {
      return Promise.resolve({
        ok: false,
        reason: "ANALYSIS_REVISION_CONFLICT",
        current: this.current
      });
    }
    this.current = {
      ...this.current,
      revision: input.expectedRevision + 1,
      decision: input.decision,
      applyStatus: input.applyStatus,
      appliedDefinitionHash: input.appliedDefinitionHash,
      updatedAt: input.timestamp
    };
    return Promise.resolve({ ok: true, analysis: this.current });
  }

  public replaceCurrent(): Promise<CurrentAnalysisMutationResult> {
    throw new Error("NOT_USED");
  }

  public claim(): Promise<CurrentAnalysisMutationResult> {
    throw new Error("NOT_USED");
  }

  public complete(): Promise<CurrentAnalysisMutationResult> {
    throw new Error("NOT_USED");
  }

  public recoverUnfinished(): Promise<number> {
    throw new Error("NOT_USED");
  }

  public recoverUnfinishedForRun(): Promise<number> {
    throw new Error("NOT_USED");
  }
}

function seedCurrentAnalysis(
  store: InMemoryApplicationStore,
  repository: MemoryAnalysisRepository
): CaseAnalysisTransactionManager {
  return {
    execute: (work) =>
      store.execute((transaction) => work({ ...transaction, analyses: repository }))
  };
}

interface AnalysisDecisionSetup {
  readonly store: InMemoryApplicationStore;
  readonly writer: CaseDefinitionWriter;
  readonly repository: MemoryAnalysisRepository;
  readonly service: CaseAnalysisDecisionService;
  readonly command: AcceptAnalysisProposalCommand;
}

async function setup(): Promise<AnalysisDecisionSetup> {
  const store = InMemoryApplicationStore.withEmptySuite("suite-1");
  store.seedConfiguration({
    kind: "LLM",
    id: "analyzer-1",
    name: "Analyzer",
    semanticHash: HASH_B,
    revision: 0,
    definition: {
      providerType: "OPENAI_COMPATIBLE",
      model: "model",
      thinkingLevel: "OFF",
      temperature: 0,
      topP: 1,
      maxOutputTokens: 1024,
      timeoutMs: 1_000,
      structuredOutput: "JSON_OBJECT",
      baseUrl: "http://127.0.0.1:8080/v1",
      auth: { kind: "NONE" }
    },
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z"
  });
  store.seedConfiguration({
    kind: "CASE_ANALYSIS_PROMPT",
    id: "prompt-1",
    name: "Analysis Prompt",
    semanticHash: HASH_A,
    revision: 0,
    definition: {
      kind: "CASE_ANALYSIS",
      promptKey: "analysis",
      messages: [{ role: "USER", content: "{{case_definition}}" }]
    },
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z"
  });
  const writer = new CaseDefinitionWriter(store.dependencies());
  const created = await writer.createCase({
    suiteId: "suite-1",
    expectedSuiteRevision: 0,
    definition: definition()
  });
  if (!created.ok) throw new Error("TEST_CASE_SETUP_FAILED");
  const output = analysisOutput(created.case.definitionHash);
  const current: CurrentCaseAnalysis = {
    id: "analysis-1",
    runId: "run-1",
    caseKey: "case-1",
    finalCaseResultHash: HASH_C,
    revision: 3,
    prompt: {
      sourceId: "prompt-1",
      promptKey: "analysis",
      promptHash: HASH_A,
      snapshot: {}
    },
    analyzer: {
      sourceId: "analyzer-1",
      configHash: HASH_B,
      provider: "OPENAI_COMPATIBLE",
      model: "model",
      snapshot: {}
    },
    analysisInputContractVersion: "cortex.analysis-input.v1",
    analysisOutputContractVersion: "cortex.analysis-output.v1",
    analysisInputHash: HASH_A,
    analysisExecutionLimits: {
      contractVersion: "cortex.analysis-execution-limits.v1",
      analysisConcurrency: 1
    },
    status: "SUCCEEDED",
    output,
    analysisResultHash: HASH_B,
    decision: "PENDING",
    applyStatus: "NOT_APPLIED",
    baseDefinitionHash: created.case.definitionHash,
    appliedDefinitionHash: null,
    errorCode: null,
    errorMessage: null,
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z"
  };
  const repository = new MemoryAnalysisRepository(current);
  const service = new CaseAnalysisDecisionService({
    transactionManager: seedCurrentAnalysis(store, repository),
    caseWriter: writer,
    clock: store
  });
  const command = {
    runId: "run-1",
    caseKey: "case-1",
    analysisId: "analysis-1",
    expectedAnalysisRevision: 3,
    expectedFinalCaseResultHash: HASH_C,
    expectedAnalysisInputHash: HASH_A,
    expectedPromptHash: HASH_A,
    expectedAnalyzerConfigHash: HASH_B,
    suiteId: "suite-1",
    expectedSuiteRevision: 1,
    expectedCaseId: created.case.id,
    expectedCaseRevision: 0
  };
  return { store, writer, repository, service, command };
}

describe("CaseAnalysisDecisionService", () => {
  it("在同一事务中应用可信 Proposal 并记录新 Case Definition Hash", async () => {
    const { store, repository, service, command } = await setup();
    const result = await service.acceptProposal(command);

    expect(result).toMatchObject({
      ok: true,
      analysis: { decision: "ACCEPTED", applyStatus: "APPLIED", revision: 4 },
      case: { revision: 1, definition: { assertions: [{ value: "old" }, { value: "new" }] } }
    });
    expect(repository.current.appliedDefinitionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(store.snapshot().suites[0]).toMatchObject({ revision: 2 });
  });

  it("Case 或 Prompt 漂移时保存 CONFLICT，不自动 Rebase", async () => {
    const { store, writer, repository, service, command } = await setup();
    await writer.editCase({
      suiteId: "suite-1",
      caseKey: "case-1",
      expectedSuiteRevision: 1,
      expectedCaseRevision: 0,
      definition: { ...definition(), description: "Manual edit" }
    });

    const result = await service.acceptProposal(command);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "ANALYSIS_APPLY_CONFLICT", reason: "CASE_VERSION_CHANGED" },
      analysis: { decision: "ACCEPTED", applyStatus: "CONFLICT", revision: 4 }
    });
    expect(repository.current.appliedDefinitionHash).toBeNull();
    expect(store.snapshot().cases[0]).toMatchObject({ description: "Manual edit", revision: 1 });
  });

  it("拒绝只推进当前 Analysis 决策，不修改 Case", async () => {
    const { store, service, command } = await setup();
    const result = await service.rejectProposal({
      runId: command.runId,
      caseKey: command.caseKey,
      analysisId: command.analysisId,
      expectedAnalysisRevision: command.expectedAnalysisRevision
    });
    expect(result).toMatchObject({
      ok: true,
      analysis: { decision: "REJECTED", applyStatus: "NOT_APPLIED", revision: 4 }
    });
    expect(store.snapshot().cases[0]).toMatchObject({ revision: 0 });
  });

  it("按 Analysis ID、Revision、状态与 Proposal 决策版本拒绝过期操作", async () => {
    const missing = await setup();
    await expect(
      missing.service.rejectProposal({
        ...missing.command,
        runId: "run-missing"
      })
    ).resolves.toEqual({
      ok: false,
      error: { code: "ANALYSIS_NOT_FOUND" },
      analysis: null
    });

    const wrongId = await setup();
    await expect(
      wrongId.service.rejectProposal({
        ...wrongId.command,
        analysisId: "analysis-stale"
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "ANALYSIS_NOT_FOUND" },
      analysis: { id: "analysis-1" }
    });

    const wrongRevision = await setup();
    await expect(
      wrongRevision.service.rejectProposal({
        ...wrongRevision.command,
        expectedAnalysisRevision: 2
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "ANALYSIS_REVISION_CONFLICT", actualRevision: 3 }
    });

    const mutations: readonly ((analysis: CurrentCaseAnalysis) => CurrentCaseAnalysis)[] = [
      (analysis): CurrentCaseAnalysis => ({ ...analysis, status: "RUNNING" }),
      (analysis): CurrentCaseAnalysis => ({ ...analysis, decision: "REJECTED" }),
      (analysis): CurrentCaseAnalysis => ({ ...analysis, applyStatus: "APPLIED" }),
      (analysis): CurrentCaseAnalysis => {
        const currentOutput = analysis.output;
        if (currentOutput === null) return analysis;
        return {
          ...analysis,
          output: {
            classification: currentOutput.classification,
            confidence: currentOutput.confidence,
            evidence: currentOutput.evidence,
            explanation: currentOutput.explanation,
            recommendedAction: currentOutput.recommendedAction
          }
        };
      }
    ];
    for (const mutate of mutations) {
      const current = await setup();
      current.repository.current = mutate(current.repository.current);
      await expect(current.service.rejectProposal(current.command)).resolves.toMatchObject({
        ok: false,
        error: { code: "ANALYSIS_STATE_CONFLICT", actualRevision: 3 }
      });
    }
  });

  it("分别识别冻结结果、Prompt 与 Analyzer 的版本漂移", async () => {
    const scenarios: readonly {
      readonly patch: Partial<AcceptAnalysisProposalCommand>;
      readonly reason:
        "CASE_VERSION_CHANGED" | "PROMPT_VERSION_CHANGED" | "ANALYZER_VERSION_CHANGED";
    }[] = [
      { patch: { expectedFinalCaseResultHash: HASH_A }, reason: "CASE_VERSION_CHANGED" },
      { patch: { expectedAnalysisInputHash: HASH_B }, reason: "CASE_VERSION_CHANGED" },
      { patch: { expectedPromptHash: HASH_B }, reason: "PROMPT_VERSION_CHANGED" },
      { patch: { expectedAnalyzerConfigHash: HASH_A }, reason: "ANALYZER_VERSION_CHANGED" }
    ];
    for (const scenario of scenarios) {
      const current = await setup();
      await expect(
        current.service.acceptProposal({ ...current.command, ...scenario.patch })
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "ANALYSIS_APPLY_CONFLICT", reason: scenario.reason },
        analysis: { applyStatus: "CONFLICT", revision: 4 }
      });
    }

    const missingPrompt = await setup();
    await missingPrompt.store.execute(async (transaction) => {
      await transaction.configurations.deleteResource("CASE_ANALYSIS_PROMPT", "prompt-1", 0);
    });
    await expect(
      missingPrompt.service.acceptProposal(missingPrompt.command)
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "ANALYSIS_APPLY_CONFLICT", reason: "PROMPT_VERSION_CHANGED" }
    });

    const changedPrompt = await setup();
    const prompt = changedPrompt.store
      .snapshot()
      .configurationResources.find((resource) => resource.kind === "CASE_ANALYSIS_PROMPT");
    if (prompt === undefined) throw new Error("TEST_ANALYSIS_PROMPT_NOT_FOUND");
    await changedPrompt.store.execute(async (transaction) => {
      await transaction.configurations.updateResource(
        { ...prompt, semanticHash: HASH_C, revision: 1 },
        0
      );
    });
    await expect(
      changedPrompt.service.acceptProposal(changedPrompt.command)
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "ANALYSIS_APPLY_CONFLICT", reason: "PROMPT_VERSION_CHANGED" }
    });

    const missingAnalyzer = await setup();
    await missingAnalyzer.store.execute(async (transaction) => {
      await transaction.configurations.deleteResource("LLM", "analyzer-1", 0);
    });
    await expect(
      missingAnalyzer.service.acceptProposal(missingAnalyzer.command)
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "ANALYSIS_APPLY_CONFLICT", reason: "ANALYZER_VERSION_CHANGED" }
    });

    const offline = await setup();
    offline.repository.current = {
      ...offline.repository.current,
      prompt: { ...offline.repository.current.prompt, sourceId: null },
      analyzer: { ...offline.repository.current.analyzer, sourceId: null }
    };
    await expect(offline.service.acceptProposal(offline.command)).resolves.toMatchObject({
      ok: true,
      analysis: { decision: "ACCEPTED", applyStatus: "APPLIED" }
    });
  });

  it("对 Suite 与 Case 的每个乐观锁事实独立识别版本冲突", async () => {
    const patches: readonly Partial<AcceptAnalysisProposalCommand>[] = [
      { suiteId: "suite-missing" },
      { expectedSuiteRevision: 0 },
      { expectedCaseId: "case-stale" },
      { expectedCaseRevision: 1 }
    ];
    for (const patch of patches) {
      const current = await setup();
      await expect(
        current.service.acceptProposal({ ...current.command, ...patch })
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "ANALYSIS_APPLY_CONFLICT", reason: "CASE_VERSION_CHANGED" },
        analysis: { decision: "ACCEPTED", applyStatus: "CONFLICT", revision: 4 }
      });
      expect(current.store.snapshot().cases[0]).toMatchObject({ revision: 0 });
    }
  });

  it("验证编辑后 Proposal，并区分 Case、Assert 与 Rubric Prompt 冲突", async () => {
    const invalid = await setup();
    await expect(
      invalid.service.acceptProposal({
        ...invalid.command,
        editedProposal: {
          action: "ADD_ASSERTION",
          baseDefinitionHash: invalid.repository.current.baseDefinitionHash ?? HASH_A,
          targetAssertionIndex: -1,
          assertion: { type: "equals", metric: "answer", weight: 1, value: "new" }
        }
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "ANALYSIS_PROPOSAL_INVALID" },
      analysis: { revision: 3, decision: "PENDING" }
    });

    const baseConflict = await setup();
    await expect(
      baseConflict.service.acceptProposal({
        ...baseConflict.command,
        editedProposal: {
          action: "ADD_ASSERTION",
          baseDefinitionHash: HASH_A,
          targetAssertionIndex: 1,
          assertion: { type: "equals", metric: "answer", weight: 1, value: "new" }
        }
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "ANALYSIS_APPLY_CONFLICT", reason: "CASE_VERSION_CHANGED" },
      analysis: { decision: "EDITED_AND_ACCEPTED", applyStatus: "CONFLICT" }
    });

    const assertionConflict = await setup();
    await expect(
      assertionConflict.service.acceptProposal({
        ...assertionConflict.command,
        editedProposal: {
          action: "REPLACE_ASSERTION",
          baseDefinitionHash: assertionConflict.repository.current.baseDefinitionHash ?? HASH_A,
          targetAssertionIndex: 0,
          targetAssertionDefinitionHash: HASH_A,
          assertion: { type: "equals", metric: "answer", weight: 1, value: "new" }
        }
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "ANALYSIS_APPLY_CONFLICT", reason: "ASSERTION_VERSION_CHANGED" },
      analysis: { decision: "EDITED_AND_ACCEPTED", applyStatus: "CONFLICT" }
    });

    const rubricConflict = await setup();
    await expect(
      rubricConflict.service.acceptProposal({
        ...rubricConflict.command,
        editedProposal: {
          action: "ADD_ASSERTION",
          baseDefinitionHash: rubricConflict.repository.current.baseDefinitionHash ?? HASH_A,
          targetAssertionIndex: 1,
          assertion: {
            type: "llm-rubric",
            metric: "quality",
            weight: 1,
            rubricPrompt: "prompt://missing"
          }
        }
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "ANALYSIS_APPLY_CONFLICT", reason: "RUBRIC_PROMPT_CHANGED" },
      analysis: { decision: "EDITED_AND_ACCEPTED", applyStatus: "CONFLICT" }
    });

    const edited = await setup();
    await expect(
      edited.service.acceptProposal({
        ...edited.command,
        editedProposal: {
          action: "ADD_ASSERTION",
          baseDefinitionHash: edited.repository.current.baseDefinitionHash ?? HASH_A,
          targetAssertionIndex: 1,
          assertion: { type: "equals", metric: "answer", weight: 1, value: "edited" }
        }
      })
    ).resolves.toMatchObject({
      ok: true,
      analysis: { decision: "EDITED_AND_ACCEPTED", applyStatus: "APPLIED", revision: 4 },
      case: { definition: { assertions: [{ value: "old" }, { value: "edited" }] } }
    });
  });
});
