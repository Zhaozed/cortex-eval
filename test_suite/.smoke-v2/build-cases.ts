/**
 * 飞书 E2E v2 用例构建器。
 *
 * 输入：
 *   · scenarios.v2.json       55 条口语化场景（含 blockedIf / dimensions / expected）
 *   · bindings.v2.json        真实自然值：32 条 fixtures + 7 个 preflight 开关 + global.codeword + cases[].sid
 *   · rules/index.ts          37 个评测子项（D1–D6）的断言生成器
 * 输出：
 *   · .local/<run_label>/r<N>/cases.v2.ready.jsonl   可直接导入平台的用例（contract cortex.case-definition.v1）
 *   · .local/<run_label>/r<N>/manifest.v2.ready.json 构建回执（含 BLOCKED 清单）
 *
 * 取值链路（唯一真相源 readiness.ts）：
 *   prompt 里的 {{token}} ← fixtures[key].value（key↔token 映射见 fixtures.ts）；{{codeword}} ← global.codeword.value。
 *   bindings.cases[id].tokens 只是「镜像」，若与 fixture 推导值不一致就直接报错，绝不静默采用其中一边。
 *
 * sid：多轮 case 的会话 id 由本脚本按 `<run_label>-<caseId>-r<runIndex>` 自动生成。
 *      client 模式是 STANDARD 会话语义，同一 sid 跨 run 复用会把上一轮上下文带进来，
 *      所以「同一条 case 跑 3 次」必须用 3 个不同的 run_index 各构建一次（run-all.sh 已封装）。
 *
 * 本脚本只做本地文件构建与校验：不联网、不调用 Agent、不创建任何真实飞书资源。
 * 规则源：test_suite/feishu-e2e-v2/SPEC.md（冲突时以 SPEC 为准）。
 */
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CaseAuthoringV1Schema } from "../../packages/contracts/src/case-authoring-contracts.ts";
import { FIXTURES, FIXTURE_KEYS, TOKEN_TO_FIXTURE, findFixture } from "./fixtures.ts";
import { createReadiness, domainOf, FLAG_PATHS, PROBE_ONLY_FIXTURES, getPath, nonEmpty, type Readiness } from "./readiness.ts";
import { assertionAuthoringIssue, ASSERTION_ISSUES } from "../../packages/contracts/src/assertion-rules/authoring-validation.ts";

const dir = dirname(fileURLToPath(import.meta.url));
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const readJson = async (p: string) => JSON.parse(await readFile(p, "utf8"));

