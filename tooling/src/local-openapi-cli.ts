import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import messages from "../messages/zh-CN.json" with { type: "json" };
import { generateLocalOpenApiJson } from "./local-openapi.ts";

const path = resolve("apps/local-server/openapi.json");
const generated = await generateLocalOpenApiJson();
if (process.argv.includes("--check")) {
  const committed = await readFile(path, "utf8").catch(() => "");
  if (committed !== generated) {
    process.stderr.write(`${messages.OPENAPI_DRIFT}\n`);
    process.exitCode = 1;
  }
} else {
  await writeFile(path, generated, { encoding: "utf8", mode: 0o644 });
}
