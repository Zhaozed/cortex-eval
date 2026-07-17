import { createHash } from "node:crypto";

import { UuidV7Schema } from "@cortex-eval/contracts/src/contracts-primitives.ts";
import {
  ExecutionV2Schema,
  type ExecutionV2,
  type WorkPackageManifestV2
} from "@cortex-eval/contracts/src/work-package-contracts.ts";
import { WORK_PACKAGE_RUNTIME_LIMITS } from "@cortex-eval/contracts/src/work-package-runtime-contracts.ts";

import {
  SecureWorkPackageDirectory,
  type SecureDirectoryEntry,
  type WorkPackageLock,
  type WorkPackageLockOwner
} from "./secure-work-package-directory.ts";

/** Artifact integrity policy for one explicitly scoped package operation. */
export interface WorkPackageValidationOptions {
  /** Allow Reporting to ignore unavailable Raw bytes while still validating their descriptor. */
  readonly allowRawEvidenceUnavailable?: boolean | undefined;
}
import { validateFileIntegrity } from "./work-package-file-integrity.ts";
import { validateWorkPackageManifestPolicy } from "./work-package-manifest-policy.ts";

const ARTIFACT_FILE_NAMES = new Set([
  "rest-results.jsonl",
  "promptfoo-raw.json",
  "normalized-eval.jsonl",
  "report.json",
  "report.md",
  "analysis-results.json"
]);

/** Validated immutable Execution state discovered in one package. */
export interface ValidatedWorkPackageExecution {
  /** Frozen Execution identity. */
  readonly executionId: string;
  /** Fully cleaned Execution state. */
  readonly execution: ExecutionV2;
  /** Hash of the exact mutable state bytes read under the package lock. */
  readonly executionSha256: string;
}

/** Complete package validation result used by CLI stage commands. */
export interface ValidatedWorkPackage {
  /** Fully cleaned immutable Manifest. */
  readonly manifest: WorkPackageManifestV2;
  /** Hash of the exact Manifest file bytes. */
  readonly manifestSha256: string;
  /** Exact Manifest file byte count used by export framing. */
  readonly manifestSizeBytes: number;
  /** Validated dynamic Executions in stable identity order. */
  readonly executions: readonly ValidatedWorkPackageExecution[];
}

// Parse external JSON without exposing parser or schema diagnostics.
function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error("WORK_PACKAGE_INVALID");
  }
}

// Collect every directory prefix required by one materialized file path.
function requiredDirectories(paths: readonly string[]): Set<string> {
  const directories = new Set<string>();
  for (const path of paths) {
    const components = path.split("/");
    components.pop();
    let current = "";
    for (const component of components) {
      current = current.length === 0 ? component : `${current}/${component}`;
      directories.add(current);
    }
  }
  return directories;
}

// Reject any path shape before opening a dynamic Execution file.
function executionIds(entries: readonly SecureDirectoryEntry[]): readonly string[] {
  const identities = new Set<string>();
  for (const entry of entries) {
    if (!entry.path.startsWith("executions/")) continue;
    const components = entry.path.split("/");
    const identity = components[1];
    if (identity === undefined || !UuidV7Schema.safeParse(identity).success) {
      throw new Error("WORK_PACKAGE_UNKNOWN_FILE");
    }
    if (components.length === 2) {
      if (entry.kind !== "DIRECTORY") throw new Error("WORK_PACKAGE_PATH_INVALID");
      identities.add(identity);
      continue;
    }
    if (components.length !== 3 || entry.kind !== "FILE") {
      throw new Error("WORK_PACKAGE_UNKNOWN_FILE");
    }
    const fileName = components[2];
    if (fileName !== "execution.json" && !ARTIFACT_FILE_NAMES.has(fileName ?? "")) {
      throw new Error("WORK_PACKAGE_UNKNOWN_FILE");
    }
  }
  return [...identities].sort((left, right) => left.localeCompare(right));
}

// Verify one dynamic Execution and every artifact registered in its state.
async function validateExecution(
  directory: SecureWorkPackageDirectory,
  manifest: WorkPackageManifestV2,
  entries: readonly SecureDirectoryEntry[],
  executionId: string,
  options: WorkPackageValidationOptions
): Promise<ValidatedWorkPackageExecution> {
  const statePath = `executions/${executionId}/execution.json`;
  const stateBytes = await directory.readFileBounded(
    statePath,
    WORK_PACKAGE_RUNTIME_LIMITS.executionBytes
  );
  let execution: ExecutionV2;
  try {
    execution = ExecutionV2Schema.parse(parseJson(stateBytes));
  } catch {
    throw new Error("WORK_PACKAGE_INVALID");
  }
  if (execution.packageId !== manifest.packageId || execution.executionId !== executionId) {
    throw new Error("WORK_PACKAGE_INVALID");
  }
  const registered = new Map(
    Object.values(execution.stages)
      .flatMap((stage) => stage.artifacts)
      .map((artifact) => [artifact.path, artifact] as const)
  );
  const prefix = `executions/${executionId}/`;
  const actualArtifacts = entries
    .filter(
      (entry) =>
        entry.kind === "FILE" &&
        entry.path.startsWith(prefix) &&
        entry.path !== statePath &&
        ARTIFACT_FILE_NAMES.has(entry.path.slice(prefix.length))
    )
    .map((entry) => entry.path);
  if (actualArtifacts.some((path) => !registered.has(path))) {
    throw new Error("WORK_PACKAGE_ARTIFACT_ORPHAN");
  }
  for (const artifact of registered.values()) {
    if (
      options.allowRawEvidenceUnavailable === true &&
      artifact.kind === "RAW_PROMPTFOO_EVIDENCE"
    ) {
      continue;
    }
    await validateFileIntegrity(directory, artifact);
  }
  return {
    executionId,
    execution,
    executionSha256: createHash("sha256").update(stateBytes).digest("hex")
  };
}

