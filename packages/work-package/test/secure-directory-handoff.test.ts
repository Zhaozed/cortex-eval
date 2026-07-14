import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openVerifiedDirectory } from "../src/secure-directory-handoff.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("secure directory handoff", () => {
  it("rejects files, symbolic links and an unexpected owner mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "cortex-directory-handoff-"));
    roots.push(root);
    const file = join(root, "file");
    const directory = join(root, "directory");
    const link = join(root, "link");
    await writeFile(file, "fixture", { mode: 0o600 });
    await mkdir(directory, { mode: 0o700 });
    await symlink(directory, link);

    await expect(openVerifiedDirectory(file, null)).rejects.toThrow("WORK_PACKAGE_PATH_INVALID");
    await expect(openVerifiedDirectory(link, null)).rejects.toThrow("WORK_PACKAGE_PATH_INVALID");
    await chmod(directory, 0o755);
    await expect(openVerifiedDirectory(directory, 0o700)).rejects.toThrow(
      "WORK_PACKAGE_PATH_INVALID"
    );
  });
});
