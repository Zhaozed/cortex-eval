/**
 * 飞书 E2E v2 报告生成器（只读 DB，不改任何数据）。
 *
 * 用法：
 *   npx tsx test_suite/feishu-e2e-v2/scripts/report.ts --run <runId> [--run <runId> ...] \
 *       [--baseline <runId>] [--suite <suiteId>] [--out <dir>]
 *
 * 多次 --run = 同一批 case 的重复运行（SPEC 要求每条跑 3 次取多数）。
 * 输出：
 *   reports/report-<时间>.json   机器可读全量指标
 *   reports/report-<时间>.md     给人看的中文报告（维度通过率 / 硬性门禁 / 缺陷清单 / 待清理资源）
 *
 * 指标定义全部来自 SPEC.md 第 6 节。
 */
import { DatabaseSync } from "node:sqlite";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const repoRoot = resolve(root, "../..");

/* --------------------------------------------------------------- CLI */
const argv = process.argv.slice(2);
const collect = (name: string): string[] =>
  argv
    .reduce<string[]>((acc, a, i) => (a === name ? [...acc, argv[i + 1] ?? ""] : acc), [])
    .filter(Boolean);
const runIds = collect("--run");
const baselineIds = collect("--baseline");
const suiteIds = collect("--suite");
const outDirArg = collect("--out");
if (!runIds.length) {
  console.error(
    "用法：npx tsx scripts/report.ts --run <runId> [--run <runId> ...] [--baseline <runId>] [--suite <suiteId>] [--out <dir>]\n" +
      "没有任何 runId 就没法出报告。"
  );
  process.exit(1);
}
const outDir = outDirArg[0] ? resolve(outDirArg[0]) : resolve(root, "reports");
const dbPath = resolve(repoRoot, ".cortex-eval/db/cortex-eval.sqlite3");

const db = new DatabaseSync(dbPath, { readOnly: true });
const q = <T = any>(sql: string, ...args: any[]): T[] => db.prepare(sql).all(...args) as T[];
const one = <T = any>(sql: string, ...args: any[]): T | undefined =>
  db.prepare(sql).get(...args) as T | undefined;

/* ------------------------------------------------- 维度层定义（SPEC §2） */
const LAYERS: Record<string, string> = {
  D1: "意图路由",
  D2: "工具编排",
  D3: "结果真实性",
  D4: "语音可播报",
  D5: "视觉交互（A2UI）",
  D6: "安全与边界"
};
const layerOf = (metric: string): string => /【(?:硬性|质量)】(D\d)\./.exec(metric)?.[1] ?? "?";
const subOf = (metric: string): string => /【(?:硬性|质量)】(D\d\.\d+)/.exec(metric)?.[1] ?? "?";
const kindOf = (metric: string): "HARD" | "SOFT" | "UNKNOWN" =>
  metric.startsWith("【硬性】") ? "HARD" : metric.startsWith("【质量】") ? "SOFT" : "UNKNOWN";
const humanOf = (metric: string): string => metric.split("｜").slice(1).join("｜") || metric;
/**
 * 证据不足判定（SPEC §8.5）：断言取不到判定所需字段时返回 pass:true + score:1，
 * reason 以「证据不足：」开头。这类项被算成「通过」，必须单独统计——占比过高说明是采集/端点问题，本轮结论作废。
 */
const INSUFFICIENT_RE = /^证据不足[：:]/;
const isInsufficient = (reason: string | null | undefined): boolean =>
  INSUFFICIENT_RE.test(String(reason ?? "").trim());
/** 证据不足占比超过这个值，本轮结论作废（先修采集再重跑）。 */
const EVIDENCE_GAP_LIMIT = 0.1;

const pct = (n: number, d: number): string => (d ? `${((n / d) * 100).toFixed(1)}%` : "—");
const quantile = (xs: number[], p: number): number | null => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i]!;
};

