/**
 * 飞书 E2E v2 跑前体检。
 *
 * 用法：
 *   npx tsx test_suite/feishu-e2e-v2/scripts/preflight.ts                # 只做静态检查（不联网、不碰飞书）
 *   npx tsx test_suite/feishu-e2e-v2/scripts/preflight.ts --probe        # 额外做真实探测（HTTP 端点 + lark-cli 只读）
 *   npx tsx test_suite/feishu-e2e-v2/scripts/preflight.ts --bindings <路径>  # 指定 bindings.v2.json
 *
 * 输出：
 *   · 控制台中文体检报告 + 「明天要做什么」清单
 *   · test_suite/feishu-e2e-v2/preflight-report.json（机器可读）
 *
 * 本脚本永远不写任何真实飞书资源；--probe 只跑只读命令。
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FIXTURES, FIXTURE_KEYS, TOKEN_TO_FIXTURE, findFixture, type Fixture } from "../fixtures.ts";
import { createReadiness, domainOf, FLAG_PATHS, PROBE_ONLY_FIXTURES, getPath, nonEmpty, type FixtureState } from "../readiness.ts";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

/* --------------------------------------------------------------- CLI */
const argv = process.argv.slice(2);
const doProbe = argv.includes("--probe");
const bIdx = argv.indexOf("--bindings");
const bindingsPath = bIdx >= 0 ? resolve(argv[bIdx + 1] ?? "") : resolve(root, "bindings.v2.json");
const templatePath = resolve(root, "bindings.v2.template.json");
const scenariosPath = resolve(root, "scenarios.v2.json");
const suitePath = resolve(root, "suite-config.json");

const readJsonSafe = async (p: string): Promise<any | null> => {
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch {
    return null;
  }
};

type State = "READY" | "MISSING" | "UNKNOWN";
interface FixtureStatus {
  key: string;
  name: string;
  group: string;
  severity: Fixture["severity"];
  state: State;
  evidence: string;
  neededBy: string[];
  howToPrepare: string;
  sideEffect: boolean;
}

const suiteConfig = await readJsonSafe(suitePath);
const scenarioDoc = await readJsonSafe(scenariosPath);
const template = await readJsonSafe(templatePath);
const bindings = await readJsonSafe(bindingsPath);

const report: any = {
  generated_at: new Date().toISOString(),
  mode: doProbe ? "static+probe" : "static",
  verdict: "UNKNOWN",
  files: {
    "suite-config.json": Boolean(suiteConfig),
    "scenarios.v2.json": Boolean(scenarioDoc),
    "bindings.v2.template.json": Boolean(template),
    "bindings.v2.json": Boolean(bindings),
    "rules/index.ts": null as boolean | null
  },
  endpoint: { up: null as boolean | null, detail: "" },
  bindings: {} as any,
  fixtures: [] as FixtureStatus[],
  cases: {} as any,
  todo: [] as any[],
  summary_zh: ""
};

/* rules/index.ts 是否存在 */
try {
  await import("../rules/index.ts");
  report.files["rules/index.ts"] = true;
} catch {
  report.files["rules/index.ts"] = false;
}

/* ------------------------------------------------- 场景 & token 收集 */
const scenarios: any[] = scenarioDoc?.cases ?? [];
const tokenRe = /\{\{([a-z_]+)\}\}/g;
const tokensByCase = new Map<string, Set<string>>();
const allTokens = new Set<string>();
const fixtureUse = new Map<string, string[]>();
const unknownFixtureKeys = new Map<string, string[]>();

for (const s of scenarios) {
  const bag = new Set<string>();
  for (const p of s?.prompt ?? []) for (const m of String(p).matchAll(tokenRe)) bag.add(m[1]!);
  for (const [k, v] of Object.entries(s?.expected ?? {})) {
    for (const m of JSON.stringify(v).matchAll(tokenRe)) bag.add(m[1]!);
  }
  tokensByCase.set(s.id, bag);
  for (const t of bag) allTokens.add(t);
  for (const key of s?.blockedIf ?? []) {
    if (!findFixture(key)) {
      const arr = unknownFixtureKeys.get(key) ?? [];
      arr.push(s.id);
      unknownFixtureKeys.set(key, arr);
      continue;
    }
    const arr = fixtureUse.get(key) ?? [];
    arr.push(s.id);
    fixtureUse.set(key, arr);
  }
}