/* ------------------------------------------------------------------ CLI */
const argv = process.argv.slice(2);
const optIndex = (name: string) => argv.indexOf(name);
const optValue = (name: string): string | undefined => {
  const i = optIndex(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const bindingsPath = optValue("--bindings") ? resolve(optValue("--bindings")!) : null;
const outOverride = optValue("--out") ? resolve(optValue("--out")!) : null;
const allowDirty = argv.includes("--allow-dirty");
/** 前置没备齐时只构建就绪的那部分（其余记入 manifest.blocked，不算失败） */
const skipBlocked = argv.includes("--skip-blocked");
/** 第几次重复运行（1..runs_per_case）。多轮 case 的 sid 按它区分，禁止跨 run 复用 */
const runIndexRaw = optValue("--run-index") ?? "1";
const runIndex = Number(runIndexRaw);
const ready = Boolean(bindingsPath);
const VALUE_OPTS = ["--bindings", "--out", "--run-index"];
for (const [i, a] of argv.entries())
  if (!["--allow-dirty", "--skip-blocked", ...VALUE_OPTS].includes(a) && !VALUE_OPTS.includes(argv[i - 1] ?? ""))
    throw new Error(
      `未知参数：${a}\n用法：tsx build-cases.ts [--bindings /abs/bindings.v2.json] [--out /abs/cases.jsonl] [--run-index 1] [--skip-blocked] [--allow-dirty]`
    );
if (!Number.isSafeInteger(runIndex) || runIndex < 1 || runIndex > 20)
  throw new Error(`--run-index 必须是 1..20 的整数，实为 ${runIndexRaw}`);

/* --------------------------------------------------------------- Inputs */
const suiteConfig = await readJson(resolve(dir, "suite-config.json"));
const scenarioDoc = await readJson(resolve(dir, "scenarios.v2.json"));
const scenarios: any[] = scenarioDoc.cases;
if (!Array.isArray(scenarios) || !scenarios.length) throw new Error("scenarios.v2.json 顶层缺 cases 数组");

const bindings = ready ? await readJson(bindingsPath!) : null;
const template = await readJson(resolve(dir, "bindings.v2.template.json")).catch(() => null);
/** 就绪度判定：与 scripts/preflight.ts 共用 readiness.ts，两边结论必须一致 */
const R: Readiness | null = ready ? createReadiness(bindings, "bindings.v2.json") : null;
const runLabel = ready ? String(bindings?.run_label ?? "") : "";
const runsPerCase = Number(suiteConfig?.scoring?.runs_per_case ?? 3);
if (ready && !/^[A-Za-z0-9_-]{3,40}$/.test(runLabel))
  throw new Error(`bindings.v2.json 的 run_label 非法（${JSON.stringify(runLabel)}）：要 3-40 位字母数字下划线连字符，且每个 run_label 只能构建一次`);

/* ------------------------------------------------------- Rules (lazy) */
let buildAssertions: (ctx: any) => any[];
let DIMENSION_IDS: string[];
let dimensionMeta: (id: string) => { layer: string; layerName: string; name: string; hard: boolean };
try {
  const rules: any = await import("./rules/index.ts");
  buildAssertions = rules.buildAssertions;
  DIMENSION_IDS = rules.DIMENSION_IDS;
  dimensionMeta = rules.dimensionMeta;
  if (typeof buildAssertions !== "function" || !Array.isArray(DIMENSION_IDS) || typeof dimensionMeta !== "function")
    throw new Error("rules/index.ts 必须导出 buildAssertions / DIMENSION_IDS / dimensionMeta");
} catch (error) {
  throw new Error(
    `无法加载 test_suite/feishu-e2e-v2/rules/index.ts：${(error as Error).message}\n` +
      `断言生成器是必需的（37 子项 D1.1–D6.7，见 SPEC 第 2 节）。请确认该文件存在且导出签名正确。`
  );
}

/* ------------------------------------------------- Prompt hygiene (R1–R7) */
const DIRTY_PROMPT: [string, RegExp][] = [
  ["R1 URL", /https?:\/\/|www\./i],
  ["R1 内部ID", /\b(ou|oc|om|omm|on)_[A-Za-z0-9]{6,}/],
  ["R1 docx token", /\b[A-Za-z0-9]{20,}\b/],
  ["R1 ISO8601", /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/],
  ["R1 裸时钟ISO", /\d{2}:\d{2}:\d{2}/],
  ["R4 评测标记", /\[EVAL[:：]/i],
  ["R5 题面泄答案", /(如果同名|若有多个|先让我确认|不要猜|不要自己选|别自己猜)/],
  ["R6 评测腔", /(回读|逐字|原样|不要动原文|只读就行|核对一致)/],
  ["工具名泄露", /\b(feishu_[a-z_]+|create_event|update_event|delete_events|get_event|web_search|declare_miss_tool_candidates)\b/],
  ["calendar_id", /@group\.calendar\.|calendar_id/i]
];
function scanPrompt(text: string): string[] {
  const hits: string[] = [];
  for (const [label, re] of DIRTY_PROMPT) if (re.test(text)) hits.push(label);
  return hits;
}

/* --------------------------------------------------- Token substitution */
const unresolvedByCase = new Map<string, Set<string>>();
function substitute(value: any, tokens: Record<string, unknown>, bag: Set<string>): any {
  if (Array.isArray(value)) return value.map((v) => substitute(v, tokens, bag));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, tokens, bag)]));
  if (typeof value !== "string") return value;
  const whole = /^\{\{([a-z_0-9]+)\}\}$/.exec(value);
  if (whole && Object.hasOwn(tokens, whole[1]!)) return tokens[whole[1]!];
  return value.replace(/\{\{([a-z_0-9]+)\}\}/g, (_, k: string) => {
    if (!Object.hasOwn(tokens, k) || tokens[k] === "" || tokens[k] == null) {
      bag.add(k);
      return `BIND_REQUIRED_${k}`;
    }
    const v = tokens[k];
    return typeof v === "string" ? v : JSON.stringify(v);
  });
}

