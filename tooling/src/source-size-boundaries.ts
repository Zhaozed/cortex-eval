import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const SOURCE_LINE_LIMIT = 1000;
const SCAN_ROOTS = ["apps", "packages", "tooling"] as const;
const EXCLUDED_DIRECTORIES = new Set(["node_modules", "dist", "coverage"]);

/** One TypeScript source file that exceeds the repository maintainability boundary. */
export interface SourceSizeViolation {
  /** Source path relative to the repository root. */
  readonly file: string;
  /** Physical source lines, excluding a trailing empty line. */
  readonly lines: number;
  /** Stable repository maximum. */
  readonly limit: 1000;
  /** Stable architecture failure code. */
  readonly code: "ARCH_SOURCE_FILE_TOO_LARGE";
}

// Recursively collect current TypeScript production and test files without generated trees.
async function collectTypeScriptFiles(directory: string): Promise<readonly string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRECTORIES.has(entry.name)) {
        files.push(...(await collectTypeScriptFiles(path)));
      }
      continue;
    }
    if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      files.push(path);
    }
  }
  return files;
}

// Count physical lines without treating one conventional trailing newline as a blank source line.
function countSourceLines(content: string): number {
  if (content.length === 0) return 0;
  const lineBreaks = content.match(/\r\n|\r|\n/g)?.length ?? 0;
  return lineBreaks + (/\r\n$|\r$|\n$/.test(content) ? 0 : 1);
}

/** Collect every current TypeScript production or test file above 1000 physical lines. */
export async function collectSourceSizeViolations(
  root: string
): Promise<readonly SourceSizeViolation[]> {
  const files = (
    await Promise.all(
      SCAN_ROOTS.map((directory) => collectTypeScriptFiles(resolve(root, directory)))
    )
  ).flat();
  const violations: SourceSizeViolation[] = [];
  for (const file of files) {
    const lines = countSourceLines(await readFile(file, "utf8"));
    if (lines <= SOURCE_LINE_LIMIT) continue;
    violations.push({
      file: relative(root, file),
      lines,
      limit: SOURCE_LINE_LIMIT,
      code: "ARCH_SOURCE_FILE_TOO_LARGE"
    });
  }
  return violations.sort((left, right) => left.file.localeCompare(right.file));
}