/* --------------------------------------------------- bindings 检查 */
/**
 * bindings.v2.json 结构（与 bindings.v2.template.json 完全一致）：
 *   { uid, sid, run_label,
 *     global:   { codeword: { value, desc, filled } },
 *     fixtures: { "<canonicalKey>": { value, desc, filled, needed_by[], token } },
 *     preflight:{ writes_approved, send_whitelist_confirmed, cleanup_confirmed, room_bookable } }
 *
 * prompt 里的 {{token}} 一律溯源到 fixtures[key].value（token 名见 fixtures.ts 的 token 字段），
 * 唯一例外是 {{codeword}} 来自 global.codeword.value。
 * 没有 bindings.v2.json 时退回读模板，只做静态一致性检查（所有 filled=false 都会被判 MISSING）。
 */
const src: any = bindings ?? template;
const srcLabel = bindings ? "bindings.v2.json" : "bindings.v2.template.json（模板，仅供静态检查）";
const boundFixtures: Record<string, any> = src?.fixtures ?? {};
const templateFixtures: Record<string, any> = template?.fixtures ?? {};
/* 就绪判定全部来自 readiness.ts（唯一真相源）；本脚本只负责探测、报告、待办文案 */
const R = createReadiness(src, srcLabel);
const { fixtureReady, tokenFixtureKey, isFilled } = R;
const get = getPath;
const missingTokens = [...allTokens].filter((t) => !isFilled(t)).sort();
const undeclaredTokens = [...allTokens].filter((t) => !tokenFixtureKey(t)).sort();
/** 7 个开关型前置只在 preflight.* 里表态，不该再出现在 fixtures 段（两处填=歧义） */
const FLAG_KEYS = Object.keys(FLAG_PATHS);
/** 非开关型前置（值型 / 条件型），bindings.fixtures 必须正好是这些 key */
const DATA_FIXTURE_KEYS = FIXTURE_KEYS.filter((k) => !FLAG_KEYS.includes(k));

/* 三方 key 一致性：fixtures.ts ↔ template ↔ bindings ↔ scenarios.blockedIf */
const templateKeys = Object.keys(templateFixtures);
const boundKeys = Object.keys(boundFixtures);
const sortedJoin = (a: Iterable<string>) => [...a].sort().join(",");
const keyDiff = {
  missing_in_template: DATA_FIXTURE_KEYS.filter((k) => !templateKeys.includes(k)),
  extra_in_template: templateKeys.filter((k) => !DATA_FIXTURE_KEYS.includes(k)),
  /* 开关型前置写进了 fixtures 段 → 用户会不知道该填哪一处 */
  flag_keys_inside_fixtures: FLAG_KEYS.filter((k) => templateKeys.includes(k)),
  missing_preflight_flags: FLAG_KEYS.filter((k) => typeof get(template, FLAG_PATHS[k]!) !== "boolean"),
  missing_in_bindings: bindings ? DATA_FIXTURE_KEYS.filter((k) => !boundKeys.includes(k)) : [],
  extra_in_bindings: boundKeys.filter((k) => !DATA_FIXTURE_KEYS.includes(k)),
  missing_preflight_flags_in_bindings: bindings ? FLAG_KEYS.filter((k) => typeof get(bindings, FLAG_PATHS[k]!) !== "boolean") : [],
  token_name_mismatch: FIXTURES.filter((f) => f.token && templateFixtures[f.key] && templateFixtures[f.key].token !== f.token).map((f) => f.key),
  needed_by_mismatch: FIXTURE_KEYS.filter((k) => {
    const entry = templateFixtures[k];
    if (!entry || !Array.isArray(entry.needed_by)) return false;
    const declared = sortedJoin(entry.needed_by.filter((x: string) => !FIXTURES.find((f) => f.global && f.key === x)));
    const actual = sortedJoin(fixtureUse.get(k) ?? []);
    return declared !== actual;
  })
};

