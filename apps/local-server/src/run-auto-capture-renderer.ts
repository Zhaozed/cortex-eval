import { realpath } from "node:fs/promises";
import { localCaptureAsset } from "./run-a2ui-assets.ts";
export { localCaptureAsset } from "./run-a2ui-assets.ts";
import { chromium, type Browser, type Frame } from "playwright";
import { captureOrigin, captureResourceAllowed } from "./run-auto-capture-model.ts";
import { runCaptureHost } from "./run-auto-capture-host.ts";

export interface CaptureImage {
  readonly label: string;
  readonly base64: string;
}
export interface CaptureRequest {
  readonly payloads: readonly Record<string, unknown>[];
  readonly signal: AbortSignal;
}
interface CaptureWindow extends Window {
  captureViewer: {
    handleAgentResponse(input: unknown): boolean;
    applyA2uiIndexMessages(id: string, messages: unknown[]): boolean;
  };
  captureStates: { state: string }[];
  A2UIBridge: { setLocale(locale: string): void };
  captureLayout?: { values: number[]; since: number };
}

/** Bounded, isolated replay of stored outbound payloads; no Agent requests or visual grading. */
export class RunAutoCaptureRenderer {
  constructor(
    readonly webOrigin = "http://127.0.0.1:8082",
    readonly staticRoot?: string
  ) {}
  async render(input: CaptureRequest): Promise<CaptureImage[]> {
    const origin = captureOrigin(this.webOrigin);
    const staticRoot = this.staticRoot ? await realpath(this.staticRoot) : undefined;
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(60_000)]);
    signal.throwIfAborted();
    let browser: Browser | undefined;
    const close = (): void => {
      void browser?.close().catch(() => undefined);
    };
    signal.addEventListener("abort", close, { once: true });
    try {
      browser = await chromium.launch({ headless: true, timeout: 15_000 });
      signal.throwIfAborted();
      const context = await browser.newContext({
        viewport: { width: 1000, height: 600 },
        deviceScaleFactor: 1,
        locale: "zh-CN",
        timezoneId: "Asia/Shanghai",
        colorScheme: "dark",
        serviceWorkers: "block"
      });
      const page = await context.newPage();
      page.setDefaultTimeout(12_000);
      const resources = { failure: "" };
      page.on("pageerror", () => {
        resources.failure = "A2UI_RUNTIME_ERROR";
      });
      await context.routeWebSocket("**/*", (socket) => socket.close());
      await context.route("**/*", async (route) => {
        const request = route.request();
        if (request.url() === `${origin}/__run_a2ui_capture__` && request.method() === "GET") {
          await route.fulfill({ contentType: "text/html", body: runCaptureHost });
          return;
        }
        try {
          let url = request.url();
          // Validate every redirect before fetching: route.continue() would bypass redirect guards.
          for (let hop = 0; hop < 6; hop += 1) {
            if (!captureResourceAllowed(url, origin, request.method())) break;
            if (staticRoot && new URL(url).origin === origin) {
              const asset = await localCaptureAsset(staticRoot, url);
              await route.fulfill({ body: asset.bytes, contentType: asset.contentType });
              return;
            }
            // Retry transient connection resets only; HTTP failures still fail capture.
            const response = await context.request.get(url, {
              maxRedirects: 0,
              maxRetries: 2,
              timeout: 10_000
            });
            if (response.status() >= 300 && response.status() < 400) {
              url = new URL(response.headers().location ?? "", url).href;
              await response.dispose();
              continue;
            }
            if (response.status() >= 400) resources.failure = "A2UI_RESOURCE_LOAD_FAILED";
            await route.fulfill({ response });
            await response.dispose();
            return;
          }
        } catch (error) {
          resources.failure =
            error instanceof Error && error.message === "A2UI_RESOURCE_CATALOG_INVALID"
              ? error.message
              : "A2UI_RESOURCE_LOAD_FAILED";
          /* Record a capture failure, never leak raw URLs or payloads into UI notes. */
        }
        resources.failure ||= "A2UI_RESOURCE_LOAD_FAILED";
        await route.abort().catch(() => undefined);
      });
      await page.goto(`${origin}/__run_a2ui_capture__`, { waitUntil: "load" });
      // Replay the actual ordered message stream together. Do not synthesize card contents.
      await page.evaluate(
        (payloads) => {
          const w = window as unknown as CaptureWindow;
          let handled = false;
          for (const a2ui of payloads)
            handled =
              w.captureViewer.handleAgentResponse({ response: { msg_id: "capture", a2ui } }) ||
              handled;
          if (!handled) throw new Error("A2UI_RENDER_FAILED");
        },
        [...input.payloads]
      );
      await page.locator('iframe[data-runtime-ready="true"]').waitFor();
      const frame = page.frames().find((f) => f.url().includes("/a2ui_runtime/loona.html"));
      if (!frame) throw new Error("A2UI_RENDER_FAILED");
      await frame.evaluate(() =>
        (window as unknown as CaptureWindow).A2UIBridge.setLocale("zh-Hans")
      );
      await frame.locator('[data-component="SurfaceHost"]').first().waitFor();
      await page.waitForFunction(() =>
        (window as unknown as CaptureWindow).captureStates.some((s) => s.state === "rendered")
      );
      await page.waitForLoadState("networkidle");
      const surfaces = await frame.locator('[data-component="SurfaceHost"]').evaluateAll((nodes) =>
        nodes.map((node) => ({
          id: node.getAttribute("data-surface-id"),
          total: Number(
            node.querySelector('[data-component="Carousel"]')?.getAttribute("data-total") ?? 1
          )
        }))
      );
      if (
        !surfaces.length ||
        surfaces.some((s) => !s.id || !Number.isSafeInteger(s.total) || s.total < 1)
      )
        throw new Error("A2UI_RENDER_FAILED");
      if (surfaces.reduce((sum, s) => sum + s.total, 0) > 10) throw new Error("A2UI_CAPTURE_LIMIT");
      const images: CaptureImage[] = [];
      for (const surface of surfaces) {
        const host = frame.locator('[data-component="SurfaceHost"]');
        const index = surfaces.indexOf(surface);
        const target = host.nth(index);
        for (let view = 0; view < surface.total; view += 1) {
          if (surface.total > 1) {
            const version = input.payloads
              .flatMap((p): unknown[] => (Array.isArray(p.messages) ? p.messages : []))
              .filter(
                (m): m is Record<string, unknown> =>
                  m !== null && typeof m === "object" && !Array.isArray(m)
              )
              .find((m) => m.version !== undefined)?.version;
            await page.evaluate(
              ({ id, value, version }) => {
                const ok = (
                  window as unknown as CaptureWindow
                ).captureViewer.applyA2uiIndexMessages("capture", [
                  { version, updateDataModel: { surfaceId: id, path: "/idx", value } }
                ]);
                if (!ok) throw new Error("A2UI_RENDER_FAILED");
              },
              { id: surface.id, value: view, version }
            );
            await target
              .locator(`[data-carousel-item-index="${view}"][data-carousel-item-current="true"]`)
              .waitFor();
          }
          await stableContent(frame);
          if (resources.failure) throw new Error(resources.failure);
          if (await target.locator("[data-rive-fallback]").count())
            throw new Error("A2UI_ANIMATION_FAILED");
          const bytes = await target.screenshot({ animations: "disabled" });
          images.push({
            label: `卡片 ${index + 1} · 视图 ${view + 1}`,
            base64: bytes.toString("base64")
          });
        }
      }
      return images;
    } catch (error) {
      if (signal.aborted)
        throw new Error(input.signal.aborted ? "A2UI_CAPTURE_CANCELLED" : "A2UI_CAPTURE_TIMEOUT", {
          cause: error
        });
      throw error;
    } finally {
      signal.removeEventListener("abort", close);
      await browser?.close();
    }
  }
}

async function stableContent(frame: Frame): Promise<void> {
  await frame.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(Array.from(document.images).map((image) => image.decode()));
    delete (window as unknown as CaptureWindow).captureLayout;
  });
  await frame.waitForFunction(() => {
    const w = window as unknown as CaptureWindow;
    const nodes = document.querySelectorAll(
      '[data-component="SurfaceHost"], [data-carousel-item-current="true"]'
    );
    const values = Array.from(nodes).flatMap((node) => {
      const r = node.getBoundingClientRect();
      return [r.x, r.y, r.width, r.height];
    });
    const previous = w.captureLayout;
    if (
      previous?.values.length !== values.length ||
      values.some((v, i) => Math.abs(v - (previous.values[i] ?? 0)) > 0.1)
    ) {
      w.captureLayout = { values, since: performance.now() };
      return false;
    }
    return performance.now() - previous.since >= 300;
  });
}
