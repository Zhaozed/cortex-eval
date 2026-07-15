import type {
  CompleteCurrentAnalysisInput,
  CurrentAnalysisMutationResult,
  CurrentCaseAnalysis,
  ImportedAnalysisIdentity,
  ImportedAnalysisRunContext,
  ReplaceCurrentAnalysisInput
} from "../src/features/case-analysis/case-analysis-models.ts";
import type {
  AnalysisImportStagingFactory,
  AnalysisImportStagingSession,
  CaseAnalysisRepository,
  CaseAnalysisTransaction,
  StagedAnalysisRepository
} from "../src/features/case-analysis/case-analysis-ports.ts";
import {
  ImportExecutionAnalysis,
  type ImportExecutionAnalysisCommand
} from "../src/features/execution-imports/import-execution-analysis.ts";
import type {
  ImportedAnalysisCase,
  StagedImportedAnalysisCase
} from "../src/features/case-analysis/case-analysis-models.ts";
import { describe, expect, it } from "vitest";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

function identity(resultHash = HASH_C): ImportedAnalysisIdentity {
  return {
    selector: "failed",
    reportResultSetHash: HASH_A,
    finalCaseResultSetHash: HASH_B,
    analysisResultSetHash: resultHash,
    artifactPath: "executions/018f22aa-33bb-7ccc-8ddd-fffffffffff1/analysis-results.json",
    artifactSha256: HASH_D,
    artifactSizeBytes: 42
  };
}

function analysisCase(inputHash = HASH_B, resultHash = HASH_C): ImportedAnalysisCase {
  return {
    caseKey: "case-1",
    finalCaseResultHash: HASH_A,
    analysisInputHash: inputHash,
    analysisResultHash: resultHash,
    status: "SUCCEEDED",
    output: {
      classification: "NORMAL_FAILURE",
      confidence: 0.8,
      evidence: [{ source: "failed_assertions", fieldPath: "/0", conclusion: "断言失败" }],
      explanation: "结果不满足约束",
      recommendedAction: "修复被测系统"
    }
  };
}

function analysisErrorCase(): ImportedAnalysisCase {
  return {
    caseKey: "case-1",
    finalCaseResultHash: HASH_A,
    analysisInputHash: HASH_B,
    analysisResultHash: HASH_C,
    status: "ERROR",
    errorCode: "ANALYZER_OUTPUT_INVALID",
    errorMessage: "Analyzer 输出结构无效"
  };
}

class MemoryAnalysisImports implements CaseAnalysisRepository {
  public context: ImportedAnalysisRunContext | null = {
    runId: "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeeee",
    packageId: "018f22aa-33bb-7ccc-8ddd-dddddddddddd",
    reportResultSetHash: HASH_A,
    analysisIdentity: null
  };
  public current: CurrentCaseAnalysis | null = null;
  public failIdentityWrite = false;

  public getImportedRunContext(): Promise<ImportedAnalysisRunContext | null> {
    return Promise.resolve(this.context);
  }

  public setImportedAnalysisIdentity(
    _executionId: string,
    value: ImportedAnalysisIdentity
  ): Promise<boolean> {
    if (this.context === null || this.failIdentityWrite) return Promise.resolve(false);
    this.context = { ...this.context, analysisIdentity: value };
    return Promise.resolve(true);
  }

  public getCurrent(runId: string, caseKey: string): Promise<CurrentCaseAnalysis | null> {
    void runId;
    void caseKey;
    return Promise.resolve(this.current);
  }

