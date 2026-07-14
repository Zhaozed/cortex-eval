import { lstat, open } from "node:fs/promises";

import { WORK_PACKAGE_RUNTIME_LIMITS } from "@cortex-eval/contracts/src/work-package-runtime-contracts.ts";
import { parse } from "dotenv";

/** Explicit construction input for one command-scoped Secret reader. */
export interface LoadCliSecretEnvironmentInput {
  /** Optional user-specified Secret file outside the Work Package. */
  readonly envFile?: string | undefined;
  /** Inherited process environment snapshot. */
  readonly inherited: Readonly<Record<string, string | undefined>>;
}

// Read one owner-only regular file without accepting a symlink or a size race.
async function readSecretFile(path: string): Promise<Buffer> {
  if (path.length === 0) throw new Error("VALIDATION_FAILED");
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(path);
  } catch (error) {
    throw new Error("VALIDATION_FAILED", { cause: error });
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    (before.mode & 0o077) !== 0 ||
    before.size > WORK_PACKAGE_RUNTIME_LIMITS.configurationBytes
  ) {
    throw new Error("VALIDATION_FAILED");
  }
  const file = await open(path, "r");
  try {
    const opened = await file.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    ) {
      throw new Error("VALIDATION_FAILED");
    }
    const bytes = await file.readFile();
    const after = await file.stat();
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      bytes.byteLength !== opened.size
    ) {
      throw new Error("VALIDATION_FAILED");
    }
    return bytes;
  } catch (error) {
    if (error instanceof Error && error.message === "VALIDATION_FAILED") throw error;
    throw new Error("VALIDATION_FAILED", { cause: error });
  } finally {
    await file.close();
  }
}

/** Command-scoped Secret source that never mutates process.env. */
export class CliSecretEnvironment {
  /** Parsed explicit file values. */
  readonly #explicit: Readonly<Record<string, string>>;
  /** Inherited process values. */
  readonly #inherited: Readonly<Record<string, string | undefined>>;

  /** Construct only from already cleaned key/value sources. */
  private constructor(
    explicit: Readonly<Record<string, string>>,
    inherited: Readonly<Record<string, string | undefined>>
  ) {
    this.#explicit = explicit;
    this.#inherited = inherited;
  }

  /** Load an optional bounded owner-only Env file without global side effects. */
  public static async load(input: LoadCliSecretEnvironmentInput): Promise<CliSecretEnvironment> {
    const explicit = input.envFile === undefined ? {} : parse(await readSecretFile(input.envFile));
    return new CliSecretEnvironment(explicit, { ...input.inherited });
  }

  /** Resolve one Secret with the explicitly selected file taking precedence. */
  public readSecret(key: string): string | undefined {
    const value = this.#explicit[key] ?? this.#inherited[key];
    return value === undefined || value.length === 0 ? undefined : value;
  }

  /** Fail before stage state mutation when any current-stage key is unavailable. */
  public require(keys: readonly string[]): void {
    if (keys.some((key) => this.readSecret(key) === undefined)) {
      throw new Error("VALIDATION_FAILED");
    }
  }
}
