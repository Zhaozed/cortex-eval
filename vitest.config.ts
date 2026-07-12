import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      exclude: ["**/*.test.ts", "**/test-support/**"],
      include: [
        "packages/contracts/src/**/*.ts",
        "packages/domain/src/**/*.ts",
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
    include: ["packages/*/test/**/*.test.ts", "tooling/test/**/*.test.ts"],
    testTimeout: 30_000
  }
});