report.bindings = {
  present: Boolean(bindings),
  source: srcLabel,
  path: bindingsPath,
  run_label: src?.run_label ?? null,
  run_label_ok: /^[A-Za-z0-9_-]{3,40}$/.test(String(src?.run_label ?? "")) && !/REPLACE_ME/i.test(String(src?.run_label ?? "")),
  uid: src?.uid ?? null,
  uid_ok: /^[1-9]\d{0,18}$/.test(String(src?.uid ?? "")),
  fixtures_declared_in_code: FIXTURES.length,
  fixtures_flag_backed: FLAG_KEYS.length,
  fixtures_data_backed: DATA_FIXTURE_KEYS.length,
  fixtures_in_template: templateKeys.length,
  fixtures_in_bindings: boundKeys.length,
  fixtures_ready: FIXTURE_KEYS.filter((k) => fixtureReady(k)).length,
  key_consistency: keyDiff,
  tokens_used_by_cases: allTokens.size,
  tokens_filled: [...allTokens].filter(isFilled).length,
  tokens_missing: missingTokens,
  tokens_not_declared_in_template: undeclaredTokens,
  preflight_flags: src?.preflight ?? null
};

/* ------------------------------------------------------ 端点探测 */
const endpointUrl = suiteConfig?.endpoint_url ?? "http://127.0.0.1:8080/eval/e2e";
if (doProbe) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(endpointUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: "{}",
      signal: controller.signal
    });
    report.endpoint = { up: true, detail: `HTTP ${res.status}（端点存活；空 body 被拒是预期行为）` };
  } catch (error) {
    const msg = (error as Error).message ?? String(error);
    report.endpoint = {
      up: false,
      detail: /abort/i.test(msg) ? "连接超时（5s）" : `连不上：${msg}`
    };
  } finally {
    clearTimeout(timer);
  }
} else {
  report.endpoint = { up: null, detail: "静态模式未探测；加 --probe 才会真的连一次 8080" };
}

/* ------------------------------------------- lark-cli 只读探测 */
async function runLark(argsv: string[]): Promise<{ ok: boolean; detail: string }> {
  try {
    const { stdout } = await execFileAsync("lark-cli", argsv, { timeout: 25000, maxBuffer: 8 * 1024 * 1024 });
    const text = stdout.trim();
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* 非 JSON 输出 */
    }
    if (parsed && parsed.ok === false)
      return { ok: false, detail: `${parsed?.error?.subtype ?? "error"}：${parsed?.error?.message ?? text.slice(0, 160)}` };
    if (parsed && parsed.ok === true) return { ok: true, detail: text.slice(0, 160) };
    return { ok: true, detail: text.slice(0, 160) || "命令返回空输出" };
  } catch (error: any) {
    const out = String(error?.stdout ?? error?.stderr ?? error?.message ?? error).slice(0, 240);
    return { ok: false, detail: out };
  }
}

