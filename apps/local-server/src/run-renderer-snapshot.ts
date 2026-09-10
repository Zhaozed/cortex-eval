import { readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { localCaptureAsset } from "./run-a2ui-assets.ts";
import { remoteRendererSnapshot } from "./run-remote-renderer-assets.ts";
import type { RunRendererSource } from "./run-renderer-source.ts";

export type RendererAsset = Awaited<ReturnType<typeof localCaptureAsset>>;
export type RendererAssets = Map<string, RendererAsset>;
export const rendererEntries = [
  "a2ui_viewer.js",
  "a2ui_viewer.css",
  "a2ui_catalog.css",
  "a2ui_runtime/loona.html",
  "a2ui_runtime/resource-catalog.json"
];
export async function rendererSnapshot(
  source: RunRendererSource,
  signal: AbortSignal
): Promise<RendererAssets> {
  if (source.kind === "http") return remoteRendererSnapshot(source.baseUrl, signal);
  const root = await realpath(source.root),
    assets: RendererAssets = new Map();
  const paths = [...rendererEntries];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) paths.push(path);
    }
  };
  await walk("a2ui_runtime");
  for (const path of [...new Set(paths)].sort()) {
    signal.throwIfAborted();
    try {
      assets.set(
        `/static/${path}`,
        await localCaptureAsset(root, `http://localhost/static/${path}`)
      );
    } catch (error) {
      if (error instanceof Error && error.message === "A2UI_ASSET_FORBIDDEN") continue;
      throw error;
    }
  }
  return assets;
}
