/**
 * 飞书 E2E v2 —— 「就绪度」唯一真相源。
 *
 * scripts/preflight.ts（体检报告）和 build-cases.ts（构建可导入用例）都必须用这里的判定，
 * 不允许各自实现一份，否则两边结论会漂。
 *
 * 数据形态（bindings.v2.json / bindings.v2.template.json）：
 *   { uid, run_label,
 *     global:    { codeword: { value, desc, filled } },
 *     fixtures:  { "<canonicalKey>": { value, desc, filled, needed_by[], token } },
 *     cases:     { "<caseId>": { sid, tokens? } },
 *     preflight: { writes_approved, send_whitelist_confirmed, cleanup_confirmed, room_bookable } }
 *
 * prompt 里的 {{token}} 一律溯源到 fixtures[key].value（key ↔ token 的映射见 fixtures.ts），
 * 唯一例外是 {{codeword}} 来自 global.codeword.value。
 */
import { FIXTURES, TOKEN_TO_FIXTURE, findFixture } from "./fixtures.ts";

/** 开关型前置 → bindings 里的布尔路径 */
export const FLAG_PATHS: Readonly<Record<string, string>> = {
  "auth.endpoint_up": "preflight.endpoint_up",
  "auth.feishu_tools_15": "preflight.feishu_tools_confirmed",
  "auth.lark_user_token": "preflight.lark_user_token_ready",
  "auth.write_approved": "preflight.writes_approved",
  "auth.send_whitelist": "preflight.send_whitelist_confirmed",
  "auth.cleanup_approved": "preflight.cleanup_confirmed",
  "room.bookable": "preflight.room_bookable"
};

/**
 * 端点存活只有 --probe 真连一次才算证据；静态模式只能看开关，所以不能用它卡「数据是否备好」。
 * 这里的 key 在没探测结果时一律判 UNKNOWN（既不 READY 也不 MISSING）。
 */
export const PROBE_ONLY_FIXTURES: readonly string[] = ["auth.endpoint_up"];

/** 还没填的占位值形状，出现即视为「没填」 */
export const PLACEHOLDER = /BIND_REQUIRED_|REPLACE_ME|^TODO|填写|占位|example\./i;

export const getPath = (obj: any, path: string): any => path.split(".").reduce((a, k) => (a == null ? a : a[k]), obj);

export const nonEmpty = (v: any): boolean => {
  if (v === undefined || v === null) return false;
  const s = typeof v === "string" ? v.trim() : Array.isArray(v) ? v.filter((x) => String(x).trim()).join("") : String(v);
  return s.length > 0 && !PLACEHOLDER.test(s);
};

const TOKEN_RE = /\{\{([a-z_0-9]+)\}\}/g;

/**
 * case 属于哪个分域（FS2-D / FS2-M / …）。
 * 优先用 scenarios 里的 domain 字段；缺了就按 id 前两段推（id 形如 FS2-D01-01，只取第一段会得到 "FS2"）。
 */
export const domainOf = (scenario: any): string => {
  const declared = typeof scenario?.domain === "string" ? scenario.domain.trim() : "";
  if (declared) return declared;
  const parts = String(scenario?.id ?? "").split("-");
  return parts.length >= 2 ? parts.slice(0, 2).join("-") : parts[0] ?? "";
};

export type FixtureState = "READY" | "MISSING" | "UNKNOWN";

export interface CaseBlockers {
  /** blockedIf 显式声明 + prompt token 隐含依赖，去重后真正需要的前置（不含全局） */
  requiredFixtures: string[];
  /** 未就绪的前置 key */
  missingFixtures: string[];
  /** scenarios 引用了 fixtures.ts 里没有的 key（属于必须先修的数据错误） */
  unknownFixtureKeys: string[];
  /** prompt 用到但取不到值的 token */
  missingTokens: string[];
  /** 多轮 case 缺唯一 sid */
  missingSid: boolean;
  /** 全局前置缺口（端点除外，端点单独看） */
  missingGlobal: string[];
  /** 写入型 case 但没批准写入 */
  writesNotApproved: boolean;
  ready: boolean;
}