/* --------------------------------------------------- 结论枚举（SPEC §3） */
type Verdict = "PASS" | "FAIL" | "BLOCKED" | "LABEL_ERROR" | "EVAL_ERROR";
function verdictOf(row: {
  rest_status: string;
  eval_status: string;
  error_type: string | null;
  assertions: any[];
  reason: string | null;
}): Verdict {
  if (row.rest_status === "ERROR") {
    const t = String(row.error_type ?? "");
    if (/CONTEXT_REQUIRED|CLIENT_CONTEXT|EVAL_E2E_/i.test(t)) return "BLOCKED";
    return "EVAL_ERROR";
  }
  if (row.eval_status === "EVALUATION_ERROR") return "EVAL_ERROR";
  if (row.eval_status === "NOT_EVALUATED") return "BLOCKED";
  const hard = row.assertions.filter((a) => kindOf(String(a.metric ?? "")) === "HARD");
  if (hard.length && hard.some((a) => a.status !== "PASS")) {
    const reasons = hard.filter((a) => a.status !== "PASS").map((a) => String(a.reason ?? ""));
    if (reasons.some((r) => /证据不足|EVIDENCE_MISSING|前置|fixture/i.test(r))) return "BLOCKED";
    if (reasons.some((r) => /LABEL_ERROR|期望值本身/i.test(r))) return "LABEL_ERROR";
    return "FAIL";
  }
  return row.eval_status === "PASS" ? "PASS" : "FAIL";
}

/* --------------------------------------------------------- 读 run 数据 */
interface CaseRun {
  runId: string;
  caseKey: string;
  caseId: string;
  name: string;
  domain: string;
  businessModule: string;
  scenarioTag: string;
  verdict: Verdict;
  score: number | null;
  latencyMs: number | null;
  tokens: { input: number; output: number; cached: number } | null;
  assertions: {
    metric: string;
    kind: "HARD" | "SOFT" | "UNKNOWN";
    layer: string;
    sub: string;
    human: string;
    status: string;
    score: number | null;
    weight: number | null;
    reason: string;
  }[];
  hardPass: number;
  hardTotal: number;
  softPass: number;
  softTotal: number;
  toolSequence: string[];
  resourceIds: string[];
  restError: string | null;
}

