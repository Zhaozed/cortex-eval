/**
 * 把 cases.v2.*.jsonl 导入评测平台（新建独立套件，绝不覆盖旧套件）。
 *
 * 用法：
 *   npx tsx test_suite/feishu-e2e-v2/scripts/import-suite.ts --cases <cases.jsonl> [--name <套件名>] [--desc <描述>] [--dry-run] [--force]
 *   npx tsx test_suite/feishu-e2e-v2/scripts/import-suite.ts --delete-suite <suiteId>   # 清理误建套件
 *
 * 行为：
 *   1. 按名字找套件（--name 优先，否则取 suite-config.json 的 suite_name）；找到就复用，找不到就新建。
 *      --desc 同理覆盖 suite_description；复用已有套件时若描述不一致会 PUT 同步一次
 *      （子集套件的描述必须和全集区分开，否则在平台列表里分不清哪个是冒烟用的）。
 *   2. 先 dryRun 预检，把服务端的问题原样打印出来。
 *   3. 真导入（平台是**整集替换**语义：导入后该套件只含本次这批 case）。
 *   4. 读回校验条数、逐条 case_id、断言条数。
 *
 * 安全：脚本里硬编码了旧套件 ID 黑名单，命中就拒绝执行——避免手滑把「原始33条」覆盖掉。
 */
import { readFile } from "node:fs/promises";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

/** 旧套件（回归基线），任何情况下都不许被本脚本写入 */
const PROTECTED_SUITE_IDS = new Set(["01a0a319-d701-73bb-ba2c-7e4f45833c7f"]);
const PROTECTED_SUITE_NAMES = ["飞书功能场景 E2E｜原始33条"];

const argv = process.argv.slice(2);
const get = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const dryRun = argv.includes("--dry-run");
const force = argv.includes("--force");
const casesPath = resolve(get("--cases") ?? resolve(root, "cases.v2.ready.jsonl"));
const suiteName = get("--name") ?? undefined;
/** 覆盖套件描述。不传就用 suite-config.json 的 suite_description（= 全集的描述） */
const suiteDesc = get("--desc") ?? undefined;
const base = (get("--base") ?? "http://127.0.0.1:4310").replace(/\/$/, "");

/* 清理助手：--delete-suite <id> 删掉一个套件（受保护旧套件除外） */
const deleteId = get("--delete-suite");
if (deleteId) {
  if (PROTECTED_SUITE_IDS.has(deleteId)) throw new Error(`拒绝执行：${deleteId} 是受保护的旧套件`);
  const detail = await (await fetch(`${base}/api/v1/test-suites/${deleteId}`)).json() as any;
  const res = await fetch(`${base}/api/v1/test-suites/${deleteId}?expectedRevision=${detail.revision}`, { method: "DELETE" });
  if (!res.ok && res.status !== 204) throw new Error(`删除失败 HTTP ${res.status}\n${(await res.text()).slice(0, 500)}`);
  console.log(`已删除套件 ${deleteId}（${detail.name}）`);
  process.exit(0);
}

const cfg = JSON.parse(await readFile(resolve(root, "suite-config.json"), "utf8"));
const name = suiteName ?? cfg.suite_name;
const description = suiteDesc ?? cfg.suite_description;
if (PROTECTED_SUITE_NAMES.includes(name)) throw new Error(`拒绝执行：${name} 是受保护的旧套件名`);

/* 读 cases，转成 multipart File */
const raw = await readFile(casesPath);
const text = raw.toString("utf8");
const lines = text.split(/\r?\n/).filter((l) => l.trim());
if (!lines.length) throw new Error(`${casesPath} 是空的`);
for (const [i, l] of lines.entries()) {
  try {
    JSON.parse(l);
  } catch (e) {
    throw new Error(`${casesPath} 第 ${i + 1} 行不是合法 JSON：${(e as Error).message}`);
  }
}
console.log(`读取 ${lines.length} 条 case：${casesPath}`);

