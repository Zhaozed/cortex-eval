import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { livePreviewHost } from "./run-live-preview-host.ts";
import { rendererSnapshot, type RendererAssets } from "./run-renderer-snapshot.ts";
import { runRendererSource, type RunRendererSource } from "./run-renderer-source.ts";

export interface RendererInfo {
  origin: string;
  rendererVersion: string;
  previewPath: string;
  rendererSource: string;
}
interface Snapshot {
  assets: RendererAssets;
  host: string;
  info: RendererInfo;
}
/** One stable isolated origin; immutable per-Run namespaces prevent cross-environment cache mixing. */
export class RunLivePreviewService {
  #starting: Promise<void> | undefined;
  #server: Server | undefined;
  #pending = new Map<string, Promise<RendererInfo>>();
  #snapshots = new Map<string, Snapshot>();
  #abort = new AbortController();
  constructor(readonly staticRoot: string | undefined) {}
  get origin(): string | undefined {
    const address = this.#server?.address();
    return address && typeof address !== "string" ? `http://127.0.0.1:${address.port}` : undefined;
  }
  start(): Promise<void> {
    this.#starting ??= this.#start().catch((error: unknown) => {
      this.#starting = undefined;
      throw error;
    });
    return this.#starting;
  }
  /** Compatibility for direct local callers; production uses the frozen Endpoint below. */
  info(): Promise<RendererInfo> {
    if (!this.staticRoot) return Promise.reject(new Error("A2UI_STATIC_ROOT_MISSING"));
    return this.#info(
      { kind: "directory", root: this.staticRoot, identity: this.staticRoot },
      "local"
    );
  }
  infoForEndpoint(endpoint: string, runId: string): Promise<RendererInfo> {
    return this.#info(runRendererSource(endpoint, this.staticRoot), runId);
  }
  async #info(source: RunRendererSource, runId: string): Promise<RendererInfo> {
    await this.start();
    const id = createHash("sha256")
      .update(JSON.stringify([runId, source]))
      .digest("hex");
    let pending = this.#pending.get(id);
    if (!pending) {
      if (this.#pending.size >= 32) throw new Error("A2UI_RESOURCE_LIMIT");
      pending = this.#load(source, id).catch((error: unknown) => {
        this.#pending.delete(id);
        throw error;
      });
      this.#pending.set(id, pending);
    }
    return pending;
  }
  async #load(source: RunRendererSource, id: string): Promise<RendererInfo> {
    const assets = await rendererSnapshot(source, this.#abort.signal);
    this.#abort.signal.throwIfAborted();
    const origin = this.origin;
    if (!origin) throw new Error("A2UI_PREVIEW_UNAVAILABLE");
    const prefix = `/renderers/${id}`;
    const host = livePreviewHost.replaceAll('"/static/', `"${prefix}/static/`);
    const hash = createHash("sha256").update(livePreviewHost).update(source.identity);
    for (const [path, asset] of [...assets].sort(([a], [b]) => a.localeCompare(b)))
      hash.update(path).update(asset.bytes);
    const bytes = (collection: RendererAssets): number =>
      [...collection.values()].reduce((sum, asset) => sum + asset.bytes.length, 0);
    const total =
      bytes(assets) +
      [...this.#snapshots.values()].reduce((sum, item) => sum + bytes(item.assets), 0);
    if (total > 512 * 1024 * 1024) throw new Error("A2UI_RESOURCE_LIMIT");
    const info = {
      origin,
      rendererVersion: hash.digest("hex"),
      previewPath: `${prefix}/preview`,
      rendererSource: source.identity
    };
    this.#snapshots.set(id, { assets, host, info });
    return info;
  }
  async close(): Promise<void> {
    this.#abort.abort();
    await this.#starting?.catch(() => undefined);
    await Promise.allSettled(this.#pending.values());
    if (this.#server) {
      this.#server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        this.#server?.close((error) => (error ? reject(error) : resolve()))
      );
    }
    this.#server = undefined;
    this.#starting = undefined;
    this.#pending.clear();
    this.#snapshots.clear();
  }
  async #start(): Promise<void> {
    this.#abort.signal.throwIfAborted();
    const server = createServer((req, res) => {
      const host = req.headers.host;
      if (!host || !/^127\.0\.0\.1:\d+$/.test(host)) {
        res.writeHead(403).end();
        return;
      }
      if (req.method !== "GET") {
        res.writeHead(405).end();
        return;
      }
      const url = new URL(req.url ?? "/", `http://${host}`);
      const csp =
        "default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com; frame-src 'self'; worker-src 'self' blob:; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self' http://127.0.0.1:4310 http://localhost:4310";
      res.setHeader("Content-Security-Policy", csp);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader(
        "Permissions-Policy",
        "camera=(), microphone=(), geolocation=(), clipboard-write=()"
      );
      let pathname: string;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        res.writeHead(400).end();
        return;
      }
      const match = /^\/renderers\/([a-f0-9]{64})(\/.*)$/.exec(pathname);
      const snapshot = match?.[1] ? this.#snapshots.get(match[1]) : undefined;
      const path = match?.[2];
      if (!snapshot) {
        res.writeHead(404).end();
        return;
      }
      if (path === "/preview") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(snapshot.host);
        return;
      }
      const asset = path ? snapshot.assets.get(path) : undefined;
      if (!asset) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": asset.contentType }).end(asset.bytes);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    this.#server = server;
  }
}
