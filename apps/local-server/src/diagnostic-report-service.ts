import { randomUUID } from "node:crypto";
import type { LlmConfigDefinition } from "@cortex-eval/domain/src/domain-resource-models.ts";
import {
  DiagnosisOutputSchema,
  DiagnosticNarrativeOutputSchema,
  type DiagnosticReport,
  type DiagnosticSnapshot
} from "@cortex-eval/contracts/src/diagnostic-report-contracts.ts";
import type { DiagnosticModelClient } from "@cortex-eval/evaluation-adapters/src/diagnostic-model-client.ts";
import { type DiagnosticReportStore, diagnosticActive } from "./diagnostic-report-store.ts";
import { diagnosticCaseScenario } from "./diagnostic-report-case-scene.ts";
import { redactDiagnosticText } from "./diagnostic-report-snapshot.ts";

export interface DiagnosticModelConfig {
  definition: LlmConfigDefinition;
  identity: DiagnosticReport["model"];
}
export interface DiagnosticReportDependencies {
  store: DiagnosticReportStore;
  model: DiagnosticModelClient;
  ready(runId: string): Promise<boolean>;
  snapshot(runId: string, signal: AbortSignal): Promise<DiagnosticSnapshot>;
  configuration(id: string): Promise<DiagnosticModelConfig | null>;
}

/** Read-only diagnosis jobs outlive HTTP requests; bounded, versioned and independently cancellable. */
export class DiagnosticReportService {
  readonly #jobs = new Map<
    string,
    { report: DiagnosticReport; controller: AbortController; done: Promise<void> }
  >();
  #serial: Promise<unknown> = Promise.resolve();
  #closed = false;
  constructor(readonly deps: DiagnosticReportDependencies) {}
  get store(): DiagnosticReportStore {
    return this.deps.store;
  }

