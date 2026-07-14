import { describe, expect, it } from "vitest";

import { validateMaterializedFilePaths } from "../src/work-package-path-policy.ts";

describe("Work Package materialized path policy", () => {
  it("returns a stable set of safe distinct file paths", () => {
    expect(
      validateMaterializedFilePaths([
        "manifest.json",
        "inputs/tests.json",
        "prompts/rubric/quality.json"
      ])
    ).toEqual(["manifest.json", "inputs/tests.json", "prompts/rubric/quality.json"]);
  });

  it.each([
    ["inputs/tests.json", "INPUTS/tests.json"],
    ["a", "a/b"],
    ["a/b", "a"],
    ["manifest.json", "manifest.json"]
  ])("rejects physical or file-prefix collision %j", (...paths) => {
    expect(() => validateMaterializedFilePaths(paths)).toThrow("WORK_PACKAGE_PATH_COLLISION");
  });

  it.each(["inputs/测试.json", "inputs/\u0000.json", "../manifest.json"])(
    "rejects a path outside the runtime profile %j",
    (path) => {
      expect(() => validateMaterializedFilePaths([path])).toThrow("WORK_PACKAGE_PATH_INVALID");
    }
  );
});
