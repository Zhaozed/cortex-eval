import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  runBoundedProcess,
  runPromptfooProcessProbe,
  runRealFixtureProcessProbe
} from "../src/promptfoo-process-probe.ts";

describe("Promptfoo 真实进程探针", () => {
  it("使用预计算 providerOutput，不调用 Provider，并保留组件结果与退出码语义", async () => {
    const probe = await runPromptfooProcessProbe(process.cwd());

    expect(probe.version).toBe("0.121.18");
    expect(probe.providerRequestCount).toBe(0);
    expect(probe.pass.exitCode).toBe(0);
    expect(probe.pass.componentResults).toBe(1);
    expect(probe.fail.exitCode).toBe(100);
    expect(probe.fail.componentResults).toBe(1);
    expect(probe.python).toEqual({ exitCode: 0, componentResults: 1 });
    expect(probe.ruby).toEqual({ exitCode: 0, componentResults: 1 });
    expect(probe.booleanEquals).toEqual({ exitCode: 0, componentResults: 1 });
    expect(probe.numericContainsAny).toEqual({ exitCode: 0, componentResults: 1 });
    expect(probe.llmRubricStringList).toEqual({ exitCode: 0, componentResults: 1 });
  }, 30_000);

  it("真实 REST Fixture 在隔离副本中使用预计算输出并生成可对齐组件", async () => {
    const fixture = JSON.parse(
      await readFile("test_suite/current/run_result/loona_promptfoo_tests.json", "utf8")
    ) as { assert: { type: string }[] }[];
    const expectedTypes = fixture.flatMap((item) => item.assert.map((assertion) => assertion.type));
    const probe = await runRealFixtureProcessProbe(process.cwd());
    expect(probe.providerRequestCount).toBe(0);
    expect(probe.evaluatorRequestCount).toBe(
      expectedTypes.filter((type) => type === "llm-rubric").length
    );
    expect(probe.caseCount).toBeGreaterThan(0);
    expect(probe.alignedCaseCount).toBe(probe.caseCount);
    expect(probe.componentResults).toBe(expectedTypes.length);
    expect(probe.assertionTypes).toEqual(expectedTypes);
    expect(probe.exitCode).toBe(100);
  }, 30_000);

  it("超时后先终止再强制回收卡住的子进程", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cortex-eval-stuck-process-"));
    const script = join(directory, "stuck.sh");
    try {
      await writeFile(script, "#!/bin/sh\ntrap '' TERM\nwhile true; do sleep 1; done\n", "utf8");
      await chmod(script, 0o700);
      await expect(runBoundedProcess(script, [], directory, 50, 50)).rejects.toThrow(
        "PROMPTFOO_PROBE_TIMEOUT"
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