/* ---------------------------------------------- fixture 状态判定 */
const statuses: FixtureStatus[] = [];
for (const f of FIXTURES) {
  const neededBy = f.global
    ? f.gate === "prep"
      ? []
      : scenarios.filter((s: any) => R.gateApplies(f.gate, { writes: R.writes(s), sends: R.sends(s) })).map((s: any) => s.id)
    : fixtureUse.get(f.key) ?? [];
  const base: FixtureStatus = {
    key: f.key,
    name: f.name,
    group: f.group,
    severity: f.severity,
    state: "UNKNOWN",
    evidence: "",
    neededBy,
    howToPrepare: f.howToPrepare,
    sideEffect: f.sideEffect
  };

  /* 端点：开关 + --probe 双证据。probe 说连不上时，开关开了也算 MISSING */
  if (f.key === "auth.endpoint_up") {
    const flagOn = get(src, "preflight.endpoint_up") === true;
    if (report.endpoint.up === true) statuses.push({ ...base, state: "READY", evidence: `--probe 真连通过：${report.endpoint.detail}` });
    else if (report.endpoint.up === false)
      statuses.push({ ...base, state: "MISSING", evidence: `--probe 真连失败：${report.endpoint.detail}（开关是 ${flagOn} 也没用，先把服务起起来）` });
    else if (flagOn) statuses.push({ ...base, state: "READY", evidence: "preflight.endpoint_up === true（未 --probe 复核；开跑前建议加 --probe 真连一次）" });
    else statuses.push({ ...base, state: "MISSING", evidence: "preflight.endpoint_up 还是 false：先启动 8080 端点，再把开关改成 true" });
    continue;
  }

  /* 开关型：读 preflight flag */
  const flagPath = FLAG_PATHS[f.key];
  if (flagPath) {
    const v = get(src, flagPath);
    statuses.push(
      v === true
        ? { ...base, state: "READY", evidence: `${flagPath} === true` }
        : { ...base, state: "MISSING", evidence: `${srcLabel} 的 ${flagPath} 当前是 ${JSON.stringify(v ?? null)}，需要改成 true` }
    );
    continue;
  }

  const entry = boundFixtures[f.key];
  /* bindings 里没这一条 → key 不一致，属于必须先修的数据问题 */
  if (!entry) {
    statuses.push({
      ...base,
      state: "MISSING",
      evidence: `${srcLabel} 的 fixtures 里没有 "${f.key}" 这一条（key 与 fixtures.ts 不一致，先修数据再跑）`
    });
    continue;
  }

  /* 值型 / 条件型：先看 filled(+value) */
  const declared = fixtureReady(f.key);
  let state: State = declared ? "READY" : "MISSING";
  let evidence = declared
    ? f.token
      ? `已确认：{{${f.token}}} = ${JSON.stringify(entry.value).slice(0, 90)}`
      : "已确认（条件型前置，filled=true）"
    : f.token
      ? `未填：fixtures["${f.key}"].value 要填自然值，并把 filled 改成 true`
      : `未确认：把 fixtures["${f.key}"].filled 改成 true（前提是现实里真的成立）`;

  /* --probe：用只读命令复核。探测失败可以把 READY 降级，但绝不把 MISSING 升级成 READY */
  if (doProbe && declared && f.probe?.kind === "lark") {
    const argvRaw = f.probe.target as string[];
    const argsv = argvRaw.map((a) => (a.startsWith("<") ? "" : a)).filter(Boolean);
    if (argsv.length !== argvRaw.length) {
      evidence += "；探测命令含占位参数，需人工执行";
    } else {
      const res = await runLark(argsv);
      evidence += res.ok ? `；只读探测通过：${res.detail}` : "";
      if (!res.ok) {
        state = "MISSING";
        evidence = `bindings 说已就绪，但只读探测失败：${res.detail}`;
      }
    }
  } else if (doProbe && f.probe?.kind === "manual") {
    evidence += `；仍需人工确认：${f.probe.passIf}`;
  }
  statuses.push({ ...base, state, evidence });
}
report.fixtures = statuses;

/* --------------------------------------------------- case 级就绪度 */
/**
 * 一条 case 就绪 = ① 它 blockedIf 里每个前置都 READY
 *                ② 它 prompt 用到的每个 {{token}} 都能取到非占位值（token 隐含依赖对应 fixture）
 *                ③ 所有 case 共用 bindings.v2.json 顶层真实 uid/sid，缺失即 BLOCKED
 *                ④ 全局前置（auth.*）全 READY —— 这一条不满足时所有 case 都跑不了
 * 任何一条不满足 → BLOCKED（不是 FAIL），报告里单独计数，不进通过率分母。
 */