// Require owner-only directories and reject every symlink before content validation.
function validateTreeShape(
  entries: readonly SecureDirectoryEntry[],
  manifest: WorkPackageManifestV2
): readonly string[] {
  if (entries.some((entry) => entry.kind === "SYMLINK" || entry.kind === "OTHER")) {
    throw new Error("WORK_PACKAGE_PATH_INVALID");
  }
  if (entries.some((entry) => entry.kind === "DIRECTORY" && entry.mode !== 0o700)) {
    throw new Error("WORK_PACKAGE_PATH_INVALID");
  }
  const inputPaths = [
    manifest.inputs.tests.path,
    manifest.inputs.endpoint.path,
    manifest.inputs.evaluator.path,
    manifest.inputs.analyzer.path,
    manifest.inputs.analysisPrompt.path,
    manifest.inputs.envExample.path,
    ...manifest.inputs.rubricPrompts.map((prompt) => prompt.path)
  ];
  const allowedFiles = new Set(["manifest.json", ".cortex-work-package.lock", ...inputPaths]);
  const allowedDirectories = requiredDirectories(inputPaths);
  const hasExecutionEntries = entries.some(
    (entry) => entry.path === "executions" || entry.path.startsWith("executions/")
  );
  if (hasExecutionEntries) allowedDirectories.add("executions");
  for (const entry of entries) {
    if (entry.path === "executions" || entry.path.startsWith("executions/")) continue;
    const allowed =
      (entry.kind === "FILE" && allowedFiles.has(entry.path)) ||
      (entry.kind === "DIRECTORY" && allowedDirectories.has(entry.path));
    if (!allowed) throw new Error("WORK_PACKAGE_UNKNOWN_FILE");
  }
  return executionIds(entries);
}

/** Validate one already opened package while its caller owns the stable lock. */
export async function validateLockedWorkPackageDirectory(
  directory: SecureWorkPackageDirectory,
  options: WorkPackageValidationOptions = {}
): Promise<ValidatedWorkPackage> {
  const manifestBytes = await directory.readFileBounded(
    "manifest.json",
    WORK_PACKAGE_RUNTIME_LIMITS.manifestBytes
  );
  let manifest: WorkPackageManifestV2;
  try {
    manifest = validateWorkPackageManifestPolicy(parseJson(manifestBytes));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("WORK_PACKAGE_")) throw error;
    throw new Error("WORK_PACKAGE_INVALID", { cause: error });
  }
  await validateFileIntegrity(
    directory,
    manifest.inputs.tests,
    WORK_PACKAGE_RUNTIME_LIMITS.canonicalTestsBytes
  );
  for (const input of [
    manifest.inputs.endpoint,
    manifest.inputs.evaluator,
    manifest.inputs.analyzer,
    manifest.inputs.analysisPrompt,
    manifest.inputs.envExample,
    ...manifest.inputs.rubricPrompts
  ]) {
    await validateFileIntegrity(directory, input, WORK_PACKAGE_RUNTIME_LIMITS.configurationBytes);
  }
  const entries = directory.listTree();
  const identities = validateTreeShape(entries, manifest);
  const executions: ValidatedWorkPackageExecution[] = [];
  for (const executionId of identities) {
    executions.push(await validateExecution(directory, manifest, entries, executionId, options));
  }
  return {
    manifest,
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    manifestSizeBytes: manifestBytes.byteLength,
    executions
  };
}

/** Acquire the stable lock and validate one already opened package. */
export async function validateWorkPackageDirectory(
  directory: SecureWorkPackageDirectory,
  owner: WorkPackageLockOwner
): Promise<ValidatedWorkPackage> {
  let lock: WorkPackageLock | undefined;
  try {
    lock = await directory.acquireLock(owner);
    return await validateLockedWorkPackageDirectory(directory);
  } finally {
    await lock?.release();
  }
}

/** Open and validate one complete package without leaking its root descriptor. */
export async function validateWorkPackage(
  rootPath: string,
  owner: WorkPackageLockOwner
): Promise<ValidatedWorkPackage> {
  const directory = await SecureWorkPackageDirectory.open(rootPath);
  try {
    return await validateWorkPackageDirectory(directory, owner);
  } finally {
    directory.close();
  }
}