function loadRun(runId: string): CaseRun[] {
  const rows = q<any>(
    `SELECT cr.run_id, cr.case_key, cr.rest_status, cr.http_status, cr.provider_output_json, cr.duration_ms,
            cr.error_type, cr.error_message, cr.case_definition_json,
            er.eval_status, er.score, er.reason, er.assertion_results_json, er.token_usage_json
       FROM case_result cr
       LEFT JOIN eval_result er ON er.run_id = cr.run_id AND er.case_key = cr.case_key
      WHERE cr.run_id = ?
      ORDER BY cr.ordinal`,
    runId
  );
  return rows.map((r) => {
    let def: any = {};
    try {
      def = JSON.parse(r.case_definition_json ?? "{}");
    } catch {
      def = {};
    }
    const meta = def?.metadata ?? {};
    const caseId = String(meta.case_id ?? r.case_key);
    let assertionsRaw: any[] = [];
    try {
      assertionsRaw = JSON.parse(r.assertion_results_json ?? "[]");
    } catch {
      assertionsRaw = [];
    }
    const assertions = assertionsRaw.map((a) => {
      const metric = String(a.metric ?? "");
      return {
        metric,
        kind: kindOf(metric),
        layer: layerOf(metric),
        sub: subOf(metric),
        human: humanOf(metric),
        status: String(a.status ?? "UNKNOWN"),
        score: typeof a.score === "number" ? a.score : null,
        weight: typeof a.weight === "number" ? a.weight : null,
        reason: String(a.reason ?? "")
      };
    });
    /* 工具序列 + 资源ID：从 provider_output_json 抽，帧无关 */
    const toolSequence: string[] = [];
    const resourceIds = new Set<string>();
    try {
      const po = JSON.parse(r.provider_output_json ?? "null");
      const frames: any[] =
        Array.isArray(po?.parsed_output?.turns) && po.parsed_output.turns.length
          ? po.parsed_output.turns.map((t: any) => t.parsed_output).filter(Boolean)
          : po?.parsed_output
            ? [po.parsed_output]
            : [];
      for (const f of frames) {
        for (const te of f?.tool_executions ?? []) {
          const name = te?.calls?.[0]?.name ?? te?.calls?.[0]?.tool_name ?? "?";
          toolSequence.push(`${name}:${te?.status ?? "?"}`);
        }
        const blob = JSON.stringify(f ?? {});
        for (const m of blob.matchAll(/\b(?:ou|oc|om|omm|on)_[A-Za-z0-9]{8,}\b/g))
          resourceIds.add(m[0]);
        for (const m of blob.matchAll(/"event_id"\s*:\s*"([^"]+)"/g))
          resourceIds.add(`event:${m[1]}`);
        for (const m of blob.matchAll(/"message_id"\s*:\s*"([^"]+)"/g))
          resourceIds.add(`message:${m[1]}`);
        for (const m of blob.matchAll(/"doc(?:ument)?_token"\s*:\s*"([^"]+)"/g))
          resourceIds.add(`doc:${m[1]}`);
      }
    } catch {
      /* 证据缺失不影响断言统计 */
    }
    let tokens: CaseRun["tokens"] = null;
    try {
      const t = JSON.parse(r.token_usage_json ?? "null");
      if (t)
        tokens = {
          input: Number(t.input ?? t.prompt ?? 0),
          output: Number(t.output ?? t.completion ?? 0),
          cached: Number(t.cached_input ?? t.cached ?? 0)
        };
    } catch {
      tokens = null;
    }
    const hard = assertions.filter((a) => a.kind === "HARD");
    const soft = assertions.filter((a) => a.kind === "SOFT");
    return {
      runId,
      caseKey: String(r.case_key),
      caseId,
      name:
        String(def?.description ?? "")
          .split("｜")
          .slice(2)
          .join("｜") || caseId,
      domain: caseId.split("-").slice(0, 2).join("-"),
      businessModule: String(meta.business_module ?? ""),
      scenarioTag: String(meta.scenario_tag ?? ""),
      verdict: verdictOf({
        rest_status: String(r.rest_status),
        eval_status: String(r.eval_status ?? "NOT_EVALUATED"),
        error_type: r.error_type,
        assertions: assertionsRaw,
        reason: r.reason
      }),
      score: typeof r.score === "number" ? r.score : null,
      latencyMs: typeof r.duration_ms === "number" ? r.duration_ms : null,
      tokens,
      assertions,
      hardPass: hard.filter((a) => a.status === "PASS").length,
      hardTotal: hard.length,
      softPass: soft.filter((a) => a.status === "PASS").length,
      softTotal: soft.length,
      toolSequence,
      resourceIds: [...resourceIds],
      restError: r.error_type
        ? `${r.error_type}${r.error_message ? "：" + String(r.error_message).slice(0, 120) : ""}`
        : null
    } satisfies CaseRun;
  });
}

const runs = new Map<string, CaseRun[]>();
for (const id of runIds) runs.set(id, loadRun(id));
const baseline = new Map<string, CaseRun[]>();
for (const id of baselineIds.length
  ? baselineIds
  : [one<any>(`SELECT id FROM run_log WHERE id=?`, "")?.id ?? ""].filter(Boolean)) {
  if (id) baseline.set(id, loadRun(id));
}
if (!baselineIds.length) {
  const cfg = JSON.parse(await readFile(resolve(root, "suite-config.json"), "utf8"));
  if (cfg.baseline_run_id) {
    const b = loadRun(cfg.baseline_run_id);
    if (b.length) baseline.set(cfg.baseline_run_id, b);
  }
}

/* ------------------------------------------------- 多 run 取多数（SPEC §3） */
interface CaseAggregate {
  caseId: string;
  name: string;
  domain: string;
  runs: CaseRun[];
  verdict: Verdict;
  stable: boolean;
  hardPass: number;
  hardTotal: number;
  softPass: number;
  softTotal: number;
  failedSubs: {
    sub: string;
    metric: string;
    name: string;
    kind: string;
    reason: string;
    times: number;
  }[];
}
const byCase = new Map<string, CaseRun[]>();
for (const [, list] of runs)
  for (const c of list) {
    const arr = byCase.get(c.caseId) ?? [];
    arr.push(c);
    byCase.set(c.caseId, arr);
  }
