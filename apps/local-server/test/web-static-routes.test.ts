import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { buildLocalServer } from "../src/local-server.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("P5 Web 静态路由与 CSP", () => {
  it("只为已闭环 P5 页面返回同一个生产入口", async () => {
    const root = await mkdtemp(join(tmpdir(), "cortex-web-static-"));
    roots.push(root);
    await writeFile(join(root, "index.html"), "<!doctype html><title>P5 Web</title>", "utf8");
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
      "/runs",
      "/runs/018f0f4e-7b7a-7cc0-8000-000000000002",
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
      expect(response.body).toContain("P5 Web");
    }
    for (const url of ["/reports", "/analysis"]) {
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
    await writeFile(join(root, "index.html"), "<!doctype html><title>P5 Web</title>", "utf8");
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

it("serves rebuilt hashed assets without a restart; unknown paths remain 404", async () => {
  const root = await mkdtemp(join(tmpdir(), "cortex-web-rebuild-"));
  roots.push(root);
  await writeFile(join(root, "index.html"), "<!doctype html><title>Before</title>");
  const server = buildLocalServer({
    staticRoot: root,
    requestIdGenerator: { nextId: () => "018f0f4e-7b7a-7cc0-8000-000000000001" },
    resourceHandlers: {
      listTestSuites: () =>
        Promise.resolve({ statusCode: 200, body: { items: [], nextCursor: null } })
    }
  });
  try {
    await server.ready();
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "assets", "rebuilt-123.js"), "export const ready = true;");
    await writeFile(join(root, "index.html"), '<script src="/assets/rebuilt-123.js"></script>');
    const headers = { host: "127.0.0.1:4310" };
    expect((await server.inject({ url: "/assets/rebuilt-123.js", headers })).statusCode).toBe(200);
    for (const url of [
      "/runs/templates",
      "/runs/templates/batch",
      "/configurations"
    ]) {
      const response = await server.inject({ url, headers });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("rebuilt-123.js");
    }
    for (const suffix of ["execution", "report", "analysis", "statistics"]) {
      const response = await server.inject({ url: `/runs/run-1/${suffix}?case=case-1`, headers });
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe("/runs/run-1?case=case-1&tab=trace");
    }
    for (const url of [
      "/assets/missing.js",
      "/api/v1/missing",
      "/missing-page",
      "/assets/%2e%2e/%2e%2e/package.json"
    ]) {
      expect((await server.inject({ url, headers })).statusCode).toBe(404);
    }
  } finally {
    await server.close();
  }
});