  start(runId: string, configId: string): Promise<DiagnosticReport> {
    const result = this.#serial.then(() => this.startLocked(runId, configId));
    this.#serial = result.catch(() => undefined);
    return result;
  }
  private async startLocked(runId: string, configId: string): Promise<DiagnosticReport> {
    if (this.#closed) throw new Error("DIAG_UNAVAILABLE");
    const existing = this.#jobs.get(runId);
    if (existing) {
      if (existing.report.model.configId !== configId) throw new Error("DIAG_BUSY");
      return structuredClone(existing.report);
    }
    if (this.#jobs.size >= 3) throw new Error("DIAG_BUSY");
    if (!(await this.deps.ready(runId))) throw new Error("DIAG_NOT_READY");
    const config = await this.deps.configuration(configId);
    if (!config) throw new Error("DIAG_MODEL_NOT_FOUND");
    const previous = await this.store.list(runId);
    const report: DiagnosticReport = {
      id: randomUUID(),
      runId,
      version: (previous[0]?.version ?? 0) + 1,
      status: "QUEUED",
      phase: "SNAPSHOT",
      createdAt: new Date().toISOString(),
      completedAt: null,
      model: config.identity,
      promptVersion: "diagnostic-report.v3",
      completedCases: 0,
      totalCases: 0,
      error: null,
      snapshot: null
    };
    await this.store.save(report);
    const controller = new AbortController();
    // Schedule after the claim is visible, not tied to the creating request's AbortSignal.
    const done = Promise.resolve()
      .then(() => this.execute(report, config.definition, controller.signal))
      .finally(() => this.#jobs.delete(runId));
    this.#jobs.set(runId, { report, controller, done });
    // Persist failures in execute; contain disk-failure rejections so no unhandled rejection kills the server.
    void done.catch(() => undefined);
    return structuredClone(report);
  }
  private async execute(
    report: DiagnosticReport,
    config: LlmConfigDefinition,
    signal: AbortSignal
  ): Promise<void> {
    try {
      signal.throwIfAborted();
      report.snapshot = await this.deps.snapshot(report.runId, signal);
      report.totalCases = report.snapshot.cases.length;
      report.status = "RUNNING";
      report.phase = "DIAGNOSING";
      await this.store.save(report);
      for (const item of report.snapshot.cases) {
        signal.throwIfAborted();
        try {
          const localSignal = AbortSignal.any([
            signal,
            AbortSignal.timeout(Math.min(config.timeoutMs, 10 * 60 * 1000))
          ]);
          const input = JSON.stringify({
            runId: report.runId,
            reportHash: report.snapshot.reportHash,
            agentRevision: report.snapshot.agentRevision,
            evidenceBoundary: "仅下列运行证据；未读取外部源码与日志；引用 id 必须存在。",
            caseKey: item.caseKey,
            status: item.status,
            restStatus: item.restStatus,
            reason: item.reason,
            assertions: item.assertions,
            evidence: item.evidence
          });
          const result = await abortable(
            this.deps.model.diagnose({ config, input, signal: localSignal }),
            localSignal
          );
          const diagnosis = DiagnosisOutputSchema.parse(
            JSON.parse(redactDiagnosticText(JSON.stringify(result)))
          );
          if (diagnosis.evidenceIds.some((id) => !item.evidence.some((e) => e.id === id)))
            throw new Error("DIAG_INVALID_CITATION");
          diagnosis.evidenceIds = [...new Set(diagnosis.evidenceIds)];
          if (diagnosis.evidenceIds.length === 0) diagnosis.evidenceStatus = "INSUFFICIENT";
          // References are verified structurally, not proof that an LLM's causal claim is correct.
          if (
            diagnosis.evidenceStatus === "SUPPORTED" &&
            (diagnosis.evidenceIds.length < 2 ||
              !item.evidence.some(
                (e) => e.source === "OUTPUT" && !e.truncated && diagnosis.evidenceIds.includes(e.id)
              ))
          )
            diagnosis.evidenceStatus = "HYPOTHESIS";
          item.diagnosis = diagnosis;
        } catch (error) {
          if (signal.aborted) throw error;
          const code = error instanceof Error ? error.message : "";
          item.diagnosisError =
            code === "DIAG_INVALID_CITATION"
              ? "模型引用了不存在的证据，已拒绝该归因。"
              : code === "ANALYZER_SECRET_MISSING"
                ? "模型凭据未配置。"
                : code === "ANALYZER_PROVIDER_CAPABILITY_UNSUPPORTED"
                  ? "模型不支持当前结构化输出或推理参数，请检查模型配置。"
                  : code === "ANALYZER_OUTPUT_INVALID"
                    ? "模型未返回合格的结构化诊断。"
                    : "模型调用超时、失败或诊断不符合契约；原始失败事实已保留。";
        }
        signal.throwIfAborted();
        report.completedCases += 1;
        await this.store.save(report);
      }
      const failed = report.snapshot.cases.filter((c) => c.diagnosisError !== null).length;
      const diagnosed = report.snapshot.cases.filter((c) => c.diagnosis !== null).length;
      // 只要有可用诊断就生成人话版正文；个别 Case 归因失败不剥夺整份正文。
      if (diagnosed > 0) {
        signal.throwIfAborted();
        try {
          const localSignal = AbortSignal.any([
            signal,
            AbortSignal.timeout(Math.min(config.timeoutMs, 10 * 60 * 1000))
          ]);
          const input = JSON.stringify(renderNarrativeInput(report));
          const result = await abortable(
            this.deps.model.synthesize({ config, input, signal: localSignal }),
            localSignal
          );
          const narrative = DiagnosticNarrativeOutputSchema.parse(
            JSON.parse(redactDiagnosticText(JSON.stringify(result)))
          );
          report.snapshot.narrative = narrative.markdown;
        } catch (error) {
          if (signal.aborted) throw error;
          report.snapshot.narrativeError =
            error instanceof Error && error.message === "ANALYZER_OUTPUT_INVALID"
              ? "人话版正文生成失败：模型未返回合格正文；逐项归因仍可查看。"
              : error instanceof Error && error.message === "ANALYZER_SECRET_MISSING"
                ? "人话版正文生成失败：模型凭据未配置；逐项归因仍可查看。"
                : "人话版正文生成失败：模型调用超时或失败；逐项归因仍可查看。";
        }
      }
      report.status =
        failed === 0 ? "COMPLETED" : failed === report.totalCases ? "FAILED" : "PARTIAL";
      if (failed)
        report.error = `${failed} 个 Case 未完成归因；可阅读事实与已完成部分，或生成新版本。`;
      else if (report.snapshot.narrativeError)
        report.error = `${report.snapshot.narrativeError} 可阅读逐项归因，或生成新版本。`;
    } catch {
      report.status = signal.aborted ? "CANCELLED" : "FAILED";
      report.error = signal.aborted
        ? "归因已取消，已完成内容保留。"
        : "无法完整整理或保存评测证据，请检查运行结果并生成新版本。";
    }
    report.phase = "DONE";
    report.completedAt = new Date().toISOString();
    await this.store.save(report);
  }
  async cancel(runId: string, reportId: string): Promise<DiagnosticReport> {
    const job = this.#jobs.get(runId);
    if (job?.report.id === reportId) {
      job.controller.abort();
      await job.done.catch(() => undefined);
    }
    const result = await this.store.get(runId, reportId);
    if (diagnosticActive(result)) throw new Error("DIAG_BUSY");
    return result;
  }
  async shutdown(): Promise<void> {
    this.#closed = true;
    await this.#serial;
    const jobs = [...this.#jobs.values()];
    for (const job of jobs) job.controller.abort();
    await Promise.allSettled(jobs.map((job) => job.done));
  }
}

async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let listener: () => void = () => undefined;
  const abort = new Promise<never>((_, reject) => {
    listener = (): void => reject(new Error("DIAG_ABORTED"));
    signal.addEventListener("abort", listener, { once: true });
    if (signal.aborted) listener();
  });
  try {
    return await Promise.race([work, abort]);
  } finally {
    signal.removeEventListener("abort", listener);
  }
}

/** Render report facts as readable prose for the narrative pass; never dump raw assertions. */
function renderNarrativeInput(report: DiagnosticReport): unknown {
  const s = report.snapshot;
  if (!s) return { unavailable: true };
  const failedCases = s.cases.filter((c) => c.diagnosis !== null);
  const supporting = s.cases.filter((c) => c.diagnosis !== null).length;
  return {
    title: s.title,
    suiteName: s.suiteName,
    agentRevision: s.agentRevision,
    summary: [
      `本次运行共 ${s.summary.total} 个 Case：自动通过 ${s.summary.evalPass} 个、未通过 ${s.summary.evalFail} 个、评测异常 ${s.summary.evalError} 个、未评测 ${s.summary.notEvaluated} 个，执行层面异常 ${s.summary.restError} 个。`,
      `待关注 Case（含 PASS 中的非通过断言）共 ${s.cases.length} 个，完成逐项归因 ${supporting} 个${
        supporting < s.cases.length ? `，另有 ${s.cases.length - supporting} 个未完成` : ""
      }。`,
      `有效通过率 ${s.summary.effectivePassRate === null ? "不适用" : `${(s.summary.effectivePassRate * 100).toFixed(2)}%`}。`
    ],
    cases: failedCases.map((c) => ({
      caseKey: c.caseKey,
      ...diagnosticCaseScenario(c),
      status: c.status,
      restStatus: c.restStatus,
      diagnosis:
        c.diagnosis === null
          ? null
          : {
              title: c.diagnosis.title,
              category: c.diagnosis.category,
              evidenceStatus: c.diagnosis.evidenceStatus,
              attribution: c.diagnosis.attribution,
              observation: c.diagnosis.observation,
              cause: c.diagnosis.cause,
              alternatives: c.diagnosis.alternatives,
              recommendations: c.diagnosis.recommendations,
              verification: c.diagnosis.verification
            }
    })),
    limitations: s.limitations
  };
}
