import { WorkPackageRuntimePathSchema } from "@cortex-eval/contracts/src/work-package-runtime-contracts.ts";

// Normalize a physical lookup key even though the current runtime profile is ASCII-only.
function physicalPathKey(path: string): string {
  return path.normalize("NFD").toLocaleLowerCase("en-US");
}

/** Validate exact materialized file paths and reject physical or prefix collisions. */
export function validateMaterializedFilePaths(paths: readonly string[]): readonly string[] {
  const parsed = paths.map((path) => {
    const result = WorkPackageRuntimePathSchema.safeParse(path);
    if (!result.success) throw new Error("WORK_PACKAGE_PATH_INVALID");
    return result.data;
  });
  const keys = parsed.map(physicalPathKey).sort((left, right) => left.localeCompare(right));
  for (let index = 0; index < keys.length; index += 1) {
    const current = keys[index];
    const next = keys[index + 1];
    if (current === undefined || next === undefined) continue;
    if (next === current || next.startsWith(`${current}/`)) {
      throw new Error("WORK_PACKAGE_PATH_COLLISION");
    }
  }
  return parsed;
}
