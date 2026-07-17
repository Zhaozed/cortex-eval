import { chmod, cp, lstat, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const GOLDEN_SOURCE = fileURLToPath(new URL("../test-fixtures/work-package-v2/", import.meta.url));

// Apply the runtime owner-only profile after copying Git-owned fixture bytes.
async function hardenFixtureTree(path: string): Promise<void> {
  const facts = await lstat(path);
  if (!facts.isDirectory() || facts.isSymbolicLink()) throw new Error("GOLDEN_FIXTURE_INVALID");
  await chmod(path, 0o700);
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) throw new Error("GOLDEN_FIXTURE_INVALID");
    if (entry.isDirectory()) {
      await hardenFixtureTree(child);
      continue;
    }
    if (!entry.isFile()) throw new Error("GOLDEN_FIXTURE_INVALID");
    await chmod(child, 0o600);
  }
}

/** Copy the frozen v2 Golden Package into one disposable owner-only runtime directory. */
export async function materializeGoldenWorkPackage(targetPath: string): Promise<void> {
  await cp(GOLDEN_SOURCE, targetPath, { recursive: true, errorOnExist: true, force: false });
  await hardenFixtureTree(targetPath);
}
