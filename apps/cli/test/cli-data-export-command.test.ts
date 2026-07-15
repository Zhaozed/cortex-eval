import { CliDataExportEventV1Schema } from "@cortex-eval/contracts/src/cli-contracts.ts";
import type { ReceivedCanonicalExport } from "@cortex-eval/canonical-export/src/canonical-export-receiver.ts";
import { describe, expect, it } from "vitest";

import { runCli, type CliDependencies, type CliOutput } from "../src/cli-program.ts";
import type { DataExportCommandService } from "../src/data-export-command-service.ts";

const ID = "018f1e2d-3c4b-7abc-8def-0123456789ab";
const HASH = "a".repeat(64);

function output(): {
  readonly stdout: string[];
  readonly stderr: string[];
  readonly sink: CliOutput;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    sink: {
      stdout: (value): void => {
        stdout.push(value);
      },
      stderr: (value): void => {
        stderr.push(value);
      }
    }
  };
}

function dependencies(dataCommands: DataExportCommandService, sink: CliOutput): CliDependencies {
  const unused = (): Promise<never> => Promise.reject(new Error("TEST_UNUSED_COMMAND"));
  return {
    packageCommands: { exportPackage: unused, validatePackage: unused },
    restCommands: { run: unused },
    evaluationCommands: { run: unused },
    reportCommands: { run: unused },
    analysisCommands: { run: unused },
    pipelineCommands: { run: unused },
    resultCommands: { importReport: unused, importAnalysis: unused },
    dataCommands,
    output: sink
  };
}

describe("data export CLI", () => {
  it("注册闭环命令并把 Raw 选择传给服务", async () => {
    const target = output();
    let request: unknown;
    const dataCommands: DataExportCommandService = {
      exportData: (value): Promise<ReceivedCanonicalExport> => {
        request = value;
        return Promise.resolve({ exportId: ID, manifestSha256: HASH, targetPath: "/tmp/export" });
      }
    };
    expect(await runCli(["--help"], dependencies(dataCommands, target.sink))).toBe(0);
    expect(target.stdout.join("")).toMatch(/^\s{2}data\b/m);
    target.stdout.length = 0;

    expect(
      await runCli(
        ["--json", "data", "export", "--output", "/tmp/export", "--include-raw-evidence"],
        dependencies(dataCommands, target.sink)
      )
    ).toBe(0);
    expect(request).toEqual({ rawEvidenceIncluded: true });
    expect(
      CliDataExportEventV1Schema.parse(JSON.parse(target.stdout.join("")) as unknown)
    ).toMatchObject({ type: "DATA_EXPORTED", exportId: ID, targetPath: "/tmp/export" });
  });

  it("默认不内嵌 Raw，并使用外部化中文成功文案", async () => {
    const target = output();
    let request: unknown;
    const dataCommands: DataExportCommandService = {
      exportData: (value): Promise<ReceivedCanonicalExport> => {
        request = value;
        return Promise.resolve({ exportId: ID, manifestSha256: HASH, targetPath: "/tmp/export" });
      }
    };
    expect(
      await runCli(
        ["data", "export", "--output", "/tmp/export"],
        dependencies(dataCommands, target.sink)
      )
    ).toBe(0);
    expect(request).toEqual({ rawEvidenceIncluded: false });
    expect(target.stdout.join("")).toContain("数据导出已完成");
  });

  it("把服务端 Raw 授权漂移收敛为公开 Provider 错误", async () => {
    const target = output();
    const dataCommands: DataExportCommandService = {
      exportData: (): Promise<ReceivedCanonicalExport> =>
        Promise.reject(new Error("CANONICAL_EXPORT_EVENT_INVALID"))
    };

    expect(
      await runCli(
        ["--json", "data", "export", "--output", "/tmp/export"],
        dependencies(dataCommands, target.sink)
      )
    ).toBe(3);
    expect(
      CliDataExportEventV1Schema.parse(JSON.parse(target.stdout.join("")) as unknown)
    ).toMatchObject({ type: "COMMAND_ERROR", code: "PROVIDER_REQUEST_FAILED", exitCode: 3 });
  });
});
