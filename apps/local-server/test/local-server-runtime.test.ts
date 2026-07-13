import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createLocalServerRuntime } from "../src/local-server-runtime.ts";
import {
  jsonArrayProperty,
  jsonStringProperty,
  parseJsonObject
} from "./test-support/json-test-values.ts";

describe("P3 Local Server composition root", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true }))
    );
  });

  it("装配真实 SQLite、UUIDv7 与资源 API，并按生命周期关闭", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-runtime-"));
    roots.push(projectRoot);
    const runtime = await createLocalServerRuntime({
      projectRoot,
      endpointValidator: { validate: () => Promise.resolve({ ok: true }) },
      llmValidator: { validate: () => Promise.resolve({ ok: true }) }
    });
    const created = await runtime.server.inject({
      method: "POST",
      url: "/api/v1/test-suites",
      headers: { host: "127.0.0.1:4310", "content-type": "application/json" },
      payload: { name: "Runtime Suite", description: "Current" }
    });
    expect(created.statusCode).toBe(201);
    const createdBody = parseJsonObject(created);
    expect(jsonStringProperty(createdBody, "id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(jsonStringProperty(createdBody, "createdAt")).toMatch(/Z$/);
    expect((await stat(runtime.databasePath)).isFile()).toBe(true);

    await runtime.close();
    await expect(runtime.close()).resolves.toBeUndefined();
  });

  it("SQLite 初始化前拒绝指向项目外的状态根且不创建外部文件", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-runtime-symlink-"));
    const external = await mkdtemp(join(tmpdir(), "cortex-runtime-external-"));
    roots.push(projectRoot, external);
    await symlink(external, join(projectRoot, ".cortex-eval"), "dir");

    await expect(createLocalServerRuntime({ projectRoot })).rejects.toMatchObject({
      code: "SQLITE_INITIALIZATION_FAILED"
    });
    expect(await readdir(external)).toEqual([]);
  });

  it("显式开发 Seed 重复启动不覆盖或复制已有资源", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-runtime-seed-"));
    roots.push(projectRoot);
    const first = await createLocalServerRuntime({ projectRoot, developmentSeed: true });
    const firstSuites = await first.server.inject({
      method: "GET",
      url: "/api/v1/test-suites",
      headers: { host: "127.0.0.1:4310" }
    });
    expect(firstSuites.json()).toMatchObject({
      items: [{ name: "开发示例测试集", caseCount: 1 }]
    });
    await first.close();

    const second = await createLocalServerRuntime({ projectRoot, developmentSeed: true });
    const secondSuites = await second.server.inject({
      method: "GET",
      url: "/api/v1/test-suites",
      headers: { host: "127.0.0.1:4310" }
    });
    expect(jsonArrayProperty(parseJsonObject(secondSuites), "items")).toHaveLength(1);
    const prompts = await second.server.inject({
      method: "GET",
      url: "/api/v1/llm-rubric-prompts",
      headers: { host: "127.0.0.1:4310" }
    });
    expect(jsonArrayProperty(parseJsonObject(prompts), "items")).toHaveLength(1);
    await second.close();
  });

  it("默认启动装配轮转日志并接收 staging 安全事件", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-runtime-log-"));
    roots.push(projectRoot);
    const forged = join(projectRoot, ".cortex-eval", "tmp", "case-import-forged");
    await mkdir(forged, { recursive: true });
    await writeFile(join(forged, "owner.json"), "{}", "utf8");
    const stale = new Date("2026-01-01T00:00:00.000Z");
    await utimes(forged, stale, stale);

    const runtime = await createLocalServerRuntime({ projectRoot });
    await runtime.server.inject({
      method: "GET",
      url: "/api/v1/test-suites",
      headers: { host: "127.0.0.1:4310" }
    });
    await runtime.close();

    const logPath = join(projectRoot, ".cortex-eval", "logs", "local-server.log");
    const log = await readFile(logPath, "utf8");
    expect(log).toContain("临时资源 owner 无效");
    expect(log).toContain("请求处理完成");
    expect((await stat(logPath)).mode & 0o777).toBe(0o600);
  });
});
