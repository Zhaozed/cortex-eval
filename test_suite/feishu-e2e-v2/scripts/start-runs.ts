/**
 * 建 run → 启动 → 轮询到终态（飞书 E2E v2 专用，只走平台公开 API，不碰 DB）。
 *
 * 用法：
 *   npx tsx test_suite/feishu-e2e-v2/scripts/start-runs.ts                 # 用 suite-config.json 里的套件名建 1 个 run
 *   npx tsx ... --run-index 2 --wait                                       # 第 2 次重复运行，阻塞等到跑完
 *   npx tsx ... --suite <suiteId> --name "自定义 run 名" --no-wait
 *   npx tsx ... --timeout-min 180                                          # 最长等 3 小时（默认 240）
 *
 * 为什么必须有这个脚本：
 *   SPEC §3 要求「每条 case 跑 3 次取多数」。3 次不能并行——飞书写操作共用同一批前置资源
 *   （同一场会、同一篇文档、同一间会议室），并行会互相踩，结论没有意义。所以 run-all.sh
 *   串行循环 run_index=1..3，每轮 build → import（整集替换）→ 本脚本建 run 并等到终态。
 *
 * 输出契约（run-all.sh 依赖）：
 *   最后一行固定打印 `RUN_ID=<uuid>`；退出码 0 = run 到达终态（含 COMPLETED_WITH_ERRORS，
 *   个别 case 失败是评测结果，不是脚本失败）；非 0 = 建 run/启动/超时/平台不可达。
 */
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const argv = process.argv.slice(2);
const get = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string): boolean => argv.includes(name);

const base = (get("--base") ?? "http://127.0.0.1:4310").replace(/\/$/, "");
const runIndexRaw = get("--run-index");
const runIndex = runIndexRaw === undefined ? null : Number(runIndexRaw);
if (runIndexRaw !== undefined && (!Number.isInteger(runIndex) || runIndex! < 1)) {
  console.error(`--run-index 必须是 ≥1 的整数，收到：${runIndexRaw}`);
  process.exit(2);
}
const wait = !has("--no-wait");
const timeoutMin = Number(get("--timeout-min") ?? "240");
const pollSec = Number(get("--poll-sec") ?? "10");

const cfg = JSON.parse(await readFile(resolve(root, "suite-config.json"), "utf8"));
const endpointConfigId: string = get("--endpoint") ?? cfg.endpoint_id;
const evaluatorConfigId: string = get("--evaluator") ?? cfg.evaluator_config_id;
/**
 * restConcurrency 默认取 suite-config.concurrency（=1，串行）。
 * 这不是保守，是正确性要求：本套件 38 条 case 有真实写副作用，共用同一批前置资源。
 */
const restConcurrency = Number(get("--rest-concurrency") ?? cfg.concurrency ?? 1);
const evalConcurrency = Number(get("--eval-concurrency") ?? "2");

async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(base + path, init);
  } catch (e) {
    throw new Error(
      `连不上评测平台 ${base}（${(e as Error).message}）。\n` +
        `先确认平台在跑：cd cortex-eval && pnpm dev（或你平时起 4310 的方式），然后重试。`
    );
  }
  const body = await res.text();
  if (!res.ok)
    throw new Error(`${init?.method ?? "GET"} ${path} → HTTP ${res.status}\n${body.slice(0, 800)}`);
  return body ? (JSON.parse(body) as T) : (undefined as T);
}

/* ---------------------------------------------------------- 1. 定位套件 */
const suiteArg = get("--suite");
let suiteId: string | undefined;
let suiteName: string = cfg.suite_name;
if (suiteArg && /^[0-9a-f-]{36}$/i.test(suiteArg)) {
  suiteId = suiteArg;
} else {
  const wanted = suiteArg ?? cfg.suite_name;
  let cursor: string | undefined;
  for (let page = 0; page < 50 && !suiteId; page += 1) {
    const qs = new URLSearchParams({ limit: "100" });
    if (cursor) qs.set("cursor", cursor);
    const list = await api<any>(`/api/v1/test-suites?${qs.toString()}`);
    for (const s of list.items ?? []) {
      if (s.name === wanted) {
        suiteId = s.id;
        suiteName = s.name;
        break;
      }
    }
    cursor = list.nextCursor;
    if (!cursor) break;
  }
  if (!suiteId) {
    console.error(
      `找不到套件「${wanted}」。\n` +
        `v2 套件是导入时才建的：先跑 import-suite.ts（run-all.sh 里已经串好了），或 --suite <suiteId> 指定。`
    );
    process.exit(2);
  }
}