/* 探测结果作为 override：--probe 可以把「开关说就绪」打回 MISSING */
const probeOverride = new Map<string, FixtureState>();
for (const st of statuses) if (PROBE_ONLY_FIXTURES.includes(st.key) || st.evidence.includes("只读探测")) probeOverride.set(st.key, st.state === "READY" ? "READY" : "MISSING");
for (const st of statuses) if (PROBE_ONLY_FIXTURES.includes(st.key)) probeOverride.set(st.key, st.state);
const globalMissing = R.globalMissingAll(probeOverride);
const caseRows: any[] = [];
for (const s of scenarios) {
  const b = R.caseBlockers(s, probeOverride);
  caseRows.push({
    case_id: s.id,
    name: s.name,
    domain: domainOf(s),
    turns: s.turns,
    execution_mode: s.executionMode,
    state: b.ready ? "READY" : "BLOCKED",
    missing_global: b.missingGlobal,
    missing_tokens: b.missingTokens,
    missing_uid: b.missingUid,
    missing_fixtures: b.missingFixtures,
    unknown_fixture_keys: b.unknownFixtureKeys,
    missing_sid: b.missingSid,
    writes_not_approved: b.writesNotApproved,
    uid: src?.uid ?? null,
    sid: src?.sid ?? null,
    side_effect: Boolean(s.sideEffect ?? s.side_effect),
    cleanup: s.cleanup ?? null
  });
}
report.cases = {
  total: caseRows.length,
  ready: caseRows.filter((c) => c.state === "READY").length,
  blocked: caseRows.filter((c) => c.state === "BLOCKED").length,
  blocked_by_global_only: caseRows.filter((c) => c.state === "BLOCKED" && c.missing_fixtures.length === 0 && c.missing_tokens.length === 0 && !c.missing_uid && !c.missing_sid && c.unknown_fixture_keys.length === 0).length,
  blocked_by_flags_only: caseRows.filter((c) => c.state === "BLOCKED" && c.missing_fixtures.length === 0 && c.missing_tokens.length === 0 && !c.missing_uid && !c.missing_sid && c.unknown_fixture_keys.length === 0 && c.missing_global.every((k: string) => FLAG_KEYS.includes(k))).length,
  detail: caseRows
};

