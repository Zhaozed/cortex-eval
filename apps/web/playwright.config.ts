import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4310",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  projects: [
    {
      name: "desktop-1440",
      grepInvert: /@compact/,
      use: { viewport: { width: 1440, height: 900 } }
    },
    {
      name: "desktop-1280-reduced-motion",
      grepInvert: /@compact/,
      use: {
        viewport: { width: 1280, height: 800 },
        contextOptions: { reducedMotion: "reduce" }
      }
    },
    {
      name: "compact-900",
      grep: /@compact/,
      use: { viewport: { width: 900, height: 800 } }
    }
  ],
  webServer: {
    command:
      "pnpm --dir ../.. web:build && pnpm --dir ../.. exec tsx apps/web/test-support/e2e-server.ts",
    url: "http://127.0.0.1:4310/",
    reuseExistingServer: false,
    timeout: 120_000
  }
});
