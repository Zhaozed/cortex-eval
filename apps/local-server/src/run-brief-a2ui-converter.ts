import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Brief replay 输出不携带交付态 A2UI（delivered=false），但其 output.public_results 与线上
 * Cortex 结构化 result 同构。此处调用 Cortex 仓库自带的转换入口把结构化卡片投影成 A2UI
 * 稳定载荷，供预览渲染与人工复核；转换只发生在预览时，不回写执行证据，不影响裁判输入。
 */

export interface BriefA2uiConversion {
  readonly payloads: Record<string, unknown>[];
  readonly error: string | null;
}

const BRIEF_TYPES = new Set(["daily", "meeting"]);
const CONVERT_TIMEOUT_MS = 30_000;
const CACHE_LIMIT = 16;
const cache = new Map<string, BriefA2uiConversion>();

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** 仅当证据确为 Brief replay 输出且带结构化卡片结果时才尝试转换。 */
export function briefConvertibleResults(parsed: unknown): {
  briefType: string;
  results: Record<string, unknown>[];
} | null {
  const root = object(parsed);
  const briefType = root.brief_type;
  if (typeof briefType !== "string" || !BRIEF_TYPES.has(briefType)) return null;
  const output = object(root.output);
  if (root.presentation_status !== "cards") return null;
  const results = (Array.isArray(output.public_results) ? output.public_results : [])
    .map((item) => object(item))
    .filter((item) => Array.isArray(item.cards) && item.cards.length > 0);
  return results.length > 0 ? { briefType, results } : null;
}

/** Cortex 根目录：显式环境变量优先，否则由 A2UI 静态目录（<cortex>/web_ui/static）推导。 */
export function cortexRootFor(staticRoot: string | undefined): string | null {
  const explicit = process.env.CORTEX_EVAL_CORTEX_ROOT;
  if (explicit) return explicit;
  if (!staticRoot) return null;
  const normalized = resolve(staticRoot);
  return normalized.endsWith(join("web_ui", "static")) ? dirname(dirname(normalized)) : null;
}

export async function convertBriefA2ui(
  parsed: unknown,
  cortexRoot: string | null
): Promise<BriefA2uiConversion | null> {
  const target = briefConvertibleResults(parsed);
  if (target === null) return null;
  if (cortexRoot === null)
    return {
      payloads: [],
      error:
        "Brief 卡片需经 Cortex 转换器投影为 A2UI 后才能渲染：未配置 CORTEX_EVAL_CORTEX_ROOT，且无法由 CORTEX_A2UI_STATIC_ROOT 推导 Cortex 根目录。"
    };
  const key = createHash("sha256").update(JSON.stringify(target)).digest("hex");
  const hit = cache.get(key);
  if (hit) return hit;
  const converted = await runConverter(cortexRoot, target);
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  cache.set(key, converted);
  return converted;
}

async function runConverter(
  cortexRoot: string,
  target: { briefType: string; results: Record<string, unknown>[] }
): Promise<BriefA2uiConversion> {
  const python = join(cortexRoot, ".venv", "bin", "python");
  if (!existsSync(python))
    return {
      payloads: [],
      error: `Brief 卡片转换失败：Cortex 虚拟环境不存在（${python}）。请确认 CORTEX_EVAL_CORTEX_ROOT 指向可运行的 Cortex 仓库。`
    };
  const script = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "scripts",
    "brief_a2ui_convert.py"
  );
  const payloads: Record<string, unknown>[] = [];
  for (const result of target.results) {
    const outcome = await invokePython(python, cortexRoot, script, {
      brief_type: target.briefType,
      result,
      timezone: "Asia/Shanghai"
    });
    if (!outcome.ok) return { payloads: [], error: outcome.error };
    payloads.push(outcome.payload);
  }
  return { payloads, error: null };
}

function invokePython(
  python: string,
  cwd: string,
  script: string,
  input: unknown
): Promise<{ ok: true; payload: Record<string, unknown> } | { ok: false; error: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(python, [script, cwd], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolvePromise({ ok: false, error: "Brief 卡片转换超时（30s），请检查 Cortex 环境。" });
    }, CONVERT_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", () => {
      clearTimeout(timer);
      resolvePromise({
        ok: false,
        error: "Brief 卡片转换进程启动失败，请检查 Cortex 虚拟环境。"
      });
    });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const parsed = object(JSON.parse(stdout));
        if (parsed.ok === true && Array.isArray(object(parsed.payload).messages)) {
          resolvePromise({ ok: true, payload: object(parsed.payload) });
          return;
        }
        const detail = typeof parsed.error === "string" ? parsed.error : stderr.trim();
        resolvePromise({
          ok: false,
          error: `Brief 卡片转换为 A2UI 失败：${detail || "转换器未产出有效载荷。"}`
        });
      } catch {
        resolvePromise({
          ok: false,
          error: `Brief 卡片转换输出无法解析。${stderr.trim() ? `错误输出：${stderr.trim().slice(0, 300)}` : ""}`
        });
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
