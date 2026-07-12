import { describe, expect, it } from "vitest";

import { inspectSdkContractFacts } from "../src/sdk-contract-facts.ts";

describe("官方 SDK 契约事实", () => {
  it("固定版本并证明两类 SDK 可以显式关闭自动重试", async () => {
    await expect(inspectSdkContractFacts(process.cwd())).resolves.toEqual({
      googleGenai: { version: "2.11.0", noRetryAttempts: 1 },
      openai: { version: "6.46.0", noRetryMaxRetries: 0 }
    });
  });
});