/** 一条 case 的性质，决定哪些「全局前置」真的卡它 */
export interface CaseScope {
  writes: boolean;
  sends: boolean;
}

const SEND_TOOLS = ["feishu_send_message"];

export interface Readiness {
  src: any;
  label: string;
  /** 单个前置是否就绪：开关型看 preflight flag；值型看 filled+value；条件型只看 filled */
  fixtureReady(key: string): boolean;
  /** 带探测覆盖的状态判定；override 用于 preflight --probe 的降级结果 */
  fixtureState(key: string, override?: Map<string, FixtureState>): FixtureState;
  /** prompt token → canonical fixture key（codeword 特殊） */
  tokenFixtureKey(token: string): string | null;
  /** prompt token 的真实取值；取不到返回 null */
  tokenValue(token: string): unknown | null;
  /** prompt token 是否已可解析出非占位值 */
  isFilled(token: string): boolean;
  /** 从任意 case 片段里扫出用到的 {{token}} */
  tokensOf(scenario: any): string[];
  /** 该 case 用到的 token → 解析后的值（未解析的不出现在结果里） */
  resolvedTokens(scenario: any): Record<string, unknown>;
  /** 全局前置缺口。scope 决定哪些全局门控算数（writes/sends 只卡对应类型的 case） */
  globalMissing(override?: Map<string, FixtureState>, scope?: CaseScope): string[];
  /** 所有全局前置的缺口（不看 scope），给 GO/BLOCKED 结论与待办清单用 */
  globalMissingAll(override?: Map<string, FixtureState>): string[];
  /** 这条 case 会不会给人/群发消息 */
  sends(scenario: any): boolean;
  /** 这条 case 有没有副作用（会写真实飞书） */
  writes(scenario: any): boolean;
  /** 某个全局前置的 gate 是否适用于给定 scope（算「这条前置卡住多少 case」用） */
  gateApplies(gate: string | undefined, scope: CaseScope): boolean;
  /** 一条 case 的完整阻塞原因 */
  caseBlockers(scenario: any, override?: Map<string, FixtureState>): CaseBlockers;
}

/**
 * @param src      bindings.v2.json（优先）或 bindings.v2.template.json（静态自检）
 * @param label    报告里显示的数据来源名
 */
