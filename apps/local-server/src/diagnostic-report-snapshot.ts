import type { PlatformReportOverview } from "@cortex-eval/application/src/features/reporting/platform-report-service.ts";
import type { PlatformReportArtifactCaseInput } from "@cortex-eval/application/src/features/runs/run-artifact-port.ts";
import {
  DiagnosticSnapshotSchema,
  type DiagnosticCase,
  type DiagnosticSnapshot
} from "@cortex-eval/contracts/src/diagnostic-report-contracts.ts";

/** Strip credential-bearing keys and common embedded credential forms before persistence/model use. */
export function redactDiagnosticText(value: string, secrets: readonly string[] = []): string {
  let result = value
    .replace(/\bBearer\s+[^\s"'\\,;]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|authorization|cookie|secret)\s*["']?\s*[:=]\s*["']?)[^\s"'\\,;}]+/gi,
      "$1[REDACTED]"
    );
  for (const secret of secrets)
    if (secret.length >= 4) result = result.split(secret).join("[REDACTED]");
  return result;
}

function excerpt(
  value: unknown,
  secrets: readonly string[]
): { content: string; truncated: boolean } {
  let budget = 3000;
  let truncated = false;
  const clean = (v: unknown, depth: number): unknown => {
    if (--budget < 0 || depth > 14) {
      truncated = true;
      return "[截断]";
    }
    if (typeof v === "string") {
      const text = redactDiagnosticText(v, secrets);
      if (text.length <= 16000) return text;
      truncated = true;
      return `${text.slice(0, 8000)}\n[中间内容截断]\n${text.slice(-8000)}`;
    }
    if (Array.isArray(v)) {
      const result: unknown[] = [];
      for (const child of v) {
        if (budget <= 0) {
          truncated = true;
          result.push("[剩余条目截断]");
          break;
        }
        result.push(clean(child, depth + 1));
      }
      return result;
    }
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v).map(([key, child]) => [
          key,
          /^(authorization|cookie|set-cookie|.*secret.*|.*password.*|api[_-]?key|access[_-]?token|refresh[_-]?token|thought_signature)$/i.test(
            key
          )
            ? "[REDACTED]"
            : clean(child, depth + 1)
        ])
      );
    return v;
  };
  let content = JSON.stringify(clean(value, 0), null, 2);
  if (content.length > 30000) {
    truncated = true;
    content = `${content.slice(0, 15000)}\n[中间内容截断；此摘录不是完整 JSON]\n${content.slice(-14000)}`;
  }
  return { content, truncated };
}

/** Pure snapshot of committed facts; quality-only misses in PASS cases remain visible. */
export async function createDiagnosticSnapshot(
  overview: PlatformReportOverview,
  cases: AsyncIterable<PlatformReportArtifactCaseInput>,
  signal: AbortSignal,
  secrets: readonly string[] = []
): Promise<DiagnosticSnapshot> {
  const run = overview.run;
  const snapshot: DiagnosticSnapshot = {
    runId: run.id,
    title:
      run.sourceType === "PLATFORM"
        ? (run.name ?? run.suite.name)
        : run.suite.name === run.suite.id
          ? `离线评测 · ${run.completedAt.slice(0, 10)}`
          : run.suite.name,
    suiteName: run.suite.name,
    startedAt: run.sourceType === "PLATFORM" ? run.startedAt : null,
    completedAt: run.completedAt,
    reportHash: run.reportResultSetHash ?? "",
    agentRevision: run.endpoint.definition.agentRevision
      ? `配置声明（未独立核验部署）：${run.endpoint.definition.agentRevision.branch} @ ${run.endpoint.definition.agentRevision.commit}`
      : "运行版本未验证",
    summary: {
      total: overview.report.summary.total,
      restError: overview.report.summary.restError,
      evalPass: overview.report.summary.evalPass,
      evalFail: overview.report.summary.evalFail,
      evalError: overview.report.summary.evalError,
      notEvaluated: overview.report.summary.notEvaluated,
      effectivePassRate: overview.report.summary.effectivePassRate,
      evaluatedPassRate: overview.report.summary.evaluatedPassRate,
      coverageRate: overview.report.summary.coverageRate
    },
    caseIndex: [],
    cases: [],
    narrative: null,
    narrativeError: null,
    limitations: [
      "仅依据本次运行已保存的 Case、断言、Provider Output 与差异证据；未额外读取 Agent 项目日志或源码。",
      "Agent 返回的卡片/工具回执不是浏览器真实展示验证；未配置发布门槛，不给出可发布结论。",
      "自动判定为冻结事实；AI 归因是待核验草稿，不改变 PASS/FAIL，也不代替人工验收。",
      "人工复核未纳入本报告统计；敏感凭据已做规则脱敏，业务正文仍需在对外分享前人工检查。"
    ]
  };
  for await (const item of cases) {
    signal.throwIfAborted();
    const { testCase, rest, evaluation } = item;
    const assertions = evaluation.assertions.filter((a) => a.status !== "PASS");
    snapshot.caseIndex.push({ caseKey: testCase.caseKey, status: evaluation.status });
    if (evaluation.status === "PASS" && rest.status === "SUCCEEDED" && assertions.length === 0)
      continue;
    const prefix = `C${testCase.ordinal + 1}`;
    const facts: DiagnosticCase = {
      caseKey: testCase.caseKey,
      ordinal: testCase.ordinal,
      status: evaluation.status,
      restStatus: rest.status,
      resultHash: evaluation.finalCaseResultHash,
      reason:
        evaluation.reason === null && rest.errorMessage === null
          ? null
          : redactDiagnosticText(evaluation.reason ?? rest.errorMessage ?? "", secrets),
      assertions: assertions.map((a) => ({
        index: a.index,
        metric: a.metric,
        type: a.type,
        status: a.status as "FAIL" | "ERROR" | "SKIPPED",
        reason: a.reason === null ? null : redactDiagnosticText(a.reason, secrets)
      })),
      evidence: [],
      diagnosis: null,
      diagnosisError: null
    };
    const inputs: readonly (readonly [
      DiagnosticCase["evidence"][number]["source"],
      string,
      unknown
    ])[] = [
      ["CASE", "冻结 Case（用户输入与预期）", testCase.definition],
      ["ASSERTIONS", "断言判定（非通过项）", assertions],
      [
        "RESULT",
        "执行与评测结果",
        {
          restStatus: rest.status,
          errorType: rest.errorType,
          errorMessage: rest.errorMessage,
          evalStatus: evaluation.status,
          reason: evaluation.reason,
          evaluationError: evaluation.evaluationError
        }
      ],
      ...(rest.providerOutput === null
        ? []
        : [["OUTPUT", "已保存的 Agent 输出/执行证据", rest.providerOutput] as const]),
      ...(evaluation.diffs.length === 0
        ? []
        : [["DIFF", "预期与实际差异", evaluation.diffs] as const])
    ] as const;
    for (const [i, entry] of inputs.entries())
      facts.evidence.push({
        id: `${prefix}-E${i + 1}`,
        source: entry[0],
        label: entry[1],
        ...excerpt(entry[2], secrets)
      });
    snapshot.cases.push(facts);
  }
  if (snapshot.caseIndex.length !== snapshot.summary.total)
    throw new Error("DIAG_SNAPSHOT_INCOMPLETE");
  if (snapshot.cases.some((c) => c.evidence.some((e) => e.truncated)))
    snapshot.limitations.push(
      "部分证据受大小限制已截断；引用仅证明可见摘录，完整证据请回原 Case 核验。"
    );
  return DiagnosticSnapshotSchema.parse(snapshot);
}