const RANK: Verdict[] = ["PASS", "FAIL", "LABEL_ERROR", "BLOCKED", "EVAL_ERROR"];
const aggregates: CaseAggregate[] = [...byCase.entries()].map(([caseId, list]) => {
  const tally = new Map<Verdict, number>();
  for (const c of list) tally.set(c.verdict, (tally.get(c.verdict) ?? 0) + 1);
  const majority =
    [...tally.entries()].sort(
      (a, b) => b[1] - a[1] || RANK.indexOf(a[0]) - RANK.indexOf(b[0])
    )[0]?.[0] ?? "EVAL_ERROR";
  const failed = new Map<
    string,
    { sub: string; metric: string; name: string; kind: string; reason: string; times: number }
  >();
  for (const c of list)
    for (const a of c.assertions)
      if (a.status !== "PASS") {
        const k = a.metric;
        const e = failed.get(k) ?? {
          sub: a.sub,
          metric: a.metric,
          name: a.human,
          kind: a.kind,
          reason: a.reason,
          times: 0
        };
        e.times += 1;
        if (a.reason) e.reason = a.reason;
        failed.set(k, e);
      }
  const last = list[list.length - 1]!;
  return {
    caseId,
    name: last.name,
    domain: last.domain,
    runs: list,
    verdict: majority,
    stable: tally.size === 1,
    hardPass: Math.round(list.reduce((n, c) => n + c.hardPass, 0) / list.length),
    hardTotal: last.hardTotal,
    softPass: Math.round(list.reduce((n, c) => n + c.softPass, 0) / list.length),
    softTotal: last.softTotal,
    failedSubs: [...failed.values()].sort((a, b) => b.times - a.times)
  };
});
aggregates.sort((a, b) => a.caseId.localeCompare(b.caseId));

/* --------------------------------------------------------- Suite 级指标 */
const effective = aggregates.filter(
  (a) => !["BLOCKED", "LABEL_ERROR", "EVAL_ERROR"].includes(a.verdict)
);
const hardGatePass = effective.filter((a) => a.verdict === "PASS").length;
const allAssertions = aggregates.flatMap((a) => a.runs.flatMap((r) => r.assertions));
const softAll = allAssertions.filter((a) => a.kind === "SOFT");
const hardAll = allAssertions.filter((a) => a.kind === "HARD");

const subStats = new Map<
  string,
  {
    sub: string;
    layer: string;
    name: string;
    kind: string;
    pass: number;
    total: number;
    insufficient: number;
    realPass: number;
  }
>();
for (const a of allAssertions) {
  if (a.sub === "?") continue;
  const e = subStats.get(a.sub) ?? {
    sub: a.sub,
    layer: a.layer,
    name: a.human,
    kind: a.kind,
    pass: 0,
    total: 0,
    insufficient: 0,
    realPass: 0
  };
  e.total += 1;
  const ins = isInsufficient(a.reason);
  if (ins) e.insufficient += 1;
  if (a.status === "PASS") e.pass += 1;
  /* realPass = 真的判过且判赢；证据不足虽然 status=PASS，但不算产品真的做到了 */
  if (a.status === "PASS" && !ins) e.realPass += 1;
  e.name = a.human;
  subStats.set(a.sub, e);
}

/* 证据不足总账：本轮结论是否可信，先看这个 */
const insufficientAll = allAssertions.filter((a) => isInsufficient(a.reason));
const evidenceGap = {
  count: insufficientAll.length,
  total: allAssertions.length,
  ratio: allAssertions.length ? insufficientAll.length / allAssertions.length : 0,
  limit: EVIDENCE_GAP_LIMIT,
  /** true = 本轮结论作废，先修采集/端点再重跑 */
  invalid:
    allAssertions.length > 0 && insufficientAll.length / allAssertions.length > EVIDENCE_GAP_LIMIT,
  bySub: Object.fromEntries(
    [...subStats.values()]
      .filter((s) => s.insufficient > 0)
      .sort((a, b) => b.insufficient - a.insufficient)
      .map((s) => [s.sub, { insufficient: s.insufficient, total: s.total, name: s.name }])
  ),
  samples: insufficientAll
    .slice(0, 20)
    .map((a) => ({ sub: a.sub, metric: a.metric, reason: a.reason }))
};
const layerStats = new Map<string, { layer: string; name: string; pass: number; total: number }>();
for (const s of subStats.values()) {
  const e = layerStats.get(s.layer) ?? {
    layer: s.layer,
    name: LAYERS[s.layer] ?? s.layer,
    pass: 0,
    total: 0
  };
  e.pass += s.pass;
  e.total += s.total;
  layerStats.set(s.layer, e);
}
const voiceScore = (() => {
  const d4 = allAssertions.filter((a) => a.layer === "D4");
  return d4.length ? d4.filter((a) => a.status === "PASS").length / d4.length : null;
})();
const visualScore = (() => {
  const d5 = allAssertions.filter((a) => a.layer === "D5");
  return d5.length ? d5.filter((a) => a.status === "PASS").length / d5.length : null;
})();

