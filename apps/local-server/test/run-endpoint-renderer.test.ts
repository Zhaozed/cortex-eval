import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi, type Mock } from "vitest";
import { runRendererSource } from "../src/run-renderer-source.ts";
import { rendererDependencies } from "../src/run-remote-renderer-assets.ts";
import { RunLivePreviewService } from "../src/run-live-preview-service.ts";
import { livePreviewContext } from "../src/run-live-preview-context.ts";
import { captureResult } from "./run-auto-capture-fixture.ts";

const actualFetch = globalThis.fetch;
afterEach(() => vi.unstubAllGlobals());

it("selects resources from the frozen endpoint, never applies a local directory to remote endpoints", () => {
  expect(
    runRendererSource(
      "https://cortex-dev.loonadm.com/web_ui/run/{{vars.task}}?uid=secret",
      "/local"
    )
  ).toEqual({
    kind: "http",
    baseUrl: "https://cortex-dev.loonadm.com/web_ui/static/",
    identity: "https://cortex-dev.loonadm.com/web_ui/static/"
  });
  for (const host of ["localhost", "127.0.0.1", "127.0.0.2", "[::1]"])
    expect(runRendererSource(`http://${host}:8082/run/{{vars.task}}`, "/local").kind).toBe(
      "directory"
    );
  expect(runRendererSource("http://localhost:8082/run/task", undefined)).toMatchObject({
    baseUrl: "http://localhost:8082/static/"
  });
  expect(runRendererSource("https://dev.example/proxy/web_ui/run/task", undefined)).toMatchObject({
    baseUrl: "https://dev.example/proxy/web_ui/static/"
  });
  expect(runRendererSource("http://192.168.1.2:8082/run/task", "/local").kind).toBe("http");
  expect(runRendererSource("http://127.attacker.example/run/task", "/local").kind).toBe("http");
  for (const url of [
    "file:///tmp/a",
    "https://user:pass@dev.example/run",
    "https://{{vars.host}}/run"
  ])
    expect(() => runRendererSource(url, "/local")).toThrow();
});

function stubResources(
  options: { badPath?: string; redirect?: string; changeEntry?: boolean; htmlJs?: boolean } = {}
): Mock<typeof fetch> {
  const counts = new Map<string, number>();
  const mock = vi.fn(
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.hostname === "127.0.0.1") return actualFetch(input, init);
      expect(init?.redirect).toBe("manual");
      expect(init?.credentials).toBe("omit");
      expect(init?.headers).toBeUndefined();
      const path = url.pathname.split("/static/")[1] ?? "";
      counts.set(path, (counts.get(path) ?? 0) + 1);
      if (path === options.badPath) return new Response("missing", { status: 404 });
      if (path === "a2ui_viewer.js" && !url.search)
        return new Response(null, {
          status: 307,
          headers: { location: options.redirect ?? `${url.pathname}?v=1` }
        });
      const catalog = {
        source: "fixture",
        i18n_keys: [],
        icons: [{ name: "check", format: "svg" }],
        rives: ["loading"],
        locales: [{ code: "zh-Hans" }]
      };
      const files: Record<string, [string, string]> = {
        "a2ui_viewer.js": [
          options.changeEntry && (counts.get(path) ?? 0) > 2 ? "changed" : url.hostname,
          options.htmlJs ? "text/html" : "text/javascript"
        ],
        "a2ui_viewer.css": ["", "text/css"],
        "a2ui_catalog.css": ["", "text/css"],
        "a2ui_runtime/loona.html": [
          '<script type="module" src="./assets/main.js"></script>',
          "text/html"
        ],
        "a2ui_runtime/resource-catalog.json": [JSON.stringify(catalog), "application/json"],
        "a2ui_runtime/strings/locales.json": ["[]", "application/json"],
        "a2ui_runtime/strings/zh-Hans.json": ["{}", "application/json"],
        "a2ui_runtime/icons/check.svg": ["<svg/>", "image/svg+xml"],
        "a2ui_runtime/rives/loading.riv": ["rive", "application/octet-stream"],
        "a2ui_runtime/assets/main.js": [
          'import "./child.js";new URL("rive-hash.wasm",import.meta.url);',
          "text/javascript"
        ],
        "a2ui_runtime/assets/child.js": ['export default "ok";', "text/javascript"],
        "a2ui_runtime/assets/rive-hash.wasm": ["wasm", "application/wasm"]
      };
      const file = files[path];
      if (!file) return new Response("unexpected asset", { status: 404 });
      return new Response(file[0], { headers: { "content-type": file[1] } });
    }
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

