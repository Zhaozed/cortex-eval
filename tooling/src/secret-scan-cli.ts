import { readFile } from "node:fs/promises";

import { scanJsonForSecrets } from "./secret-scan.ts";

const files = process.argv.slice(2);
if (files.length === 0) {
  throw new Error("SECRET_SCAN_FILES_REQUIRED");
}
const findings = [];
for (const file of files) {
  const value = JSON.parse(await readFile(file, "utf8")) as unknown;
  findings.push(...scanJsonForSecrets(file, value));
}
if (findings.length > 0) {
  process.stderr.write(`${JSON.stringify(findings)}\n`);
  process.exitCode = 1;
}
