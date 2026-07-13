import { lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CaseImportWorkspaceManager,
  type ProcessLiveness
} from "@cortex-eval/storage-sqlite/src/case-import-workspace.ts";

import { FileCaseExportBodyPreparer } from "../src/case-export-staging.ts";

const roots: string[] = [];
const processLiveness: ProcessLiveness = {
  processStartedAt: (): Promise<string> => Promise.resolve("Mon Jul 13 12:00:00 2026")
};

// Expose deterministic asynchronous chunks and an optional terminal failure.
function asyncChunks(values: readonly string[], failure?: Error): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<string> {
      let index = 0;
      return {
        next: (): Promise<IteratorResult<string>> => {
          const value = values[index];
          index += 1;
          if (value !== undefined) return Promise.resolve({ done: false, value });
          if (failure !== undefined) return Promise.reject(failure);
          return Promise.resolve({ done: true, value: undefined });
        }
      };
    }
  };
}

// Create one export-only owner-aware workspace manager below a disposable root.
async function setup(): Promise<{
  readonly root: string;
  readonly preparer: FileCaseExportBodyPreparer;
}> {
  const root = await mkdtemp(join(tmpdir(), "cortex-case-export-"));
  roots.push(root);
  const manager = new CaseImportWorkspaceManager({
    containmentRoot: dirname(root),
    temporaryRoot: root,
    processLiveness,
    now: (): number => 1_700_000_000_000,
    nonce: (): string => "export-owner",
    pid: process.pid,
    ttlMs: 1_000,
    workspacePrefix: "case-export-"
  });
  return { root, preparer: new FileCaseExportBodyPreparer(manager) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("P3 disk-backed Case export staging", () => {
  it("响应打开前写入 0600 文件，并在流完成后删除所属工作区", async () => {
    const { root, preparer } = await setup();
    const body = await preparer.prepare(asyncChunks(["[", '{"case":"CASE-1"}', "]"]));
    const workspaces = await readdir(root);
    expect(workspaces).toHaveLength(1);
    const filePath = join(root, workspaces[0] ?? "missing", "cases.json");
    expect((await lstat(filePath)).mode & 0o777).toBe(0o600);

    const values: Buffer[] = [];
    for await (const chunk of body) {
      if (!Buffer.isBuffer(chunk)) throw new Error("BUFFER_EXPECTED");
      values.push(chunk);
    }
    if (!body.closed) await once(body, "close");
    expect(Buffer.concat(values).toString("utf8")).toBe('[{"case":"CASE-1"}]');
    expect(await readdir(root)).toEqual([]);
  });

  it("准备期间失败时不暴露部分响应并清理所属工作区", async () => {
    const { root, preparer } = await setup();
    await expect(
      preparer.prepare(asyncChunks(["["], new Error("EXPORT_REVISION_CONFLICT")))
    ).rejects.toThrow("EXPORT_REVISION_CONFLICT");
    expect(await readdir(root)).toEqual([]);
  });

  it("响应体开始读取前取消也删除所属工作区", async () => {
    const { root, preparer } = await setup();
    const body = await preparer.prepare(asyncChunks(["[]"]));

    body.destroy();
    await once(body, "close");

    expect(await readdir(root)).toEqual([]);
  });
});