/* 覆盖率 */
const suiteCfg = JSON.parse(await readFile(resolve(root, "suite-config.json"), "utf8"));
let scenarios: any[] = [];
try {
  scenarios = (JSON.parse(await readFile(resolve(root, "scenarios.v2.json"), "utf8"))?.cases ??
    []) as any[];
} catch {
  scenarios = [];
}
const expectedTools = new Set<string>();
for (const t of (suiteCfg.target_tools ?? []) as string[]) expectedTools.add(t);
for (const s of scenarios) {
  for (const t of s?.expected?.tools ?? []) expectedTools.add(t.tool);
  for (const t of s?.expected?.forbidden ?? []) expectedTools.add(t);
  for (const t of s?.expected?.order ?? []) expectedTools.add(t);
  for (const t of Object.keys(s?.expected?.allowedWrites ?? {})) expectedTools.add(t);
}
const observedTools = new Set<string>();
for (const a of aggregates)
  for (const r of a.runs) for (const t of r.toolSequence) observedTools.add(t.split(":")[0]!);
const coveredTools = [...expectedTools].filter((t) => observedTools.has(t));
const expectedCards = new Set<string>(scenarios.map((s) => s?.expected?.card).filter(Boolean));

/* 缺陷密度 / 归因 */
const defects = aggregates.filter((a) => a.verdict === "FAIL");
const attribution = { NORMAL_FAILURE: 0, LABEL_ERROR: 0, BLOCKED: 0, EVAL_ERROR: 0 };
for (const a of aggregates) {
  if (a.verdict === "FAIL") attribution.NORMAL_FAILURE += 1;
  else if (a.verdict === "LABEL_ERROR") attribution.LABEL_ERROR += 1;
  else if (a.verdict === "BLOCKED") attribution.BLOCKED += 1;
  else if (a.verdict === "EVAL_ERROR") attribution.EVAL_ERROR += 1;
}

/* 性能 */
const latencies = aggregates
  .flatMap((a) => a.runs.map((r) => r.latencyMs ?? NaN))
  .filter(Number.isFinite);
const tokenIn = aggregates
  .flatMap((a) => a.runs.map((r) => r.tokens?.input ?? NaN))
  .filter(Number.isFinite);
const tokenOut = aggregates
  .flatMap((a) => a.runs.map((r) => r.tokens?.output ?? NaN))
  .filter(Number.isFinite);
const toolCounts = aggregates.flatMap((a) => a.runs.map((r) => r.toolSequence.length));

/* 稳定性 */
const unstable = aggregates.filter((a) => a.runs.length > 1 && !a.stable);

/* 回归 diff */
const baselineByCase = new Map<string, CaseRun>();
for (const [, list] of baseline) for (const c of list) baselineByCase.set(c.caseId, c);
const regression = aggregates
  .filter((a) => baselineByCase.has(a.caseId))
  .map((a) => ({
    caseId: a.caseId,
    before: baselineByCase.get(a.caseId)!.verdict,
    after: a.verdict
  }))
  .filter((x) => x.before !== x.after);

