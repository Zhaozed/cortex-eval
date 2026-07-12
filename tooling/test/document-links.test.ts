import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { collectBrokenDocumentLinks } from "../src/document-links.ts";

describe("文档事实入口", () => {
  it("REQ、TECH、spec 与 tasks 索引中的本地链接均存在", async () => {
    await expect(collectBrokenDocumentLinks(process.cwd())).resolves.toEqual([]);
  });

  it("报告缺失根文档和相对链接，但忽略外部链接与锚点", async () => {
    const root = await mkdtemp(join(tmpdir(), "cortex-eval-docs-"));
    try {
      await mkdir(join(root, "spec"), { recursive: true });
      await mkdir(join(root, "tasks"), { recursive: true });
      await writeFile(join(root, "REQ.md"), "[外部](https://example.com) [锚点](#x)\n", "utf8");
      await writeFile(join(root, "TECH.md"), "[缺失](missing.md#section)\n", "utf8");
      await writeFile(join(root, "spec/00_INDEX.md"), "# index\n", "utf8");
      await writeFile(join(root, "tasks/00_INDEX.md"), "# tasks\n", "utf8");
      const broken = await collectBrokenDocumentLinks(root);
      expect(broken).toContainEqual({ source: "TECH.md", target: "missing.md" });
      expect(broken).toContainEqual({ source: "SPEC_DOC.md", target: "SPEC_DOC.md" });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
