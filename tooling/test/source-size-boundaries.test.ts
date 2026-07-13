import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { collectSourceSizeViolations } from "../src/source-size-boundaries.ts";

describe("TypeScript 单文件规模边界", () => {
  it("允许 1000 行并以稳定错误拒绝 1001 行生产或测试文件", async () => {
    const root = await mkdtemp(join(tmpdir(), "cortex-eval-source-size-"));
    try {
      const sourceDirectory = join(root, "apps/web/src");
      const testDirectory = join(root, "apps/web/test");
      await mkdir(sourceDirectory, { recursive: true });
      await mkdir(testDirectory, { recursive: true });
      await writeFile(
        join(sourceDirectory, "within-limit.ts"),
        Array.from({ length: 1000 }, (_, index) => `export const value${index} = ${index};`).join(
          "\n"
        ),
        "utf8"
      );
      await writeFile(
        join(testDirectory, "oversized.test.tsx"),
        Array.from({ length: 1001 }, (_, index) => `const value${index} = ${index};`).join("\n"),
        "utf8"
      );

      await expect(collectSourceSizeViolations(root)).resolves.toEqual([
        {
          file: "apps/web/test/oversized.test.tsx",
          lines: 1001,
          limit: 1000,
          code: "ARCH_SOURCE_FILE_TOO_LARGE"
        }
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("真实仓库没有超过 1000 行的 TypeScript 生产或测试文件", async () => {
    await expect(collectSourceSizeViolations(process.cwd())).resolves.toEqual([]);
  });
});