/* ------------------------------------------------------------- JSON */
const reportJson = {
  generated_at: new Date().toISOString(),
  spec: "test_suite/feishu-e2e-v2/SPEC.md",
  runs: [...runs.keys()],
  runs_per_case: runs.size ? Math.max(...[...byCase.values()].map((l) => l.length)) : 0,
  baseline_runs: [...baseline.keys()],
  suite: {
    cases_total: aggregates.length,
    cases_effective: effective.length,
    hard_gate_pass: hardGatePass,
    hard_gate_pass_rate: effective.length ? hardGatePass / effective.length : null,
    soft_pass: softAll.filter((a) => a.status === "PASS").length,
    soft_total: softAll.length,
    soft_pass_rate: softAll.length
      ? softAll.filter((a) => a.status === "PASS").length / softAll.length
      : null,
    hard_total: hardAll.length,
    voice_score_d4: voiceScore,
    visual_score_d5: visualScore,
    defect_density: effective.length ? defects.length / effective.length : null,
    attribution,
    unstable_cases: unstable.map((a) => ({
      case_id: a.caseId,
      verdicts: a.runs.map((r) => r.verdict)
    })),
    consistency_rate: aggregates.length
      ? (aggregates.length - unstable.length) / aggregates.length
      : null,
    /* 证据不足总账：invalid=true 时本轮结论作废（SPEC §8.5） */
    evidence_gap: {
      count: evidenceGap.count,
      total: evidenceGap.total,
      ratio: Number(evidenceGap.ratio.toFixed(4)),
      limit: evidenceGap.limit,
      invalid: evidenceGap.invalid,
      by_sub: evidenceGap.bySub
    }
  },
  layers: [...layerStats.values()].sort((a, b) => a.layer.localeCompare(b.layer)),
  subitems: [...subStats.values()].sort((a, b) =>
    a.sub.localeCompare(b.sub, "en", { numeric: true })
  ),
  coverage: {
    tools_expected: expectedTools.size,
    tools_target: suiteCfg.target_tool_coverage ?? null,
    tools_observed: observedTools.size,
    tools_covered: coveredTools.length,
    tools_covered_rate: expectedTools.size ? coveredTools.length / expectedTools.size : null,
    tools_missing: [...expectedTools].filter((t) => !observedTools.has(t)).sort(),
    tools_unexpected: [...observedTools].filter((t) => !expectedTools.has(t)).sort(),
    cards_expected: [...expectedCards].sort()
  },
  performance: {
    latency_p50_ms: quantile(latencies, 50),
    latency_p95_ms: quantile(latencies, 95),
    token_input_p50: quantile(tokenIn, 50),
    token_input_p95: quantile(tokenIn, 95),
    token_output_p50: quantile(tokenOut, 50),
    token_output_p95: quantile(tokenOut, 95),
    tool_calls_min: toolCounts.length ? Math.min(...toolCounts) : null,
    tool_calls_max: toolCounts.length ? Math.max(...toolCounts) : null
  },
  regression: { baseline_cases: baselineByCase.size, changed: regression },
  cases: aggregates.map((a) => ({
    case_id: a.caseId,
    name: a.name,
    domain: a.domain,
    verdict: a.verdict,
    stable: a.stable,
    runs: a.runs.map((r) => ({
      run_id: r.runId,
      verdict: r.verdict,
      score: r.score,
      latency_ms: r.latencyMs,
      rest_error: r.restError
    })),
    hard: `${a.hardPass}/${a.hardTotal}`,
    soft: `${a.softPass}/${a.softTotal}`,
    failed: a.failedSubs,
    tool_sequence: a.runs[a.runs.length - 1]?.toolSequence ?? [],
    resource_ids: [...new Set(a.runs.flatMap((r) => r.resourceIds))]
  }))
};

/* --------------------------------------------------------------- MD */
const L: string[] = [];
L.push(`# 飞书 E2E v2 评测报告`);
L.push(``);
L.push(`生成时间：${reportJson.generated_at}　｜　规则源：\`test_suite/feishu-e2e-v2/SPEC.md\``);
L.push(`本次 run：${runIds.join("、")}　｜　基线：${[...baseline.keys()].join("、") || "无"}`);
L.push(``);
L.push(`## 一句话结论`);
L.push(``);
L.push(
  `**${effective.length} 条有效 case 里 ${hardGatePass} 条过了硬性门禁（${pct(hardGatePass, effective.length)}）**；` +
    `质量项通过 ${reportJson.suite.soft_pass}/${reportJson.suite.soft_total}（${pct(reportJson.suite.soft_pass, reportJson.suite.soft_total)}）；` +
    `语音分 ${voiceScore === null ? "—" : (voiceScore * 100).toFixed(1) + "%"}，视觉分 ${visualScore === null ? "—" : (visualScore * 100).toFixed(1) + "%"}。`
);
if (aggregates.length !== effective.length)
  (L.push(``),
    L.push(
      `> 另有 ${aggregates.length - effective.length} 条不计入通过率：BLOCKED ${attribution.BLOCKED} / LABEL_ERROR ${attribution.LABEL_ERROR} / EVAL_ERROR ${attribution.EVAL_ERROR}。这些是**前置或评测框架的问题，不是产品的问题**。`
    ));