export function createReadiness(src: any, label: string): Readiness {
  const bound: Record<string, any> = src?.fixtures ?? {};

  const fixtureReady = (key: string): boolean => {
    const f = findFixture(key);
    if (!f) return false;
    const flagPath = FLAG_PATHS[key];
    if (flagPath) return getPath(src, flagPath) === true;
    const entry = bound[key];
    if (!entry) return false;
    if (f.token) return entry.filled === true && nonEmpty(entry.value);
    return entry.filled === true;
  };

  const fixtureState = (key: string, override?: Map<string, FixtureState>): FixtureState => {
    const forced = override?.get(key);
    if (forced) return forced;
    if (PROBE_ONLY_FIXTURES.includes(key)) return "UNKNOWN";
    return fixtureReady(key) ? "READY" : "MISSING";
  };

  const tokenFixtureKey = (t: string): string | null => (t === "codeword" ? "codeword" : TOKEN_TO_FIXTURE[t] ?? null);

  const tokenValue = (t: string): unknown | null => {
    if (t === "codeword") {
      const v = getPath(src, "global.codeword.value");
      return nonEmpty(v) && getPath(src, "global.codeword.filled") !== false ? v : null;
    }
    const key = tokenFixtureKey(t);
    if (!key || !fixtureReady(key)) return null;
    const v = bound[key]?.value;
    return v === undefined ? null : v;
  };

  const isFilled = (t: string): boolean => tokenValue(t) !== null;

  const tokensOf = (scenario: any): string[] => {
    const bag = new Set<string>();
    for (const p of scenario?.prompt ?? []) for (const m of String(p).matchAll(TOKEN_RE)) bag.add(m[1]!);
    for (const v of Object.values(scenario?.expected ?? {})) for (const m of JSON.stringify(v).matchAll(TOKEN_RE)) bag.add(m[1]!);
    return [...bag].sort();
  };

  const resolvedTokens = (scenario: any): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const t of tokensOf(scenario)) {
      const v = tokenValue(t);
      if (v !== null) out[t] = v;
    }
    return out;
  };

  const writes = (scenario: any): boolean => Boolean(scenario?.sideEffect ?? scenario?.side_effect);

  const sends = (scenario: any): boolean => {
    const exp = scenario?.expected ?? {};
    const names: string[] = [
      ...(exp.tools ?? []).map((t: any) => t?.tool),
      ...(exp.order ?? []),
      ...Object.keys(exp.allowedWrites ?? {})
    ].filter((x): x is string => typeof x === "string");
    return names.some((n) => SEND_TOOLS.includes(n));
  };

  /** 某个全局前置是否真的卡这条 case */
  const gateApplies = (gate: string | undefined, scope: CaseScope): boolean => {
    switch (gate ?? "all") {
      case "all":
        return true;
      case "run":
        return true;
      case "prep":
        return false;
      case "writes":
        return scope.writes;
      case "sends":
        return scope.sends;
      default:
        return true;
    }
  };

  const globalMissing = (override?: Map<string, FixtureState>, scope: CaseScope = { writes: true, sends: true }): string[] =>
    FIXTURES.filter((f) => f.global)
      .filter((f) => !PROBE_ONLY_FIXTURES.includes(f.key) || override?.has(f.key))
      .filter((f) => gateApplies(f.gate, scope))
      .filter((f) => fixtureState(f.key, override) !== "READY")
      .map((f) => f.key);

  const globalMissingAll = (override?: Map<string, FixtureState>): string[] =>
    FIXTURES.filter((f) => f.global)
      .filter((f) => !PROBE_ONLY_FIXTURES.includes(f.key) || override?.has(f.key))
      .filter((f) => fixtureState(f.key, override) !== "READY")
      .map((f) => f.key);

  const caseBlockers = (scenario: any, override?: Map<string, FixtureState>): CaseBlockers => {
    const id = String(scenario?.id ?? "");
    const scope: CaseScope = { writes: writes(scenario), sends: sends(scenario) };
    const toks = tokensOf(scenario);
    const missingTokens = toks.filter((t) => !isFilled(t));
    const implicit = toks.map(tokenFixtureKey).filter((k): k is string => Boolean(k) && k !== "codeword");
    const declared: string[] = Array.isArray(scenario?.blockedIf) ? scenario.blockedIf.map(String) : [];
    const unknownFixtureKeys = declared.filter((k) => !findFixture(k));
    const requiredFixtures = [...new Set([...declared, ...implicit])].filter((k) => !findFixture(k)?.global);
    const missingFixtures = requiredFixtures.filter((k) => fixtureState(k, override) !== "READY");
    const multi = Number(scenario?.turns ?? 1) > 1;
    const sid = src?.cases?.[id]?.sid;
    const missingSid = multi && (typeof sid !== "string" || !sid.trim());
    const missingGlobal = globalMissing(override, scope);
    const writesNotApproved = scope.writes && getPath(src, "preflight.writes_approved") !== true;
    const ready =
      missingTokens.length === 0 &&
      missingFixtures.length === 0 &&
      unknownFixtureKeys.length === 0 &&
      !missingSid &&
      missingGlobal.length === 0 &&
      !writesNotApproved;
    return { requiredFixtures, missingFixtures, unknownFixtureKeys, missingTokens, missingSid, missingGlobal, writesNotApproved, ready };
  };

  return {
    src,
    label,
    fixtureReady,
    fixtureState,
    tokenFixtureKey,
    tokenValue,
    isFilled,
    tokensOf,
    resolvedTokens,
    globalMissing,
    globalMissingAll,
    sends,
    writes,
    gateApplies,
    caseBlockers
  };
}
