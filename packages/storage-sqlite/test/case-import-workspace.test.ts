import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CaseImportWorkspaceManager, type ProcessLiveness } from "../src/case-import-workspace.ts";

const OLD = new Date("2026-01-01T00:00:00.000Z");
const NOW = new Date("2026-01-03T00:00:00.000Z");

async function owner(root: string, name: string, value: unknown): Promise<string> {
  const path = join(root, name);
  await mkdir(path, { mode: 0o700 });
  await writeFile(join(path, "owner.json"), JSON.stringify(value), { mode: 0o600 });
  await utimes(path, OLD, OLD);
  return path;
}

describe("Case import workspace cleanup", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true }))
    );
  });

  it("拒绝指向项目外的临时根符号链接且不改动外部条目", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "case-project-"));
    const external = await mkdtemp(join(tmpdir(), "case-external-"));
    roots.push(projectRoot, external);
    const platformRoot = join(projectRoot, ".cortex-eval");
    await mkdir(platformRoot, { mode: 0o700 });
    const temporaryRoot = join(platformRoot, "tmp");
    await symlink(external, temporaryRoot, "dir");
    const unrelated = await owner(external, "case-import-unrelated", {
      pid: 10,
      processStartedAt: "old-start",
      nonce: "external-owner",
      extra: true
    });
    const events: string[] = [];
    const manager = new CaseImportWorkspaceManager({
      containmentRoot: projectRoot,
      temporaryRoot,
      processLiveness: { processStartedAt: (): Promise<null> => Promise.resolve(null) },
      now: (): number => NOW.getTime(),
      nonce: (): string => "quarantine-nonce",
      pid: 99,
      ttlMs: 0,
      onSecurityEvent: (event): void => {
        events.push(event);
      }
    });

    await expect(manager.cleanupStale()).rejects.toThrow("TEMP_ROOT_INVALID");
    expect((await lstat(unrelated)).isDirectory()).toBe(true);
    expect(await readdir(external)).toEqual(["case-import-unrelated"]);
    expect(events).toEqual(["TEMP_CONTAINMENT_REJECTED"]);
  });

  it("未过 TTL 的无 owner 新目录不被并发清理隔离", async () => {
    const root = await mkdtemp(join(tmpdir(), "case-workspace-"));
    roots.push(root);
    const initializing = join(root, "case-import-initializing");
    await mkdir(initializing, { mode: 0o700 });
    await utimes(initializing, new Date(NOW.getTime() - 1_000), new Date(NOW.getTime() - 1_000));
    const events: string[] = [];
    const manager = new CaseImportWorkspaceManager({
      containmentRoot: join(root, ".."),
      temporaryRoot: root,
      processLiveness: { processStartedAt: (): Promise<null> => Promise.resolve(null) },
      now: (): number => NOW.getTime(),
      nonce: (): string => "cleaner-nonce",
      pid: 99,
      ttlMs: 24 * 60 * 60 * 1000,
      onSecurityEvent: (event): void => {
        events.push(event);
      }
    });

    await manager.cleanupStale();

    expect((await lstat(initializing)).isDirectory()).toBe(true);
    expect(events).toEqual([]);
  });

  it("owner 初始化失败时删除已经创建的临时目录", async () => {
    const root = await mkdtemp(join(tmpdir(), "case-workspace-"));
    roots.push(root);
    const manager = new CaseImportWorkspaceManager({
      containmentRoot: join(root, ".."),
      temporaryRoot: root,
      processLiveness: {
        processStartedAt: (): Promise<string> => Promise.resolve("current-start")
      },
      now: (): number => NOW.getTime(),
      nonce: (): string => {
        throw new Error("NONCE_UNAVAILABLE");
      },
      pid: 99,
      ttlMs: 0
    });

    await expect(manager.create()).rejects.toThrow("NONCE_UNAVAILABLE");
    expect(await readdir(root)).toEqual([]);
  });

  it("活跃旧进程跳过；死亡进程和 PID 复用的旧目录才会删除", async () => {
    const root = await mkdtemp(join(tmpdir(), "case-workspace-"));
    roots.push(root);
    const active = await owner(root, "case-import-active", {
      pid: 10,
      processStartedAt: "start-active",
      nonce: "nonce-active"
    });
    const dead = await owner(root, "case-import-dead", {
      pid: 11,
      processStartedAt: "start-dead",
      nonce: "nonce-dead"
    });
    const reused = await owner(root, "case-import-reused", {
      pid: 12,
      processStartedAt: "start-old",
      nonce: "nonce-reused"
    });
    const liveness: ProcessLiveness = {
      processStartedAt: (pid) =>
        Promise.resolve(pid === 10 ? "start-active" : pid === 12 ? "start-new" : null)
    };
    const manager = new CaseImportWorkspaceManager({
      containmentRoot: join(root, ".."),
      temporaryRoot: root,
      processLiveness: liveness,
      now: (): number => NOW.getTime(),
      nonce: (): string => "cleaner-nonce",
      pid: 99,
      ttlMs: 24 * 60 * 60 * 1000
    });

    await manager.cleanupStale();

    expect((await lstat(active)).isDirectory()).toBe(true);
    await expect(lstat(dead)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(reused)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("严格拒绝伪造 owner，隔离符号链接且不触碰外部哨兵", async () => {
    const root = await mkdtemp(join(tmpdir(), "case-workspace-"));
    const external = await mkdtemp(join(tmpdir(), "case-workspace-sentinel-"));
    roots.push(root, external);
    await writeFile(join(external, "sentinel"), "keep");
    await owner(root, "case-import-forged", {
      pid: 10,
      processStartedAt: "start",
      nonce: "nonce",
      extra: true
    });
    await symlink(external, join(root, "case-import-link"));
    const events: string[] = [];
    const manager = new CaseImportWorkspaceManager({
      containmentRoot: join(root, ".."),
      temporaryRoot: root,
      processLiveness: { processStartedAt: (): Promise<null> => Promise.resolve(null) },
      now: (): number => NOW.getTime(),
      nonce: (): string => "quarantine-nonce",
      pid: 99,
      ttlMs: 0,
      onSecurityEvent: (event): void => {
        events.push(event);
      }
    });

    await manager.cleanupStale();

    expect(await readFile(join(external, "sentinel"), "utf8")).toBe("keep");
    const names = await readdir(root);
    expect(names.some((name) => name.startsWith("case-import-"))).toBe(false);
    expect(names.filter((name) => name.startsWith("quarantine-case-import-"))).toHaveLength(2);
    expect(events).toEqual(["TEMP_OWNER_INVALID", "TEMP_SYMLINK_QUARANTINED"]);
  });

  it("清理前 owner nonce 被并发替换时跳过删除", async () => {
    const root = await mkdtemp(join(tmpdir(), "case-workspace-"));
    roots.push(root);
    const workspace = await owner(root, "case-import-race", {
      pid: 10,
      processStartedAt: "old-start",
      nonce: "old-nonce"
    });
    const manager = new CaseImportWorkspaceManager({
      containmentRoot: join(root, ".."),
      temporaryRoot: root,
      processLiveness: {
        processStartedAt: async (): Promise<null> => {
          await writeFile(
            join(workspace, "owner.json"),
            JSON.stringify({ pid: 20, processStartedAt: "new-start", nonce: "new-nonce" }),
            { mode: 0o600 }
          );
          return null;
        }
      },
      now: (): number => NOW.getTime(),
      nonce: (): string => "cleaner-nonce",
      pid: 99,
      ttlMs: 0
    });

    await manager.cleanupStale();

    expect((await lstat(workspace)).isDirectory()).toBe(true);
  });
});
