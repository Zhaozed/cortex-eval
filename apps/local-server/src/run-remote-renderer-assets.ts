import { extname, posix } from "node:path";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import type { RendererAsset, RendererAssets } from "./run-renderer-snapshot.ts";

const types: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".riv": "application/octet-stream"
};
const name = z.string().regex(/^[\w-]+$/);
const catalogSchema = z.object({
  source: z.string(),
  i18n_keys: z.array(z.string()),
  icons: z.array(z.object({ name, format: z.literal("svg") })),
  rives: z.array(name),
  locales: z.array(z.object({ code: name }))
});
const maxAssetBytes = 16 * 1024 * 1024;
const maxSnapshotBytes = 128 * 1024 * 1024;

/** Only static resources from the selected environment; redirects cannot escape this prefix. */
async function readAssetOnce(base: URL, path: string, signal: AbortSignal): Promise<RendererAsset> {
  let url = new URL(path, base);
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (
      url.origin !== base.origin ||
      !url.pathname.startsWith(base.pathname) ||
      url.username ||
      url.password ||
      /%2f|%5c/i.test(url.pathname)
    )
      throw new Error("A2UI_ASSET_FORBIDDEN");
    const response = await fetch(url, {
      redirect: "manual",
      credentials: "omit",
      signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)])
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw new Error("A2UI_RESOURCE_LOAD_FAILED");
      url = new URL(location, url);
      continue;
    }
    const contentType = types[extname(path)];
    if (!response.ok || !response.body || !contentType) {
      await response.body?.cancel();
      throw new Error("A2UI_RESOURCE_LOAD_FAILED", { cause: response.status });
    }
    const actualType = response.headers.get("content-type")?.split(";")[0]?.trim();
    const accepted = [
      contentType,
      "application/octet-stream",
      ...(extname(path) === ".js" ? ["application/javascript"] : [])
    ];
    if (!actualType || !accepted.includes(actualType)) {
      await response.body.cancel();
      throw new Error("A2UI_RESOURCE_TYPE_INVALID");
    }
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > maxAssetBytes) throw new Error("A2UI_RESOURCE_LIMIT");
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel();
    }
    return { bytes: Buffer.concat(chunks), contentType };
  }
  throw new Error("A2UI_RESOURCE_REDIRECT_LIMIT");
}

/** Retry transient read-only transport failures once; never retry an escaped path or invalid content. */
async function readAsset(base: URL, path: string, signal: AbortSignal): Promise<RendererAsset> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await readAssetOnce(base, path, signal);
    } catch (error) {
      const transient =
        error instanceof TypeError ||
        (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) ||
        (error instanceof Error &&
          error.message === "A2UI_RESOURCE_LOAD_FAILED" &&
          [408, 429, 500, 502, 503, 504].includes(Number(error.cause)));
      if (attempt >= 1 || signal.aborted || !transient) throw error;
      await setTimeout(250, undefined, { signal });
    }
  }
}

