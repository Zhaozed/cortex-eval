import { collectArchitectureViolations } from "./architecture-boundaries.ts";
import { collectSourceSizeViolations } from "./source-size-boundaries.ts";

const violations = [
  ...(await collectArchitectureViolations(process.cwd())),
  ...(await collectSourceSizeViolations(process.cwd()))
];
if (violations.length > 0) {
  process.stderr.write(`${JSON.stringify(violations)}\n`);
  process.exitCode = 1;
}