/* ------------------------------------------------------ 待办清单 */
const todo: any[] = [];
let order = 1;
for (const st of statuses.filter((x) => x.state !== "READY")) {
  if (st.neededBy.length === 0 && st.severity !== "MUST") continue;
  todo.push({
    order: order++,
    group: st.group,
    severity: st.severity,
    key: st.key,
    title: st.name,
    state: st.state,
    evidence: st.evidence,
    blocks_cases: st.neededBy.length,
    blocked_case_ids: st.neededBy.slice(0, 12),
    side_effect: st.sideEffect,
    action: st.howToPrepare
  });
}
for (const t of missingTokens) {
  const fkey = tokenFixtureKey(t);
  /* 同一个前置只出一条待办：fixture 条目已经说清怎么填了，token 条目就是重复噪音 */
  if (fkey && todo.some((x) => x.key === fkey)) continue;
  const f = fkey ? findFixture(fkey) : undefined;
  const entry = templateFixtures[fkey ?? ""] ?? {};
  const ids = scenarios.filter((s: any) => (tokensByCase.get(s.id) ?? new Set<string>()).has(t)).map((s: any) => s.id);
  todo.push({
    order: order++,
    group: "7. bindings.v2.json 待填自然值",
    severity: f?.severity ?? "MUST",
    key: `token:${t}`,
    title: `填 {{${t}}}（来自前置 ${fkey ?? "未声明"}）`,
    state: "MISSING",
    evidence: entry.desc ?? f?.what ?? "模板里没写说明",
    blocks_cases: ids.length,
    blocked_case_ids: ids.slice(0, 12),
    side_effect: Boolean(f?.sideEffect),
    action:
      `编辑 ${bindingsPath} → fixtures["${fkey ?? t}"].value = <自然值>，并把 filled 改成 true\n` +
      `说明：${f?.howToPrepare ?? "（fixtures.ts 缺该项定义）"}`
  });
}
for (const [label, arr] of Object.entries(keyDiff) as [string, string[]][]) {
  if (!arr.length) continue;
  todo.push({
    order: order++,
    group: "8. 数据不一致（必须先修）",
    severity: "MUST",
    key: `keydiff:${label}`,
    title: `bindings/template 与 fixtures.ts 的 key 不一致：${label}`,
    state: "MISSING",
    evidence: arr.join("、"),
    blocks_cases: scenarios.length,
    blocked_case_ids: [],
    side_effect: false,
    action: `以 fixtures.ts 的 ${FIXTURES.length} 个 canonical key 为准，修 bindings.v2.template.json / bindings.v2.json 的 fixtures 段`
  });
}
for (const [key, ids] of unknownFixtureKeys) {
  todo.push({
    order: order++,
    group: "8. 数据不一致（必须先修）",
    severity: "MUST",
    key: `unknown-fixture:${key}`,
    title: `scenarios.v2.json 引用了 fixtures.ts 里没有的前置 key：${key}`,
    state: "MISSING",
    evidence: `涉及 case：${ids.join("、")}`,
    blocks_cases: ids.length,
    blocked_case_ids: ids,
    side_effect: false,
    action: `在 fixtures.ts 里补 ${key} 的定义，或把 scenarios.v2.json 里的 ${key} 改成 canonical key`
  });
}
if (!report.files["bindings.v2.json"])
  todo.unshift({
    order: 0,
    group: "0. 端点与运行环境",
    severity: "MUST",
    key: "bindings.v2.json",
    title: "bindings.v2.json 还不存在",
    state: "MISSING",
    evidence: `期望路径：${bindingsPath}`,
    blocks_cases: scenarios.length,
    blocked_case_ids: scenarios.map((s) => s.id).slice(0, 12),
    side_effect: false,
    action: `cp ${templatePath} ${bindingsPath}  然后逐项填 value`
  });
if (report.files["rules/index.ts"] === false)
  todo.unshift({
    order: 0,
    group: "8. 数据不一致（必须先修）",
    severity: "MUST",
    key: "rules/index.ts",
    title: "断言生成器 rules/index.ts 缺失",
    state: "MISSING",
    evidence: "build-cases.ts 无法生成 37 子项断言",
    blocks_cases: scenarios.length,
    blocked_case_ids: [],
    side_effect: false,
    action: "补 test_suite/feishu-e2e-v2/rules/index.ts（见 SPEC 第 2、7 节）"
  });
if (undeclaredTokens.length)
  todo.unshift({
    order: 0,
    group: "8. 数据不一致（必须先修）",
    severity: "MUST",
    key: "undeclared-tokens",
    title: `prompt 里用了模板没声明的 token：${undeclaredTokens.join("、")}`,
    state: "MISSING",
    evidence: "这些 token 永远不会被替换，会变成 BIND_REQUIRED_xxx",
    blocks_cases: scenarios.length,
    blocked_case_ids: [],
    side_effect: false,
    action: `在 bindings.v2.template.json 的 tokens 里补上：${undeclaredTokens.join("、")}`
  });
report.todo = todo.sort((a, b) => a.order - b.order);

/* --------------------------------------------------------- verdict */
const mustOpen = todo.filter((t) => t.severity === "MUST");
report.verdict = mustOpen.length === 0 ? "GO" : "BLOCKED";
report.summary_zh =
  `体检结论：${report.verdict}\n` +
  `· 场景 ${report.cases.total} 条，现在就绪 ${report.cases.ready} 条，被前置卡住 ${report.cases.blocked} 条\n` +
  `· 前置 ${FIXTURES.length} 项：READY ${statuses.filter((s) => s.state === "READY").length} / MISSING ${statuses.filter((s) => s.state === "MISSING").length} / UNKNOWN ${statuses.filter((s) => s.state === "UNKNOWN").length}\n` +
  `· token 用到 ${allTokens.size} 个，已填 ${report.bindings.tokens_filled} 个，缺 ${missingTokens.length} 个\n` +
  `· 待办 ${todo.length} 项，其中 MUST ${mustOpen.length} 项`;