/** Discover compiled module imports, import-meta assets, HTML and CSS dependencies, not arbitrary URLs. */
export function rendererDependencies(path: string, text: string): string[] {
  const refs: string[] = [];
  if (path.endsWith(".html"))
    for (const match of text.matchAll(/(?:src|href)=["']([^"']+)["']/g)) refs.push(match[1] ?? "");
  if (path.endsWith(".js")) {
    for (const match of text.matchAll(
      /(?:\bfrom\s*|\bimport\s*\(?\s*)["']((?:\.{1,2}\/|\/)[^"']+\.(?:js|css)(?:\?[^"']*)?)["']/g
    ))
      refs.push(match[1] ?? "");
    for (const match of text.matchAll(/new URL\(["']([^"']+)["']\s*,\s*import\.meta\.url\)/g))
      refs.push(match[1] ?? "");
    // Vite's preload map contains chunks and URL-imported assets relative to the module directory.
    for (const match of text.matchAll(/["'](\.\.?\/[^"'\s]+\.(?:js|css|wasm|riv|svg|woff2?))["']/g))
      if (!match[1]?.startsWith("../../../public/")) refs.push(match[1] ?? "");
  }
  if (path.endsWith(".css"))
    for (const match of text.matchAll(/(?:url\(\s*|@import\s+)["']?([^"')\s;]+)["']?\s*\)?/g))
      refs.push(match[1] ?? "");
  return [
    ...new Set(
      refs
        .filter((ref) => ref && !/^(?:[a-z]+:|\/\/|#)/i.test(ref))
        .map((ref) => {
          const clean = ref.split(/[?#]/)[0] ?? "";
          if (clean.startsWith("/")) throw new Error("A2UI_ABSOLUTE_RESOURCE_UNSUPPORTED");
          const resolved = posix.normalize(posix.join(posix.dirname(path), clean));
          if (!resolved.startsWith("a2ui_runtime/") || !types[extname(resolved)])
            throw new Error("A2UI_ASSET_FORBIDDEN", { cause: { path, ref, resolved } });
          return resolved;
        })
    )
  ];
}

/** Materialize an all-or-nothing versioned snapshot; browser requests never proxy arbitrary URLs. */
export async function remoteRendererSnapshot(
  baseUrl: string,
  signal: AbortSignal
): Promise<RendererAssets> {
  const base = new URL(baseUrl),
    assets: RendererAssets = new Map();
  const controller = new AbortController();
  const bounded = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(120_000)]);
  let size = 0;
  const load = async (path: string): Promise<RendererAsset> => {
    const asset = await readAsset(base, path, bounded);
    size += asset.bytes.length;
    if (size > maxSnapshotBytes) throw new Error("A2UI_RESOURCE_LIMIT");
    assets.set(`/static/${path}`, asset);
    return asset;
  };
  try {
    const catalogAsset = await load("a2ui_runtime/resource-catalog.json");
    const catalog = catalogSchema.parse(JSON.parse(catalogAsset.bytes.toString("utf8")) as unknown);
    const queue = [
      "a2ui_viewer.js",
      "a2ui_viewer.css",
      "a2ui_catalog.css",
      "a2ui_runtime/loona.html",
      "a2ui_runtime/strings/locales.json",
      ...catalog.icons.map((icon) => `a2ui_runtime/icons/${icon.name}.svg`),
      ...catalog.rives.map((rive) => `a2ui_runtime/rives/${rive}.riv`),
      ...catalog.locales.map((locale) => `a2ui_runtime/strings/${locale.code}.json`)
    ];
    const seen = new Set(["a2ui_runtime/resource-catalog.json"]);
    while (queue.length) {
      const batch = queue.splice(0, 8).filter((path) => {
        if (seen.has(path)) return false;
        seen.add(path);
        return true;
      });
      if (seen.size > 1024) throw new Error("A2UI_RESOURCE_LIMIT");
      const results = await Promise.all(
        batch.map(async (path) => {
          const asset = await load(path);
          // Viewer host resources are fixed entries. Runtime dependencies form a closed graph.
          return path.startsWith("a2ui_runtime/") && /\.(html|js|css)$/.test(path)
            ? rendererDependencies(path, asset.bytes.toString("utf8"))
            : [];
        })
      );
      queue.unshift(...results.flat());
    }
    // Detect a deployment changing its entry graph/catalog during this acquisition.
    for (const path of [
      "a2ui_viewer.js",
      "a2ui_runtime/loona.html",
      "a2ui_runtime/resource-catalog.json"
    ]) {
      const check = await readAsset(base, path, bounded);
      if (!check.bytes.equals(assets.get(`/static/${path}`)?.bytes ?? Buffer.alloc(0)))
        throw new Error("A2UI_RESOURCE_CHANGED");
    }
    return assets;
  } catch (error) {
    controller.abort();
    throw error;
  }
}
