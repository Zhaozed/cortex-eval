import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseRuntimeVersion,
  resolveInterpreterCommand,
  runRuntimeDoctor,
  runRuntimeDoctorWithSmoke,
  validateNodeRuntime
} from "../src/runtime-doctor.ts";

describe("Runtime Doctor", () => {
  it("只接受 Node 24", () => {
    expect(validateNodeRuntime("v24.18.0", "/opt/homebrew/opt/node@24/bin/node")).toEqual({
      executable: "/opt/homebrew/opt/node@24/bin/node",
      version: "24.18.0"
    });
    expect(() => validateNodeRuntime("v25.5.0", "/opt/homebrew/bin/node")).toThrow(
      "RUNTIME_NODE_VERSION"
    );
  });

  it("拒绝无法解析和低于下限的解释器版本", () => {
    expect(parseRuntimeVersion("Python 3.12.12", "python")).toEqual([3, 12, 12]);
    expect(parseRuntimeVersion("ruby 2.6.10p210", "ruby")).toEqual([2, 6, 10]);
    expect(() => parseRuntimeVersion("unknown", "python")).toThrow("RUNTIME_VERSION_PARSE");
  });

  it("显式环境变量优先于默认解释器", () => {
    expect(
      resolveInterpreterCommand("PROMPTFOO_PYTHON", "python3", {
        PROMPTFOO_PYTHON: "/custom/python"
      })
    ).toBe("/custom/python");
    expect(resolveInterpreterCommand("PROMPTFOO_RUBY", "ruby", {})).toBe("ruby");
  });

  it("检查当前 Node、Python 与 Ruby 的真实命令", () => {
    expect(runRuntimeDoctor()).toMatchObject({
      node: { version: "24.18.0" },
      python: { version: "3.12.12" },
      ruby: { version: "2.6.10" }
    });
  });

  it("完整 Doctor 返回 Python 与 Ruby 内联 Assertion Smoke", async () => {
    await expect(runRuntimeDoctorWithSmoke(process.cwd())).resolves.toMatchObject({
      runtimes: {
        node: { version: "24.18.0" },
        python: { version: "3.12.12" },
        ruby: { version: "2.6.10" }
      },
      promptfooVersion: "0.121.18",
      pythonInlineAssertion: { exitCode: 0, componentResults: 1 },
      rubyInlineAssertion: { exitCode: 0, componentResults: 1 }
    });
  }, 30_000);

  it("拒绝缺失命令和低版本 Python", async () => {
    expect(() =>
      runRuntimeDoctor({ PROMPTFOO_PYTHON: "/missing/python", PROMPTFOO_RUBY: "ruby" })
    ).toThrow("RUNTIME_COMMAND_UNAVAILABLE:python");
    const directory = await mkdtemp(join(tmpdir(), "cortex-eval-runtime-"));
    const python = join(directory, "python");
    try {
      await writeFile(python, "#!/bin/sh\necho 'Python 3.6.9'\n", "utf8");
      await chmod(python, 0o700);
      expect(() => runRuntimeDoctor({ PROMPTFOO_PYTHON: python, PROMPTFOO_RUBY: "ruby" })).toThrow(
        "RUNTIME_PYTHON_VERSION:3.6.9"
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("解释器版本检查和 Promptfoo Smoke 使用同一个显式命令", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cortex-eval-doctor-smoke-"));
    const python = join(directory, "python");
    try {
      await writeFile(
        python,
        '#!/bin/sh\nif [ "$1" = "--version" ]; then echo \'Python 3.9.0\'; exit 0; fi\nexit 77\n',
        "utf8"
      );
      await chmod(python, 0o700);
      await expect(
        runRuntimeDoctorWithSmoke(process.cwd(), {
          PROMPTFOO_PYTHON: python,
          PROMPTFOO_RUBY: "ruby"
        })
      ).rejects.toThrow("RUNTIME_PYTHON_SMOKE:100");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 30_000);
});
