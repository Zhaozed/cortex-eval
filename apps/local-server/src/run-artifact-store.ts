import { createHash, randomUUID, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rmdir,
  stat,
  unlink
} from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import type {
  PlatformRestArtifactInput,
  PlatformRestArtifactWriteResult,
  RunArtifactAvailability,
  RunArtifactStore
} from "@cortex-eval/application/src/features/runs/run-artifact-port.ts";
import type {
  RunArtifactDescriptor,
  RunArtifactManifest,
  StoredRestCaseResult
} from "@cortex-eval/application/src/features/runs/platform-run-models.ts";
import { RestArtifactCaseV1Schema } from "@cortex-eval/contracts/src/artifact-contracts.ts";
import {
  canonicalJson,
  type DomainJsonObject
} from "@cortex-eval/domain/src/domain-canonical-hash.ts";
import { OrderedRestResultSetHasher } from "@cortex-eval/domain/src/domain-hash-inputs.ts";

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REST_ARTIFACT_PATH = /^runs\/([0-9a-f-]+)\/rest-results\.json$/;
const TEMP_ARTIFACT = /^\.rest-results\.[A-Za-z0-9-]+\.tmp$/;

/** Local Run Artifact Store construction options. */
export interface LocalRunArtifactStoreOptions {
  /** Absolute project root owning `.cortex-eval`. */
  readonly projectRoot: string;
  /** Injectable collision-resistant temporary identity. */
  readonly nonce?: (() => string) | undefined;
}

/** Stable owner-safe Artifact file failure. */
export class RunArtifactStoreError extends Error {
  /** Stable public failure code. */
  readonly code = "ARTIFACT_WRITE_FAILED" as const;

  /** Create one path-safe Artifact failure. */
  public constructor() {
    super("ARTIFACT_WRITE_FAILED");
    this.name = "RunArtifactStoreError";
  }
}

// Return only a filesystem error code from an unknown exception.
function filesystemCode(error: unknown): unknown {
  return error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
}

// Confirm one canonical child remains strictly below its canonical root.
function isContained(root: string, child: string): boolean {
  const childPath = relative(root, child);
  return (
    childPath !== "" &&
    !childPath.startsWith(`..${sep}`) &&
    childPath !== ".." &&
    !isAbsolute(childPath)
  );
}

// Create or validate one owner-only real directory without following a symlink.
async function ensureDirectory(canonicalParent: string, path: string): Promise<string> {
  const before = await lstat(path).catch(() => null);
  if (before === null) {
    await mkdir(path, { mode: 0o700 }).catch((error: unknown): void => {
      if (filesystemCode(error) !== "EEXIST") throw error;
    });
  }
  const facts = await lstat(path).catch(() => null);
  const canonical = await realpath(path).catch(() => null);
  if (
    facts === null ||
    !facts.isDirectory() ||
    facts.isSymbolicLink() ||
    canonical === null ||
    !isContained(canonicalParent, canonical)
  ) {
    throw new RunArtifactStoreError();
  }
  await chmod(canonical, 0o700);
  return canonical;
}

// Map one clean Provider Output to the public Artifact contract.
function providerOutput(
  value: Extract<StoredRestCaseResult, { status: "SUCCEEDED" }>["providerOutput"]
): DomainJsonObject {
  if (!value.ok) return { ok: false, err_msg: value.errorMessage };
  return {
    ok: true,
    task_name: value.taskName,
    resolved_config: value.resolvedConfig,
    parsed_output: value.parsedOutput
  };
}

// Map one durable result into the immutable Artifact projection.
function artifactCase(value: StoredRestCaseResult): DomainJsonObject {
  const common = {
    caseKey: value.caseKey,
    ordinal: value.ordinal,
    caseDefinitionHash: value.caseDefinitionHash,
    status: value.status,
    httpStatus: value.httpStatus,
    durationMs: value.durationMs,
    completedAt: value.completedAt,
    resultHash: value.resultHash,
    provenance: null
  };
  if (value.status === "SUCCEEDED") {
    return { ...common, providerOutput: providerOutput(value.providerOutput) };
  }
  return {
    ...common,
    providerOutput: null,
    error: { type: value.errorType, message: value.errorMessage }
  };
}

// Require one exact UTC ISO timestamp without accepting date normalization.
function validTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