/* -------------------------------------------------------- 控制台 */
const line = "─".repeat(78);
console.log(`\n${line}\n飞书 E2E v2 · 跑前体检（${report.mode}）  ${report.generated_at}\n${line}`);
console.log(report.summary_zh);
console.log(`\n【端点】${endpointUrl}\n  ${report.endpoint.up === null ? "未探测" : report.endpoint.up ? "存活 ✅" : "连不上 ❌"} · ${report.endpoint.detail}`);
console.log(`\n【文件】`);
for (const [k, v] of Object.entries(report.files)) console.log(`  ${v ? "✅" : "❌"} ${k}`);

console.log(`\n${line}\n前置条件明细\n${line}`);
for (const st of statuses) {
  const icon = st.state === "READY" ? "✅" : st.state === "MISSING" ? "❌" : "❔";
  console.log(`${icon} [${st.severity}] ${st.key} — ${st.name}`);
  console.log(`     影响 ${st.neededBy.length} 条 case${st.neededBy.length ? "：" + st.neededBy.slice(0, 8).join("、") + (st.neededBy.length > 8 ? " …" : "") : ""}`);
  if (st.evidence) console.log(`     证据：${st.evidence}`);
}

console.log(`\n${line}\n明天要做什么（紧凑版；完整可复制步骤见 preflight-todo.md）\n${line}`);
if (!todo.length) console.log("  没有待办，可以直接跑。");
else {
  let lastGroup = "";
  for (const t of report.todo) {
    if (t.group !== lastGroup) {
      console.log(`\n[${t.group}]`);
      lastGroup = t.group;
    }
    console.log(`  ${t.order}. [${t.severity}] ${t.title} — 卡住 ${t.blocks_cases} 条${t.side_effect ? " ⚠有副作用" : ""}`);
    console.log(`     ${String(t.evidence).split("\n")[0]}`);
  }
}

console.log(`\n${line}\n被卡住的 case（${report.cases.blocked}/${report.cases.total}）\n${line}`);
for (const c of caseRows.filter((x) => x.state === "BLOCKED").slice(0, 60)) {
  const why = [
    c.missing_global?.length ? `全局开关 ${c.missing_global.join("、")}` : "",
    c.missing_fixtures.length ? `前置 ${c.missing_fixtures.join("、")}` : "",
    c.missing_tokens.length ? `token ${c.missing_tokens.join("、")}` : "",
    c.unknown_fixture_keys?.length ? `未知key ${c.unknown_fixture_keys.join("、")}` : ""
  ]
    .filter(Boolean)
    .join("；");
  console.log(`  ❌ ${c.case_id} ${c.name} — ${why || "（未给出原因，看 preflight-report.json）"}`);
}
if (report.cases.blocked > 60) console.log(`  …另有 ${report.cases.blocked - 60} 条`);

