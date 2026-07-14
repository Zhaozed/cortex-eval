import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CliSecretEnvironment } from "../src/cli-secret-environment.ts";

const roots: string[] = [];

async function fixture(content: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cortex-cli-env-"));
  roots.push(root);
  const path = join(root, "runtime.env");
  await writeFile(path, content, { mode: 0o600 });
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("P7 CLI Secret environment", () => {
  it("uses an explicit Env file before the inherited process environment", async () => {
    const path = await fixture("ENDPOINT_TOKEN=file-secret\n");
    const environment = await CliSecretEnvironment.load({
      envFile: path,
      inherited: { ENDPOINT_TOKEN: "process-secret" }
    });
    expect(environment.readSecret("ENDPOINT_TOKEN")).toBe("file-secret");
    expect(() => environment.require(["ENDPOINT_TOKEN"])).not.toThrow();
  });

  it("rejects missing or empty stage keys without exposing values", async () => {
    const path = await fixture("ENDPOINT_TOKEN=\n");
    const environment = await CliSecretEnvironment.load({ envFile: path, inherited: {} });
    expect(() => environment.require(["ENDPOINT_TOKEN"])).toThrow("VALIDATION_FAILED");
    expect(environment.readSecret("ENDPOINT_TOKEN")).toBeUndefined();
  });

  it("rejects a non-owner-only explicit Secret file", async () => {
    const path = await fixture("ENDPOINT_TOKEN=secret\n");
    await chmod(path, 0o644);
    await expect(CliSecretEnvironment.load({ envFile: path, inherited: {} })).rejects.toThrow(
      "VALIDATION_FAILED"
    );
  });

  it("rejects an empty or missing explicit Secret file path", async () => {
    await expect(CliSecretEnvironment.load({ envFile: "", inherited: {} })).rejects.toThrow(
      "VALIDATION_FAILED"
    );
    await expect(
      CliSecretEnvironment.load({ envFile: "/definitely/missing/cortex.env", inherited: {} })
    ).rejects.toThrow("VALIDATION_FAILED");
  });
});
