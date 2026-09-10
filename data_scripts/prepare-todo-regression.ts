import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";

import { repairTodoPlannerCase } from "./todo-case-repair.ts";
import { buildTodoE2ESamples } from "./todo-e2e-samples.ts";

const { values } = parseArgs({
  options: { input: { type: "string" }, output: { type: "string" } }
});
if (!values.input || !values.output)
  throw new Error(
    "Usage: pnpm exec tsx data_scripts/prepare-todo-regression.ts --input <planner.jsonl> --output <new-directory>"
  );
const input = resolve(values.input);
const directory = resolve(values.output);
const targets = [join(directory, "planner.cases.jsonl"), join(directory, "e2e.draft.cases.jsonl")];
if (targets.includes(input)) throw new Error("TODO_SOURCE_MUST_NOT_BE_OVERWRITTEN");
const cases = (await readFile(input, "utf8"))
  .split(/\r?\n/)
  .filter((line) => line.trim())
  .map((line) => repairTodoPlannerCase(JSON.parse(line) as unknown));
if (new Set(cases.map((c) => c.metadata.case_id)).size !== cases.length)
  throw new Error("TODO_DUPLICATE_CASE_ID");
// Claim a fresh destination before writing either file; never partially overwrite an existing pack.
await mkdir(resolve(directory, ".."), { recursive: true });
await mkdir(directory);
for (const [name, items] of [
  ["planner.cases.jsonl", cases],
  ["e2e.draft.cases.jsonl", buildTodoE2ESamples()]
] as const) {
  // Exclusive writes preserve earlier prepared packs and the user's source exports.
  await writeFile(join(directory, name), items.map((c) => JSON.stringify(c)).join("\n") + "\n", {
    flag: "wx",
    mode: 0o600
  });
}
console.log(
  JSON.stringify({ directory, plannerCount: cases.length, e2eDraftCount: 8, executed: false })
);