  public replaceCurrent(
    input: ReplaceCurrentAnalysisInput
  ): Promise<CurrentAnalysisMutationResult> {
    const revision = (this.current?.revision ?? 0) + 1;
    this.current = {
      id: input.id,
      runId: input.runId,
      caseKey: input.caseKey,
      finalCaseResultHash: input.finalCaseResultHash,
      revision,
      prompt: input.prompt,
      analyzer: input.analyzer,
      analysisInputContractVersion: "cortex.analysis-input.v1",
      analysisOutputContractVersion: "cortex.analysis-output.v1",
      analysisInputHash: input.analysisInputHash,
      analysisExecutionLimits: input.analysisExecutionLimits,
      status: "PENDING",
      output: null,
      analysisResultHash: null,
      decision: "NO_PROPOSAL",
      applyStatus: "NOT_APPLICABLE",
      baseDefinitionHash: null,
      appliedDefinitionHash: null,
      errorCode: null,
      errorMessage: null,
      createdAt: input.timestamp,
      updatedAt: input.timestamp
    };
    return Promise.resolve({ ok: true, analysis: this.current });
  }

  public claim(
    id: string,
    expectedRevision: number,
    timestamp: string
  ): Promise<CurrentAnalysisMutationResult> {
    void timestamp;
    if (this.current?.id !== id || this.current.revision !== expectedRevision) {
      return Promise.resolve({
        ok: false,
        reason: "ANALYSIS_REVISION_CONFLICT",
        current: this.current
      });
    }
    this.current = { ...this.current, revision: expectedRevision + 1, status: "RUNNING" };
    return Promise.resolve({ ok: true, analysis: this.current });
  }

  public complete(input: CompleteCurrentAnalysisInput): Promise<CurrentAnalysisMutationResult> {
    if (this.current?.id !== input.id || this.current.revision !== input.expectedRevision) {
      return Promise.resolve({
        ok: false,
        reason: "ANALYSIS_REVISION_CONFLICT",
        current: this.current
      });
    }
    this.current = {
      ...this.current,
      revision: input.expectedRevision + 1,
      status: input.result.status,
      output: input.result.status === "SUCCEEDED" ? input.result.output : null,
      analysisResultHash: input.analysisResultHash,
      errorCode: input.result.status === "ERROR" ? input.result.errorCode : null,
      errorMessage: input.errorMessage
    };
    return Promise.resolve({ ok: true, analysis: this.current });
  }

  public rejectProposal(): Promise<CurrentAnalysisMutationResult> {
    throw new Error("TEST_UNUSED");
  }
  public recordProposalApplication(): Promise<CurrentAnalysisMutationResult> {
    throw new Error("TEST_UNUSED");
  }
  public recoverUnfinished(): Promise<number> {
    throw new Error("TEST_UNUSED");
  }
  public recoverUnfinishedForRun(): Promise<number> {
    throw new Error("TEST_UNUSED");
  }
}

class MemoryAnalysisStagingFactory implements AnalysisImportStagingFactory {
  readonly #repository: MemoryAnalysisImports;
  public insideTransaction = false;
  public cleaned = false;

  public constructor(repository: MemoryAnalysisImports) {
    this.#repository = repository;
  }