/* ------------------------------------------------------------ Validation */
const errors: string[] = [];
const warnings: string[] = [];
const seenIds = new Set<string>();
const seenSids = new Set<string>();
const domainCount = new Map<string, number>();
const toolSeen = new Set<string>();
const cardSeen = new Set<string>();
const dimensionCount = new Map<string, number>();
/** 每条 case 实际写入 definition 的阈值（per-case 动态计算，用于 manifest 汇总） */
const thresholds: number[] = [];
/** 真正被构建进 jsonl 的 case 覆盖到的工具/卡片（--skip-blocked 时会小于声明覆盖） */
const toolSeenBuilt = new Set<string>();
const cardSeenBuilt = new Set<string>();

const definitions: any[] = [];
const receipts: any[] = [];
/** --skip-blocked 时记在这里：前置没备齐而不构建的 case（不是失败，不进通过率分母） */
const blockedRows: any[] = [];
let endpointWarned = false;

for (const original of scenarios) {
  const id: string = original?.id;
  if (typeof id !== "string" || !id.trim()) {
    errors.push("存在缺 id 的场景");
    continue;
  }
  if (seenIds.has(id)) errors.push(`${id}：case_id 重复`);
  seenIds.add(id);

  const domain = domainOf(original);
  /* 分域字段必须与 id 前缀一致，否则报告里的分域统计会串 */
  /* id 形如 FS2-D01-01 = <domain><序号>-<变体>；domain 必须是 id 前缀且后面紧跟数字 */
  if (!id.startsWith(domain) || !/^\d+-\d+$/.test(id.slice(domain.length)))
    errors.push(`${id}：domain 字段 "${domain}" 与 case_id 前缀不一致（期望 id = ${domain}<NN>-<NN>）`);
  domainCount.set(domain, (domainCount.get(domain) ?? 0) + 1);

  /* 结构检查 */
  const turns = Number(original.turns);
  if (!Number.isSafeInteger(turns) || turns < 1) errors.push(`${id}：turns 必须是正整数`);
  if (!Array.isArray(original.prompt) || original.prompt.length !== turns)
    errors.push(`${id}：prompt 数组长度(${original.prompt?.length})必须等于 turns(${turns})`);
  const multi = turns > 1;
  if (multi && original.executionMode !== "client")
    errors.push(`${id}：多轮必须 executionMode=client（isolated 模式多轮会被 E2E 入口直接拒绝）`);
  if (!multi && original.executionMode !== "isolated")
    errors.push(`${id}：单轮应使用 executionMode=isolated`);
  if (!Array.isArray(original.dimensions) || !original.dimensions.length)
    errors.push(`${id}：dimensions 必须显式声明至少一个子项`);
  for (const d of original.dimensions ?? []) {
    if (!DIMENSION_IDS.includes(d)) errors.push(`${id}：dimensions 含非法子项 ${d}`);
    dimensionCount.set(d, (dimensionCount.get(d) ?? 0) + 1);
  }
  const exp = original.expected ?? {};
  const caseTools = new Set<string>();
  for (const t of exp.tools ?? []) if (t?.tool) caseTools.add(t.tool);
  for (const t of exp.forbidden ?? []) caseTools.add(t);
  for (const t of exp.order ?? []) caseTools.add(t);
  for (const t of Object.keys(exp.allowedWrites ?? {})) caseTools.add(t);
  for (const t of caseTools) toolSeen.add(t);
  if (exp.card) cardSeen.add(exp.card);

  /* prompt 卫生（R1–R7）——对替换前的模板扫描 */
  for (const [ti, p] of (original.prompt ?? []).entries()) {
    const hits = scanPrompt(String(p));
    if (hits.length) errors.push(`${id} 第${ti + 1}轮 prompt 违反 ${[...new Set(hits)].join("、")}：${String(p).slice(0, 80)}…`);
  }

  /* ---------------- 前置就绪度（与 scripts/preflight.ts 同源：readiness.ts） ---------------- */
  const blockers = ready ? R!.caseBlockers(original) : null;
  if (blockers && !blockers.ready) {
    const why = [
      blockers.missingFixtures.length ? `前置未就绪 ${blockers.missingFixtures.join("、")}` : "",
      blockers.missingTokens.length ? `取值缺失 {{${blockers.missingTokens.join("}}、{{")}}}` : "",
      blockers.unknownFixtureKeys.length ? `blockedIf 引用了 fixtures.ts 里不存在的 key ${blockers.unknownFixtureKeys.join("、")}` : "",
      blockers.missingGlobal.length ? `全局开关未打开 ${blockers.missingGlobal.join("、")}` : "",
      blockers.writesNotApproved ? "写入型 case 但 preflight.writes_approved=false" : ""
    ]
      .filter(Boolean)
      .join("；");
    if (skipBlocked) {
      blockedRows.push({ case_id: id, name: original.name, domain, reason: why, ...blockers });
      continue; /* 不构建、不算失败，进 manifest.blocked */
    }
    errors.push(`${id}：前置未就绪 → ${why}`);
  }

  for (const t of caseTools) toolSeenBuilt.add(t);
  if (exp.card) cardSeenBuilt.add(exp.card);

  /* ---------------- token 替换：一律溯源到 fixtures[key].value ---------------- */
  const bag = new Set<string>();
  const tokens: Record<string, unknown> = ready ? R!.resolvedTokens(original) : {};
  const s = substitute(original, tokens, bag);
  if (bag.size) {
    unresolvedByCase.set(id, bag);
    const detail = [...bag]
      .map((t) => {
        const key = R ? R.tokenFixtureKey(t) : null;
        return `{{${t}}}${key ? `（来自 fixtures["${key}"].value）` : "（fixtures.ts 未声明该 token）"}`;
      })
      .join("、");
    if (ready) errors.push(`${id}：取值缺失 ${detail}`);
    else warnings.push(`${id}：草稿态未绑定 ${detail}`);
  }

  /* ---------------- 绑定态强校验 ---------------- */
  let sid: string | undefined;
  if (ready) {
    /* bindings.cases 段已废弃：token 只从 fixtures 推导，sid 由本脚本按 run_index 生成，避免两处不一致 */
    const legacy = bindings?.cases?.[id];
    if (legacy && typeof legacy === "object") {
      if (legacy.tokens) errors.push(`${id}：bindings.cases[${id}].tokens 已废弃（token 一律从 fixtures 推导），请删掉整个 cases 段`);
      if (typeof legacy.sid === "string" && legacy.sid.trim())
        errors.push(`${id}：bindings.cases[${id}].sid 不要手填（sid 由 --run-index 自动生成，手填会导致跨 run 串会话），请删掉整个 cases 段`);
    }
    for (const [k, v] of Object.entries(tokens)) {
      if (typeof v !== "string") continue;
      if (/BIND_REQUIRED_|REPLACE_ME|TODO|填写|example\./i.test(v)) errors.push(`${id}：{{${k}}} 仍是占位值 ${JSON.stringify(v).slice(0, 60)}`);
      if (/\b(ou|oc|om|omm|on)_[A-Za-z0-9]{6,}/.test(v)) errors.push(`${id}：{{${k}}} 不得注入内部 ID（R1）`);
      if (/https?:\/\//.test(v)) errors.push(`${id}：{{${k}}} 不得注入 URL（R1）`);
      if (/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v)) errors.push(`${id}：{{${k}}} 不得注入 ISO8601 时间（R2）`);
    }
    if (multi) {
      sid = `${runLabel}-${id}-r${runIndex}`;
      if (!/^[A-Za-z0-9_.-]{3,120}$/.test(sid)) errors.push(`${id}：自动生成的 sid 非法（${sid}），检查 run_label`);
      if (seenSids.has(sid)) errors.push(`${id}：sid 与其他 case 重复（${sid}）`);
      else seenSids.add(sid);
    }
    /* 端点是「跑」的前置，不是「构建」的前置：构建期只提示，不阻断 */
    if (getPath(bindings, "preflight.endpoint_up") !== true) endpointWarned = true;
  }

  /* 断言生成 */
  let assertions: any[] = [];
  try {
    assertions = buildAssertions({ caseId: id, scenario: s, tokens });
  } catch (error) {
    errors.push(`${id}：buildAssertions 抛错 ${(error as Error).message}`);
    continue;
  }
  if (!Array.isArray(assertions) || !assertions.length) {
    errors.push(`${id}：buildAssertions 返回空`);
    continue;
  }
  let hard = 0;
  let soft = 0;
  for (const a of assertions) {
    if (a.type !== "javascript") errors.push(`${id}：断言类型必须是 javascript，实为 ${a.type}`);
    const m = String(a.metric ?? "");
    if (!/^【(硬性|质量)】D\d\.\d/.test(m)) errors.push(`${id}：metric 命名不符合规范 → ${m}`);
    if (m.startsWith("【硬性】")) {
      hard += 1;
      if (a.weight !== suiteConfig.scoring.hard_weight) errors.push(`${id}：硬性断言 weight 必须=${suiteConfig.scoring.hard_weight}，实为 ${a.weight}`);
    } else {
      soft += 1;
      if (a.weight !== suiteConfig.scoring.soft_weight) errors.push(`${id}：质量断言 weight 必须=${suiteConfig.scoring.soft_weight}，实为 ${a.weight}`);
    }
    const issue = assertionAuthoringIssue(a);
    if (issue) errors.push(`${id}：断言「${m}」未过平台校验 ${issue.code}（${ASSERTION_ISSUES[issue.code]}）`);
  }
  /* ------------- 计分模型自检（per-case 动态阈值，2026-09-15 定稿） -------------
   * 平台真实行为（packages/application/src/features/evaluation/promptfoo-result-importer.ts L474-490）：
   *   score = Σ(断言得分 × weight) / Σweight ；pass = score >= case.threshold
   *   threshold 是「每条 case 自己的」字段（CaseAuthoringV1Schema.threshold，允许 0..1 任意小数）。
   * 所以「一票否决」不取决于硬性条数，而取决于「单条硬性权重占比 > 1 - threshold」。
   * 方案：硬性 weight=20、质量 weight=1，阈值取 lo / hi 的中点：
   *   lo = 挂 1 条硬性时的得分   → 必须 <  threshold（否则一票否决失效）
   *   hi = 质量项全挂时的得分     → 必须 >= threshold（否则质量项会误判死 case）
   * 可行条件：hi > lo ⟺ soft × SW < HW ⟺ 质量项条数有上限（max_soft_per_case）。
   * 断言得分必须二值 0/1（rules/index.ts 已约束），部分分会让得分落在阈值附近产生歧义。 */
  const HW = Number(suiteConfig.scoring.hard_weight);
  const SW = Number(suiteConfig.scoring.soft_weight);
  const minHard = Number(suiteConfig.scoring.min_hard_per_case ?? 1);
  const maxHard = Number(suiteConfig.scoring.max_hard_per_case ?? 37);
  const maxSoft = Number(suiteConfig.scoring.max_soft_per_case ?? 19);
  const total = hard * HW + soft * SW;
  const scoreIf = (hardPass: number, softPass: number) => (total === 0 ? 0 : (hardPass * HW + softPass * SW) / total);
  const f4 = (n: number) => n.toFixed(4);
  const lo = scoreIf(hard - 1, soft);
  const hi = scoreIf(hard, 0);
  const threshold = Number(((lo + hi) / 2).toFixed(6));
  thresholds.push(threshold);
  if (hard < minHard)
    errors.push(`${id}：硬性断言只有 ${hard} 条（下限 ${minHard}）。没有门槛项时总权重为 0，平台会直接判 0 分`);
  if (hard > maxHard)
    errors.push(`${id}：硬性断言 ${hard} 条 > 上限 ${maxHard}（37 个子项的全集），检查 rules 是否对同一子项重复出题`);
  if (soft > maxSoft)
    errors.push(
      `${id}：质量断言 ${soft} 条 > 上限 ${maxSoft}。质量项权重之和必须 < 单条硬性权重（${HW}），` +
        `否则「质量全挂仍 PASS」和「挂 1 条硬性必 FAIL」无法同时成立（合并同类质量项）`
    );
  if (!(threshold > 0 && threshold <= 1)) errors.push(`${id}：算出的阈值 ${threshold} 不在 (0,1] 区间`);
  else if (hard >= minHard && soft <= maxSoft) {
    if (!(hi > lo))
      errors.push(`${id}：硬性${hard}/质量${soft} 无法构造阈值（lo=${f4(lo)} ≥ hi=${f4(hi)}）：减少质量项条数或调大 hard_weight`);
    else {
      if (lo >= threshold)
        errors.push(`${id}：阈值 ${threshold} 失效——挂 1 条硬性得分 ${f4(lo)} 仍 ≥ 阈值，一票否决不成立`);
      if (soft > 0 && hi < threshold)
        errors.push(`${id}：阈值 ${threshold} 失效——质量项全挂得分 ${f4(hi)} < 阈值，质量项会误判死 case`);
    }
  }

  /* request_body */
  const body: any = {
    uid: { __cortex_eval_int64: ready ? String(bindings.uid ?? suiteConfig.default_uid) : suiteConfig.default_uid },
    timezone: suiteConfig.timezone,
    lang: suiteConfig.lang,
    execution_mode: ready ? (multi ? "client" : "isolated") : "client",
    timeout_ms: Math.min(240000, Math.floor(540000 / Math.max(1, turns))),
    ...(multi
      ? { ...(ready && sid ? { sid } : {}), conversation: (s.prompt ?? []).map((t: string) => ({ role: "user", text: t })) }
      : { text: (s.prompt ?? [])[0] })
  };

  const domainName = (suiteConfig.domains as Record<string, string>)[domain] ?? domain;
  const definition = CaseAuthoringV1Schema.parse({
    contractVersion: "cortex.case-definition.v1",
    description: `${ready ? "" : "[待绑定]｜"}${original.priority ?? "P1"}｜${id}｜${original.name ?? ""}｜硬性${hard}·质量${soft}`,
    threshold,
    vars: { task: "agent-e2e", request_body: body },
    metadata: {
      case_id: id,
      req_id: `feishu2_${id}`,
      task_id: `feishu2_${id}`,
      business_module: `飞书v2-${domain}`,
      scenario_tag: `feishu-v2-${domain.toLowerCase()}${ready ? "" : "-unbound"}`,
      a2ui_capture: true
    },
    assert: assertions
  });
  definitions.push(definition);
  receipts.push({
    case_id: id,
    domain,
    domain_name: domainName,
    name: original.name,
    turns,
    execution_mode: body.execution_mode,
    hard_assertions: hard,
    soft_assertions: soft,
    dimensions: original.dimensions,
    expected_card: exp.card ?? null,
    side_effect: original.side_effect ?? original.sideEffect ?? false,
    blocked_if: original.blockedIf ?? [],
    unresolved_tokens: [...bag],
    cleanup: original.cleanup ?? null,
    definition_sha256: sha(JSON.stringify(definition))
  });
}

