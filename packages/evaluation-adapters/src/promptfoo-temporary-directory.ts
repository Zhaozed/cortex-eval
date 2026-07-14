import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

const DIRECTORY_MODE = 0o700;
const INVALID_PATH = "PROMPTFOO_TEMPORARY_PATH_INVALID";

// Return only a filesystem error code from an unknown boundary failure.
function filesystemCode(error: unknown): unknown {
  return error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
}

// Require one canonical child to remain strictly below its canonical parent.
function isContained(parent: string, child: string): boolean {
  const childPath = relative(parent, child);
  return (
    childPath !== "" &&
    childPath !== ".." &&
    !childPath.startsWith(`..${sep}`) &&
    !isAbsolute(childPath)
  );
}

// Read one path component without following a symbolic link.
async function pathFacts(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (filesystemCode(error) === "ENOENT") return null;
    throw error;
  }
}

// Validate one existing directory without following a symbolic-link boundary.
async function canonicalRealDirectory(path: string, facts: Stats): Promise<string> {
  if (!facts.isDirectory() || facts.isSymbolicLink()) throw new Error(INVALID_PATH);
  return realpath(path);
}

// Create missing components only after the complete existing prefix has passed containment checks.
async function ensureContainedParent(
  containmentRoot: string,
  temporaryParent: string
): Promise<string> {
  if (!isAbsolute(containmentRoot) || !isAbsolute(temporaryParent)) {
    throw new Error(INVALID_PATH);
  }
  const lexicalChild = relative(containmentRoot, temporaryParent);
  if (
    lexicalChild === "" ||
    lexicalChild === ".." ||
    lexicalChild.startsWith(`..${sep}`) ||
    isAbsolute(lexicalChild)
  ) {
    throw new Error(INVALID_PATH);
  }

  const rootFacts = await pathFacts(containmentRoot);
  if (rootFacts === null) throw new Error(INVALID_PATH);
  let canonicalParent = await canonicalRealDirectory(containmentRoot, rootFacts);
  let lexicalParent = containmentRoot;
  let creating = false;
  for (const segment of lexicalChild.split(sep)) {
    lexicalParent = join(lexicalParent, segment);
    let facts = creating ? null : await pathFacts(lexicalParent);
    if (facts === null) {
      creating = true;
      await mkdir(lexicalParent, { mode: DIRECTORY_MODE }).catch((error: unknown): void => {
        if (filesystemCode(error) !== "EEXIST") throw error;
      });
      facts = await pathFacts(lexicalParent);
    }
    if (facts === null) throw new Error(INVALID_PATH);
    const canonicalChild = await canonicalRealDirectory(lexicalParent, facts);
    if (!isContained(canonicalParent, canonicalChild)) throw new Error(INVALID_PATH);
    canonicalParent = canonicalChild;
  }
  await chmod(canonicalParent, DIRECTORY_MODE);
  return canonicalParent;
}

/** Create one owner-only disposable Promptfoo directory below an explicit controlled root. */
export async function createPromptfooTemporaryDirectory(
  containmentRoot: string,
  temporaryParent: string
): Promise<string> {
  try {
    const canonicalTemporaryParent = await ensureContainedParent(containmentRoot, temporaryParent);
    const directory = await mkdtemp(join(canonicalTemporaryParent, "evaluation-"));
    const directoryFacts = await pathFacts(directory);
    if (directoryFacts === null) throw new Error(INVALID_PATH);
    const canonicalDirectory = await canonicalRealDirectory(directory, directoryFacts);
    if (!isContained(canonicalTemporaryParent, canonicalDirectory)) {
      await rm(directory, { force: true, recursive: true }).catch(() => undefined);
      throw new Error(INVALID_PATH);
    }
    await chmod(canonicalDirectory, DIRECTORY_MODE);
    return canonicalDirectory;
  } catch (error) {
    if (error instanceof Error && error.message === INVALID_PATH) throw error;
    throw new Error(INVALID_PATH, { cause: error });
  }
}
