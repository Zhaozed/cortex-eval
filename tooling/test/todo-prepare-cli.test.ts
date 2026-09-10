import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, it } from "vitest";

import { buildTodoE2ESamples } from "../../data_scripts/todo-e2e-samples.ts";
import { runBoundedProcess } from "../src/promptfoo-process-probe.ts";

it("Todo准备CLI生成36+8，不改源、不覆盖既有目录，不执行Agent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "todo-prepare-"));
  try {
    const input = resolve("tooling/test-support/todo-planner-legacy.jsonl");
    const before = await readFile(input, "utf8");
    const output = join(directory, "pack");
    const args = [
      resolve("data_scripts/prepare-todo-regression.ts"),
      "--input",
      input,
      "--output",
      output
    ];
    const result = await runBoundedProcess(resolve("node_modules/.bin/tsx"), args, directory);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      plannerCount: 36,
      e2eDraftCount: 8,
      executed: false
    });
    const golden = await readFile(join(output, "planner.cases.jsonl"), "utf8");
    expect(golden.trim().split("\n")).toHaveLength(36);
    const repeated = await runBoundedProcess(resolve("node_modules/.bin/tsx"), args, directory);
    expect(repeated.exitCode).not.toBe(0);
    expect(await readFile(join(output, "planner.cases.jsonl"), "utf8")).toBe(golden);
    expect(await readFile(input, "utf8")).toBe(before);
    const draft = (await readFile("test_suite/todo/e2e.draft.cases.jsonl", "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
    expect(draft).toEqual(buildTodoE2ESamples());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("Todo准备CLI拒绝非法输入，不留下半套产物", async () => {
  const directory = await mkdtemp(join(tmpdir(), "todo-invalid-"));
  try {
    const input = join(directory, "bad.jsonl");
    await writeFile(input, "{}\n");
    const result = await runBoundedProcess(
      resolve("node_modules/.bin/tsx"),
      [
        resolve("data_scripts/prepare-todo-regression.ts"),
        "--input",
        input,
        "--output",
        join(directory, "pack")
      ],
      directory
    );
    expect(result.exitCode).not.toBe(0);
    expect(await readdir(directory)).toEqual(["bad.jsonl"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
