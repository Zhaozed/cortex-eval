import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { localCaptureAsset } from "../src/run-auto-capture-renderer.ts";

it("serves only renderer static files, rejects traversal and symlink escape", async () => {
  const root = await mkdtemp(join(tmpdir(), "capture-assets-"));
  const assets = join(root, "static");
  try {
    await mkdir(assets);
    await writeFile(join(assets, "viewer.js"), "window.viewer = true;");
    await writeFile(join(root, "private.js"), "private");
    await writeFile(join(assets, "private.txt"), "private");
    await symlink(join(root, "private.js"), join(assets, "escape.js"));
    expect((await localCaptureAsset(assets, "http://localhost/static/viewer.js")).contentType).toBe(
      "text/javascript"
    );
    for (const path of [
      "/static/..%2fprivate.js",
      "/static/escape.js",
      "/static/private.txt",
      "/private.js"
    ])
      await expect(localCaptureAsset(assets, `http://localhost${path}`)).rejects.toThrow(
        "A2UI_ASSET_FORBIDDEN"
      );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("mirrors the production dynamic catalog rather than stale vendored resource names", async () => {
  const root = await mkdtemp(join(tmpdir(), "capture-catalog-"));
  const runtime = join(root, "a2ui_runtime");
  try {
    await mkdir(join(runtime, "icons"), { recursive: true });
    await mkdir(join(runtime, "rives"));
    await writeFile(
      join(runtime, "resource-catalog.json"),
      JSON.stringify({ source: "production", i18n_keys: ["task"], rives: ["stale"] })
    );
    await writeFile(join(runtime, "icons", "todo.svg"), "svg");
    await writeFile(join(runtime, "rives", "tools.riv"), "riv");
    await symlink(join(root, "private.riv"), join(runtime, "rives", "escape.riv"));
    const url = "http://localhost/static/a2ui_runtime/resource-catalog.json";
    const catalog: unknown = JSON.parse((await localCaptureAsset(root, url)).bytes.toString());
    expect(catalog).toEqual({
      source: "production",
      i18n_keys: ["task"],
      icons: [{ name: "todo", format: "svg" }],
      rives: ["tools"]
    });
    await writeFile(
      join(runtime, "resource-catalog.json"),
      JSON.stringify({ source: 4, i18n_keys: [] })
    );
    await expect(localCaptureAsset(root, url)).rejects.toThrow("A2UI_RESOURCE_CATALOG_INVALID");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
