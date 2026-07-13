import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("Case import bounded memory", () => {
  it("真实 200 MiB multipart 的 RSS 增量不超过固定 192 MiB", async () => {
    const helper = fileURLToPath(
      new URL("../test-support/case-import-memory-probe.ts", import.meta.url)
    );
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", helper], {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(`CASE_IMPORT_MEMORY_PROBE_FAILED:${stderr.slice(0, 500)}`));
      });
    });
    const result = JSON.parse(output.trim()) as {
      baselineRss: number;
      peakRss: number;
      deltaRss: number;
    };
    expect(result.baselineRss).toBeGreaterThan(0);
    expect(result.peakRss).toBeGreaterThanOrEqual(result.baselineRss);
    expect(result.deltaRss).toBeLessThanOrEqual(192 * 1024 * 1024);
  }, 120_000);
});
