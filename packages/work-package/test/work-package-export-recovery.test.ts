import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupStaleWorkPackageExports,
  type WorkPackageProcessLiveness
} from "../src/work-package-export-recovery.ts";

const OLD = new Date("2026-07-12T00:00:00.000Z");
const FRESH = new Date("2026-07-14T11:59:59.000Z");
const NOW = new Date("2026-07-14T12:00:00.000Z");
const TTL_MS = 24 * 60 * 60 * 1_000;
const roots: string[] = [];

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function staging(
  parent: string,
  nonce: string,
  value: unknown,
  modifiedAt: Date
): Promise<string> {
  const path = join(parent, `.cortex-export-${nonce}`);
  await mkdir(path, { mode: 0o700 });
  if (value !== null) {
    await writeFile(join(path, ".cortex-export-owner.json"), `${JSON.stringify(value)}\n`, {
      mode: 0o600
    });
  }
  await utimes(path, modifiedAt, modifiedAt);
  return path;
}

function owner(nonce: string, pid: number, processStartedAt: string): object {
  return {
    nonce,
    pid,
    processStartedAt,
    createdAt: "2026-07-12T00:00:00.000Z",
    targetName: "package"
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Work Package export crash recovery", () => {
  it("keeps live and fresh staging but removes old dead and PID-reused owners", async () => {
    const parent = await temporaryRoot("cortex-export-recovery-");
    await staging(parent, "active001", owner("active001", 10, "active-start"), OLD);
    await staging(parent, "dead0001", owner("dead0001", 11, "dead-start"), OLD);
    await staging(parent, "reused01", owner("reused01", 12, "old-start"), OLD);
    await staging(parent, "fresh001", owner("fresh001", 13, "dead-start"), FRESH);
    const liveness: WorkPackageProcessLiveness = {
      processStartedAt: (pid) =>
        Promise.resolve(pid === 10 ? "active-start" : pid === 12 ? "new-start" : null)
    };

    await cleanupStaleWorkPackageExports(parent, {
      processLiveness: liveness,
      now: (): number => NOW.getTime(),
      ttlMs: TTL_MS
    });

    expect((await readdir(parent)).sort()).toEqual([
      ".cortex-export-active001",
      ".cortex-export-fresh001"
    ]);
  });

  it("removes an old ownerless post-validation staging but keeps a fresh initializer", async () => {
    const parent = await temporaryRoot("cortex-export-recovery-");
    await staging(parent, "oldempty", null, OLD);
    await staging(parent, "newempty", null, FRESH);

    await cleanupStaleWorkPackageExports(parent, {
      processLiveness: { processStartedAt: (): Promise<null> => Promise.resolve(null) },
      now: (): number => NOW.getTime(),
      ttlMs: TTL_MS
    });

    expect(await readdir(parent)).toEqual([".cortex-export-newempty"]);
  });

  it("never follows a staging symlink or removes a malformed owner", async () => {
    const parent = await temporaryRoot("cortex-export-recovery-");
    const outside = await temporaryRoot("cortex-export-outside-");
    await writeFile(join(outside, "sentinel"), "keep");
    await symlink(outside, join(parent, ".cortex-export-link0001"));
    await staging(parent, "forged01", { ...owner("forged01", 20, "start"), extra: true }, OLD);
    const events: string[] = [];

    await cleanupStaleWorkPackageExports(parent, {
      processLiveness: { processStartedAt: (): Promise<null> => Promise.resolve(null) },
      now: (): number => NOW.getTime(),
      ttlMs: 0,
      onSecurityEvent: (event): void => {
        events.push(event);
      }
    });

    expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("keep");
    expect((await lstat(join(parent, ".cortex-export-link0001"))).isSymbolicLink()).toBe(true);
    expect((await lstat(join(parent, ".cortex-export-forged01"))).isDirectory()).toBe(true);
    expect(events).toEqual(["TEMP_OWNER_INVALID", "TEMP_SYMLINK_QUARANTINED"]);
  });

  it("skips cleanup when owner identity changes during liveness inspection", async () => {
    const parent = await temporaryRoot("cortex-export-recovery-");
    const path = await staging(parent, "ownerace", owner("ownerace", 30, "old-start"), OLD);

    await cleanupStaleWorkPackageExports(parent, {
      processLiveness: {
        processStartedAt: async (): Promise<null> => {
          await writeFile(
            join(path, ".cortex-export-owner.json"),
            `${JSON.stringify(owner("ownerace", 31, "new-start"))}\n`,
            { mode: 0o600 }
          );
          return null;
        }
      },
      now: (): number => NOW.getTime(),
      ttlMs: TTL_MS
    });

    expect((await lstat(path)).isDirectory()).toBe(true);
  });
});