L.push(``);
L.push(`## 0. 本轮结论可信吗（先看这个）`);
L.push(``);
if (evidenceGap.invalid) {
  L.push(
    `> ⛔ **本轮结论作废**：${evidenceGap.count}/${evidenceGap.total} 条断言（${pct(evidenceGap.count, evidenceGap.total)}）拿不到判定所需的字段，只能按「证据不足」放行，超过 ${(evidenceGap.limit * 100).toFixed(0)}% 上限。` +
      `先修端点采集（8080 是否在跑、parsed_output 是否完整），再重跑。下面的通过率**不能拿去做结论**。`
  );
} else if (evidenceGap.count > 0) {
  L.push(
    `> ⚠️ 有 ${evidenceGap.count}/${evidenceGap.total} 条断言（${pct(evidenceGap.count, evidenceGap.total)}）证据不足、按放行处理，未超 ${(evidenceGap.limit * 100).toFixed(0)}% 上限，本轮结论可用，但下面标了「证据不足」的子项通过率是**虚高**的，看「真判通过」那列。`
  );
} else {
  L.push(
    `> ✅ 全部 ${evidenceGap.total} 条断言都拿到了判定所需字段，没有「证据不足」放行项，下面的通过率是实打实的。`
  );
}
if (evidenceGap.count > 0) {
  L.push(``);
  L.push(`| 子项 | 名称 | 证据不足 / 总数 |`);
  L.push(`| --- | --- | --- |`);
  for (const [sub, v] of Object.entries(evidenceGap.bySub))
    L.push(
      `| ${sub} | ${String((v as any).name).slice(0, 40)} | ${(v as any).insufficient}/${(v as any).total} |`
    );
}
L.push(``);
L.push(`## 1. 维度通过率（按断言条数算，不按 case 算）`);
L.push(``);
L.push(`| 层 | 维度 | 通过 / 总数 | 通过率 |`);
L.push(`| --- | --- | --- | --- |`);
for (const l of [...layerStats.values()].sort((a, b) => a.layer.localeCompare(b.layer)))
  L.push(`| ${l.layer} | ${l.name} | ${l.pass} / ${l.total} | ${pct(l.pass, l.total)} |`);
L.push(``);
L.push(`### 子项明细（最弱的排前面，直接定位问题）`);
L.push(``);
L.push(`| 子项 | 类型 | 名称（人话判据） | 通过率 | 通过/总数 | 真判通过 | 证据不足 |`);
L.push(`| --- | --- | --- | --- | --- | --- | --- |`);
const sortedSubs = [...subStats.values()].sort(
  (a, b) => a.realPass / (a.total || 1) - b.realPass / (b.total || 1)
);
for (const s of sortedSubs)
  L.push(
    `| ${s.sub} | ${s.kind === "HARD" ? "硬性" : "质量"} | ${s.name} | ${pct(s.pass, s.total)} | ${s.pass}/${s.total} | ${s.realPass}/${s.total} | ${s.insufficient ? `⚠️ ${s.insufficient}` : "0"} |`
  );
