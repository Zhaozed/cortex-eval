import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { initializeSqliteStorage } from "../src/sqlite-database.ts";

const execFileAsync = promisify(execFile);

describe("SQLite 独立进程竞争", () => {
  it("两个独立 Node 进程竞争 RUNNING 时只有一个成功", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "cortex-process-race-"));
    const storage = await initializeSqliteStorage({ projectRoot });
    const script = resolve(
      process.cwd(),
      "packages/storage-sqlite/test-support/claim-running-process.ts"
    );
    const command = resolve(process.cwd(), "node_modules/.bin/tsx");
    const attempts = await Promise.all([
      execFileAsync(command, [script, storage.databasePath, "run-a"]),
      execFileAsync(command, [script, storage.databasePath, "run-b"])
    ]);
    expect(attempts.map((item) => item.stdout.trim()).sort()).toEqual(["CONFLICT", "SUCCESS"]);
    await storage.close();
  });
});
