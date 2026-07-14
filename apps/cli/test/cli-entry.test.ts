import { afterEach, describe, expect, it, vi } from "vitest";

const originalArgv = process.argv;
const originalExitCode = process.exitCode;

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

describe("P7 CLI production entry", () => {
  it("composes the real command graph and accepts the package-manager separator", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((value: string | Uint8Array): boolean => {
      stdout.push(value.toString());
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((value: string | Uint8Array): boolean => {
      stderr.push(value.toString());
      return true;
    });
    process.argv = [process.execPath, "cortex-eval", "--", "--help"];

    await import("../src/cli-entry.ts");

    expect(process.exitCode).toBe(0);
    expect(stdout.join("")).toContain("pipeline");
    expect(stderr).toEqual([]);
  });
});