// Write one complete UTF-8 chunk while updating exact integrity facts.
async function writeChunk(
  handle: Awaited<ReturnType<typeof open>>,
  hash: Hash,
  value: string
): Promise<number> {
  const bytes = Buffer.from(value, "utf8");
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, null);
    if (result.bytesWritten < 1) throw new RunArtifactStoreError();
    offset += result.bytesWritten;
  }
  hash.update(bytes);
  return bytes.byteLength;
}

// Fsync one directory after a no-replace link or deletion.
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Hash one regular file with bounded memory and return its exact size.
async function inspectFile(
  path: string
): Promise<{ readonly sha256: string; readonly sizeBytes: number } | null> {
  const facts = await lstat(path).catch(() => null);
  if (facts === null || !facts.isFile() || facts.isSymbolicLink()) return null;
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of createReadStream(path)) {
    if (!Buffer.isBuffer(chunk)) throw new RunArtifactStoreError();
    sizeBytes += chunk.byteLength;
    hash.update(chunk);
  }
  return { sha256: hash.digest("hex"), sizeBytes };
}

// Resolve only the one closed P5 Artifact path shape.
function artifactRunId(path: string): string | null {
  const match = REST_ARTIFACT_PATH.exec(path);
  const runId = match?.[1];
  return runId !== undefined && RUN_ID.test(runId) ? runId : null;
}

/** Owner-safe local implementation of the Run Artifact Port. */
export class LocalRunArtifactStore implements RunArtifactStore {
  /** Canonical `.cortex-eval/artifacts` root. */
  readonly #artifactRoot: string;
  /** Canonical `artifacts/runs` root. */
  readonly #runsRoot: string;
  /** Temporary name source. */
  readonly #nonce: () => string;

  /** Construct only after every containment directory has been validated. */
  private constructor(artifactRoot: string, runsRoot: string, nonce: () => string) {
    this.#artifactRoot = artifactRoot;
    this.#runsRoot = runsRoot;
    this.#nonce = nonce;
  }

  /** Validate and initialize the complete owner-only Artifact root. */
  public static async create(
    options: LocalRunArtifactStoreOptions
  ): Promise<LocalRunArtifactStore> {
    if (!isAbsolute(options.projectRoot)) throw new RunArtifactStoreError();
    try {
      const projectRoot = await realpath(options.projectRoot);
      if (!(await stat(projectRoot)).isDirectory()) throw new RunArtifactStoreError();
      const stateRoot = await ensureDirectory(projectRoot, join(projectRoot, ".cortex-eval"));
      const artifactRoot = await ensureDirectory(stateRoot, join(stateRoot, "artifacts"));
      const runsRoot = await ensureDirectory(artifactRoot, join(artifactRoot, "runs"));
      return new LocalRunArtifactStore(artifactRoot, runsRoot, options.nonce ?? randomUUID);
    } catch (error) {
      if (error instanceof RunArtifactStoreError) throw error;
      throw new RunArtifactStoreError();
    }
  }