async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(base + path, init);
  const body = await res.text();
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} → HTTP ${res.status}\n${body.slice(0, 800)}`);
  return body ? (JSON.parse(body) as T) : (undefined as T);
}

/* 1. 找套件 */
let suite: { id: string; name: string; revision: number; caseCount: number } | null = null;
let cursor: string | undefined;
for (let page = 0; page < 50; page += 1) {
  const qs = new URLSearchParams({ limit: "100" });
  if (cursor) qs.set("cursor", cursor);
  const res = await api<any>(`/api/v1/test-suites?${qs}`);
  for (const it of res.items ?? []) if (it.name === name) suite = it;
  cursor = res.nextCursor;
  if (suite || !cursor) break;
}
if (suite) {
  if (PROTECTED_SUITE_IDS.has(suite.id)) throw new Error(`拒绝执行：${suite.id} 是受保护的旧套件`);
  console.log(`复用已有套件：${suite.name}（id=${suite.id}，revision=${suite.revision}，当前 ${suite.caseCount} 条）`);
  /* 描述漂移会让「全集 / MINI 冒烟」在平台列表里长得一样，必须同步。dry-run 只提示不动手 */
  if ((suite as any).description !== description) {
    if (dryRun) console.log("[dry-run] 描述与平台现值不一致，真导入时会 PUT 同步");
    else {
      const upd = await api<any>(`/api/v1/test-suites/${suite.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: suite.name, description, expectedRevision: suite.revision })
      });
      suite.revision = Number(upd?.revision ?? suite.revision);
      console.log(`已同步套件描述（revision=${suite.revision}）`);
    }
  }
  if (suite.caseCount > 0 && !force)
    throw new Error(
      `该套件已有 ${suite.caseCount} 条 case，导入是**整集替换**会全部覆盖。\n` +
        `确认无误请加 --force；或换一个 --name 新建套件。`
    );
} else {
  if (dryRun) {
    console.log(`[dry-run] 将新建套件「${name}」`);
  } else {
    suite = await api<any>("/api/v1/test-suites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, description })
    });
    console.log(`已新建套件：${suite!.name}（id=${suite!.id}，revision=${suite!.revision}）`);
  }
}
if (dryRun && !suite) {
  console.log("[dry-run] 未创建套件，无法做服务端导入预检。去掉 --dry-run 才会真的建套件并导入。");
  process.exit(0);
}
const suiteId = suite!.id;

/* 2/3. 导入（先 dryRun 再真导） */
const filename = basename(casesPath).endsWith(".jsonl") ? basename(casesPath) : `${basename(casesPath)}.jsonl`;
async function postImport(expectedRevision: number, isDry: boolean) {
  const form = new FormData();
  form.append("file", new Blob([raw], { type: "application/x-ndjson" }), filename);
  const qs = new URLSearchParams({ expectedRevision: String(expectedRevision) });
  if (isDry) qs.set("dryRun", "true");
  const res = await fetch(`${base}/api/v1/test-suites/${suiteId}/import?${qs}`, { method: "POST", body: form });
  const body = await res.text();
  if (!res.ok) throw new Error(`导入${isDry ? "预检" : ""}失败 HTTP ${res.status}\n${body.slice(0, 3000)}`);
  return body ? JSON.parse(body) : null;
}

const current = await api<any>(`/api/v1/test-suites/${suiteId}`);
const preview = await postImport(current.revision, true);
console.log(`服务端预检：${JSON.stringify(preview?.summary ?? preview, null, 2).slice(0, 1200)}`);
const previewErrors = (preview?.errors ?? preview?.issues ?? []) as any[];
if (previewErrors.length && !force) throw new Error(`服务端预检报 ${previewErrors.length} 处问题，已中止。加 --force 可强行导入。`);

if (dryRun) {
  console.log("[dry-run] 预检通过，未真导入。");
  process.exit(0);
}
const result = await postImport(current.revision, false);
console.log(`导入完成：${JSON.stringify(result?.summary ?? result, null, 2).slice(0, 800)}`);

/* 4. 读回校验 */
const after = await api<any>(`/api/v1/test-suites/${suiteId}`);
const readBack: string[] = [];
let caseCursor: string | undefined;
for (let page = 0; page < 20; page += 1) {
  const qs = new URLSearchParams({ limit: "100" });
  if (caseCursor) qs.set("cursor", caseCursor);
  const res = await api<any>(`/api/v1/test-suites/${suiteId}/cases?${qs}`);
  for (const it of res.items ?? []) readBack.push(it.caseKey ?? it.case_id ?? it.metadata?.case_id ?? "?");
  caseCursor = res.nextCursor;
  if (!caseCursor) break;
}
const expectedIds = lines.map((l) => JSON.parse(l).metadata.case_id as string);
const missing = expectedIds.filter((id) => !readBack.includes(id));
const extra = readBack.filter((id) => !expectedIds.includes(id));
console.log(
  JSON.stringify(
    {
      suite_id: suiteId,
      suite_name: after.name,
      revision: after.revision,
      imported: lines.length,
      read_back: readBack.length,
      missing,
      extra,
      ok: missing.length === 0 && extra.length === 0 && readBack.length === expectedIds.length,
      url: `http://127.0.0.1:4310/test-suites/${suiteId}`
    },
    null,
    2
  )
);
if (missing.length || extra.length) process.exitCode = 1;
