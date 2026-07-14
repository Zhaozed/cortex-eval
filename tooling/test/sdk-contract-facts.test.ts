import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { inspectSdkContractFacts } from "../src/sdk-contract-facts.ts";

describe("官方 SDK 契约事实", () => {
  it("固定版本并证明两类 SDK 可以显式关闭自动重试", async () => {
    await expect(inspectSdkContractFacts(process.cwd())).resolves.toEqual({
      googleGenai: { version: "2.11.0", noRetryAttempts: 1 },
      openai: { version: "6.46.0", noRetryMaxRetries: 0 }
    });
  });

  it("拒绝缺失版本和缺失显式关闭重试声明的 SDK", async () => {
    const root = await mkdtemp(join(tmpdir(), "cortex-sdk-contract-"));
    const google = join(root, "node_modules", "@google", "genai");
    const openai = join(root, "node_modules", "openai");
    await mkdir(join(google, "dist", "node"), { recursive: true });
    await mkdir(openai, { recursive: true });
    await writeFile(join(openai, "package.json"), JSON.stringify({ version: "1.0.0" }));
    await writeFile(join(openai, "client.d.ts"), "maxRetries?: number");
    await writeFile(join(google, "dist", "node", "node.d.ts"), "If 0 or 1, it means no retries");
    try {
      await writeFile(join(google, "package.json"), JSON.stringify({}));
      await expect(inspectSdkContractFacts(root)).rejects.toThrow("SDK_PACKAGE_VERSION");

      await writeFile(join(google, "package.json"), JSON.stringify({ version: "1.0.0" }));
      await writeFile(join(google, "dist", "node", "node.d.ts"), "retryOptions");
      await expect(inspectSdkContractFacts(root)).rejects.toThrow("GOOGLE_GENAI_NO_RETRY_CONTRACT");

      await writeFile(join(google, "dist", "node", "node.d.ts"), "If 0 or 1, it means no retries");
      await writeFile(join(openai, "client.d.ts"), "class OpenAI {}");
      await expect(inspectSdkContractFacts(root)).rejects.toThrow("OPENAI_NO_RETRY_CONTRACT");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
