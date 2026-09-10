import { defineConfig } from "@playwright/test";

const port = Number(process.env.CORTEX_EVAL_E2E_PORT ?? "4310");
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL,
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
      name: "desktop-1024-case-authoring",
      grep: /资源 Dashboard/,
      use: { viewport: { width: 1024, height: 900 } }
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
    url: `${baseURL}/`,
    reuseExistingServer: false,
    timeout: 120_000
  }
});