/* ------------------------------------------------------- Suite-level QC */
for (const [d, want] of Object.entries(suiteConfig.domain_counts as Record<string, number>)) {
  const got = domainCount.get(d) ?? 0;
  if (got !== want) errors.push(`分域计数不符：${d} 期望 ${want} 条，实际 ${got} 条`);
}
const expectedTotal = Number(suiteConfig.expected_case_count ?? 55);
if (definitions.length + blockedRows.length !== expectedTotal)
  errors.push(`总条数期望 ${expectedTotal}，实际构建 ${definitions.length} + 跳过 ${blockedRows.length}`);
if (definitions.length === 0) errors.push("一条都没构建出来（全部被前置卡住？）：先按 preflight-todo.md 补前置，或检查 bindings.v2.json");
if (toolSeen.size < suiteConfig.target_tool_coverage)
  warnings.push(`声明的工具覆盖 ${toolSeen.size}/${suiteConfig.target_tool_coverage}（低于目标不阻断，但需在报告里说明）`);
if (toolSeenBuilt.size < toolSeen.size)
  warnings.push(`本次实际构建的工具覆盖只有 ${toolSeenBuilt.size}/${toolSeen.size}：差的 ${[...toolSeen].filter((t) => !toolSeenBuilt.has(t)).join("、")} 全在被跳过的 case 里`);
