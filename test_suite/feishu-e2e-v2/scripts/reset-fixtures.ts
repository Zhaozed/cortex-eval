/**
 * 飞书 E2E v2 —— 轮间前置恢复脚本（reset-fixtures）
 *
 * 背景：55 条 case × 3 轮串行重跑，其中一批前置是「消耗型/非幂等」的（会被 case 的写操作破坏），
 * 每轮开跑前必须恢复到初始状态。本脚本把可自动恢复的部分脚本化，其余输出中文人工清单。
 *
 * 用法：
 *   npx tsx test_suite/feishu-e2e-v2/scripts/reset-fixtures.ts                       # 默认 dry-run：只打印计划，不执行
 *   npx tsx test_suite/feishu-e2e-v2/scripts/reset-fixtures.ts --apply                # 真实执行（--yes 是等价别名）
 *   npx tsx test_suite/feishu-e2e-v2/scripts/reset-fixtures.ts --bindings <path>     # 指定 bindings.v2.json（默认 test_suite/feishu-e2e-v2/bindings.v2.json）
 *   npx tsx test_suite/feishu-e2e-v2/scripts/reset-fixtures.ts --only <key1,key2>    # 只处理指定项（key 见下方 ALL_KEYS）
 *
 * 退出码：
 *   0 = dry-run 正常 / apply 全部成功（报告项 REPORT_BAD 不算失败，进人工清单）
 *   1 = apply 时有恢复项失败（逐条打印哪一项、为什么）
 *   2 = 参数错误 / bindings.v2.json 不存在或缺暗号
 *
 * ─────────────────────────── 安全红线（不可绕过） ───────────────────────────
 * R1 只允许操作「标题或正文含暗号（bindings 的 global.codeword.value，形如 0917A）」的资源。
 *    任何删除/改名/改期动作前，先 list/search 出来校验暗号命中；不命中就跳过并打印「跳过：不含暗号，不敢动」。
 * R2 禁止删除会议室、禁止删除群、禁止删除联系人、禁止删除日历、禁止删除整篇文档（drive +delete 永不调用）。
 * R3 doc.readonly_unique 是只读文档：只报告状态，发现被改也不自动修（进人工清单）。
 * R4 消息撤不回：被测 Agent 用自己身份发的消息，本脚本一律不碰，只打印人工撤回清单。
 * R5 每一步先打印「将执行 → 命令 → 目的」再执行；执行后打印结果摘要（拿到/没拿到 id）。
 * R6 幂等：先查有没有已满足初始状态的资源，有就「已就绪，跳过」；重复跑不出错。
 * R7 识别不到、状态不明、恢复动作有歧义的资源一律进「需人工处理」清单，绝不猜测执行。
 * R8 不碰文件系统（不 rm、不写仓库文件），只对飞书资源做本文件声明的操作。
 * ────────────────────────────────────────────────────────────────────────────
 *
 * 恢复策略说明（为什么日历类选「删掉重建」而不是「原地改回」）：
 *   · update_event / +update 对参会人和会议室是增量语义，要恢复到精确初始态得先算 diff（该删谁、该加哪个房间），
 *     中间任何一步状态读不准就会越修越歪；delete + create 的终态是确定的、代码路径唯一、天然幂等。
 *   · 日程没有任何地方引用 event_id（bindings 里存的是标题），重建不破坏任何契约。
 *   · 删除范围被 R1 暗号红线兜住：只有标题含暗号的日程才会被删。
 *
 * 初始状态（canonical）时间槽是本脚本常量（下方 CANON 定义处有逐条来源注释），
 * 与 scenarios.v2.json 的 cleanup 文案对齐；「明天/后天/大后天」按运行当天 Asia/Shanghai 计算。
 */
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { findFixture } from "../fixtures.ts";
import { getPath, nonEmpty } from "../readiness.ts";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const ALL_KEYS = [
  "calendar.event_to_cancel",
  "calendar.event_add_attendee",
  "calendar.event_to_update",
  "calendar.event_with_room",
  "calendar.event_duplicate_title",
  "calendar.busy_slot",
  "calendar.leftover_sweep",
  "doc.rename_target",
  "doc.append_target",
  "doc.partial_target",
  "doc.prune_target",
  "doc.rewrite_target",
  "doc.readonly_unique",
  "doc.duplicate_title",
  "doc.codeword_pool",
  "calendar.event_tomorrow",
  "calendar.second"
];

/* --------------------------------------------------------------- CLI */
function usage(): void {
  console.log(`飞书 E2E v2 · 轮间前置恢复脚本

用法：
  npx tsx test_suite/feishu-e2e-v2/scripts/reset-fixtures.ts [选项]

选项：
  （无参数）        默认 dry-run：只打印将要执行的 lark-cli 命令和原因，不真跑
  --dry-run         同上，显式写出
  --apply           真实执行恢复动作（别名：--yes）。会写真实飞书资源，受文件头安全红线约束
  --bindings <path> bindings.v2.json 路径（默认 test_suite/feishu-e2e-v2/bindings.v2.json；
                    不存在直接报错，不静默跳过）
  --only <k1,k2>    只处理指定项，可用 key：
                    ${ALL_KEYS.join("、")}
  --help            本帮助

退出码：0=dry-run 正常/apply 全成功；1=apply 有恢复项失败；2=参数或 bindings 错误`);
}

const argv = process.argv.slice(2);
const VALUE_FLAGS = new Set(["--bindings", "--only"]);
const BOOL_FLAGS = new Set(["--apply", "--yes", "--dry-run", "--help", "-h"]);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (BOOL_FLAGS.has(a)) continue;
  if (VALUE_FLAGS.has(a)) {
    if (argv[i + 1] === undefined || argv[i + 1]!.startsWith("--")) {
      console.error(`参数错误：${a} 后面要跟一个值`);
      process.exit(2);
    }
    i++;
    continue;
  }
  console.error(`未知参数：${a}`);
  usage();
  process.exit(2);
}
if (argv.includes("--help") || argv.includes("-h")) {
  usage();
  process.exit(0);
}
const flagValue = (name: string): string | null => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
};
const APPLY = argv.includes("--apply") || argv.includes("--yes");
if (APPLY && argv.includes("--dry-run")) {
  console.error("参数错误：--dry-run 不能与 --apply/--yes 同时使用");
  process.exit(2);
}

const bindingsArg = flagValue("--bindings");
const bindingsPath = bindingsArg ? resolve(bindingsArg) : resolve(root, "bindings.v2.json");
const onlyArg = flagValue("--only");

/* ---------------------------------------------------------- bindings */
const readJsonSafe = async (p: string): Promise<any | null> => {
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch {
    return null;
  }
};
const bindings = await readJsonSafe(bindingsPath);
if (!bindings) {
  console.error(`❌ 找不到或读不懂 bindings：${bindingsPath}
   请先执行：
     cd ${root}
     cp bindings.v2.template.json bindings.v2.json
   然后把 fixtures 各项的 value/filled 填好（本脚本靠它们定位真实资源，不填就不动）。`);
  process.exit(2);
}

const codeword = String(getPath(bindings, "global.codeword.value") ?? "").trim();
if (!codeword || !nonEmpty(codeword)) {
  console.error(
    `❌ bindings 里 global.codeword.value 为空/占位值。暗号是安全红线 R1 的唯一判据，缺了它本脚本拒绝运行。`
  );
  process.exit(2);
}

/** 读 fixtures[key].value（key 自带点号，不能用 getPath 按点拆） */
const fxEntry = (key: string): any => bindings?.fixtures?.[key] ?? null;
const fxValue = (key: string): string | null => {
  const v = fxEntry(key)?.value;
  return nonEmpty(v) ? String(v).trim() : null;
};

