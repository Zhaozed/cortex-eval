import { readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

/** Stable target package names used by architecture checks. */
export type ArchitecturePackage =
  | "domain"
  | "reporting"
  | "application"
  | "contracts"
  | "storage-sqlite"
  | "evaluation-adapters"
  | "work-package"
  | "local-server"
  | "cli"
  | "web";

/** Import boundary violation. */
export interface ArchitectureViolation {
  /** Source file relative to the repository. */
  file: string;
  /** Imported package name. */
  target: ArchitecturePackage | "unknown";
  /** Stable boundary error. */
  code: string;
}

const ALLOWED_DEPENDENCIES: Readonly<Record<ArchitecturePackage, readonly ArchitecturePackage[]>> =
  {
    domain: [],
    reporting: ["domain"],
    application: ["domain", "reporting", "application"],
    contracts: [],
    "storage-sqlite": ["application", "domain"],
    "evaluation-adapters": ["application", "contracts"],
    "work-package": ["application", "contracts", "reporting", "domain"],
    "local-server": [
      "application",
      "contracts",
      "storage-sqlite",
      "evaluation-adapters",
      "work-package",
      "reporting",
      "domain"
    ],
    cli: ["application", "contracts", "evaluation-adapters", "work-package", "reporting", "domain"],
    web: ["contracts"]
  };

// Return a stable violation code or null for one package dependency.
export function validatePackageDependency(
  source: ArchitecturePackage,
  target: ArchitecturePackage
): string | null {
  if (source === target || ALLOWED_DEPENDENCIES[source].includes(target)) {
    return null;
  }
  if (source === "domain") {
    return "ARCH_DOMAIN_OUTER_IMPORT";
  }
  return `ARCH_${source.toUpperCase().replaceAll("-", "_")}_IMPORT`;
}

// Recursively collect TypeScript production files below one source directory.
async function collectTypeScriptFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    return entries
      .filter(
        (entry) =>
          entry.isFile() &&
          (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
          !entry.name.endsWith(".test.ts") &&
          !entry.parentPath.includes("test-support")
      )
      .map((entry) => resolve(entry.parentPath, entry.name));
  } catch {
    return [];
  }
}

// Extract static, re-export, dynamic and CommonJS literal module specifiers.
function collectModuleSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) {
        specifiers.push(specifier);
      }
    }
  }
  return specifiers;
}

// Resolve an internal package target from an alias or repository-relative import.
function resolveArchitectureTarget(
  root: string,
  sourceFile: string,
  specifier: string
): ArchitecturePackage | null {
  const alias = /^@cortex-eval\/([^/]+)(?:\/.*)?$/.exec(specifier)?.[1];
  if (alias && alias in ALLOWED_DEPENDENCIES) {
    return alias as ArchitecturePackage;
  }
  if (!specifier.startsWith(".")) {
    return null;
  }
  const resolvedSpecifier = resolve(dirname(sourceFile), specifier);
  const relativeSpecifier = relative(root, resolvedSpecifier);
  if (relativeSpecifier.startsWith(`..${sep}`) || relativeSpecifier === "..") {
    return null;
  }
  const parts = relativeSpecifier.split(sep);
  if ((parts[0] !== "packages" && parts[0] !== "apps") || parts[1] === undefined) {
    return null;
  }
  const target = parts[1];
  return target in ALLOWED_DEPENDENCIES ? (target as ArchitecturePackage) : null;
}

// Discover package imports and enforce the single allowed dependency graph.
export async function collectArchitectureViolations(
  root: string
): Promise<ArchitectureViolation[]> {
  const packageLocations: readonly [ArchitecturePackage, string][] = [
    ["domain", "packages/domain/src"],
    ["reporting", "packages/reporting/src"],
    ["application", "packages/application/src"],
    ["contracts", "packages/contracts/src"],
    ["storage-sqlite", "packages/storage-sqlite/src"],
    ["evaluation-adapters", "packages/evaluation-adapters/src"],
    ["work-package", "packages/work-package/src"],
    ["local-server", "apps/local-server/src"],
    ["cli", "apps/cli/src"],
    ["web", "apps/web/src"]
  ];
  const violations: ArchitectureViolation[] = [];
  for (const [source, location] of packageLocations) {
    const files = await collectTypeScriptFiles(resolve(root, location));
    for (const file of files) {
      const content = await readFile(file, "utf8");
      if (/\bimport\s*\(\s*(?!["'])/.test(content)) {
        violations.push({
          file: relative(root, file),
          target: "unknown",
          code: "ARCH_DYNAMIC_IMPORT_EXPRESSION"
        });
      }
      for (const specifier of collectModuleSpecifiers(content)) {
        const target = resolveArchitectureTarget(root, file, specifier);
        if (target === null) {
          continue;
        }
        const code = validatePackageDependency(source, target);
        if (code) {
          violations.push({ file: relative(root, file), target, code });
        }
      }
    }
  }
  return violations.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.target.localeCompare(right.target) ||
      left.code.localeCompare(right.code)
  );
}