  public open(): Promise<AnalysisImportStagingSession> {
    const staged: StagedImportedAnalysisCase[] = [];
    return Promise.resolve({
      stage: (value) => {
        if (staged.some((item) => item.caseKey === value.caseKey)) {
          return Promise.resolve("CASE_KEY_DUPLICATE" as const);
        }
        staged.push(value);
        return Promise.resolve("STAGED" as const);
      },
      withStagedTransaction: async (work) => {
        this.insideTransaction = true;
        const transaction: CaseAnalysisTransaction = {
          analyses: this.#repository,
          runs: {} as never,
          configurations: {} as never,
          testSuites: {} as never
        };
        const stagedAnalyses: StagedAnalysisRepository = {
          reconcileCurrent: async (input) => {
            let importedCount = 0;
            for (const value of staged) {
              const current = await this.#repository.getCurrent(input.runId, value.caseKey);
              if (current?.analysisInputHash === value.analysisInputHash) {
                if (current.analysisResultHash !== value.analysisResultHash) return { ok: false };
                continue;
              }
              const replacement = await this.#repository.replaceCurrent({
                id: value.id,
                runId: input.runId,
                caseKey: value.caseKey,
                finalCaseResultHash: value.finalCaseResultHash,
                expectedRevision: current?.revision ?? null,
                prompt: input.prompt,
                analyzer: input.analyzer,
                analysisInputHash: value.analysisInputHash,
                analysisExecutionLimits: input.analysisExecutionLimits,
                timestamp: input.timestamp
              });
              if (!replacement.ok) return { ok: false };
              const claimed = await this.#repository.claim(
                replacement.analysis.id,
                replacement.analysis.revision,
                input.timestamp
              );
              if (!claimed.ok) return { ok: false };
              const completed = await this.#repository.complete(
                value.status === "ERROR"
                  ? {
                      id: claimed.analysis.id,
                      expectedRevision: claimed.analysis.revision,
                      analysisResultHash: value.analysisResultHash,
                      result: { status: "ERROR", errorCode: value.errorCode },
                      errorMessage: value.errorMessage,
                      timestamp: input.timestamp
                    }
                  : {
                      id: claimed.analysis.id,
                      expectedRevision: claimed.analysis.revision,
                      analysisResultHash: value.analysisResultHash,
                      result: { status: "SUCCEEDED", output: value.output },
                      errorMessage: null,
                      timestamp: input.timestamp
                    }
              );
              if (!completed.ok) return { ok: false };
              importedCount += 1;
            }
            return { ok: true, importedCount };
          }
        };
        try {
          return await work(transaction, stagedAnalyses);
        } finally {
          this.insideTransaction = false;
        }
      },
      cleanup: () => {
        this.cleaned = true;
        return Promise.resolve();
      }
    });
  }
}

function service(
  repository: MemoryAnalysisImports,
  stagingFactory = new MemoryAnalysisStagingFactory(repository)
): ImportExecutionAnalysis {
  return new ImportExecutionAnalysis({
    stagingFactory,
    idGenerator: { nextId: () => "018f22aa-33bb-7ccc-8ddd-cccccccccccc" },
    clock: { now: () => "2026-07-15T01:00:00.000Z" }
  });
}

function command(
  values: readonly ImportedAnalysisCase[],
  importedIdentity = identity()
): ImportExecutionAnalysisCommand {
  return {
    packageId: "018f22aa-33bb-7ccc-8ddd-dddddddddddd",
    executionId: "018f22aa-33bb-7ccc-8ddd-fffffffffff1",
    identity: importedIdentity,
    prompt: {
      sourceId: null,
      promptKey: "analysis",
      promptHash: HASH_A,
      snapshot: { kind: "CASE_ANALYSIS", promptKey: "analysis", messages: [] }
    },
    analyzer: {
      sourceId: null,
      configHash: HASH_B,
      provider: "OPENAI_COMPATIBLE",
      model: "model",
      snapshot: { providerType: "OPENAI_COMPATIBLE", model: "model" }
    },
    analysisExecutionLimits: {
      contractVersion: "cortex.analysis-execution-limits.v1",
      analysisConcurrency: 1
    },
    openCases: async function* (): AsyncGenerator<ImportedAnalysisCase> {
      await Promise.resolve();
      yield* values;
    }
  };
}