for (const d of DIMENSION_IDS) if (!dimensionCount.has(d)) warnings.push(`子项 ${d} 没有任何 case 声明，等于没被评测`);
if (blockedRows.length)
  warnings.push(`--skip-blocked：跳过 ${blockedRows.length} 条前置未就绪的 case（详见 manifest.blocked），它们不算失败、不进通过率分母`);
if (endpointWarned)
  warnings.push("preflight.endpoint_up 还不是 true：构建可以继续，但跑之前必须启动 8080 端点并把这个开关打开");
if (ready && !skipBlocked && blockedRows.length === 0 && R) {
  const gm = R.globalMissingAll();
  if (gm.length) warnings.push(`全局开关仍缺：${gm.join("、")}（构建期不阻断，跑之前要补齐）`);
}

if (errors.length && !allowDirty) {
  console.error(`构建失败：${errors.length} 处问题`);
  for (const e of errors.slice(0, 80)) console.error(`  · ${e}`);
  if (errors.length > 80) console.error(`  …另有 ${errors.length - 80} 处`);
  process.exitCode = 1;
  throw new Error("BUILD_FAILED");
}

/* ------------------------------------------------------------- Output */
const outDir = outOverride ? dirname(outOverride) : ready ? resolve(dir, ".local", runLabel, `r${runIndex}`) : dir;
const outPath = outOverride ?? resolve(outDir, ready ? "cases.v2.ready.jsonl" : "cases.v2.draft.jsonl");
await mkdir(outDir, { recursive: true });
if (ready) {
  let exists = true;
  try {
    await access(outPath);
  } catch {
    exists = false;
  }
  if (exists && !allowDirty)
    throw new Error(
      `${outPath} 已存在。同一个 run_label + run_index 只能构建一次（多轮 sid 与暗号都不能复用）；\n` +
        `换 --run-index ${runIndex + 1} 构建下一次重复运行，或换新的 run_label，或加 --allow-dirty 显式覆盖。`
    );
}
const data = definitions.map((c) => JSON.stringify(c)).join("\n") + "\n";
await writeFile(outPath, data);