/* ------------------------------------------------------ 日期（沪时区） */
const TZ = "Asia/Shanghai";
const shDate = (offsetDays: number): string => {
  const d = new Date(Date.now() + offsetDays * 86400000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(d);
  const g = (t: string): string => parts.find((x) => x.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")}`;
};
const TODAY = shDate(0);
const TOMORROW = shDate(1); // 明天
const AFTER = shDate(2); // 后天
const AFTER3 = shDate(3); // 大后天
const iso = (date: string, hhmm: string): string => `${date}T${hhmm}:00+08:00`;
const epoch = (isoStr: string): number => Math.floor(Date.parse(isoStr) / 1000);

/* ------------------------------------------------------------ 日志 */
const LINE = "─".repeat(76);
const log = (...a: unknown[]): void => console.log(...(a as [unknown]));
const section = (title: string): void => log(`\n${LINE}\n${title}\n${LINE}`);
const fmtCmd = (args: string[]): string =>
  "lark-cli " + args.map((a) => (/[\s"'~|《》「」]/.test(a) ? JSON.stringify(a) : a)).join(" ");

/* ------------------------------------------------- lark-cli 执行器 */
interface LarkOut {
  ok: boolean;
  json: any | null;
  raw: string;
  error: string;
}
/** dry-run 下只打印计划、返回 null；apply 下真实执行（R5：先打印「将执行→命令→目的」再跑） */
async function lark(args: string[], purpose: string): Promise<LarkOut | null> {
  log(`  → 将执行：${fmtCmd(args)}`);
  log(`    目的：${purpose}`);
  if (!APPLY) {
    log(`    （dry-run：不执行）`);
    return null;
  }
  try {
    const { stdout } = await execFileAsync("lark-cli", args, {
      timeout: 60000,
      maxBuffer: 16 * 1024 * 1024
    });
    const raw = stdout.trim();
    let json: any | null = null;
    try {
      json = JSON.parse(raw);
    } catch {
      /* 非 JSON 输出 */
    }
    if (json && json.ok === false) {
      const err = `${json?.error?.subtype ?? "error"}：${json?.error?.message ?? raw.slice(0, 200)}`;
      log(`    结果：❌ 失败 —— ${err}`);
      return { ok: false, json, raw, error: err };
    }
    const brief = raw.replace(/\s+/g, " ").slice(0, 140);
    log(`    结果：✅ OK${brief ? `（${brief}${raw.length > 140 ? "…" : ""}）` : "（空输出）"}`);
    return { ok: true, json, raw, error: "" };
  } catch (e: any) {
    if (
      e?.code === 10 ||
      /confirmation_required|high-risk/i.test(String(e?.stdout ?? e?.stderr ?? e?.message ?? ""))
    ) {
      const err =
        "lark-cli 判为高风险操作要求确认（exit 10）。按红线本脚本不自动绕过、不追加确认 flag。";
      log(`    结果：⛔ ${err}`);
      return { ok: false, json: null, raw: String(e?.stdout ?? ""), error: err };
    }
    const err = String(e?.stderr ?? e?.message ?? e)
      .replace(/\s+/g, " ")
      .slice(0, 300);
    log(`    结果：❌ 命令执行失败 —— ${err}`);
    return { ok: false, json: null, raw: String(e?.stdout ?? ""), error: err };
  }
}

/* ------------------------------------------- 宽松 JSON 遍历工具 */
function* walk(o: any): Generator<any> {
  if (o && typeof o === "object") {
    yield o;
    for (const v of Object.values(o)) yield* walk(v);
  }
}
const findAll = (o: any, pred: (x: any) => boolean): any[] => {
  const out: any[] = [];
  for (const n of walk(o)) if (pred(n)) out.push(n);
  return out;
};
/** 从任意形状的时间字段里抠 epoch 秒（timestamp/date_time/ISO 都认；纯日期按沪时区零点） */
function timeEpoch(v: any): number | null {
  if (v == null) return null;
  if (typeof v === "number") return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
  if (typeof v === "string") {
    const s = v.trim();
    if (/^\d{10,13}$/.test(s)) {
      const n = Number(s);
      return n > 1e12 ? Math.floor(n / 1000) : n;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return Math.floor(Date.parse(`${s}T00:00:00+08:00`) / 1000);
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : Math.floor(t / 1000);
  }
  if (typeof v === "object") {
    for (const k of ["timestamp", "date_time", "dateTime", "datetime", "date"]) {
      if (v[k] != null) {
        const e = timeEpoch(v[k]);
        if (e !== null) return e;
      }
    }
  }
  return null;
}

interface Ev {
  id: string;
  summary: string;
  startE: number | null;
  endE: number | null;
}
function normalizeEvents(json: any): Ev[] {
  const out: Ev[] = [];
  const seen = new Set<string>();
  for (const n of findAll(json, (x) => typeof x?.event_id === "string" && x.event_id.length > 0)) {
    if (seen.has(n.event_id)) continue;
    seen.add(n.event_id);
    out.push({
      id: n.event_id as string,
      summary: String(n.summary ?? "").trim(),
      startE: timeEpoch(n.start),
      endE: timeEpoch(n.end)
    });
  }
  return out;
}

interface DocHit {
  title: string;
  token: string | null;
  url: string | null;
}
function normalizeDocs(json: any): DocHit[] {
  const out: DocHit[] = [];
  const seen = new Set<string>();
  for (const n of walk(json)) {
    const title = typeof n?.title === "string" ? n.title.trim() : "";
    if (!title) continue;
    const token =
      ([n.token, n.docs_token, n.doc_token, n.file_token, n.obj_token].find(
        (x) => typeof x === "string" && x.length > 8
      ) as string | undefined) ?? null;
    const url =
      ([n.url, n.doc_url, n.link].find((x) => typeof x === "string" && x.startsWith("http")) as
        string | undefined) ?? null;
    if (!token && !url) continue;
    const k = token ?? url!;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ title, token, url });
  }
  return out;
}

/* ------------------------------------------------- 结果项与 --only */
type Status = "PLANNED" | "RESTORED" | "READY" | "FAILED" | "MANUAL" | "REPORT_OK" | "REPORT_BAD";
type Kind = "auto" | "report";
interface Item {
  key: string;
  kind: Kind;
  title: string;
  status: Status;
  detail: string;
}
const items: Item[] = [];
const pushItem = (key: string, kind: Kind, title: string, status: Status, detail: string): void => {
  items.push({ key, kind, title, status, detail });
  const icon =
    status === "RESTORED"
      ? "🔧 已恢复"
      : status === "READY"
        ? "✅ 已就绪，跳过"
        : status === "FAILED"
          ? "❌ 失败"
          : status === "MANUAL"
            ? "🖐 转人工"
            : status === "REPORT_OK"
              ? "✅ 报告正常"
              : status === "REPORT_BAD"
                ? "⚠️ 报告异常"
                : "📋 计划";
  log(`  ${icon}：${detail}`);
};

/** 动态收集的人工项（跑完统一编号打印） */
const manualSteps: string[] = [];
const addManual = (s: string): void => {
  manualSteps.push(s);
};

const only = onlyArg
  ? onlyArg
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean)
  : null;
if (only) {
  const bad = only.filter((k) => !ALL_KEYS.includes(k));
  if (bad.length) {
    console.error(`--only 含未知 key：${bad.join("、")}\n可用 key：\n  ${ALL_KEYS.join("\n  ")}`);
    process.exit(2);
  }
}
const wanted = (k: string): boolean => !only || only.includes(k);

/* ------------------------------------------------------ 运行时上下文 */
const ctx: {
  selfOpenId: string | null;
  colleagueId: string | null | undefined; // undefined=尚未解析
  roomIds: Map<string, string | null>;
  planned: Set<string>; // dry-run 下已打印过计划的解析步骤（避免重复刷屏）
} = { selfOpenId: null, colleagueId: undefined, roomIds: new Map(), planned: new Set() };

const PLACE_OU = "ou_<秦宇龙_open_id·apply时解析>";
const PLACE_OMM = "omm_<苏州会议室_room_id·apply时解析>";
const colleagueName = fxValue("person.qinyulong") ?? "秦宇龙"; // 与 fixtures.ts probe 里写死的查询词一致
const roomName = fxValue("room.suzhou_free");

async function ensureAuth(): Promise<boolean> {
  const out = await lark(
    ["auth", "status"],
    "确认 lark-cli user 身份可用（token 过期时一切读写都免谈；实测 auth status 不接受 --format）"
  );
  if (!out) return true; // dry-run
  const u = out.json?.identities?.user;
  if (!out.ok || !u || u.available !== true) {
    log(`  ❌ user 身份不可用：${u?.message ?? out.error ?? "未知原因"}`);
    log(`     先跑 lark-cli auth login 完成扫码授权，再重跑本脚本 --apply。`);
    return false;
  }
  ctx.selfOpenId = typeof u.openId === "string" ? u.openId : null;
  log(`    user 身份就绪：${u.userName ?? ""} ${ctx.selfOpenId ?? "(openId 未返回)"}`);
  return true;
}

async function resolveColleague(): Promise<string | null> {
  if (!APPLY) {
    if (!ctx.planned.has("colleague")) {
      ctx.planned.add("colleague");
      await lark(
        ["contact", "+search-user", "--query", colleagueName, "--as", "user"],
        `解析「${colleagueName}」的 open_id（dry-run：apply 时会先跑这一步，再把 ou_ 写进 --attendee-ids）`
      );
    }
    return PLACE_OU;
  }
  if (ctx.colleagueId !== undefined) return ctx.colleagueId;
  const out = await lark(
    ["contact", "+search-user", "--query", colleagueName, "--as", "user"],
    `解析「${colleagueName}」的 open_id（带参会人的日程重建需要）`
  );
  if (!out?.ok) {
    ctx.colleagueId = null;
    return null;
  }
  const ids = [
    ...new Set(
      findAll(out.json, (n) => typeof n?.open_id === "string" && n.open_id.startsWith("ou_")).map(
        (n) => n.open_id as string
      )
    )
  ];
  if (ids.length !== 1) {
    log(`    ⚠ 命中 ${ids.length} 个 open_id（fixture 要求唯一命中），不猜、不挑`);
    ctx.colleagueId = null;
    return null;
  }
  ctx.colleagueId = ids[0]!;
  log(`    拿到唯一 open_id：${ctx.colleagueId}`);
  return ctx.colleagueId;
}

async function resolveRoom(startIso: string, endIso: string): Promise<string | null> {
  const slot = `${startIso}~${endIso}`;
  if (!APPLY) {
    if (!roomName) return PLACE_OMM;
    if (!ctx.planned.has(slot)) {
      ctx.planned.add(slot);
      await lark(
        ["calendar", "+room-find", "--room-name", roomName, "--slot", slot, "--as", "user"],
        `确认「${roomName}」在 ${slot} 可预订并取 room_id（dry-run：apply 时会先跑这一步，拿到 omm_ 再写进 --attendee-ids；必须真实占房，只写地点字段不算）`
      );
    }
    return PLACE_OMM;
  }
  if (ctx.roomIds.has(slot)) return ctx.roomIds.get(slot)!;
  if (!roomName) {
    log(`    ⚠ bindings 里 room.suzhou_free 未填，拿不到会议室名 → 不猜`);
    ctx.roomIds.set(slot, null);
    return null;
  }
  const out = await lark(
    ["calendar", "+room-find", "--room-name", roomName, "--slot", slot, "--as", "user"],
    `确认「${roomName}」在 ${slot} 可预订并取 room_id（必须真实占房，只写地点字段不算）`
  );
  if (!out?.ok) {
    ctx.roomIds.set(slot, null);
    return null;
  }
  const rooms = findAll(
    out.json,
    (n) => typeof n?.room_id === "string" && n.room_id.startsWith("omm_")
  );
  const hit = rooms.find((r) => {
    const nm = String(r?.name ?? r?.room_name ?? "");
    return nm.length > 0 && (nm.includes(roomName!) || roomName!.includes(nm));
  });
  if (!hit) {
    log(
      `    ⚠ ${slot} 没有名称与「${roomName}」互为包含的可用会议室（被占或无权限）→ 不订别的房间`
    );
    ctx.roomIds.set(slot, null);
    return null;
  }
  log(`    拿到 room_id：${hit.room_id}（${String(hit?.name ?? hit?.room_name ?? roomName)}）`);
  ctx.roomIds.set(slot, hit.room_id as string);
  return hit.room_id as string;
}

/* ------------------------------------------------- canonical 日程定义 */
interface Spec {
  key: string;
  title: string;
  /** 标题匹配核心词（busy_slot 存在 fixtures.ts 与 scenario 两处不一致的标题，都认） */
  cores: string[];
  date: string;
  sh: string;
  eh: string;
  colleague: boolean;
  room: boolean;
  onlySelf: boolean;
}
/**
 * 每条初始状态的来源（不许改，改了就是猜测）：
 *  · event_add_attendee 明天上午/仅本人        ← fixtures.ts「建一场明天上午的会…参会人只有本人」；09:00-10:00 为本脚本选定的 canonical 槽位
 *  · event_to_cancel   明天上午/订苏州房        ← fixtures.ts「明天上午…必须真实预订 room.suzhou_free」；10:00-11:00 为 canonical 槽位，且避开明天 11:30-12:00 空闲前置
 *  · event_with_room   明天下午/订房/本人+秦    ← fixtures.ts + FS2-X08-01 fixture；14:00-15:00 为 canonical 槽位
 *  · duplicate_title   明天下午+后天下午各一场  ← fixtures.ts「明天下午、后天下午各一场，参会人本人+秦宇龙，都没有预订会议室」；15:00-16:00 / 13:00-14:00 为 canonical 槽位（避开 freebusy 9 时段）
 *  · event_to_update   明天 16:30-17:30        ← FS2-C06-01 cleanup「改回明天下午四点半到五点半」；参会人+会议室 ← FS2-C06-01 fixture「已带参会人{{colleague}}与会议室{{room}}」
 *  · busy_slot         后天 11:00-12:00        ← FS2-S04-01 fixture「后天上午十一点到十二点已有一场『测试冲突占位 <暗号>』」
 */
function buildSpecs(): { specs: Spec[]; missing: { key: string; reason: string }[] } {
  const specs: Spec[] = [];
  const missing: { key: string; reason: string }[] = [];
  const need = (key: string): string | null => {
    const t = fxValue(key);
    if (!t) {
      missing.push({
        key,
        reason: `bindings 里 fixtures["${key}"].value 未填 —— 不知道真实标题，不猜、不动，转人工`
      });
      return null;
    }
    if (!t.includes(codeword)) {
      missing.push({
        key,
        reason: `bindings 标题「${t}」不含暗号 ${codeword} —— 触发红线 R1，拒绝自动操作，转人工`
      });
      return null;
    }
    return t;
  };
  const tAdd = need("calendar.event_add_attendee");
  if (tAdd)
    specs.push({
      key: "calendar.event_add_attendee",
      title: tAdd,
      cores: [tAdd, "测试方案对齐"],
      date: TOMORROW,
      sh: "09:00",
      eh: "10:00",
      colleague: false,
      room: false,
      onlySelf: true
    });
  const tCancel = need("calendar.event_to_cancel");
  if (tCancel)
    specs.push({
      key: "calendar.event_to_cancel",
      title: tCancel,
      cores: [tCancel, "测试房间核验"],
      date: TOMORROW,
      sh: "10:00",
      eh: "11:00",
      colleague: false,
      room: true,
      onlySelf: false
    });
  const tRoom = need("calendar.event_with_room");
  if (tRoom)
    specs.push({
      key: "calendar.event_with_room",
      title: tRoom,
      cores: [tRoom, "测试房间评审"],
      date: TOMORROW,
      sh: "14:00",
      eh: "15:00",
      colleague: true,
      room: true,
      onlySelf: false
    });
  const dupTitle = `测试发布评审 ${codeword}`; // 无 token，标题由 fixtures.ts/scenario 写死
  specs.push({
    key: "calendar.event_duplicate_title",
    title: dupTitle,
    cores: [dupTitle],
    date: TOMORROW,
    sh: "15:00",
    eh: "16:00",
    colleague: true,
    room: false,
    onlySelf: false
  });
  specs.push({
    key: "calendar.event_duplicate_title",
    title: dupTitle,
    cores: [dupTitle],
    date: AFTER,
    sh: "13:00",
    eh: "14:00",
    colleague: true,
    room: false,
    onlySelf: false
  });
  const tUpd = need("calendar.event_to_update");
  if (tUpd)
    specs.push({
      key: "calendar.event_to_update",
      title: tUpd,
      cores: [tUpd, "测试排期评审", "测试改期会议"],
      date: TOMORROW,
      sh: "16:30",
      eh: "17:30",
      colleague: true,
      room: true,
      onlySelf: false
    });
  const busyTitle = `测试冲突占位 ${codeword}`; // FS2-S04-01 fixture 文案；fixtures.ts howToPrepare 写的是「已占用时段」，两个标题都认（见 cores）
  specs.push({
    key: "calendar.busy_slot",
    title: busyTitle,
    cores: [busyTitle, "测试冲突占位", "已占用时段"],
    date: AFTER,
    sh: "11:00",
    eh: "12:00",
    colleague: false,
    room: false,
    onlySelf: false
  });
  return { specs, missing };
}

/* --------------------------------------------------- 日历：删/建/核对 */
async function deleteEvent(id: string, summary: string, reason: string): Promise<boolean> {
  if (!summary.includes(codeword)) {
    log(`  跳过：「${summary}」不含暗号 ${codeword}，不敢动（红线 R1）`);
    return false;
  }
  const out = await lark(
    [
      "calendar",
      "events",
      "delete",
      "--calendar-id",
      "primary",
      "--event-id",
      id,
      "--need-notification",
      "false",
      "--as",
      "user"
    ],
    `删除日程「${summary}」：${reason}`
  );
  if (!out) return true; // dry-run 视为计划成功
  return out.ok;
}

async function createEvent(sp: Spec): Promise<boolean> {
  const startIso = iso(sp.date, sp.sh);
  const endIso = iso(sp.date, sp.eh);
  const att: string[] = [];
  if (sp.colleague) {
    const cid = await resolveColleague();
    if (APPLY && !cid) return false;
    att.push(cid ?? PLACE_OU);
  }
  if (sp.room) {
    const rid = await resolveRoom(startIso, endIso);
    if (APPLY && !rid) {
      log(`    ⚠ 拿不到「${roomName ?? "?"}」的 room_id → 本场无法按初始状态重建（缺会议室证据）`);
      return false;
    }
    att.push(rid ?? PLACE_OMM);
  }
  const args = ["calendar", "+create", "--summary", sp.title, "--start", startIso, "--end", endIso];
  if (att.length) args.push("--attendee-ids", att.join(","));
  args.push(
    "--description",
    `评测前置 ${sp.key}，由 reset-fixtures.ts 重建；暗号 ${codeword}`,
    "--as",
    "user"
  );
  const purpose =
    `重建「${sp.title}」 ${sp.date} ${sp.sh}–${sp.eh}` +
    (sp.colleague ? `，参会人含 ${colleagueName}` : "") +
    (sp.onlySelf ? "，参会人仅本人" : "") +
    (sp.room ? `，真实预订「${roomName ?? "?"}」` : "");
  const out = await lark(args, purpose);
  if (!out) return true;
  if (!out.ok) return false;
  const ids = findAll(out.json, (n) => typeof n?.event_id === "string" && n.event_id).map(
    (n) => n.event_id
  );
  log(
    `    结果摘要：${ids.length ? `拿到 event_id ${ids.join(", ")}` : "⚠ 命令成功但响应里没解析到 event_id（apply 下建议人工复核这场会）"}`
  );
  return true;
}

async function detailMatches(ev: Ev, sp: Spec): Promise<boolean> {
  if (!sp.room && !sp.colleague && !sp.onlySelf) return true; // 标题+时间已足够
  const out = await lark(
    ["calendar", "+get", "--calendar-id", "primary", "--event-id", ev.id, "--as", "user"],
    `核对「${ev.summary}」的会议室/参会人是否仍是初始状态（决定跳过还是重建）`
  );
  if (!out) return false; // dry-run：无法核实 → 计划里按「需要重建」展示
  if (!out.ok) return false; // 读不到详情 → 保守重建（终态确定）
  const s = JSON.stringify(out.json ?? {});
  if (sp.room) {
    const roomOk = s.includes("omm_") || (roomName ? s.includes(roomName) : false);
    if (!roomOk) {
      log(`    核对：会议室不在（初始状态要求已订「${roomName ?? "?"}」）→ 需重建`);
      return false;
    }
  }
  const attNodes = findAll(out.json, (n) => Array.isArray(n?.attendees));
  if (!attNodes.length) {
    log(`    核对：响应里没解析到 attendees 数组 → 状态不明，保守重建`);
    return false;
  }
  const userIds = new Set<string>();
  for (const n of attNodes) {
    for (const a of n.attendees as any[]) {
      for (const m of JSON.stringify(a ?? {}).matchAll(/ou_[A-Za-z0-9]+/g)) userIds.add(m[0]!);
    }
  }
  if (sp.onlySelf) {
    const extra = [...userIds].filter((i) => i !== ctx.selfOpenId);
    if (extra.length) {
      log(`    核对：参会人应为仅本人，实际多出 ${extra.length} 人（${extra.join(", ")}）→ 需重建`);
      return false;
    }
  }
  if (sp.colleague) {
    const cid = await resolveColleague();
    if (cid && !userIds.has(cid)) {
      log(`    核对：参会人缺 ${colleagueName} → 需重建`);
      return false;
    }
  }
  return true;
}

/* ============================================================ 主流程：日历 */

/**
 * 上一轮 case 会新建的日程标题（来源：scenarios.v2.json 里 create_event 类 case 的题面原文）。
 * 只用于「说明输出」；真正的残留判据是：标题含暗号 且 不属于 canonical 清单。
 */
const KNOWN_LEFTOVERS: { core: string; from: string; slot: string }[] = [
  { core: "测试联调评审", from: "FS2-C04-01", slot: "后天 15:00-16:00" },
  { core: "测试房间预约", from: "FS2-C05-01", slot: "后天 14:00-15:00（真订 room.suzhou_free）" },
  { core: "测试全员对齐", from: "FS2-C10-01", slot: "后天 16:00-17:00" },
  { core: "测试排期落地", from: "FS2-X01-01", slot: "大后天 15:00-16:00" },
  { core: "测试场地确认", from: "FS2-X05-01", slot: "后天 10:00-11:00（真订 room.suzhou_free）" },
  {
    core: "测试文档对齐",
    from: "FS2-X07-01",
    slot: "明天 11:30 起（压住 freebusy 要求的明天 11:30-12:00 空闲）"
  },
  { core: "测试冲突核验", from: "FS2-S04-01（正常不应写入）", slot: "后天 11:00-12:00" },
  { core: "测试多日历核验", from: "FS2-C09-01（正常不应写入）", slot: "大后天 10:30-11:30" }
];

const CAL_KEYS = [
  "calendar.event_add_attendee",
  "calendar.event_to_cancel",
  "calendar.event_with_room",
  "calendar.event_duplicate_title",
  "calendar.event_to_update",
  "calendar.busy_slot",
  "calendar.leftover_sweep"
];
const anyCalendarWanted = CAL_KEYS.some((k) => wanted(k));

const titleOf = (key: string): string => findFixture(key)?.name ?? key;

const fmtT = (e: number | null): string =>
  e == null
    ? "时间不明"
    : new Intl.DateTimeFormat("zh-CN", {
        timeZone: TZ,
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      }).format(new Date(e * 1000));
const fmtEv = (ev: Ev): string =>
  `${fmtT(ev.startE)}–${fmtT(ev.endE)} 「${ev.summary || "(无标题)"}」 ${ev.id}`;

let calReadFailed = false;

/** 逐日读 明天/后天/大后天 的日程（分三次调用，避免单次响应被分页截断） */
async function fetchWindowEvents(): Promise<Ev[]> {
  const all: Ev[] = [];
  const seen = new Set<string>();
  for (const d of [TOMORROW, AFTER, AFTER3]) {
    const out = await lark(
      [
        "calendar",
        "+agenda",
        "--calendar-id",
        "primary",
        "--start",
        iso(d, "00:00"),
        "--end",
        iso(d, "23:59"),
        "--as",
        "user"
      ],
      `读取 ${d} 全天日程：本脚本只认这个窗口里的资源，且必须标题含暗号 ${codeword}（红线 R1）`
    );
    if (!out) continue; // dry-run：拿不到真实数据
    if (!out.ok) {
      log(`    ⚠ ${d} 日程读取失败 → 本日状态按「不明」处理（不猜、不删，红线 R7）`);
      calReadFailed = true;
      continue;
    }
    const evs = normalizeEvents(out.json);
    log(`    结果摘要：${d} 读到 ${evs.length} 场日程`);
    for (const ev of evs) {
      if (seen.has(ev.id)) continue;
      seen.add(ev.id);
      all.push(ev);
    }
  }
  return all;
}

const canonicalCores = (specs: Spec[]): string[] => [
  ...new Set(specs.flatMap((sp) => sp.cores).filter(Boolean))
];

async function sweepLeftovers(events: Ev[], specs: Spec[]): Promise<void> {
  if (!wanted("calendar.leftover_sweep")) return;
  section(`【步骤 2】清理上一轮 case 残留的日程（把 freebusy.slots_clear 要求的空闲时段腾回来）`);
  log(`  判据：标题含暗号 ${codeword} 且不属于下面 canonical 清单 → 判为残留，取消（delete）。`);
  log(`  canonical 清单（绝不会被扫掉）：`);
  for (const sp of specs) log(`    · [${sp.key}] 「${sp.title}」 ${sp.date} ${sp.sh}–${sp.eh}`);
  log(`  已知残留标题（来源 scenarios.v2.json 题面）：`);
  for (const l of KNOWN_LEFTOVERS) log(`    · 「${l.core} ${codeword}」 ← ${l.from}，${l.slot}`);

  if (!APPLY) {
    pushItem(
      "calendar.leftover_sweep",
      "auto",
      "残留日程清扫",
      "PLANNED",
      `dry-run：读不到真实日程；apply 时会在 ${TOMORROW} ~ ${AFTER3} 窗口内取消「含暗号且非 canonical」的残留（上面 ${KNOWN_LEFTOVERS.length} 种标题）`
    );
    return;
  }
  if (calReadFailed) {
    pushItem(
      "calendar.leftover_sweep",
      "auto",
      "残留日程清扫",
      "MANUAL",
      "日程读取失败 → 状态不明，不敢扫（红线 R7）"
    );
    addManual(
      `残留日程清扫失败：${TOMORROW}~${AFTER3} 的日程没读到（lark-cli 报错）。请人工在飞书日历里取消上一轮 case 新建的这些会：${KNOWN_LEFTOVERS.map((l) => `「${l.core} ${codeword}」`).join("、")}。`
    );
    return;
  }
  const cores = canonicalCores(specs);
  const cand = events.filter(
    (ev) => ev.summary.includes(codeword) && !cores.some((c) => ev.summary.includes(c))
  );
  const untouched = events.filter((ev) => !ev.summary.includes(codeword));
  if (untouched.length) {
    log(`  跳过 ${untouched.length} 场不含暗号的日程（红线 R1：不敢动）：`);
    for (const ev of untouched.slice(0, 20)) log(`    - ${fmtEv(ev)}`);
    addManual(
      `${TOMORROW}~${AFTER3} 窗口内有 ${untouched.length} 场不含暗号「${codeword}」的日程，本脚本按红线 R1 一律不动。请人工确认它们没压在 freebusy.slots_clear 的 9 个时段上（明天 11:30-12:00、明天下午至少留一个整点空、后天 10:00-11:00 / 14:00-15:00 / 15:00-16:00 / 16:00-17:00、大后天 14:00-15:00 / 15:00-16:00 / 16:30-17:30）。`
    );
  }
  if (!cand.length) {
    pushItem(
      "calendar.leftover_sweep",
      "auto",
      "残留日程清扫",
      "READY",
      `窗口内没有含暗号的残留日程（已就绪）`
    );
    return;
  }
  let bad = 0;
  for (const ev of cand) {
    const ok = await deleteEvent(
      ev.id,
      ev.summary,
      "上一轮 case 新建的残留，占着 freebusy 前置要求空闲的时段"
    );
    if (!ok) bad++;
  }
  pushItem(
    "calendar.leftover_sweep",
    "auto",
    "残留日程清扫",
    bad ? "FAILED" : "RESTORED",
    bad
      ? `${cand.length} 场残留里 ${bad} 场取消失败`
      : `已取消 ${cand.length} 场残留日程：${cand.map((e) => e.summary).join("、")}`
  );
  if (bad)
    addManual(
      `残留日程清扫有 ${bad} 场取消失败，请到飞书日历里人工取消（标题都含暗号 ${codeword}）。`
    );
}

/** 单场 canonical 日程：核对 → 已就绪跳过 / 不符则删掉重建 */
async function ensureOneSpec(events: Ev[], sp: Spec): Promise<Status> {
  const wantStart = epoch(iso(sp.date, sp.sh));
  const cands = events.filter(
    (ev) => ev.summary.includes(codeword) && sp.cores.some((c) => c && ev.summary.includes(c))
  );
  if (!APPLY) {
    log(
      `    （dry-run：读不到真实状态，一律按「需要重建」展示计划；apply 时会先核对，已就绪的直接跳过）`
    );
    const ok = await createEvent(sp);
    return ok ? "PLANNED" : "FAILED";
  }
  const exact = cands.filter((ev) => ev.startE === wantStart);
  const offTime = cands.filter((ev) => ev.startE !== wantStart);
  if (exact.length) {
    const keep = exact[0]!;
    if (await detailMatches(keep, sp)) {
      for (const ev of exact.slice(1))
        await deleteEvent(
          ev.id,
          ev.summary,
          "同一初始状态出现多场，删掉多余的，保证题面里的标题唯一命中"
        );
      for (const ev of offTime)
        await deleteEvent(
          ev.id,
          ev.summary,
          "同标题但时间不对（上一轮被改期留下的），删掉以保证唯一命中"
        );
      log(`    已就绪：${fmtEv(keep)}`);
      return exact.length > 1 || offTime.length ? "RESTORED" : "READY";
    }
    for (const ev of exact)
      await deleteEvent(
        ev.id,
        ev.summary,
        "时间对但会议室/参会人与初始状态不符，删掉重建（终态确定）"
      );
  } else if (offTime.length) {
    for (const ev of offTime) {
      log(`    发现同标题但时段不对（上一轮被改期/挪走）：${fmtEv(ev)}`);
      await deleteEvent(ev.id, ev.summary, "上一轮被改期，删掉后按初始时段重建");
    }
  } else {
    log(`    窗口内没找到「${sp.title}」→ 上一轮已被消耗（取消/改期/换房），需要重建`);
  }
  return (await createEvent(sp)) ? "RESTORED" : "FAILED";
}

const stLabel = (s: Status): string =>
  s === "READY"
    ? "已就绪"
    : s === "RESTORED"
      ? "已恢复"
      : s === "PLANNED"
        ? "计划恢复"
        : s === "FAILED"
          ? "失败"
          : s;

async function ensureSpecs(
  events: Ev[],
  specs: Spec[],
  missing: { key: string; reason: string }[]
): Promise<void> {
  if (!anyCalendarWanted) return;
  section(`【步骤 3】恢复日历类消耗型前置（策略：核对不符就「删掉重建」，理由见文件头）`);
  for (const m of missing) {
    if (!wanted(m.key)) continue;
    pushItem(m.key, "auto", titleOf(m.key), "MANUAL", m.reason);
    addManual(
      `${m.key}（${titleOf(m.key)}）：${m.reason}。原始造数要求见 fixtures.ts → ${(findFixture(m.key)?.howToPrepare ?? "").split("\n")[0]}`
    );
  }
  const byKey = new Map<string, Spec[]>();
  for (const sp of specs) {
    const arr = byKey.get(sp.key) ?? [];
    arr.push(sp);
    byKey.set(sp.key, arr);
  }
  for (const [key, list] of byKey) {
    if (!wanted(key)) continue;
    log(`\n  ▸ ${key} —— ${titleOf(key)}`);
    const st: Status[] = [];
    for (const sp of list) {
      log(
        `    初始状态：「${sp.title}」 ${sp.date} ${sp.sh}–${sp.eh}` +
          (sp.colleague ? `，参会人含 ${colleagueName}` : "") +
          (sp.onlySelf ? "，参会人仅本人" : "") +
          (sp.room ? `，真实预订「${roomName ?? "?"}」` : "")
      );
      st.push(await ensureOneSpec(events, sp));
    }
    const final: Status = st.includes("FAILED")
      ? "FAILED"
      : st.every((s) => s === "READY")
        ? "READY"
        : st.includes("PLANNED")
          ? "PLANNED"
          : "RESTORED";
    pushItem(
      key,
      "auto",
      titleOf(key),
      final,
      list.map((sp, i) => `${sp.date} ${sp.sh}–${sp.eh}：${stLabel(st[i]!)}`).join("；")
    );
    if (final === "FAILED") {
      addManual(
        `${key}（${titleOf(key)}）自动恢复失败。请人工在飞书日历里按初始状态重建：${list
          .map(
            (sp) =>
              `「${sp.title}」 ${sp.date} ${sp.sh}–${sp.eh}${sp.colleague ? ` 参会人含 ${colleagueName}` : ""}${sp.onlySelf ? " 参会人仅本人" : ""}${sp.room ? ` 真订「${roomName ?? "?"}」` : ""}`
          )
          .join("；")}。`
      );
    }
  }
}

/* --------------------------------------------- 日历：只读复核（报告项） */
async function reportCalendar(): Promise<void> {
  const keys = ["calendar.event_tomorrow", "calendar.second"].filter((k) => wanted(k));
  if (!keys.length) return;
  section(`【步骤 4】日历只读复核（只报告，不写）`);
  if (wanted("calendar.event_tomorrow")) {
    const key = "calendar.event_tomorrow";
    log(`\n  ▸ ${key} —— ${titleOf(key)}`);
    if (!APPLY) {
      pushItem(
        key,
        "report",
        titleOf(key),
        "REPORT_OK",
        `dry-run：不探测。apply 时会复核 ${TOMORROW} 是否 ≥1 场；canonical 里明天本来就有 5 场（09:00 / 10:00 / 14:00 / 15:00 / 16:30）`
      );
    } else {
      const out = await lark(
        [
          "calendar",
          "+agenda",
          "--calendar-id",
          "primary",
          "--start",
          iso(TOMORROW, "00:00"),
          "--end",
          iso(TOMORROW, "23:59"),
          "--as",
          "user"
        ],
        `复核 ${TOMORROW}（明天）是否 ≥1 场真实会议（FS2-C01-01 / FS2-A01-01 的基础）`
      );
      const evs = out?.ok ? normalizeEvents(out.json) : [];
      if (!out?.ok) {
        pushItem(key, "report", titleOf(key), "REPORT_BAD", "明天日程读取失败，无法确认");
        addManual(
          `calendar.event_tomorrow：${TOMORROW} 的日程没读到，请人工在飞书里确认明天至少有 1 场会（否则 FS2-C01-01 / FS2-A01-01 记 BLOCKED）。`
        );
      } else if (evs.length >= 1) {
        pushItem(
          key,
          "report",
          titleOf(key),
          "REPORT_OK",
          `${TOMORROW} 共 ${evs.length} 场会议：${evs
            .slice(0, 8)
            .map((e) => `${fmtT(e.startE)} ${e.summary}`)
            .join(" / ")}`
        );
      } else {
        pushItem(key, "report", titleOf(key), "REPORT_BAD", `${TOMORROW} 一场会都没有`);
        addManual(
          `calendar.event_tomorrow：${TOMORROW} 日历是空的，FS2-C01-01 / FS2-A01-01 会记 BLOCKED。步骤 2 的 canonical 日程若建成功了就不会为空，请回看上面哪一项失败。`
        );
      }
    }
  }
  if (wanted("calendar.second")) {
    const key = "calendar.second";
    const name = fxValue(key);
    log(`\n  ▸ ${key} —— ${titleOf(key)}`);
    const out = await lark(
      ["calendar", "calendars", "list", "--as", "user"],
      `列出本人可见日历：FS2-C09-01 要求 ≥2 个可选日历（只有 1 个则该 case 记 BLOCKED，不判失败）。只读，不建日历（红线 R2）`
    );
    if (!APPLY) {
      pushItem(
        key,
        "report",
        titleOf(key),
        "REPORT_OK",
        `dry-run：不探测。bindings 里第二个日历显示名 = ${name ? `「${name}」` : "(未填)"}`
      );
    } else if (!out?.ok) {
      pushItem(key, "report", titleOf(key), "REPORT_BAD", "日历列表读取失败");
      addManual(
        `calendar.second：日历列表没读到，请人工确认账号下 ≥2 个日历，并把第二个日历的显示名填进 bindings 的 fixtures["calendar.second"].value。`
      );
    } else {
      const names = [
        ...new Set(
          findAll(out.json, (n) => typeof n?.summary === "string" || typeof n?.name === "string")
            .map((n) => String(n.summary ?? n.name))
            .filter(Boolean)
        )
      ];
      const okCount = names.length >= 2;
      const hit = name
        ? names.some((n) => n === name || n.includes(name) || name.includes(n))
        : false;
      pushItem(
        key,
        "report",
        titleOf(key),
        okCount && (hit || !name) ? "REPORT_OK" : "REPORT_BAD",
        `可见日历 ${names.length} 个：${names.slice(0, 10).join(" / ") || "(空)"}${name ? `；bindings 指定「${name}」${hit ? "命中" : "⚠ 未命中"}` : ""}`
      );
      if (!okCount || (name && !hit)) {
        addManual(
          `calendar.second：账号下只有 ${names.length} 个日历${name ? `，或找不到 bindings 里写的「${name}」` : ""}。请人工新建/确认一个副日历（fixtures.ts 建议命名「测试副日历 ${codeword}」），并把显示名填回 bindings。本脚本按红线 R2 不建、不删日历。`
        );
      }
    }
  }
}

/* ============================================================ 主流程：云文档 */

/** case 每轮会新建的文档标题核心词（来源：scenarios.v2.json 里 feishu_create_doc 类 case 的题面原文） */
const CASE_CREATED_DOCS: { core: string; from: string }[] = [
  { core: "测试发布方案", from: "FS2-D06-01" },
  { core: "测试讨论整理", from: "FS2-X03-01" },
  { core: "测试待办清单", from: "FS2-S08-01" }
];
/** FS2-D05-01 题面写死的改名目标（不含 token，只能写死；改完必须能改回来） */
const RENAME_TO = "测试发布方案V2";
/** FS2-D04-01 题面写死的追加正文关键词（用于只读定位本轮追加的块） */
const APPEND_KEYWORD = "追加段|回归结果补齐了";

interface DocSearch {
  hits: DocHit[];
  ok: boolean;
  json: any | null;
}
async function searchDocs(query: string, purpose: string): Promise<DocSearch> {
  const out = await lark(
    ["docs", "+search", "--query", query, "--page-size", "20", "--as", "user"],
    purpose
  );
  if (!out) return { hits: [], ok: false, json: null };
  if (!out.ok) return { hits: [], ok: false, json: out.json };
  const hits = normalizeDocs(out.json);
  log(
    `    结果摘要：搜「${query}」命中 ${hits.length} 篇${
      hits.length
        ? `：${hits
            .slice(0, 8)
            .map((h) => h.title)
            .join(" / ")}`
        : ""
    }`
  );
  return { hits, ok: true, json: out.json };
}
/** 先严格同名，退一步再 containment（搜索结果里标题常被截断或带后缀） */
function pickExact(hits: DocHit[], title: string): DocHit[] {
  const t = title.trim();
  const ex = hits.filter((h) => h.title.trim() === t);
  if (ex.length) return ex;
  return hits.filter((h) => h.title.includes(t) || (h.title.length > 4 && t.includes(h.title)));
}
/** 从搜索响应里猜资源类型（drive +update-title 的 --type 必须与真实类型一致，否则 981003） */
function docTypeOf(json: any, hit: DocHit): string {
  const keys = ["obj_type", "docs_type", "doc_type", "type", "file_type"];
  const allow = new Set(["docx", "sheet", "bitable", "slides", "wiki", "file", "mindnote"]);
  for (const n of findAll(json, (x) => {
    const vals = [
      x?.token,
      x?.docs_token,
      x?.doc_token,
      x?.file_token,
      x?.obj_token,
      x?.url
    ].filter((v) => typeof v === "string");
    return vals.some((v) => (hit.token && v === hit.token) || (hit.url && v === hit.url));
  })) {
    for (const k of keys) {
      const v = typeof n?.[k] === "string" ? String(n[k]).toLowerCase() : "";
      if (allow.has(v)) return v;
      if (v === "doc" || v === "base") return v === "doc" ? "docx" : "bitable";
    }
  }
  const u = hit.url ?? "";
  if (u.includes("/docx/")) return "docx";
  if (u.includes("/wiki/")) return "wiki";
  if (u.includes("/sheets/")) return "sheet";
  if (u.includes("/base/")) return "bitable";
  return "docx"; // fixtures.ts 要求这几篇前置都是 docx
}
const docRef = (h: DocHit): string => h.token ?? h.url!;
const titleArgs = (h: DocHit, type: string): string[] =>
  h.url ? ["--url", h.url] : ["--token", h.token!, "--type", type];

/* ------------------------------------------------- doc.rename_target */
async function docRename(): Promise<void> {
  const key = "doc.rename_target";
  if (!wanted(key)) return;
  log(`\n  ▸ ${key} —— ${titleOf(key)}`);
  const orig = fxValue(key);
  if (!orig) {
    pushItem(
      key,
      "auto",
      titleOf(key),
      "MANUAL",
      `bindings 里 fixtures["${key}"].value 未填 → 不知道原标题，不猜（红线 R7）`
    );
    addManual(
      `doc.rename_target：bindings 里没填原标题，请填 fixtures["${key}"].value 后重跑；或人工把文档标题改回原值。`
    );
    return;
  }
  if (!orig.includes(codeword)) {
    pushItem(
      key,
      "auto",
      titleOf(key),
      "MANUAL",
      `bindings 里的原标题「${orig}」不含暗号 ${codeword} → 触发红线 R1，拒绝自动改名`
    );
    addManual(`doc.rename_target：原标题「${orig}」不含暗号，本脚本不敢动。请人工确认并改回标题。`);
    return;
  }
  const renamed = `${RENAME_TO} ${codeword}`;
  const s1 = await searchDocs(
    orig,
    `按原标题《${orig}》搜：搜到就说明标题没被改（已就绪），搜不到再去找被 FS2-D05-01 改成《${renamed}》的那篇`
  );

  if (!APPLY) {
    await lark(
      ["docs", "+search", "--query", renamed, "--page-size", "20", "--as", "user"],
      `原标题没搜到时，按《${renamed}》搜出被改名后的那篇（FS2-D05-01 每轮都会改名）`
    );
    await lark(
      [
        "drive",
        "+update-title",
        "--url",
        "<文档 URL 或 --token + --type docx>",
        "--title",
        orig,
        "--as",
        "user"
      ],
      `把标题从《${renamed}》改回《${orig}》：不改回，下一轮题面里的 {{doc_rename_title}} 就搜不到，FS2-D05-01 记 BLOCKED`
    );
    pushItem(
      key,
      "auto",
      titleOf(key),
      "PLANNED",
      `dry-run：计划「搜原标题 → 搜《${renamed}》→ drive +update-title 改回《${orig}》」`
    );
    return;
  }

  const ex1 = pickExact(s1.hits, orig);
  if (ex1.length === 1) {
    pushItem(key, "auto", titleOf(key), "READY", `《${orig}》唯一命中，标题没被改（已就绪）`);
    return;
  }
  if (ex1.length > 1) {
    pushItem(
      key,
      "auto",
      titleOf(key),
      "MANUAL",
      `《${orig}》命中 ${ex1.length} 篇 → 歧义，不猜是哪一篇（红线 R7）`
    );
    addManual(
      `doc.rename_target：《${orig}》搜到 ${ex1.length} 篇（${ex1.map((h) => docRef(h)).join("、")}）。请人工确认哪一篇是前置文档、把多余的改名或归档，保证唯一命中。`
    );
    return;
  }
  const s2 = await searchDocs(
    renamed,
    `原标题没搜到 → 找被 FS2-D05-01 改成《${renamed}》的那篇，准备改回`
  );
  const ex2 = pickExact(s2.hits, renamed);
  if (!ex2.length) {
    pushItem(
      key,
      "auto",
      titleOf(key),
      "MANUAL",
      `《${orig}》和《${renamed}》都搜不到 → 文档可能被删或搜索索引未刷新，不猜`
    );
    addManual(
      `doc.rename_target：《${orig}》与《${renamed}》都搜不到。请人工在飞书云文档里找这篇（可能刚改完名、搜索索引没刷新，等几分钟重试），必要时按 fixtures.ts 的结构重建一篇同名文档。`
    );
    return;
  }
  if (ex2.length > 1) {
    pushItem(
      key,
      "auto",
      titleOf(key),
      "MANUAL",
      `《${renamed}》命中 ${ex2.length} 篇 → 歧义，不猜（红线 R7）`
    );
    addManual(
      `doc.rename_target：《${renamed}》搜到 ${ex2.length} 篇（${ex2.map((h) => docRef(h)).join("、")}），说明上一轮改名产物没清干净。请人工只保留 1 篇并把标题改回《${orig}》，其余归档。`
    );
    return;
  }
  const hit = ex2[0]!;
  if (!hit.title.includes(codeword)) {
    log(`    跳过：「${hit.title}」不含暗号 ${codeword}，不敢动（红线 R1）`);
    pushItem(key, "auto", titleOf(key), "MANUAL", `命中的《${hit.title}》不含暗号 → 不动`);
    return;
  }
  const type = docTypeOf(s2.json, hit);
  log(`    资源类型判定：${type}（--type 与真实类型不符会报 981003）`);
  const out = await lark(
    ["drive", "+update-title", ...titleArgs(hit, type), "--title", orig, "--as", "user"],
    `把标题从《${hit.title}》改回《${orig}》（doc_token/url：${docRef(hit)}）`
  );
  if (out?.ok) {
    pushItem(
      key,
      "auto",
      titleOf(key),
      "RESTORED",
      `已把《${hit.title}》改回《${orig}》（${docRef(hit)}）`
    );
  } else {
    pushItem(key, "auto", titleOf(key), "FAILED", `改回标题失败：${out?.error ?? "未知原因"}`);
    addManual(
      `doc.rename_target：自动改回标题失败（${out?.error ?? "原因不明"}）。请人工把《${renamed}》（${docRef(hit)}）的标题改回《${orig}》。`
    );
  }
}

/* ------------------------------------------------- doc.append_target */
async function docAppend(): Promise<void> {
  const key = "doc.append_target";
  if (!wanted(key)) return;
  log(`\n  ▸ ${key} —— ${titleOf(key)}`);
  const title = fxValue(key);
  if (!title) {
    pushItem(
      key,
      "auto",
      titleOf(key),
      "MANUAL",
      `bindings 里 fixtures["${key}"].value 未填 → 不知道真实标题，不猜（红线 R7）`
    );
    addManual(
      `doc.append_target：bindings 没填标题。请填 fixtures["${key}"].value，或人工打开该文档删掉末尾「${codeword} 追加段…」那一段。`
    );
    return;
  }
  if (!title.includes(codeword)) {
    pushItem(
      key,
      "auto",
      titleOf(key),
      "MANUAL",
      `bindings 标题「${title}」不含暗号 ${codeword} → 触发红线 R1，拒绝自动删块`
    );
    addManual(
      `doc.append_target：标题「${title}」不含暗号，本脚本不敢删块。请人工删掉上一轮追加的那一段。`
    );
    return;
  }
  const s = await searchDocs(
    title,
    `搜《${title}》：定位 FS2-D04-01 每轮往末尾追加了一段的那篇文档`
  );

  if (!APPLY) {
    await lark(
      [
        "docs",
        "+fetch",
        "--doc",
        "<doc_token 或 URL>",
        "--scope",
        "keyword",
        "--keyword",
        APPEND_KEYWORD,
        "--detail",
        "with-ids",
        "--as",
        "user"
      ],
      `只读定位本轮追加的块：关键词「${APPEND_KEYWORD}」来自 FS2-D04-01 题面原文；--detail with-ids 才能拿到 block_id，绝不动原有段落`
    );
    await lark(
      [
        "docs",
        "+update",
        "--doc",
        "<doc_token 或 URL>",
        "--command",
        "block_delete",
        "--block-id",
        "<上一步拿到的 block_id，逗号分隔>",
        "--as",
        "user"
      ],
      `只删这些追加块，把文档恢复到「追加前」（原有 ≥3 段正文一段都不动）`
    );
    pushItem(
      key,
      "auto",
      titleOf(key),
      "PLANNED",
      `dry-run：计划「搜《${title}》→ keyword 定位追加段 → block_delete 只删追加块」；解析不出 block_id 就转人工，绝不盲删`
    );
    return;
  }

  const ex = pickExact(s.hits, title);
  if (!ex.length) {
    pushItem(key, "auto", titleOf(key), "MANUAL", `《${title}》搜不到 → 文档可能被删/改名，不猜`);
    addManual(
      `doc.append_target：《${title}》搜不到。请按 fixtures.ts 重建一篇同名 docx（正文 ≥3 个独立段落），否则 FS2-D04-01 记 BLOCKED。`
    );
    return;
  }
  if (ex.length > 1) {
    pushItem(
      key,
      "auto",
      titleOf(key),
      "MANUAL",
      `《${title}》命中 ${ex.length} 篇 → 歧义，不猜（红线 R7）`
    );
    addManual(
      `doc.append_target：《${title}》搜到 ${ex.length} 篇（${ex.map((h) => docRef(h)).join("、")}）。请人工保留 1 篇、其余改名或归档，再重跑本脚本。`
    );
    return;
  }
  const hit = ex[0]!;
  const f = await lark(
    [
      "docs",
      "+fetch",
      "--doc",
      docRef(hit),
      "--scope",
      "keyword",
      "--keyword",
      APPEND_KEYWORD,
      "--detail",
      "with-ids",
      "--as",
      "user"
    ],
    `只读定位《${title}》里本轮追加的块（关键词「${APPEND_KEYWORD}」）`
  );
  if (!f?.ok) {
    pushItem(
      key,
      "auto",
      titleOf(key),
      "MANUAL",
      `正文读取失败，拿不到 block_id → 不盲删（红线 R7）`
    );
    addManual(
      `doc.append_target：《${title}》（${docRef(hit)}）正文没读到，无法定位追加块。请人工删掉末尾那段「${codeword} 追加段，回归结果补齐了…」，或重建同名副本。`
    );
    return;
  }
  const raw = f.raw;
  if (!raw.includes("追加段") && !raw.includes("回归结果补齐了")) {
    pushItem(
      key,
      "auto",
      titleOf(key),
      "READY",
      `《${title}》里没有本轮追加段（本轮没跑 FS2-D04-01，或已清理过）→ 已就绪`
    );
    return;
  }
  if (!raw.includes(codeword)) {
    pushItem(
      key,
      "auto",
      titleOf(key),
      "MANUAL",
      `定位到的正文不含暗号 ${codeword} → 不敢删（红线 R1）`
    );
    addManual(
      `doc.append_target：《${title}》里疑似追加段的内容不含暗号 ${codeword}，本脚本不敢删。请人工核对后删除。`
    );
    return;
  }
  const ids = [...new Set([...raw.matchAll(/(?:doxcn|blk)[A-Za-z0-9_-]{6,}/g)].map((m) => m[0]))];
  if (!ids.length) {
    pushItem(key, "auto", titleOf(key), "MANUAL", `响应里解析不出 block_id（不敢盲删整篇）`);
    addManual(
      `doc.append_target：能读到追加段但解析不出 block_id。请人工打开《${title}》（${docRef(hit)}）删掉末尾那段，或自己跑：lark-cli docs +fetch --doc ${docRef(hit)} --scope keyword --keyword "${APPEND_KEYWORD}" --detail with-ids --as user 看清 block_id 后再 block_delete。`
    );
    return;
  }
  if (ids.length > 8) {
    pushItem(
      key,
      "auto",
      titleOf(key),
      "MANUAL",
      `解析出 ${ids.length} 个 block_id，远超「追加 1 段」的预期 → 不敢批量删（红线 R7）`
    );
    addManual(
      `doc.append_target：解析出 ${ids.length} 个 block_id（${ids.slice(0, 10).join(", ")}…），不像只追加了一段。请人工核对《${title}》（${docRef(hit)}）后再删。`
    );
    return;
  }
  const out = await lark(
    [
      "docs",
      "+update",
      "--doc",
      docRef(hit),
      "--command",
      "block_delete",
      "--block-id",
      ids.join(","),
      "--as",
      "user"
    ],
    `删掉本轮追加的 ${ids.length} 个块（${ids.join(", ")}），把《${title}》恢复到追加前`
  );
  if (out?.ok) {
    pushItem(
      key,
      "auto",
      titleOf(key),
      "RESTORED",
      `已删除追加的 ${ids.length} 个块，《${title}》恢复原状`
    );
  } else {
    pushItem(key, "auto", titleOf(key), "FAILED", `删块失败：${out?.error ?? "未知原因"}`);
    addManual(
      `doc.append_target：自动删块失败（${out?.error ?? "原因不明"}）。请人工打开《${title}》（${docRef(hit)}）删掉末尾追加段。`
    );
  }
}

/* --------------------------------------------- 云文档：只读报告项 */
async function reportDocs(): Promise<void> {
  const keys = ["doc.readonly_unique", "doc.duplicate_title", "doc.codeword_pool"].filter((k) =>
    wanted(k)
  );
  if (!keys.length) return;
  section(`【步骤 6】云文档只读复核（只报告，一个字都不改）`);

  if (wanted("doc.readonly_unique")) {
    const key = "doc.readonly_unique";
    const title = fxValue(key);
    log(`\n  ▸ ${key} —— ${titleOf(key)}（红线 R3：只报告，发现被改也不自动修）`);
    if (!title) {
      pushItem(key, "report", titleOf(key), "REPORT_BAD", "bindings 里没填标题，无法复核");
      addManual(
        `doc.readonly_unique：bindings 没填 fixtures["${key}"].value。请填《飞书测试文档-auto》的真实完整标题（标题里不带暗号，暗号写在正文首行）。`
      );
    } else if (!APPLY) {
      pushItem(
        key,
        "report",
        titleOf(key),
        "REPORT_OK",
        `dry-run：不探测。apply 时会核对《${title}》唯一命中 1 篇，且正文仍含暗号 + 决策/风险/待办三块`
      );
    } else {
      const s = await searchDocs(
        title,
        `搜《${title}》：必须唯一命中 1 篇（7 条只读文档 case 的目标；命中 ≥2 篇这些 case 全变歧义）`
      );
      const ex = pickExact(s.hits, title);
      if (ex.length !== 1) {
        pushItem(
          key,
          "report",
          titleOf(key),
          "REPORT_BAD",
          `《${title}》命中 ${ex.length} 篇（要求唯一 1 篇）`
        );
        addManual(
          `doc.readonly_unique：《${title}》命中 ${ex.length} 篇（${ex.map((h) => docRef(h)).join("、") || "0 篇"}）。命中 2 篇以上会让 FS2-D01/D07/X04/X07/V04/A05/S08 全部变歧义、只能判 LABEL_ERROR。请人工把多余副本改名或移到归档文件夹（红线 R2：本脚本不删文档），保留唯一一篇。`
        );
      } else {
        const hit = ex[0]!;
        const f = await lark(
          [
            "docs",
            "+fetch",
            "--doc",
            docRef(hit),
            "--scope",
            "full",
            "--doc-format",
            "markdown",
            "--as",
            "user"
          ],
          `只读核对《${title}》正文：暗号 + 决策（先灰度后全量）/ 风险（回归未完成）/ 待办（补回归结果）三块是否都还在`
        );
        const text = f?.raw ?? "";
        const need: [string, string][] = [
          ["暗号", codeword],
          ["决策（先灰度后全量）", "灰度"],
          ["风险（回归未完成）", "回归"],
          ["待办（补回归结果）", "待办"]
        ];
        const lacks = need.filter(([, kw]) => !text.includes(kw)).map(([n]) => n);
        if (!f?.ok) {
          pushItem(key, "report", titleOf(key), "REPORT_BAD", `正文读取失败，无法确认是否被改`);
          addManual(
            `doc.readonly_unique：《${title}》正文没读到（${f?.error ?? "原因不明"}）。请人工打开确认它没被任何 case 改过、且仍含决策/风险/待办三块。`
          );
        } else if (lacks.length) {
          pushItem(
            key,
            "report",
            titleOf(key),
            "REPORT_BAD",
            `《${title}》正文缺少：${lacks.join("、")} → 只读文档疑似被改（R3：只报告不自动修）`
          );
          addManual(
            `doc.readonly_unique：《${title}》（${docRef(hit)}）正文里找不到「${lacks.join("、")}」。它是只读前置，任何 case 都不该改它；被改了就是产品缺陷。请人工核对并补回原文（决策=先灰度后全量、风险=回归未完成、待办=补回归结果且负责人未指定），本脚本不自动改。`
          );
        } else {
          pushItem(
            key,
            "report",
            titleOf(key),
            "REPORT_OK",
            `《${title}》唯一命中，正文含暗号与决策/风险/待办三块（未被改）`
          );
        }
      }
    }
  }

  if (wanted("doc.duplicate_title")) {
    const key = "doc.duplicate_title";
    const title = fxValue(key);
    log(`\n  ▸ ${key} —— ${titleOf(key)}`);
    if (!title) {
      pushItem(key, "report", titleOf(key), "REPORT_BAD", "bindings 里没填同名文档标题");
      addManual(
        `doc.duplicate_title：bindings 没填 fixtures["${key}"].value。请按 fixtures.ts 建 2 篇标题完全相同的 docx（建议《产品周会纪要 ${codeword}》），并把标题填进 bindings。`
      );
    } else if (!APPLY) {
      pushItem(
        key,
        "report",
        titleOf(key),
        "REPORT_OK",
        `dry-run：不探测。apply 时会核对《${title}》确实有 ≥2 篇同名`
      );
    } else {
      const s = await searchDocs(
        title,
        `搜《${title}》：FS2-D02-01 要求确实存在 ≥2 篇同名文档（歧义负例）`
      );
      const ex = pickExact(s.hits, title);
      if (ex.length >= 2) {
        pushItem(
          key,
          "report",
          titleOf(key),
          "REPORT_OK",
          `《${title}》同名 ${ex.length} 篇（≥2，歧义负例成立）`
        );
      } else {
        pushItem(
          key,
          "report",
          titleOf(key),
          "REPORT_BAD",
          `《${title}》只命中 ${ex.length} 篇（要求 ≥2 篇）`
        );
        addManual(
          `doc.duplicate_title：《${title}》只搜到 ${ex.length} 篇，FS2-D02-01 会记 BLOCKED。请人工再建一篇**标题完全相同**的 docx（正文可各写一句区分：一篇排期写明天、一篇写后天）。红线 R2：本脚本不建也不删文档。`
        );
      }
    }
  }

  if (wanted("doc.codeword_pool")) {
    const key = "doc.codeword_pool";
    log(`\n  ▸ ${key} —— ${titleOf(key)}`);
    const out = await lark(
      ["docs", "+search", "--query", codeword, "--page-size", "20", "--as", "user"],
      `按暗号 ${codeword} 搜文档：FS2-D03-01 要求 ≥3 篇、且标题互不相同（同名会制造它自己不该有的歧义）`
    );
    if (!APPLY) {
      pushItem(
        key,
        "report",
        titleOf(key),
        "REPORT_OK",
        `dry-run：不探测。apply 时会统计标题含 ${codeword} 的文档数与重名情况，并把 case 每轮新建的 ${CASE_CREATED_DOCS.map((d) => `《${d.core} ${codeword}》`).join("、")} 列入人工归档清单`
      );
      return;
    }
    if (!out?.ok) {
      pushItem(key, "report", titleOf(key), "REPORT_BAD", "按暗号搜索失败");
      addManual(
        `doc.codeword_pool：按暗号 ${codeword} 搜文档失败（${out?.error ?? "原因不明"}）。请人工在飞书云文档里搜一次，确认标题含暗号的文档 ≥3 篇且标题互不相同。`
      );
    } else {
      const hits = normalizeDocs(out.json).filter((h) => h.title.includes(codeword));
      const byTitle = new Map<string, number>();
      for (const h of hits) byTitle.set(h.title, (byTitle.get(h.title) ?? 0) + 1);
      const titles = [...byTitle.keys()];
      const dupBad = [...byTitle.entries()].filter(
        ([t, n]) => n > 1 && t !== fxValue("doc.duplicate_title")
      );
      log(`    结果摘要：标题含暗号的文档 ${hits.length} 篇、${titles.length} 个不同标题`);
      for (const [t, n] of byTitle) log(`      · 《${t}》 × ${n}`);
      if (titles.length >= 3 && !dupBad.length) {
        pushItem(
          key,
          "report",
          titleOf(key),
          "REPORT_OK",
          `暗号文档 ${hits.length} 篇 / ${titles.length} 个不同标题（≥3 且无意外重名）`
        );
      } else {
        pushItem(
          key,
          "report",
          titleOf(key),
          "REPORT_BAD",
          `不同标题 ${titles.length} 个（要求 ≥3）${dupBad.length ? `；意外重名：${dupBad.map(([t, n]) => `《${t}》×${n}`).join("、")}` : ""}`
        );
      }
      if (dupBad.length) {
        addManual(
          `doc.codeword_pool：出现意外重名文档 ${dupBad.map(([t, n]) => `《${t}》×${n}`).join("、")}（只有 doc.duplicate_title 那对同名是故意的）。这会让 FS2-D03-01 的清单出现歧义。请人工把多余的副本改名或移到归档文件夹；来源大概率是 ${CASE_CREATED_DOCS.map((d) => `${d.from}《${d.core} ${codeword}》`).join("、")} 每轮各新建一篇、3 轮叠出来的。`
        );
      }
      if (titles.length < 3) {
        addManual(
          `doc.codeword_pool：标题含暗号 ${codeword} 的文档只有 ${titles.length} 个不同标题（要求 ≥3），FS2-D03-01 会记 BLOCKED。请人工确认 doc.append_target / doc.partial_target / doc.rename_target / doc.prune_target / doc.duplicate_title 这几篇都建好了。`
        );
      }
    }
  }
}

/* ------------------------------------- 正文被破坏、只能人工重建的三篇文档 */
/**
 * doc.partial_target / doc.prune_target / doc.rewrite_target：
 * case 会改日期、删块、整篇重写，正文结构一旦被破坏就**不可逆**——脚本没法凭空写回原文
 * （原文内容不在仓库里，任何自动重建都等于编造）。按红线 R7 一律转人工，只打印清单。
 * 技术上 lark-cli 有 docs +history-revert，但「回到哪个版本」必须人眼确认，本脚本不自动回滚。
 */
const REBUILD_ONLY_KEYS = ["doc.partial_target", "doc.prune_target", "doc.rewrite_target"];
function docRebuildOnly(): void {
  for (const key of REBUILD_ONLY_KEYS) {
    if (!wanted(key)) continue;
    const title = fxValue(key);
    const f = findFixture(key);
    const prep = (f?.howToPrepare ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const structReq = (prep.find((l) => l.startsWith("建一篇")) ?? prep[0] ?? "").replace(
      /。+$/,
      ""
    );
    pushItem(
      key,
      "auto",
      f?.name ?? key,
      "MANUAL",
      `${title ? `《${title}》` : "(bindings 未填标题)"} 正文被 case 破坏后不可逆（改日期/删块/整篇重写），脚本无法凭空写回原文 → 转人工重建副本`
    );
    addManual(
      `${key}（${f?.name ?? key}）${title ? `《${title}》` : "（bindings 未填标题）"}：上一轮跑完正文就废了，重跑前必须人工重建**同内容**副本，否则相关 case 记 BLOCKED。原始造数要求（fixtures.ts）：${structReq}。偷懒办法：打开该文档的历史版本（lark-cli docs +history-list --doc <token> --as user），人眼确认后用 docs +history-revert 回到跑前那一版——版本要你自己认，本脚本不自动回滚。`
    );
  }
}

async function docsPipeline(): Promise<void> {
  const keys = ["doc.rename_target", "doc.append_target", ...REBUILD_ONLY_KEYS].filter((k) =>
    wanted(k)
  );
  if (!keys.length) return;
  section(`【步骤 5】云文档类前置：能自动恢复的恢复（改回标题 / 删掉本轮追加块），不能的转人工`);
  log(
    `  红线 R2：本脚本永不调用 drive +delete，不删任何整篇文档；红线 R3：doc.readonly_unique 只报告不修。`
  );
  await docRename();
  await docAppend();
  docRebuildOnly();
}

/* ============================================================ 人工清单（静态部分） */
const scenariosPath = resolve(root, "scenarios.v2.json");
/** 兜底：scenarios.v2.json 读不到时用这份写死的清单（来源同上，人工核对过） */
const FALLBACK_SEND_CASES = [
  "FS2-M06-01",
  "FS2-M07-01",
  "FS2-M08-01",
  "FS2-A04-01",
  "FS2-X02-01",
  "FS2-X04-01",
  "FS2-X06-01",
  "FS2-X07-01"
];
const FALLBACK_CREATE_DOC_CASES = ["FS2-D06-01", "FS2-X03-01", "FS2-S08-01"];

async function collectStaticManual(): Promise<string[]> {
  const sc = await readJsonSafe(scenariosPath);
  const cases: any[] = Array.isArray(sc?.cases) ? sc.cases : [];
  const writesOf = (c: any): string[] => Object.keys(c?.expected?.allowedWrites ?? {});
  const sendIds = cases
    .filter((c) => writesOf(c).includes("feishu_send_message"))
    .map((c) => String(c.id));
  const createIds = cases
    .filter((c) => writesOf(c).includes("feishu_create_doc"))
    .map((c) => String(c.id));
  const sends = sendIds.length ? sendIds : FALLBACK_SEND_CASES;
  const creates = createIds.length ? createIds : FALLBACK_CREATE_DOC_CASES;
  const out: string[] = [];

  out.push(
    `【每轮之间跑一次本脚本】run_index 1 → 2 → 3 是串行的，每轮跑完、下一轮开跑前执行一次：npx tsx test_suite/feishu-e2e-v2/scripts/reset-fixtures.ts --apply（不带 --apply 就是 dry-run，只看计划）。不要在一轮跑到一半时执行。`
  );
  out.push(
    `【开跑前 3 分钟自检】① lark-cli auth status —— user 身份必须 available（上次 user token 过期于 2026-09-04，过期就 lark-cli auth login 重新扫码，注意勾选日历/文档/IM 的**写权限**，否则本脚本 --apply 会大面积失败）；② npx tsx test_suite/feishu-e2e-v2/scripts/preflight.ts --probe —— 39 项前置体检；③ 人工扫一眼 ${TOMORROW} ~ ${AFTER3} 的日历，确认 freebusy.slots_clear 那 9 个时段没被压住。`
  );
  out.push(
    `【消息撤回：${sends.length} 条 case，本脚本一律不碰（红线 R4）】${sends.join("、")} 每轮都会用**你本人身份**真发消息，飞书消息发出去就收不回自动化的余地（im messages delete 是 high-risk-write，必须你自己确认）。message_id 从本轮 run 证据里取，然后逐条执行：lark-cli im messages delete --message-id <om_xxx> --as user --yes；或直接在飞书客户端里长按撤回。3 轮 = 每处各 3 条，别漏。`
  );
  out.push(
    `【新建文档归档：${creates.length} 条 case（红线 R2：本脚本不删文档）】${creates.join("、")} 每轮各新建 1 篇，3 轮就是各 3 篇同名：${CASE_CREATED_DOCS.map((d) => `《${d.core} ${codeword}》(${d.from})`).join("、")}。加上 FS2-D05-01 改名产物《${RENAME_TO} ${codeword}》。请人工把多余副本改名或移到归档文件夹，否则 doc.codeword_pool / doc.readonly_unique 会出现同名歧义，FS2-D02/D03 只能判 LABEL_ERROR。`
  );
  out.push(
    `【msg.keyword_in_group】FS2-M03/M04/X01/X03 要求「秦宇龙在最近 2 天内发过含关键词的群消息」。这条只能由**他本人**重发（本脚本不会冒充别人发言）。开跑当天确认关键词消息还在 2 天窗口内，超窗就让他在飞书测试群再发一条含「${fxValue("msg.keyword_in_group") ?? "发布评审"}」的消息。`
  );
  out.push(
    `【doc.readonly_unique 是只读红线】《${fxValue("doc.readonly_unique") ?? "飞书测试文档-auto"}》任何 case 都不该改它。上面步骤 6 只做只读复核；一旦报告「正文缺少决策/风险/待办」或「命中 ≥2 篇」，说明有 case 越界或副本没清干净——这属于产品缺陷/环境污染，请人工处理，本脚本按红线 R3 不自动修。`
  );
  return out;
}

/* ============================================================ 总结与退出码 */
function printSummary(allManual: string[]): void {
  section(`【总结】`);
  const auto = items.filter(
    (i) => i.kind === "auto" && (i.status === "RESTORED" || i.status === "PLANNED")
  );
  const ready = items.filter((i) => i.status === "READY");
  const failed = items.filter((i) => i.status === "FAILED");
  const manual = items.filter((i) => i.status === "MANUAL" || i.status === "REPORT_BAD");
  const repOk = items.filter((i) => i.status === "REPORT_OK");
  const repBad = items.filter((i) => i.status === "REPORT_BAD");

  log(`逐项结果：`);
  for (const i of items) {
    const tag = i.kind === "auto" ? "自动" : "报告";
    log(`  [${tag}] ${i.key.padEnd(30, " ")} ${stLabel(i.status).padEnd(6, " ")} ${i.detail}`);
  }

  log(
    `\n自动恢复 ${auto.length} 项 / 跳过 ${ready.length} 项（已就绪）/ 需人工 ${allManual.length} 项`
  );
  log(
    `（另有只读报告项：正常 ${repOk.length} / 异常 ${repBad.length}；自动项转人工 ${manual.filter((i) => i.kind === "auto").length} 项；执行失败 ${failed.length} 项）`
  );
  if (!APPLY)
    log(
      `注意：当前是 dry-run，「自动恢复 ${auto.length} 项」是**计划**条数，一条都没真跑；要真跑加 --apply。`
    );

  log(`\n【需人工处理清单（明天照做，按顺序）】`);
  if (!allManual.length) log(`  （无）`);
  allManual.forEach((s, i) => log(`  ${i + 1}. ${s}`));

  if (failed.length) {
    log(`\n❌ apply 有 ${failed.length} 项恢复失败：`);
    for (const f of failed) log(`   · ${f.key}（${f.title}）：${f.detail}`);
  }
}

/* ============================================================ main */
async function main(): Promise<number> {
  log(`飞书 E2E v2 · 轮间前置恢复脚本 reset-fixtures`);
  log(LINE);
  log(
    `  模式        ：${APPLY ? "🔴 apply（真实写飞书资源）" : "🟢 dry-run（默认；只打印计划，一条都不执行）"}`
  );
  log(`  bindings    ：${bindingsPath}`);
  log(`  暗号（R1）  ：${codeword}`);
  log(`  日期（沪）  ：今天 ${TODAY} / 明天 ${TOMORROW} / 后天 ${AFTER} / 大后天 ${AFTER3}`);
  log(`  同事 / 房间 ：${colleagueName} / ${roomName ?? "(bindings 未填 room.suzhou_free)"}`);
  if (only) log(`  --only      ：${only.join("、")}`);
  if (!APPLY)
    log(
      `  说明        ：dry-run 读不到真实资源状态，所有判断按「需要重建」展示；已就绪的项要 apply 时才识别得出。`
    );

  section(`【步骤 0】身份确认（只读）`);
  const authOk = await ensureAuth();
  if (APPLY && !authOk) {
    pushItem(
      "auth.lark_user_token",
      "auto",
      "lark-cli user 身份",
      "FAILED",
      "user 身份不可用 → 本轮没有执行任何恢复动作（读写全免谈）"
    );
    addManual(
      `lark-cli user 身份不可用：先跑 lark-cli auth login 完成扫码授权（记得给日历/文档/IM 的写权限），再重跑本脚本 --apply。`
    );
    printSummary([...(await collectStaticManual()), ...manualSteps]);
    return 1;
  }

  const { specs, missing } = buildSpecs();
  let events: Ev[] = [];
  if (anyCalendarWanted) {
    section(`【步骤 1】读取 ${TOMORROW} ~ ${AFTER3} 的日程（后面所有判断的唯一数据来源）`);
    events = await fetchWindowEvents();
    if (APPLY)
      log(
        `  窗口内共 ${events.length} 场日程；其中含暗号 ${codeword} 的 ${events.filter((e) => e.summary.includes(codeword)).length} 场。`
      );
  }

  await sweepLeftovers(events, specs);
  await ensureSpecs(events, specs, missing);
  await reportCalendar();
  await docsPipeline();
  await reportDocs();

  const allManual = [...(await collectStaticManual()), ...manualSteps];
  printSummary(allManual);
  return APPLY && items.some((i) => i.status === "FAILED") ? 1 : 0;
}

process.exit(await main());