L.push(``);
L.push(
  `> **通过率** = status 为 PASS 的占比（证据不足也算 PASS）。**真判通过** = 真的取到证据且判赢的占比，这才是产品真实水平。两列差得越多，说明这个子项越没被真正考到。`
);
L.push(``);
L.push(`## 2. Case 结论（${aggregates.length} 条，跑 ${reportJson.runs_per_case} 次取多数）`);
L.push(``);
L.push(`| Case | 名称 | 域 | 结论 | 硬性 | 质量 | 稳定 | 失败 top1 |`);
L.push(`| --- | --- | --- | --- | --- | --- | --- | --- |`);
for (const a of aggregates) {
  const top = a.failedSubs[0];
  L.push(
    `| ${a.caseId} | ${a.name.slice(0, 28)} | ${a.domain} | ${a.verdict} | ${a.hardPass}/${a.hardTotal} | ${a.softPass}/${a.softTotal} | ${a.stable ? "✅" : "⚠️"} | ${top ? `${top.sub} ${String(top.name ?? "").slice(0, 24)}` : "—"} |`
  );
}
L.push(``);
L.push(`## 3. 失败根因（人话，直接抄 reason）`);
L.push(``);
const failing = aggregates.filter((a) => a.verdict === "FAIL" && a.failedSubs.length);
if (!failing.length) L.push(`没有硬性失败项。`);
for (const a of failing) {
  L.push(`### ${a.caseId}　${a.name}`);
  for (const f of a.failedSubs.slice(0, 6)) {
    L.push(
      `- **${f.sub}｜${f.name || humanOf(f.metric)}**（${f.kind === "HARD" ? "硬性" : "质量"}，${f.times} 次运行里失败 ${f.times} 次）`
    );
    L.push(`  > ${f.reason.replace(/\n+/g, " ").slice(0, 600)}`);
  }
  L.push(``);
}
L.push(`## 4. 覆盖率`);
L.push(``);
L.push(`| 项 | 值 |`);
L.push(`| --- | --- |`);
L.push(
  `| 工具覆盖率 | ${reportJson.coverage.tools_covered} / ${reportJson.coverage.tools_expected} 期望工具被真实调用（目标 ${reportJson.coverage.tools_target ?? "—"}） |`
);
L.push(`| 未命中的期望工具 | ${reportJson.coverage.tools_missing.join("、") || "无"} |`);
L.push(`| 期望外被调用的工具 | ${reportJson.coverage.tools_unexpected.join("、") || "无"} |`);
L.push(`| 卡片类型覆盖 | ${reportJson.coverage.cards_expected.join("、") || "—"} |`);
L.push(
  `| 结论一致率（稳定性） | ${reportJson.suite.consistency_rate === null ? "—" : (reportJson.suite.consistency_rate * 100).toFixed(1) + "%"}（${unstable.length} 条不一致） |`
);
L.push(``);
L.push(`## 5. 性能`);
L.push(``);
L.push(`| 指标 | P50 | P95 |`);
L.push(`| --- | --- | --- |`);
L.push(
  `| 端到端时延(ms) | ${reportJson.performance.latency_p50_ms ?? "—"} | ${reportJson.performance.latency_p95_ms ?? "—"} |`
);
L.push(
  `| input token | ${reportJson.performance.token_input_p50 ?? "—"} | ${reportJson.performance.token_input_p95 ?? "—"} |`
);
L.push(
  `| output token | ${reportJson.performance.token_output_p50 ?? "—"} | ${reportJson.performance.token_output_p95 ?? "—"} |`
);
L.push(``);
L.push(
  `单 case 工具调用次数：${reportJson.performance.tool_calls_min ?? "—"} ～ ${reportJson.performance.tool_calls_max ?? "—"}`
);
L.push(``);
if (regression.length) {
  L.push(`## 6. 与基线的回归 diff`);
  L.push(``);
  L.push(`| Case | 基线 | 本次 |`);
  L.push(`| --- | --- | --- |`);
  for (const r of regression) L.push(`| ${r.caseId} | ${r.before} | ${r.after} |`);
  L.push(``);
}
L.push(`## 7. 跑完要清理的真实资源`);
L.push(``);
const withRes = aggregates.filter((a) => a.runs.some((r) => r.resourceIds.length));
if (!withRes.length) L.push(`本次没有采集到资源 ID。`);
else {
  L.push(`| Case | 资源 ID |`);
  L.push(`| --- | --- |`);
  for (const a of withRes)
    L.push(
      `| ${a.caseId} | ${[...new Set(a.runs.flatMap((r) => r.resourceIds))].slice(0, 8).join("<br>")} |`
    );
}
L.push(``);
L.push(`> 日程可按 event_id 取消；文档和消息没有删除工具，需要人工按暗号搜出来删。`);

await mkdir(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const jsonPath = resolve(outDir, `report-${stamp}.json`);
const mdPath = resolve(outDir, `report-${stamp}.md`);
await writeFile(jsonPath, JSON.stringify(reportJson, null, 2) + "\n");
await writeFile(mdPath, L.join("\n") + "\n");
console.log(
  JSON.stringify(
    {
      json: jsonPath,
      md: mdPath,
      cases: aggregates.length,
      hard_gate_pass: hardGatePass,
      effective: effective.length
    },
    null,
    2
  )
);
db.close();