/* ---------------------------------------------------------- 2. 建 run */
const label = get("--label") ?? (cfg.run_label as string | undefined) ?? "";
const runName =
  get("--name") ??
  `${suiteName}${runIndex ? ` · r${runIndex}` : ""}${label ? ` · ${label}` : ""}`.slice(0, 120);

const created = await api<any>("/api/v1/runs", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    suiteId,
    endpointConfigId,
    evaluatorConfigId,
    runMode: "PIPELINE",
    name: runName,
    description: [
      `飞书 E2E v2 自动创建${runIndex ? `（第 ${runIndex}/${cfg.scoring?.runs_per_case ?? 3} 次重复运行）` : ""}`,
      `端点 ${cfg.endpoint_url}`,
      `串行执行 restConcurrency=${restConcurrency}（写副作用 case 共用前置资源，禁止并行）`,
      "由 scripts/start-runs.ts 创建，判分口径见 test_suite/feishu-e2e-v2/SPEC.md §3"
    ].join("｜"),
    runExecutionLimits: {
      contractVersion: "cortex.run-execution-limits.v1",
      restConcurrency,
      evalConcurrency
    }
  })
});
const runId: string = created.id;
console.log(`已建 run：${runId}  「${runName}」  套件 ${suiteId}`);

/* ---------------------------------------------------------- 3. 启动 */
const TERMINAL = new Set([
  "COMPLETED",
  "COMPLETED_WITH_ERRORS",
  "FAILED",
  "CANCELLED",
  "INTERRUPTED"
]);
const detail0 = await api<any>(`/api/v1/runs/${runId}`);
await api<any>(`/api/v1/runs/${runId}/start`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ expectedRevision: detail0.lockRevision ?? 0 })
});
console.log(
  `已启动。${wait ? `每 ${pollSec}s 轮询一次，最长等 ${timeoutMin} 分钟。` : "--no-wait：不等了，自己去看。"}`
);
if (!wait) {
  console.log(`平台页面：${base}/runs/${runId}`);
  console.log(`RUN_ID=${runId}`);
  process.exit(0);
}

/* ---------------------------------------------------------- 4. 轮询 */
const deadline = Date.now() + timeoutMin * 60_000;
let last = "";
let final: any = detail0;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, pollSec * 1000));
  final = await api<any>(`/api/v1/runs/${runId}`);
  const rest = final.rest ?? {};
  const ev = final.evaluation ?? {};
  const line =
    `[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] ` +
    `${final.status}/${final.stage}  ` +
    `执行 ${rest.completed ?? 0}/${rest.total ?? 0}（失败 ${rest.error ?? 0}）  ` +
    `评测 ${ev.completed ?? 0}/${ev.total ?? 0}  通过 ${ev.passed ?? 0} 未通过 ${ev.failed ?? 0} ` +
    `评测异常 ${ev.error ?? 0} 未评测 ${ev.notEvaluated ?? 0}`;
  if (line !== last) {
    console.log(line);
    last = line;
  }
  if (TERMINAL.has(final.status)) break;
}

if (!TERMINAL.has(final.status)) {
  console.error(
    `\n超时：${timeoutMin} 分钟还没跑完（当前 ${final.status}/${final.stage}）。\n` +
      `run 没被取消，还在平台上跑：${base}/runs/${runId}\n` +
      `等它自己跑完后，用 report.ts 出报告：\n` +
      `  npx tsx test_suite/feishu-e2e-v2/scripts/report.ts --run ${runId}`
  );
  console.log(`RUN_ID=${runId}`);
  process.exit(3);
}

const ev = final.evaluation ?? {};
console.log(
  `\n终态：${final.status}\n` +
    `  执行：${final.rest?.completed ?? 0}/${final.rest?.total ?? 0}，异常 ${final.rest?.error ?? 0}\n` +
    `  评测：通过 ${ev.passed ?? 0}，未通过 ${ev.failed ?? 0}，评测异常 ${ev.error ?? 0}，未评测 ${ev.notEvaluated ?? 0}\n` +
    `  页面：${base}/runs/${runId}`
);
if (final.status === "FAILED" || final.status === "INTERRUPTED") {
  console.error("run 本身失败/被打断（不是 case 判负），去看平台日志。");
  console.log(`RUN_ID=${runId}`);
  process.exit(4);
}
if ((final.rest?.error ?? 0) > 0) {
  console.log(
    `注意：${final.rest.error} 条 case 采集失败（endpoint 没回或超时）。这些会算 EVAL_ERROR，不进通过率分母；` +
      `数量多就先查 8080 端点，别急着下产品结论。`
  );
}
console.log(`RUN_ID=${runId}`);