/* ------------------------------------------- 生成《明天待办》Markdown */
const md: string[] = [];
md.push(`# 飞书 E2E v2 · 跑前体检与待办清单`);
md.push(``);
md.push(`生成时间：${report.generated_at} ｜ 模式：${report.mode} ｜ 结论：**${report.verdict}**`);
md.push(``);
md.push(`> 数据来源：\`bindings.v2.json\`（没有就用模板）。把下面每一项做完，\`preflight\` 结论会变成 **GO**，才能开跑。`);
md.push(``);
md.push(`## 一句话进度`);
md.push(``);
md.push(`| 项 | 数 |`);
md.push(`| --- | --- |`);
md.push(`| 场景总数 | ${report.cases.total} |`);
md.push(`| 现在就绪 | ${report.cases.ready} |`);
md.push(`| 被前置卡住（BLOCKED，不算失败） | ${report.cases.blocked} |`);
md.push(`| 前置条件 | ${FIXTURES.length} 项：READY ${statuses.filter((x) => x.state === "READY").length} / MISSING ${statuses.filter((x) => x.state === "MISSING").length} / UNKNOWN ${statuses.filter((x) => x.state === "UNKNOWN").length} |`);
md.push(`| 待办 | ${todo.length} 项（MUST ${todo.filter((t) => t.severity === "MUST").length} / SHOULD ${todo.filter((t) => t.severity === "SHOULD").length}） |`);
md.push(``);
md.push(`## 端点`);
md.push(``);
md.push(`- \`${endpointUrl}\` → ${report.endpoint.up === null ? "未探测（加 --probe）" : report.endpoint.up ? "存活" : "连不上"}${report.endpoint.detail ? "：" + report.endpoint.detail : ""}`);
md.push(``);
if (!report.files["bindings.v2.json"]) {
  md.push(`## 第 0 步：先建 bindings.v2.json`);
  md.push(``);
  md.push(`\`\`\`bash`);
  md.push(`cd ${root}`);
  md.push(`cp bindings.v2.template.json bindings.v2.json`);
  md.push(`\`\`\``);
  md.push(``);
}
md.push(`## 待办明细（按分组，照着做）`);
md.push(``);
const byGroup = new Map<string, any[]>();
for (const t of todo) {
  const arr = byGroup.get(t.group) ?? [];
  arr.push(t);
  byGroup.set(t.group, arr);
}
let n = 0;
for (const [g, items] of [...byGroup.entries()].sort((a, b) => a[0].localeCompare(b[0], "zh-Hans-CN"))) {
  md.push(`### ${g}`);
  md.push(``);
  for (const t of items) {
    n += 1;
    md.push(`#### ${n}. [${t.severity}] ${t.title}`);
    md.push(``);
    md.push(`- key：\`${t.key}\` ｜ 现状：${t.state}`);
    md.push(`- 卡住 ${t.blocks_cases} 条 case${t.blocked_case_ids?.length ? "：" + t.blocked_case_ids.join("、") + (t.blocks_cases > t.blocked_case_ids.length ? " …" : "") : ""}`);
    if (t.evidence) md.push(`- 证据：${String(t.evidence).replace(/\n/g, " ")}`);
    md.push(`- 怎么做：`);
    for (const l of String(t.action ?? "").split("\n")) md.push(`  ${l.trim() ? "> " + l : ">"}`);
    if (t.side_effect) md.push(`- ⚠ 会在真实飞书里留下资源，跑完要清理`);
    md.push(``);
  }
}
md.push(`## 被卡住的 case（${report.cases.blocked}/${report.cases.total}）`);
md.push(``);
md.push(`| case | 名称 | 缺什么 |`);
md.push(`| --- | --- | --- |`);
for (const c of caseRows.filter((x: any) => x.state === "BLOCKED")) {
  const why = [
    c.missing_global?.length ? `全局 ${c.missing_global.join("、")}` : "",
    c.missing_fixtures.length ? `前置 ${c.missing_fixtures.join("、")}` : "",
    c.missing_tokens.length ? `token ${c.missing_tokens.join("、")}` : "",
    c.unknown_fixture_keys?.length ? `未知key ${c.unknown_fixture_keys.join("、")}` : ""
  ]
    .filter(Boolean)
    .join("；");
  md.push(`| ${c.case_id} | ${c.name} | ${why} |`);
}
md.push(``);
const todoMdPath = resolve(root, "preflight-todo.md");
await writeFile(todoMdPath, md.join("\n"));

await writeFile(resolve(root, "preflight-report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(`\n报告已写入：${resolve(root, "preflight-report.json")}`);
console.log(`待办清单（给人看的）：${todoMdPath}`);
if (report.verdict === "BLOCKED") process.exitCode = 1;
