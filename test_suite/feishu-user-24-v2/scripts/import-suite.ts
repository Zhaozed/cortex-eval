/**
 * feishu-user-24-v2：把 ToolHub 合并后的 24 条断言适配集导入平台（新建独立套件，绝不覆盖旧集）。
 *
 * 用法：
 *   npx tsx test_suite/feishu-user-24-v2/scripts/import-suite.ts [--cases <cases.jsonl>] [--name <套件名>] [--desc <描述>] [--dry-run] [--force]
 */
import { readFile } from "node:fs/promises";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

/** 旧套件（回归基线），任何情况下都不许被本脚本写入 */
const PROTECTED_SUITE_IDS = new Set([
  "01a0a319-d701-73bb-ba2c-7e4f45833c7f", // 飞书功能场景 E2E｜原始33条
  "01a0a8e0-7ffb-75a9-834d-faf37bf92fac" // 飞书用户整理24条｜2026-09-16（旧工具名，隔离基线）
]);
const PROTECTED_SUITE_NAMES = ["飞书功能场景 E2E｜原始33条", "飞书用户整理24条｜2026-09-16"];

const argv = process.argv.slice(2);
const get = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const dryRun = argv.includes("--dry-run");
const force = argv.includes("--force");
const casesPath = resolve(get("--cases") ?? resolve(root, "cases.jsonl"));
const suiteName = get("--name") ?? "飞书用户整理24条｜v2 ToolHub合并｜2026-09-17";
const suiteDesc =
  get("--desc") ??
  "ToolHub 工具合并（docs/chat 统一契约，2026-09-17 V1.1）后的 24 条隔离/真实链路评测集：19 isolated + 5 client。仅调整断言适配新工具名（search_docs/get_doc/create_doc/update_doc/send_chat_message/get_chat_messages/search_chat_messages/get_chat_thread/list_chats/list_chat_members/search_chat_users），用户输入未动。D5.5 危险确认只针对 send_chat_message/delete_events；update_doc mode=replace 仅在未定位 block_id/block_ids 时判整篇替换。";
const base = (get("--base") ?? "http://127.0.0.1:4310").replace(/\/$/, "");

if (PROTECTED_SUITE_NAMES.includes(suiteName))
  throw new Error(`拒绝执行：${suiteName} 是受保护的旧套件名`);

const raw = await readFile(casesPath);
const text = raw.toString("utf8");
const lines = text.split(/\r?\n/).filter((l) => l.trim());
if (!lines.length) throw new Error(`${casesPath} 是空的`);
for (const [i, l] of lines.entries()) {
  try {
    JSON.parse(l);
  } catch {
    throw new Error(`${casesPath} 第 ${i + 1} 行不是合法 JSON`);
  }
}
console.log(`读取 ${lines.length} 条 case：${casesPath}`);

async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(base + path, init);
  const body = await res.text();
  if (!res.ok)
    throw new Error(`${init?.method ?? "GET"} ${path} → HTTP ${res.status}\n${body.slice(0, 800)}`);
  return body ? (JSON.parse(body) as T) : (undefined as T);
}

/* 1. 找套件：按名字，找到非空且无 --force 就拒绝（整集替换语义） */
let suite: {
  id: string;
  name: string;
  revision: number;
  caseCount: number;
  description?: string;
} | null = null;
let cursor: string | undefined;
for (let page = 0; page < 50; page += 1) {
  const qs = new URLSearchParams({ limit: "100" });
  if (cursor) qs.set("cursor", cursor);
  const res = await api<any>(`/api/v1/test-suites?${qs}`);
  for (const it of res.items ?? []) if (it.name === suiteName) suite = it;
  cursor = res.nextCursor;
  if (suite || !cursor) break;
}
if (suite) {
  if (PROTECTED_SUITE_IDS.has(suite.id)) throw new Error(`拒绝执行：${suite.id} 是受保护的旧套件`);
  console.log(
    `复用已有套件：${suite.name}（id=${suite.id}，revision=${suite.revision}，当前 ${suite.caseCount} 条）`
  );
  if ((suite as any).description !== suiteDesc && !dryRun) {
    const upd = await api<any>(`/api/v1/test-suites/${suite.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: suite.name,
        description: suiteDesc,
        expectedRevision: suite.revision
      })
    });
    suite.revision = Number(upd?.revision ?? suite.revision);
    console.log(`已同步套件描述（revision=${suite.revision}）`);
  }
  if (suite.caseCount > 0 && !force)
    throw new Error(
      `该套件已有 ${suite.caseCount} 条 case，导入是整集替换会全部覆盖。确认请加 --force，或换 --name 新建。`
    );
} else {
  if (dryRun) {
    console.log(`[dry-run] 将新建套件「${suiteName}」`);
  } else {
    suite = await api<any>("/api/v1/test-suites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: suiteName, description: suiteDesc })
    });
    console.log(`已新建套件：${suite!.name}（id=${suite!.id}，revision=${suite!.revision}）`);
  }
}
if (dryRun && !suite) {
  console.log("[dry-run] 未创建套件，无法做服务端导入预检。去掉 --dry-run 才会真的建套件并导入。");
  process.exit(0);
}
const suiteId = suite!.id;

const filename = basename(casesPath).endsWith(".jsonl")
  ? basename(casesPath)
  : `${basename(casesPath)}.jsonl`;
async function postImport(expectedRevision: number, isDry: boolean) {
  const form = new FormData();
  form.append("file", new Blob([raw], { type: "application/x-ndjson" }), filename);
  const qs = new URLSearchParams({ expectedRevision: String(expectedRevision) });
  if (isDry) qs.set("dryRun", "true");
  const res = await fetch(`${base}/api/v1/test-suites/${suiteId}/import?${qs}`, {
    method: "POST",
    body: form
  });
  const body = await res.text();
  if (!res.ok)
    throw new Error(`导入${isDry ? "预检" : ""}失败 HTTP ${res.status}\n${body.slice(0, 3000)}`);
  return body ? JSON.parse(body) : null;
}

const current = await api<any>(`/api/v1/test-suites/${suiteId}`);
const preview = await postImport(current.revision, true);
console.log(`服务端预检：${JSON.stringify(preview?.summary ?? preview, null, 2).slice(0, 1500)}`);
const previewErrors = (preview?.errors ?? preview?.issues ?? []) as any[];
if (previewErrors.length && !force)
  throw new Error(`服务端预检报 ${previewErrors.length} 处问题，已中止。加 --force 可强行导入。`);

if (dryRun) {
  console.log("[dry-run] 预检通过，未真导入。");
  process.exit(0);
}
const result = await postImport(current.revision, false);
console.log(`导入完成：${JSON.stringify(result?.summary ?? result, null, 2).slice(0, 800)}`);

const after = await api<any>(`/api/v1/test-suites/${suiteId}`);
const readBack: string[] = [];
let caseCursor: string | undefined;
for (let page = 0; page < 20; page += 1) {
  const qs = new URLSearchParams({ limit: "100" });
  if (caseCursor) qs.set("cursor", caseCursor);
  const res = await api<any>(`/api/v1/test-suites/${suiteId}/cases?${qs}`);
  for (const it of res.items ?? [])
    readBack.push(it.caseKey ?? it.case_id ?? it.metadata?.case_id ?? "?");
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
      url: `${base}/test-suites/${suiteId}`
    },
    null,
    2
  )
);
if (missing.length || extra.length) process.exitCode = 1;
