import { chmod, mkdtemp, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  BUSINESS_TABLES,
  initializeSqliteStorage,
  resolveDefaultDatabasePath
} from "../src/sqlite-database.ts";

const openStorages: { close(): Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(openStorages.splice(0).map(async (storage) => storage.close()));
});

describe("SQLite 初始化与 Migration", () => {
  it("创建恰好十张业务表并显式保留 Kysely Migration 元数据表", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-storage-"));
    const storage = await initializeSqliteStorage({ projectRoot });
    openStorages.push(storage);

    const database = new Database(storage.databasePath, { readonly: true });
    const rows = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];
    database.close();

    const names = rows.map((row) => row.name);
    const businessTableNames = new Set<string>(BUSINESS_TABLES);
    expect(names.filter((name) => businessTableNames.has(name))).toEqual(
      [...BUSINESS_TABLES].sort()
    );
    expect(names).toContain("kysely_migration");
    expect(names).toContain("kysely_migration_lock");
    expect(
      names.filter((name) => !name.startsWith("kysely_") && !name.startsWith("sqlite_"))
    ).toHaveLength(10);
  });

  it("每个独立连接均启用外键、WAL、Busy Timeout 和 FULL 同步", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-storage-"));
    const first = await initializeSqliteStorage({ projectRoot });
    const second = await initializeSqliteStorage({ projectRoot });
    openStorages.push(first, second);

    for (const storage of [first, second]) {
      const pragmas = await storage.inspectConnectionPragmas();
      expect(pragmas).toEqual({
        foreignKeys: true,
        journalMode: "wal",
        busyTimeoutMs: 5_000,
        synchronous: "full"
      });
    }
  });

  it("只使用装配层传入的绝对项目根，不受当前工作目录影响", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-project-"));
    const unrelatedRoot = await mkdtemp(join(tmpdir(), "cortex-cwd-"));
    const nested = join(unrelatedRoot, "nested");
    await mkdir(nested);
    const originalCwd = process.cwd();
    process.chdir(nested);
    try {
      expect(resolveDefaultDatabasePath(projectRoot)).toBe(
        join(projectRoot, ".cortex-eval", "db", "cortex-eval.sqlite3")
      );
      const storage = await initializeSqliteStorage({ projectRoot });
      openStorages.push(storage);
      expect(storage.databasePath).toBe(resolveDefaultDatabasePath(projectRoot));
    } finally {
      process.chdir(originalCwd);
    }
    await expect(initializeSqliteStorage({ projectRoot: "relative/root" })).rejects.toMatchObject({
      code: "SQLITE_PROJECT_ROOT_INVALID"
    });
  });

  it("收敛已有目录、主库和 WAL 辅助文件权限", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-permissions-"));
    const databasePath = resolveDefaultDatabasePath(projectRoot);
    await mkdir(dirname(databasePath), { recursive: true, mode: 0o777 });
    await chmod(join(projectRoot, ".cortex-eval"), 0o777);
    await chmod(dirname(databasePath), 0o777);

    const storage = await initializeSqliteStorage({ projectRoot });
    openStorages.push(storage);

    expect((await stat(join(projectRoot, ".cortex-eval"))).mode & 0o777).toBe(0o700);
    expect((await stat(dirname(databasePath))).mode & 0o777).toBe(0o700);
    expect((await stat(databasePath)).mode & 0o777).toBe(0o600);
    for (const suffix of ["-wal", "-shm"]) {
      const auxiliary = await stat(`${databasePath}${suffix}`).catch(() => null);
      if (auxiliary !== null) expect(auxiliary.mode & 0o777).toBe(0o600);
    }
  });
});
