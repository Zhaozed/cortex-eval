/**
 * rules 专用 vitest 配置。
 *
 * 为什么要有它：仓库根 `vitest.config.ts` 的 `test.include` 只覆盖
 * `apps/*​/test`、`packages/*​/test`、`tooling/test`，不含 `test_suite/**`，
 * 而根配置属于「禁改」范围。所以本目录自带一份配置，用
 *   npx vitest run --config test_suite/feishu-e2e-v2/rules/vitest.config.ts
 * 运行。root 指回仓库根，保证 `@cortex-eval/*` 与 node_modules 解析与主仓一致。
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

export default defineConfig({
  root: repoRoot,
  test: {
    environment: "node",
    include: ["test_suite/feishu-e2e-v2/rules/__tests__/**/*.test.ts"],
    testTimeout: 60_000
  }
});