const manifest = {
  version: "2.0",
  generated_at: new Date().toISOString(),
  state: ready ? "BOUND_NOT_EXECUTED" : "DRAFT_UNBOUND",
  run_label: ready ? runLabel : null,
  run_index: ready ? runIndex : null,
  runs_per_case: runsPerCase,
  skip_blocked: skipBlocked,
  cases: definitions.length,
  blocked: blockedRows.length,
  blocked_detail: blockedRows.map((b) => ({
    case_id: b.case_id,
    name: b.name,
    domain: b.domain,
    reason: b.reason,
    missing_fixtures: b.missingFixtures,
    missing_tokens: b.missingTokens,
    missing_global: b.missingGlobal,
    unknown_fixture_keys: b.unknownFixtureKeys
  })),
  hard_assertions: receipts.reduce((n, r) => n + r.hard_assertions, 0),
  soft_assertions: receipts.reduce((n, r) => n + r.soft_assertions, 0),
  domains: Object.fromEntries(domainCount),
  tool_coverage: [...toolSeen].sort(),
  tool_coverage_count: toolSeen.size,
  tool_coverage_built: [...toolSeenBuilt].sort(),
  tool_coverage_built_count: toolSeenBuilt.size,
  card_coverage: [...cardSeen].sort(),
  card_coverage_built: [...cardSeenBuilt].sort(),
  sid_policy: ready ? `自动生成：<run_label>-<caseId>-r<run_index>（本次 r${runIndex}）` : null,
  fixtures_snapshot: ready
    ? Object.fromEntries(
        FIXTURE_KEYS.map((k) => [k, { state: R!.fixtureState(k), flag_path: FLAG_PATHS[k] ?? null }])
      )
    : null,
  dimension_declaration_count: Object.fromEntries([...dimensionCount].sort()),
  sha256: sha(data),
  endpoint_id: suiteConfig.endpoint_id,
  threshold_policy: {
    mode: suiteConfig.scoring.threshold_mode ?? "per_case_midpoint",
    hard_weight: Number(suiteConfig.scoring.hard_weight),
    soft_weight: Number(suiteConfig.scoring.soft_weight),
    formula: "threshold = round((lo+hi)/2, 6)；lo=挂1条硬性的得分，hi=质量项全挂的得分；pass = score >= threshold",
    min: thresholds.length ? Number(Math.min(...thresholds).toFixed(6)) : null,
    max: thresholds.length ? Number(Math.max(...thresholds).toFixed(6)) : null
  },
  warnings,
  errors: allowDirty ? errors : [],
  entries: receipts
};
await writeFile(resolve(outDir, ready ? "manifest.v2.ready.json" : "manifest.v2.draft.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(
  JSON.stringify(
    {
      output: outPath,
      run_index: ready ? runIndex : null,
      cases: definitions.length,
      blocked: blockedRows.length,
      hard: manifest.hard_assertions,
      soft: manifest.soft_assertions,
      tools: manifest.tool_coverage_count,
      state: manifest.state,
      warnings: warnings.length,
      errors: errors.length
    },
    null,
    2
  )
);