it("isolates dev and staging snapshots on one CSP origin, follows version redirects and freezes each Run", async () => {
  const mock = stubResources();
  const service = new RunLivePreviewService("/must-not-read-local");
  try {
    await service.start();
    const before = service.origin;
    const [dev, staging] = await Promise.all([
      service.infoForEndpoint("https://dev.example/run", "run-1"),
      service.infoForEndpoint("https://stage.example/run", "run-2")
    ]);
    expect(dev.origin).toBe(before);
    expect(staging.origin).toBe(before);
    expect(dev.previewPath).not.toBe(staging.previewPath);
    expect(dev.rendererVersion).not.toBe(staging.rendererVersion);
    for (const [info, name] of [
      [dev, "dev.example"],
      [staging, "stage.example"]
    ] as const) {
      const prefix = `${info.origin}${info.previewPath.replace("/preview", "")}`;
      expect(await (await actualFetch(`${prefix}/static/a2ui_viewer.js`)).text()).toBe(name);
      expect(await (await actualFetch(`${info.origin}${info.previewPath}`)).text()).toContain(
        `${info.previewPath.replace("/preview", "")}/static/a2ui_viewer.js`
      );
      expect(
        (await actualFetch(`${prefix}/static/a2ui_runtime/assets/rive-hash.wasm`)).status
      ).toBe(200);
      expect((await actualFetch(`${prefix}/api/run`)).status).toBe(404);
      expect((await actualFetch(`${prefix}/static/missing.js`)).status).toBe(404);
    }
    const calls = mock.mock.calls.length;
    expect(await service.infoForEndpoint("https://dev.example/run", "run-1")).toEqual(dev);
    expect(mock.mock.calls.length).toBe(calls);
    const nextRun = await service.infoForEndpoint("https://dev.example/run", "run-3");
    expect(nextRun.previewPath).not.toBe(dev.previewPath);
    expect(nextRun.rendererVersion).toBe(dev.rendererVersion);
  } finally {
    await service.close();
  }
});

it.each([
  { badPath: "a2ui_runtime/assets/child.js" },
  { redirect: "https://other.example/web_ui/static/a2ui_viewer.js" },
  { redirect: "/api/private" },
  { changeEntry: true },
  { htmlJs: true }
])("fails closed without local fallback or partial snapshots: %j", async (options) => {
  const mock = stubResources(options);
  const service = new RunLivePreviewService("/must-not-read-local");
  try {
    const context = await livePreviewContext(captureResult(), service, "https://dev.example/run");
    expect(context.live.available).toBe(false);
    expect(context.preview.origin).toBeNull();
    expect(context.preview.error).toContain("不会回退");
    expect(
      mock.mock.calls.every(
        ([input]) =>
          new URL(input instanceof Request ? input.url : input.toString()).hostname ===
          "dev.example"
      )
    ).toBe(true);
    stubResources();
    expect(
      (await livePreviewContext(captureResult(), service, "https://dev.example/run")).live.available
    ).toBe(true);
  } finally {
    await service.close();
  }
});

it("uses local resources for local endpoints and never fetches remote resources", async () => {
  const root = await mkdtemp(join(tmpdir(), "endpoint-local-"));
  const mock = vi.fn();
  vi.stubGlobal("fetch", mock);
  const service = new RunLivePreviewService(root);
  try {
    await mkdir(join(root, "a2ui_runtime/icons"), { recursive: true });
    await mkdir(join(root, "a2ui_runtime/rives"));
    for (const file of [
      "a2ui_viewer.js",
      "a2ui_viewer.css",
      "a2ui_catalog.css",
      "a2ui_runtime/loona.html"
    ])
      await writeFile(join(root, file), "local");
    await writeFile(
      join(root, "a2ui_runtime/resource-catalog.json"),
      JSON.stringify({ source: "local", i18n_keys: [] })
    );
    const context = await livePreviewContext(
      captureResult(),
      service,
      "http://localhost:8082/run/task"
    );
    expect(context.live.available).toBe(true);
    expect(context.preview.rendererSource).toContain(root);
    expect(mock).not.toHaveBeenCalled();
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("missing frozen endpoint does not silently render using global local resources", async () => {
  const service = new RunLivePreviewService("/local");
  try {
    expect((await livePreviewContext(captureResult(), service)).live.available).toBe(false);
  } finally {
    await service.close();
  }
});

it("discovers only supported runtime dependencies and rejects escaping resources", () => {
  expect(
    rendererDependencies(
      "a2ui_runtime/assets/main.js",
      `const value={"from":[{from:()=>true}],other:"text"};`
    )
  ).toEqual([]);
  expect(
    rendererDependencies(
      "a2ui_runtime/assets/main.js",
      'import "./child.js";new URL("rive.wasm",import.meta.url)'
    )
  ).toEqual(["a2ui_runtime/assets/child.js", "a2ui_runtime/assets/rive.wasm"]);
  expect(
    rendererDependencies("a2ui_runtime/assets/main.css", 'a{src:url("./font.woff2")}')
  ).toEqual(["a2ui_runtime/assets/font.woff2"]);
  expect(() =>
    rendererDependencies("a2ui_runtime/loona.html", '<script src="../../api.js">')
  ).toThrow("A2UI_ASSET_FORBIDDEN");
});

it("retries transient remote transport failures without changing environment", async () => {
  stubResources();
  const delegate = globalThis.fetch;
  let attempts = 0;
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (attempts++ === 0) return Promise.reject(new TypeError("fetch failed"));
    return delegate(input, init);
  });
  const service = new RunLivePreviewService("/must-not-read-local");
  try {
    const info = await service.infoForEndpoint("https://dev.example/run", "retry-run");
    expect(info.rendererSource).toBe("https://dev.example/web_ui/static/");
  } finally {
    await service.close();
  }
});
