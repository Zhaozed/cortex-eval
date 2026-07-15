import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("核心包覆盖率范围", () => {
  it("显式纳入 P2 Application 与 Storage SQLite 生产源码", async () => {
    const config = await readFile(resolve(process.cwd(), "vitest.config.ts"), "utf8");
    expect(config).toContain('"packages/application/src/**/*.ts"');
    expect(config).toContain('"packages/storage-sqlite/src/**/*.ts"');
  });

  it("显式纳入 P7 CLI 与 Work Package 生产源码", async () => {
    const config = await readFile(resolve(process.cwd(), "vitest.config.ts"), "utf8");
    expect(config).toContain('"apps/cli/src/**/*.ts"');
    expect(config).toContain('"packages/work-package/src/**/*.ts"');
  });

  it("显式纳入 P10 Canonical Export 独立接收端生产源码", async () => {
    const config = await readFile(resolve(process.cwd(), "vitest.config.ts"), "utf8");
    expect(config).toContain('"packages/canonical-export/src/**/*.ts"');
  });
});
