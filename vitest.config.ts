import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      exclude: ["**/*.test.ts", "**/test-support/**"],
      include: [
        "apps/cli/src/**/*.ts",
        "apps/local-server/src/**/*.ts",
        "apps/web/src/**/*.ts",
        "apps/web/src/**/*.tsx",
        "packages/application/src/**/*.ts",
        "packages/contracts/src/**/*.ts",
        "packages/domain/src/**/*.ts",
        "packages/storage-sqlite/src/**/*.ts",
        "packages/work-package/src/**/*.ts",
        "tooling/src/architecture-boundaries.ts",
        "tooling/src/benchmark-harness.ts",
        "tooling/src/deterministic-cases.ts",
        "tooling/src/document-links.ts",
        "tooling/src/fixture-contract.ts",
        "tooling/src/promptfoo-capabilities.ts",
        "tooling/src/runtime-doctor.ts",
        "tooling/src/sdk-contract-facts.ts",
        "tooling/src/secret-scan.ts"
      ],
      provider: "v8",
      reporter: ["text", "json-summary"],
      thresholds: {
        branches: 85,
        functions: 90,
        lines: 90,
        statements: 90
      }
    },
    include: [
      "apps/*/test/**/*.test.ts",
      "apps/*/test/**/*.test.tsx",
      "packages/*/test/**/*.test.ts",
      "tooling/test/**/*.test.ts"
    ],
    // Keep real Promptfoo/SQLite/HTTP integration workers from starving one another under coverage.
    maxWorkers: 3,
    setupFiles: ["apps/web/test/setup.ts"],
    testTimeout: 30_000
  }
});