  /** Atomically write one immutable REST Artifact without replacing a prior file. */
  public async writeRestResults(
    input: PlatformRestArtifactInput
  ): Promise<PlatformRestArtifactWriteResult> {
    if (
      !RUN_ID.test(input.runId) ||
      !/^[0-9a-f]{64}$/.test(input.runContextHash) ||
      !validTimestamp(input.completedAt) ||
      !Number.isInteger(input.expectedTotal) ||
      input.expectedTotal < 1
    ) {
      throw new RunArtifactStoreError();
    }
    const relativePath = `runs/${input.runId}/rest-results.json`;
    let tempPath: string | null = null;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      const runRoot = await ensureDirectory(this.#runsRoot, join(this.#runsRoot, input.runId));
      tempPath = join(runRoot, `.rest-results.${this.#nonce()}.tmp`);
      const targetPath = join(runRoot, "rest-results.json");
      handle = await open(tempPath, "wx", 0o600);
      const fileHash = createHash("sha256");
      const resultSetHasher = new OrderedRestResultSetHasher();
      let sizeBytes = await writeChunk(handle, fileHash, '{"cases":[');
      let caseCount = 0;
      for await (const item of input.cases) {
        if (caseCount >= input.expectedTotal || item.runId !== input.runId) {
          throw new RunArtifactStoreError();
        }
        const artifact = artifactCase(item);
        if (!RestArtifactCaseV1Schema.safeParse(artifact).success) {
          throw new RunArtifactStoreError();
        }
        resultSetHasher.add({
          caseKey: item.caseKey,
          ordinal: item.ordinal,
          resultHash: item.resultHash
        });
        if (caseCount > 0) sizeBytes += await writeChunk(handle, fileHash, ",");
        sizeBytes += await writeChunk(handle, fileHash, canonicalJson(artifact));
        caseCount += 1;
      }
      if (caseCount !== input.expectedTotal) throw new RunArtifactStoreError();
      const resultSetHash = resultSetHasher.finish();
      const trailer =
        `],"completedAt":${canonicalJson(input.completedAt)},` +
        `"contractVersion":"cortex.platform-rest-results.v1",` +
        `"resultSetHash":${canonicalJson(resultSetHash)},` +
        `"runContextHash":${canonicalJson(input.runContextHash)},` +
        `"runId":${canonicalJson(input.runId)}}\n`;
      sizeBytes += await writeChunk(handle, fileHash, trailer);
      await handle.sync();
      await handle.close();
      handle = null;
      await chmod(tempPath, 0o600);
      await link(tempPath, targetPath);
      await syncDirectory(runRoot);
      await unlink(tempPath);
      tempPath = null;
      return {
        descriptor: {
          kind: "REST_RESULTS",
          path: relativePath,
          expectedSha256: fileHash.digest("hex"),
          expectedSizeBytes: sizeBytes,
          contractVersion: "cortex.platform-rest-results.v1"
        },
        resultSetHash
      };
    } catch {
      throw new RunArtifactStoreError();
    } finally {
      if (handle !== null) await handle.close().catch(() => undefined);
      if (tempPath !== null) await unlink(tempPath).catch(() => undefined);
    }
  }

  /** Remove only one controlled uncommitted immutable file. */
  public async removeUncommitted(artifact: RunArtifactDescriptor): Promise<void> {
    const runId = artifactRunId(artifact.path);
    if (artifact.kind !== "REST_RESULTS" || runId === null) throw new RunArtifactStoreError();
    const path = join(this.#artifactRoot, artifact.path);
    const facts = await lstat(path).catch(() => null);
    if (facts === null) return;
    if (!facts.isFile() || facts.isSymbolicLink()) throw new RunArtifactStoreError();
    await unlink(path);
    await syncDirectory(join(this.#runsRoot, runId));
  }

  /** Inspect immutable file integrity without mutating Manifest or database facts. */
  public async inspect(manifest: RunArtifactManifest): Promise<readonly RunArtifactAvailability[]> {
    const results: RunArtifactAvailability[] = [];
    for (const artifact of manifest.artifacts) {
      const runId = artifactRunId(artifact.path);
      if (runId === null || runId !== manifest.owner.id) {
        results.push({ artifact, status: "CORRUPTED" });
        continue;
      }
      const path = join(this.#artifactRoot, artifact.path);
      const facts = await inspectFile(path);
      if (facts === null) {
        results.push({ artifact, status: "MISSING" });
        continue;
      }
      const valid =
        facts.sha256 === artifact.expectedSha256 && facts.sizeBytes === artifact.expectedSizeBytes;
      results.push({ artifact, status: valid ? "PRESENT" : "CORRUPTED" });
    }
    return results;
  }

  /** Remove only regular controlled files absent from every durable Manifest. */
  public async cleanupOrphans(manifests: readonly RunArtifactManifest[]): Promise<void> {
    const durablePaths = new Set(
      manifests.flatMap((manifest) => manifest.artifacts.map((artifact) => artifact.path))
    );
    const runEntries = await readdir(this.#runsRoot, { withFileTypes: true });
    for (const runEntry of runEntries) {
      if (!runEntry.isDirectory() || runEntry.isSymbolicLink() || !RUN_ID.test(runEntry.name))
        continue;
      const runRoot = join(this.#runsRoot, runEntry.name);
      const files = await readdir(runRoot, { withFileTypes: true });
      for (const file of files) {
        if (!file.isFile() || file.isSymbolicLink()) continue;
        const relativePath = `runs/${runEntry.name}/${file.name}`;
        const removable =
          (file.name === "rest-results.json" && !durablePaths.has(relativePath)) ||
          TEMP_ARTIFACT.test(file.name);
        if (removable) await unlink(join(runRoot, file.name));
      }
      if ((await readdir(runRoot)).length === 0) await rmdir(runRoot);
    }
    await syncDirectory(this.#runsRoot);
  }
}