describe("Import Execution Analysis", () => {
  it("完整 Case 文件流在主数据库写事务之前完成消费", async () => {
    const repository = new MemoryAnalysisImports();
    const stagingFactory = new MemoryAnalysisStagingFactory(repository);
    const input = command([analysisCase()]);
    const guarded: ImportExecutionAnalysisCommand = {
      ...input,
      openCases: async function* (): AsyncGenerator<ImportedAnalysisCase> {
        await Promise.resolve();
        if (stagingFactory.insideTransaction) throw new Error("FILE_READ_INSIDE_TRANSACTION");
        yield analysisCase();
      }
    };

    await expect(service(repository, stagingFactory).execute(guarded)).resolves.toMatchObject({
      ok: true,
      importedCount: 1
    });
    expect(stagingFactory.cleaned).toBe(true);
  });

  it("绑定已有 Report，保存结构化当前 Analysis，并按完整 Artifact 身份幂等", async () => {
    const repository = new MemoryAnalysisImports();
    const useCase = service(repository);
    await expect(useCase.execute(command([analysisCase()]))).resolves.toMatchObject({
      ok: true,
      idempotent: false,
      importedCount: 1
    });
    expect(repository.current).toMatchObject({
      status: "SUCCEEDED",
      analysisInputHash: HASH_B,
      output: { evidence: [{ source: "failed_assertions", fieldPath: "/0" }] }
    });
    await expect(useCase.execute(command([analysisCase()]))).resolves.toMatchObject({
      ok: true,
      idempotent: true,
      importedCount: 0
    });
  });

  it("相同 Analysis Input 对应不同结果拒绝；不同输入覆盖当前 Revision", async () => {
    const repository = new MemoryAnalysisImports();
    const useCase = service(repository);
    await useCase.execute(command([analysisCase()]));
    repository.context =
      repository.context === null ? null : { ...repository.context, analysisIdentity: null };
    await expect(
      useCase.execute(command([analysisCase(HASH_B, HASH_D)], identity(HASH_D)))
    ).resolves.toMatchObject({ ok: false, error: { code: "EXECUTION_RESULT_CONFLICT" } });
    const priorRevision = repository.current?.revision;
    await expect(
      useCase.execute(command([analysisCase(HASH_C, HASH_D)], identity(HASH_D)))
    ).resolves.toMatchObject({ ok: true, idempotent: false, importedCount: 1 });
    expect(repository.current).toMatchObject({ analysisInputHash: HASH_C });
    expect(repository.current?.revision).toBeGreaterThan(priorRevision ?? 0);
  });

  it("拒绝缺失或版本不一致的 Report 依赖上下文", async () => {
    for (const context of [
      null,
      {
        runId: "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeeee",
        packageId: "018f22aa-33bb-7ccc-8ddd-aaaaaaaaaaaa",
        reportResultSetHash: HASH_A,
        analysisIdentity: null
      },
      {
        runId: "018f22aa-33bb-7ccc-8ddd-eeeeeeeeeeee",
        packageId: "018f22aa-33bb-7ccc-8ddd-dddddddddddd",
        reportResultSetHash: HASH_D,
        analysisIdentity: null
      }
    ] satisfies readonly (ImportedAnalysisRunContext | null)[]) {
      const repository = new MemoryAnalysisImports();
      repository.context = context;
      await expect(service(repository).execute(command([analysisCase()]))).resolves.toMatchObject({
        ok: false,
        error: { code: "EXECUTION_RESULT_CONFLICT" }
      });
      expect(repository.current).toBeNull();
    }
  });

  it("导入错误终态、合法空结果，并在 Artifact 身份登记失败时返回冲突", async () => {
    const errorRepository = new MemoryAnalysisImports();
    await expect(
      service(errorRepository).execute(command([analysisErrorCase()]))
    ).resolves.toMatchObject({ ok: true, idempotent: false, importedCount: 1 });
    expect(errorRepository.current).toMatchObject({
      status: "ERROR",
      output: null,
      errorCode: "ANALYZER_OUTPUT_INVALID",
      errorMessage: "Analyzer 输出结构无效"
    });

    const emptyRepository = new MemoryAnalysisImports();
    await expect(service(emptyRepository).execute(command([]))).resolves.toMatchObject({
      ok: true,
      idempotent: false,
      importedCount: 0
    });
    expect(emptyRepository.current).toBeNull();

    const failedIdentity = new MemoryAnalysisImports();
    failedIdentity.failIdentityWrite = true;
    await expect(service(failedIdentity).execute(command([]))).resolves.toMatchObject({
      ok: false,
      error: { code: "EXECUTION_RESULT_CONFLICT" }
    });
  });
});
