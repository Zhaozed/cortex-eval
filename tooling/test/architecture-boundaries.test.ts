import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  collectArchitectureViolations,
  validatePackageDependency
} from "../src/architecture-boundaries.ts";

describe("架构单向依赖", () => {
  it("阻止 Domain 反向依赖 Contracts，允许 Application 依赖 Domain", () => {
    expect(validatePackageDependency("domain", "contracts")).toBe("ARCH_DOMAIN_OUTER_IMPORT");
    expect(validatePackageDependency("application", "domain")).toBeNull();
  });

  it("扫描真实包导入并忽略不存在的目标目录", async () => {
    const root = await mkdtemp(join(tmpdir(), "cortex-eval-architecture-"));
    try {
      const domain = join(root, "packages/domain/src");
      const application = join(root, "packages/application/src");
      await mkdir(domain, { recursive: true });
      await mkdir(application, { recursive: true });
      await writeFile(join(domain, "bad.ts"), 'import "@cortex-eval/contracts";\n', "utf8");
      await writeFile(
        join(domain, "bad.tsx"),
        'export { x } from "@cortex-eval/contracts";\n',
        "utf8"
      );
      await writeFile(
        join(domain, "computed.ts"),
        'const target = "contracts"; import(target);\n',
        "utf8"
      );
      await writeFile(
        join(domain, "relative.ts"),
        'import "../../contracts/src/x.ts";\nvoid import("../../contracts/src/y.ts");\n',
        "utf8"
      );
      await writeFile(join(application, "good.ts"), 'import "@cortex-eval/domain";\n', "utf8");
      await expect(collectArchitectureViolations(root)).resolves.toEqual([
        {
          file: "packages/domain/src/bad.ts",
          target: "contracts",
          code: "ARCH_DOMAIN_OUTER_IMPORT"
        },
        {
          file: "packages/domain/src/bad.tsx",
          target: "contracts",
          code: "ARCH_DOMAIN_OUTER_IMPORT"
        },
        {
          file: "packages/domain/src/computed.ts",
          target: "unknown",
          code: "ARCH_DYNAMIC_IMPORT_EXPRESSION"
        },
        {
          file: "packages/domain/src/relative.ts",
          target: "contracts",
          code: "ARCH_DOMAIN_OUTER_IMPORT"
        },
        {
          file: "packages/domain/src/relative.ts",
          target: "contracts",
          code: "ARCH_DOMAIN_OUTER_IMPORT"
        }
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
