import { readFile, realpath, readdir } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, extname } from "node:path";

/** Serve only production static assets; path traversal and escaping symlinks are rejected. */
export async function localCaptureAsset(
  root: string,
  url: string
): Promise<{ bytes: Buffer; contentType: string }> {
  const pathname = decodeURIComponent(new URL(url).pathname);
  if (!pathname.startsWith("/static/")) throw new Error("A2UI_ASSET_FORBIDDEN");
  const canonicalRoot = await realpath(root);
  const candidate = await realpath(resolve(canonicalRoot, pathname.slice("/static/".length)));
  const rel = relative(canonicalRoot, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error("A2UI_ASSET_FORBIDDEN");
  const types: Readonly<Record<string, string>> = {
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
  const contentType = types[extname(candidate)];
  if (!contentType) throw new Error("A2UI_ASSET_FORBIDDEN");
  let bytes = await readFile(candidate);
  if (pathname === "/static/a2ui_runtime/resource-catalog.json") {
    // Cortex Web serves this route dynamically. A raw vendored JSON file has stale asset lists.
    const catalog: unknown = JSON.parse(bytes.toString("utf8"));
    if (catalog === null || typeof catalog !== "object" || Array.isArray(catalog))
      throw new Error("A2UI_RESOURCE_CATALOG_INVALID");
    const metadata = catalog as Record<string, unknown>;
    if (
      typeof metadata.source !== "string" ||
      !Array.isArray(metadata.i18n_keys) ||
      metadata.i18n_keys.some((key) => typeof key !== "string")
    )
      throw new Error("A2UI_RESOURCE_CATALOG_INVALID");
    const names = async (directory: string, suffix: string): Promise<string[]> => {
      const dir = await realpath(resolve(canonicalRoot, "a2ui_runtime", directory));
      const relativeDir = relative(canonicalRoot, dir);
      if (relativeDir.startsWith(`..${sep}`) || relativeDir === ".." || isAbsolute(relativeDir))
        throw new Error("A2UI_ASSET_FORBIDDEN");
      const entries = await readdir(dir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
        .map((entry) => entry.name.slice(0, -suffix.length))
        .sort();
    };
    const [icons, rives] = await Promise.all([names("icons", ".svg"), names("rives", ".riv")]);
    bytes = Buffer.from(
      JSON.stringify({ ...metadata, icons: icons.map((name) => ({ name, format: "svg" })), rives })
    );
  }
  return { bytes, contentType };
}
