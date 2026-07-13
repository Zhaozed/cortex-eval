import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { buildLocalServer } from "../src/local-server.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("P4 Web 静态路由与 CSP", () => {
  it("只为已闭环 P4 页面返回同一个生产入口", async () => {
    const root = await mkdtemp(join(tmpdir(), "cortex-web-static-"));
    roots.push(root);
    await writeFile(join(root, "index.html"), "<!doctype html><title>P4 Web</title>", "utf8");
    let request = 0;
    const server = buildLocalServer({
      staticRoot: root,
      requestIdGenerator: {
        nextId: () => `018f0f4e-7b7a-7cc0-8000-${String(++request).padStart(12, "0")}`
      },
      resourceHandlers: {
        listTestSuites: () =>
          Promise.resolve({ statusCode: 200, body: { items: [], nextCursor: null } })
      }
    });

    const routes = [
      "/",
      "/test-suites",
      "/test-suites/018f0f4e-7b7a-7cc0-8000-000000000001",
      "/endpoint-configs",
      "/llm-configs",
      "/rubric-prompts",
      "/analysis-prompts"
    ];
    for (const url of routes) {
      const response = await server.inject({
        method: "GET",
        url,
        headers: { host: "127.0.0.1:4310" }
      });
      expect(response.statusCode, url).toBe(200);
      expect(response.headers["content-type"]).toContain("text/html");
      expect(response.body).toContain("P4 Web");
    }
    for (const url of ["/runs", "/reports", "/analysis"]) {
      const response = await server.inject({
        method: "GET",
        url,
        headers: { host: "127.0.0.1:4310" }
      });
      expect(response.statusCode, url).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: "ROUTE_NOT_FOUND" } });
    }
    await server.close();
  });

  it("只为 Radix 运行时样式放开 inline，脚本仍保持严格同源", async () => {
    const root = await mkdtemp(join(tmpdir(), "cortex-web-csp-"));
    roots.push(root);
    await writeFile(join(root, "index.html"), "<!doctype html><title>P4 Web</title>", "utf8");
    const server = buildLocalServer({
      staticRoot: root,
      requestIdGenerator: {
        nextId: () => "018f0f4e-7b7a-7cc0-8000-000000000001"
      },
      resourceHandlers: {
        listTestSuites: () =>
          Promise.resolve({ statusCode: 200, body: { items: [], nextCursor: null } })
      }
    });

    const response = await server.inject({
      method: "GET",
      url: "/",
      headers: { host: "127.0.0.1:4310" }
    });
    const csp = response.headers["content-security-policy"] ?? "";

    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-eval'");
    await server.close();
  });
});
