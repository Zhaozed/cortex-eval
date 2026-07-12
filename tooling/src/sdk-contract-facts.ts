import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/** SDK facts that prevent hidden retry behavior. */
export interface SdkContractFacts {
  /** Google Gen AI SDK contract. */
  googleGenai: {
    /** Exact package version. */
    version: string;
    /** Total attempts that mean one request and no retry. */
    noRetryAttempts: 1;
  };
  /** OpenAI SDK contract. */
  openai: {
    /** Exact package version. */
    version: string;
    /** Maximum retries that disable SDK retry. */
    noRetryMaxRetries: 0;
  };
}

// Read one package version without importing runtime code.
async function readPackageVersion(path: string): Promise<string> {
  const value = JSON.parse(await readFile(path, "utf8")) as { version?: unknown };
  if (typeof value.version !== "string" || value.version === "") {
    throw new Error("SDK_PACKAGE_VERSION");
  }
  return value.version;
}

// Inspect installed official SDK declarations for the exact no-retry controls.
export async function inspectSdkContractFacts(root: string): Promise<SdkContractFacts> {
  const googleRoot = resolve(root, "node_modules/@google/genai");
  const openaiRoot = resolve(root, "node_modules/openai");
  const [googleVersion, openaiVersion, googleTypes, openaiTypes] = await Promise.all([
    readPackageVersion(resolve(googleRoot, "package.json")),
    readPackageVersion(resolve(openaiRoot, "package.json")),
    readFile(resolve(googleRoot, "dist/node/node.d.ts"), "utf8"),
    readFile(resolve(openaiRoot, "client.d.ts"), "utf8")
  ]);
  if (!googleTypes.includes("If 0 or 1, it means no retries")) {
    throw new Error("GOOGLE_GENAI_NO_RETRY_CONTRACT");
  }
  if (!openaiTypes.includes("maxRetries?: number")) {
    throw new Error("OPENAI_NO_RETRY_CONTRACT");
  }
  return {
    googleGenai: { version: googleVersion, noRetryAttempts: 1 },
    openai: { version: openaiVersion, noRetryMaxRetries: 0 }
  };
}
