import { createHash, randomUUID, type Hash } from "node:crypto";
import { createReadStream, type Stats } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, realpath, stat, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { Readable } from "node:stream";

import type {
  PlatformNormalizedEvalArtifactInput,
  PlatformRawPromptfooArtifactInput,
  PlatformReportArtifactInput,
  PlatformReportArtifactWriteResult,
  PlatformRestArtifactInput,
  PlatformRestArtifactWriteResult,
  PublishedRunArtifact,
  RunArtifactAvailability,
  RunArtifactStore
} from "@cortex-eval/application/src/features/runs/run-artifact-port.ts";
import { isFrozenEvaluationRawSource } from "@cortex-eval/application/src/features/evaluation/frozen-evaluation-engine.ts";
import type { PlatformEvalCaseResult } from "@cortex-eval/application/src/features/evaluation/platform-eval-models.ts";
import type {
  RunArtifactManifest,
  StoredRestCaseResult
} from "@cortex-eval/application/src/features/runs/platform-run-models.ts";
import {
  EvalCaseV1Schema,
  MetricSummaryV1Schema,
  PlatformRawPromptfooEvidenceArtifactV1Schema,
  ReportSummaryV1Schema,
  RestArtifactCaseV1Schema,
  type ReportCaseV1
} from "@cortex-eval/contracts/src/artifact-contracts.ts";
import {
  canonicalJson,
  type DomainJsonObject
} from "@cortex-eval/domain/src/domain-canonical-hash.ts";
import {
  hashEvalResultSet,
  OrderedRestResultSetHasher
} from "@cortex-eval/domain/src/domain-hash-inputs.ts";
import {
  createReportAccumulator,
  type ReportAggregationResult
} from "@cortex-eval/reporting/src/report-aggregation.ts";
import {
  renderReportMarkdownCase,
  renderReportMarkdownHeader,
  type ReportMarkdownCaseInput
} from "@cortex-eval/reporting/src/report-markdown.ts";
import { mapAlignedPlatformReportCaseToV1, mapRunReportContextToV1 } from "./report-dto-mappers.ts";

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RUN_ARTIFACT_PATH =
  /^runs\/([0-9a-f-]+)\/(rest-results\.json|promptfoo-raw\.json|normalized-eval\.json|report\.json|report\.md)$/;
const TEMP_ARTIFACT =
  /^\.(rest-results|promptfoo-raw|normalized-eval|report-json|report-markdown)\.[A-Za-z0-9-]+\.tmp$/;

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Local Run Artifact Store construction options. */
export interface LocalRunArtifactStoreOptions {
  /** Absolute project root owning `.cortex-eval`. */
  readonly projectRoot: string;
  /** Injectable collision-resistant temporary identity. */
  readonly nonce?: (() => string) | undefined;
  /** Flush one Artifact directory after a visible entry mutation. */
  readonly syncDirectory?: ((path: string) => Promise<void>) | undefined;
  /** Receive one sanitized cleanup failure code without Artifact content. */
  readonly onCleanupFailure?:
    ((code: "RUN_ARTIFACT_CLEANUP_FAILED") => void | Promise<void>) | undefined;
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
    provenance:
      value.provenance === null
        ? null
        : {
            sourceKind: value.provenance.sourceKind,
            sourceId: value.provenance.sourceId,
            sourceResultHash: value.provenance.sourceResultHash
          }
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

// Map one clean normalized result into the immutable Eval Artifact projection.
function evalArtifactCase(value: PlatformEvalCaseResult): DomainJsonObject {
  return {
    caseKey: value.caseKey,
    ordinal: value.ordinal,
    status: value.status,
    promptfooSuccess: value.promptfooSuccess,
    score: value.score,
    reason: value.reason,
    evaluationError: value.evaluationError === null ? null : { ...value.evaluationError },
    assertions: value.assertions.map((item) => ({ ...item })),
    diffs: value.diffs.map((item) => ({ ...item })),
    metrics: value.metrics.map((item) => ({ ...item })),
    latencyMs: value.latencyMs,
    tokenUsage: value.tokenUsage === null ? null : { ...value.tokenUsage },
    cost: value.cost,
    rawEvidence: value.rawEvidence === null ? null : { ...value.rawEvidence },
    evalResultHash: value.evalResultHash,
    finalCaseResultHash: value.finalCaseResultHash,
    provenance: value.provenance === null ? null : { ...value.provenance }
  };
}

// Project one strict Report Case into the one-way Markdown renderer.
function reportMarkdownCase(value: ReportCaseV1): ReportMarkdownCaseInput {
  return {
    caseKey: value.caseKey,
    ordinal: value.ordinal,
    status: value.evaluation.status,
    reason: value.evaluation.reason,
    evaluationErrorCode: value.evaluation.evaluationError?.code ?? null,
    assertions: value.evaluation.assertions.map((item) => ({
      index: item.index,
      type: item.type,
      metric: item.metric,
      status: item.status,
      score: item.score,
      reason: item.reason
    })),
    diffs: value.evaluation.diffs.map((item) => ({
      assertionIndex: item.assertionIndex,
      instancePath: item.instancePath,
      schemaPath: item.schemaPath,
      keyword: item.keyword,
      expectedConstraint: item.expectedConstraint,
      actual: item.actual,
      reason: item.reason
    }))
  };
}

// Require the writer's independent second-pass aggregation to match the preflight exactly.
function sameAggregation(left: ReportAggregationResult, right: ReportAggregationResult): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

// Require one exact UTC ISO timestamp without accepting date normalization.
function validTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

// Re-read mutable AbortSignal state across asynchronous boundaries.
function signalAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

// Write one complete UTF-8 chunk while updating exact integrity facts.
async function writeChunk(
  handle: Awaited<ReturnType<typeof open>>,
  hash: Hash,
  value: string
): Promise<number> {
  const bytes = Buffer.from(value, "utf8");
  return await writeBytes(handle, hash, bytes);
}

// Write one complete binary chunk while updating exact integrity facts.
async function writeBytes(
  handle: Awaited<ReturnType<typeof open>>,
  hash: Hash,
  bytes: Uint8Array
): Promise<number> {
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
): Promise<{ readonly sha256: string; readonly sizeBytes: number; readonly facts: Stats } | null> {
  const before = await lstat(path).catch(() => null);
  if (before === null || !before.isFile() || before.isSymbolicLink()) return null;
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of createReadStream(path)) {
    if (!Buffer.isBuffer(chunk)) throw new RunArtifactStoreError();
    sizeBytes += chunk.byteLength;
    hash.update(chunk);
  }
  const after = await lstat(path).catch(() => null);
  if (after === null || !sameFileIdentity(before, after) || after.size !== before.size) return null;
  return { sha256: hash.digest("hex"), sizeBytes, facts: after };
}

// Encode exact bigint device/inode facts as one opaque non-persisted publication token.
async function exactPublicationIdentity(path: string): Promise<string | null> {
  const facts = await lstat(path, { bigint: true }).catch(() => null);
  if (facts === null || !facts.isFile() || facts.isSymbolicLink()) return null;
  return `${facts.dev.toString()}:${facts.ino.toString()}`;
}

// Resolve only the one closed P5 Artifact path shape.
function artifactRunId(path: string): string | null {
  const match = RUN_ARTIFACT_PATH.exec(path);
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
  /** Directory durability boundary. */
  readonly #syncDirectory: (path: string) => Promise<void>;
  /** Resilient post-failure cleanup observer. */
  readonly #onCleanupFailure:
    ((code: "RUN_ARTIFACT_CLEANUP_FAILED") => void | Promise<void>) | undefined;

  /** Construct only after every containment directory has been validated. */
  private constructor(
    artifactRoot: string,
    runsRoot: string,
    nonce: () => string,
    directorySync: (path: string) => Promise<void>,
    onCleanupFailure: ((code: "RUN_ARTIFACT_CLEANUP_FAILED") => void | Promise<void>) | undefined
  ) {
    this.#artifactRoot = artifactRoot;
    this.#runsRoot = runsRoot;
    this.#nonce = nonce;
    this.#syncDirectory = directorySync;
    this.#onCleanupFailure = onCleanupFailure;
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
      return new LocalRunArtifactStore(
        artifactRoot,
        runsRoot,
        options.nonce ?? randomUUID,
        options.syncDirectory ?? syncDirectory,
        options.onCleanupFailure
      );
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
      const publicationIdentity = await this.#linkAndSync(runRoot, tempPath, targetPath);
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
        publicationIdentity,
        resultSetHash
      };
    } catch {
      throw new RunArtifactStoreError();
    } finally {
      if (handle !== null) await handle.close().catch(() => undefined);
      if (tempPath !== null) await unlink(tempPath).catch(() => undefined);
    }
  }

  /** Atomically write one immutable raw Promptfoo evidence Artifact. */
  public async writeRawPromptfooEvidence(
    input: PlatformRawPromptfooArtifactInput
  ): Promise<PublishedRunArtifact> {
    const envelope = {
      contractVersion: "cortex.platform-raw-promptfoo-evidence.v1" as const,
      runId: input.runId,
      runContextHash: input.runContextHash,
      evaluationContextHash: input.evaluationContextHash,
      promptfooVersion: input.promptfooVersion,
      exitCode: input.exitCode,
      durationMs: input.durationMs
    };
    const validationRaw = isFrozenEvaluationRawSource(input.raw)
      ? { results: { version: 3, results: [] } }
      : input.raw;
    if (
      !PlatformRawPromptfooEvidenceArtifactV1Schema.safeParse({
        ...envelope,
        raw: validationRaw
      }).success
    ) {
      throw new RunArtifactStoreError();
    }
    const relativePath = `runs/${input.runId}/promptfoo-raw.json`;
    let tempPath: string | null = null;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      const runRoot = await ensureDirectory(this.#runsRoot, join(this.#runsRoot, input.runId));
      tempPath = join(runRoot, `.promptfoo-raw.${this.#nonce()}.tmp`);
      const targetPath = join(runRoot, "promptfoo-raw.json");
      handle = await open(tempPath, "wx", 0o600);
      const fileHash = createHash("sha256");
      let sizeBytes = 0;
      if (isFrozenEvaluationRawSource(input.raw)) {
        const serialized = canonicalJson({ ...envelope, raw: null });
        const marker = '"raw":null';
        const markerIndex = serialized.indexOf(marker);
        if (markerIndex < 0) throw new RunArtifactStoreError();
        const prefix = `${serialized.slice(0, markerIndex)}"raw":`;
        const suffix = serialized.slice(markerIndex + marker.length);
        sizeBytes += await writeChunk(handle, fileHash, prefix);
        for await (const chunk of input.raw.openBytes()) {
          sizeBytes += await writeBytes(handle, fileHash, chunk);
        }
        sizeBytes += await writeChunk(handle, fileHash, `${suffix}\n`);
      } else {
        const artifact = { ...envelope, raw: input.raw };
        sizeBytes = await writeChunk(handle, fileHash, `${canonicalJson(artifact)}\n`);
      }
      await handle.sync();
      await handle.close();
      handle = null;
      await chmod(tempPath, 0o600);
      const publicationIdentity = await this.#linkAndSync(runRoot, tempPath, targetPath);
      await unlink(tempPath);
      tempPath = null;
      return {
        descriptor: {
          kind: "RAW_PROMPTFOO_EVIDENCE",
          path: relativePath,
          expectedSha256: fileHash.digest("hex"),
          expectedSizeBytes: sizeBytes,
          contractVersion: "cortex.platform-raw-promptfoo-evidence.v1"
        },
        publicationIdentity
      };
    } catch {
      throw new RunArtifactStoreError();
    } finally {
      if (handle !== null) await handle.close().catch(() => undefined);
      if (tempPath !== null) await unlink(tempPath).catch(() => undefined);
    }
  }

  /** Atomically stream one immutable normalized Evaluation Artifact. */
  public async writeNormalizedEvalResults(
    input: PlatformNormalizedEvalArtifactInput
  ): Promise<PublishedRunArtifact> {
    if (
      !RUN_ID.test(input.runId) ||
      !/^[0-9a-f]{64}$/.test(input.runContextHash) ||
      !/^[0-9a-f]{64}$/.test(input.evaluationContextHash) ||
      !validTimestamp(input.completedAt) ||
      !Number.isInteger(input.expectedTotal) ||
      input.expectedTotal < 1 ||
      !/^[0-9a-f]{64}$/.test(input.resultSetHash)
    ) {
      throw new RunArtifactStoreError();
    }
    const relativePath = `runs/${input.runId}/normalized-eval.json`;
    let tempPath: string | null = null;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      const runRoot = await ensureDirectory(this.#runsRoot, join(this.#runsRoot, input.runId));
      tempPath = join(runRoot, `.normalized-eval.${this.#nonce()}.tmp`);
      const targetPath = join(runRoot, "normalized-eval.json");
      handle = await open(tempPath, "wx", 0o600);
      const fileHash = createHash("sha256");
      const identities: { caseKey: string; ordinal: number; evalResultHash: string }[] = [];
      const caseKeys = new Set<string>();
      let sizeBytes = await writeChunk(handle, fileHash, '{"cases":[');
      let caseCount = 0;
      for await (const item of input.cases) {
        if (
          caseCount >= input.expectedTotal ||
          item.runId !== input.runId ||
          item.ordinal !== caseCount ||
          caseKeys.has(item.caseKey)
        ) {
          throw new RunArtifactStoreError();
        }
        const projected = evalArtifactCase(item);
        if (!EvalCaseV1Schema.safeParse(projected).success) throw new RunArtifactStoreError();
        caseKeys.add(item.caseKey);
        identities.push({
          caseKey: item.caseKey,
          ordinal: item.ordinal,
          evalResultHash: item.evalResultHash
        });
        if (caseCount > 0) sizeBytes += await writeChunk(handle, fileHash, ",");
        sizeBytes += await writeChunk(handle, fileHash, canonicalJson(projected));
        caseCount += 1;
      }
      if (caseCount !== input.expectedTotal) throw new RunArtifactStoreError();
      const computedResultSetHash = hashEvalResultSet({
        contractVersion: "cortex.eval-result-set.v1",
        owner: { kind: "RUN", id: input.runId },
        evaluationContextHash: input.evaluationContextHash,
        cases: identities
      });
      if (computedResultSetHash !== input.resultSetHash) throw new RunArtifactStoreError();
      const trailer =
        `],"completedAt":${canonicalJson(input.completedAt)},` +
        `"contractVersion":"cortex.platform-normalized-eval.v1",` +
        `"evaluationContextHash":${canonicalJson(input.evaluationContextHash)},` +
        `"resultSetHash":${canonicalJson(input.resultSetHash)},` +
        `"runContextHash":${canonicalJson(input.runContextHash)},` +
        `"runId":${canonicalJson(input.runId)}}\n`;
      sizeBytes += await writeChunk(handle, fileHash, trailer);
      await handle.sync();
      await handle.close();
      handle = null;
      await chmod(tempPath, 0o600);
      const publicationIdentity = await this.#linkAndSync(runRoot, tempPath, targetPath);
      await unlink(tempPath);
      tempPath = null;
      return {
        descriptor: {
          kind: "NORMALIZED_EVAL_RESULTS",
          path: relativePath,
          expectedSha256: fileHash.digest("hex"),
          expectedSizeBytes: sizeBytes,
          contractVersion: "cortex.platform-normalized-eval.v1"
        },
        publicationIdentity
      };
    } catch {
      throw new RunArtifactStoreError();
    } finally {
      if (handle !== null) await handle.close().catch(() => undefined);
      if (tempPath !== null) await unlink(tempPath).catch(() => undefined);
    }
  }

  /** Stream and atomically publish one immutable Report JSON/Markdown pair. */
  public async writeReport(
    input: PlatformReportArtifactInput
  ): Promise<PlatformReportArtifactWriteResult> {
    const evaluationContextHash = input.run.evaluationContextHash;
    const evaluationResultSetHash = input.run.evaluationResultSetHash;
    if (
      !RUN_ID.test(input.run.id) ||
      evaluationContextHash === null ||
      evaluationResultSetHash === null ||
      !validTimestamp(input.completedAt) ||
      !Number.isInteger(input.expectedTotal) ||
      input.expectedTotal < 1 ||
      input.expectedTotal !== input.run.suite.cases.length ||
      input.signal.aborted
    ) {
      throw new RunArtifactStoreError();
    }
    let jsonTemp: string | null = null;
    let markdownTemp: string | null = null;
    let jsonHandle: Awaited<ReturnType<typeof open>> | null = null;
    let markdownHandle: Awaited<ReturnType<typeof open>> | null = null;
    const published: PublishedRunArtifact[] = [];
    try {
      const context = mapRunReportContextToV1(input.run);
      const summary = ReportSummaryV1Schema.parse(input.aggregation.summary);
      const byMetric = input.aggregation.byMetric.map((item) => MetricSummaryV1Schema.parse(item));
      const runRoot = await ensureDirectory(this.#runsRoot, join(this.#runsRoot, input.run.id));
      jsonTemp = join(runRoot, `.report-json.${this.#nonce()}.tmp`);
      markdownTemp = join(runRoot, `.report-markdown.${this.#nonce()}.tmp`);
      jsonHandle = await open(jsonTemp, "wx", 0o600);
      markdownHandle = await open(markdownTemp, "wx", 0o600);
      const jsonHash = createHash("sha256");
      const markdownHash = createHash("sha256");
      let jsonSize = await writeChunk(
        jsonHandle,
        jsonHash,
        `${JSON.stringify({ byMetric }).slice(0, -1)},"cases":[`
      );
      let markdownSize = await writeChunk(
        markdownHandle,
        markdownHash,
        renderReportMarkdownHeader({
          owner: { kind: "RUN", id: input.run.id },
          completedAt: input.completedAt,
          summary,
          byMetric
        })
      );
      const accumulator = createReportAccumulator({
        owner: { kind: "RUN", id: input.run.id },
        runContextHash: input.run.runContextHash,
        evaluationContextHash,
        evaluationResultSetHash,
        expectedCaseKey: (ordinal) => input.run.suite.cases[ordinal]?.caseKey ?? null
      });
      let caseCount = 0;
      for await (const item of input.cases) {
        if (caseCount >= input.expectedTotal || signalAborted(input.signal)) {
          throw new RunArtifactStoreError();
        }
        const reportCase = mapAlignedPlatformReportCaseToV1(item);
        accumulator.add({
          caseKey: reportCase.caseKey,
          ordinal: reportCase.ordinal,
          rest: { status: reportCase.rest.status, resultHash: reportCase.rest.resultHash },
          evaluation: {
            status: reportCase.evaluation.status,
            evalResultHash: reportCase.evaluation.evalResultHash,
            finalCaseResultHash: reportCase.evaluation.finalCaseResultHash,
            metrics: reportCase.evaluation.metrics
          }
        });
        if (caseCount > 0) jsonSize += await writeChunk(jsonHandle, jsonHash, ",");
        jsonSize += await writeChunk(jsonHandle, jsonHash, JSON.stringify(reportCase));
        const markdown = renderReportMarkdownCase(reportMarkdownCase(reportCase));
        if (markdown !== "") {
          markdownSize += await writeChunk(markdownHandle, markdownHash, markdown);
        }
        caseCount += 1;
      }
      if (
        caseCount !== input.expectedTotal ||
        !sameAggregation(accumulator.finish(), input.aggregation)
      ) {
        throw new RunArtifactStoreError();
      }
      if (signalAborted(input.signal)) throw new RunArtifactStoreError();
      const trailer =
        `],"completedAt":${JSON.stringify(input.completedAt)},` +
        `"context":${JSON.stringify(context)},` +
        '"contractVersion":"cortex.report.v1",' +
        `"evaluationContextHash":${JSON.stringify(evaluationContextHash)},` +
        `"evaluationResultSetHash":${JSON.stringify(evaluationResultSetHash)},` +
        `"owner":${JSON.stringify({ kind: "RUN", id: input.run.id })},` +
        '"packageId":null,' +
        `"reportResultSetHash":${JSON.stringify(input.aggregation.reportResultSetHash)},` +
        `"summary":${JSON.stringify(summary)}}\n`;
      jsonSize += await writeChunk(jsonHandle, jsonHash, trailer);
      markdownSize += await writeChunk(markdownHandle, markdownHash, "\n");
      await Promise.all([jsonHandle.sync(), markdownHandle.sync()]);
      await Promise.all([jsonHandle.close(), markdownHandle.close()]);
      jsonHandle = null;
      markdownHandle = null;
      await Promise.all([chmod(jsonTemp, 0o600), chmod(markdownTemp, 0o600)]);
      const jsonPublicationIdentity = await this.#linkAndSync(
        runRoot,
        jsonTemp,
        join(runRoot, "report.json")
      );
      const jsonPublication: PublishedRunArtifact = {
        descriptor: {
          kind: "REPORT_JSON",
          path: `runs/${input.run.id}/report.json`,
          expectedSha256: jsonHash.digest("hex"),
          expectedSizeBytes: jsonSize,
          contractVersion: "cortex.report.v1"
        },
        publicationIdentity: jsonPublicationIdentity
      };
      published.push(jsonPublication);
      const markdownPublicationIdentity = await this.#linkAndSync(
        runRoot,
        markdownTemp,
        join(runRoot, "report.md")
      );
      const markdownPublication: PublishedRunArtifact = {
        descriptor: {
          kind: "REPORT_MARKDOWN",
          path: `runs/${input.run.id}/report.md`,
          expectedSha256: markdownHash.digest("hex"),
          expectedSizeBytes: markdownSize,
          contractVersion: "cortex.report-markdown.v1"
        },
        publicationIdentity: markdownPublicationIdentity
      };
      published.push(markdownPublication);
      await Promise.all([unlink(jsonTemp), unlink(markdownTemp)]);
      jsonTemp = null;
      markdownTemp = null;
      return { json: jsonPublication, markdown: markdownPublication };
    } catch {
      await Promise.allSettled(published.map((artifact) => this.removeUncommitted(artifact)));
      throw new RunArtifactStoreError();
    } finally {
      await Promise.allSettled([jsonHandle?.close(), markdownHandle?.close()]);
      await Promise.allSettled([
        jsonTemp === null ? Promise.resolve() : unlink(jsonTemp),
        markdownTemp === null ? Promise.resolve() : unlink(markdownTemp)
      ]);
    }
  }

  /** Remove only one controlled uncommitted immutable file. */
  public async removeUncommitted(published: PublishedRunArtifact): Promise<void> {
    const artifact = published.descriptor;
    const runId = artifactRunId(artifact.path);
    if (runId === null) throw new RunArtifactStoreError();
    const fileName = artifact.path.split("/").at(-1);
    const expectedFile =
      artifact.kind === "REST_RESULTS"
        ? "rest-results.json"
        : artifact.kind === "RAW_PROMPTFOO_EVIDENCE"
          ? "promptfoo-raw.json"
          : artifact.kind === "NORMALIZED_EVAL_RESULTS"
            ? "normalized-eval.json"
            : artifact.kind === "REPORT_JSON"
              ? "report.json"
              : artifact.kind === "REPORT_MARKDOWN"
                ? "report.md"
                : null;
    if (fileName !== expectedFile) throw new RunArtifactStoreError();
    const path = join(this.#artifactRoot, artifact.path);
    const facts = await lstat(path).catch(() => null);
    if (facts === null) return;
    const observed = await inspectFile(path);
    const current = await lstat(path).catch(() => null);
    const currentPublicationIdentity = await exactPublicationIdentity(path);
    if (
      observed === null ||
      current === null ||
      !sameFileIdentity(observed.facts, current) ||
      observed.sha256 !== artifact.expectedSha256 ||
      observed.sizeBytes !== artifact.expectedSizeBytes ||
      currentPublicationIdentity !== published.publicationIdentity
    ) {
      await Promise.resolve(this.#onCleanupFailure?.("RUN_ARTIFACT_CLEANUP_FAILED")).catch(
        () => undefined
      );
      throw new RunArtifactStoreError();
    }
    await unlink(path);
    await syncDirectory(join(this.#runsRoot, runId));
  }

  // Publish one link and compensate it if the following directory durability step fails.
  async #linkAndSync(runRoot: string, temporaryPath: string, targetPath: string): Promise<string> {
    const temporaryFacts = await lstat(temporaryPath);
    await link(temporaryPath, targetPath);
    const publishedFacts = await lstat(targetPath);
    const temporaryIdentity = await exactPublicationIdentity(temporaryPath);
    const publicationIdentity = await exactPublicationIdentity(targetPath);
    if (
      !sameFileIdentity(temporaryFacts, publishedFacts) ||
      temporaryIdentity === null ||
      publicationIdentity === null ||
      temporaryIdentity !== publicationIdentity
    ) {
      await Promise.resolve(this.#onCleanupFailure?.("RUN_ARTIFACT_CLEANUP_FAILED")).catch(
        () => undefined
      );
      throw new Error("RUN_ARTIFACT_CLEANUP_FAILED");
    }
    try {
      await this.#syncDirectory(runRoot);
    } catch (error) {
      try {
        const currentFacts = await lstat(targetPath).catch(() => null);
        if (currentFacts === null) {
          await this.#syncDirectory(runRoot);
        } else if (!sameFileIdentity(currentFacts, publishedFacts)) {
          throw new Error("RUN_ARTIFACT_CLEANUP_FAILED", { cause: error });
        } else {
          await unlink(targetPath);
          await this.#syncDirectory(runRoot);
        }
      } catch {
        await Promise.resolve(this.#onCleanupFailure?.("RUN_ARTIFACT_CLEANUP_FAILED")).catch(
          () => undefined
        );
      }
      throw error;
    }
    return publicationIdentity;
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

  /** Verify and open the exact committed Report JSON file object for bounded streaming export. */
  public async openReportJson(
    manifest: RunArtifactManifest,
    signal: AbortSignal
  ): Promise<Readable | null> {
    if (signal.aborted) throw new Error("REQUEST_ABORTED");
    const descriptor = manifest.artifacts.find((item) => item.kind === "REPORT_JSON");
    const ownerId = manifest.owner.id;
    if (
      descriptor?.path !== `runs/${ownerId}/report.json` ||
      descriptor.contractVersion !== "cortex.report.v1" ||
      artifactRunId(descriptor.path) !== ownerId
    ) {
      return null;
    }
    const path = join(this.#artifactRoot, descriptor.path);
    const pathFacts = await lstat(path).catch(() => null);
    if (pathFacts === null || !pathFacts.isFile() || pathFacts.isSymbolicLink()) return null;
    const handle = await open(path, "r").catch(() => null);
    if (handle === null) return null;
    let transferred = false;
    try {
      const before = await handle.stat();
      if (
        !before.isFile() ||
        !sameFileIdentity(pathFacts, before) ||
        before.size !== descriptor.expectedSizeBytes
      ) {
        return null;
      }
      const hash = createHash("sha256");
      const verification = handle.createReadStream({ start: 0, autoClose: false, signal });
      try {
        for await (const chunk of verification) {
          const bytes: unknown = chunk;
          if (!Buffer.isBuffer(bytes)) return null;
          hash.update(bytes);
        }
      } catch (error) {
        if (signalAborted(signal)) throw new Error("REQUEST_ABORTED", { cause: error });
        return null;
      }
      const [after, currentPathFacts] = await Promise.all([
        handle.stat(),
        lstat(path).catch(() => null)
      ]);
      if (
        signalAborted(signal) ||
        currentPathFacts === null ||
        currentPathFacts.isSymbolicLink() ||
        !sameFileIdentity(before, after) ||
        !sameFileIdentity(after, currentPathFacts) ||
        after.size !== descriptor.expectedSizeBytes ||
        hash.digest("hex") !== descriptor.expectedSha256
      ) {
        if (signalAborted(signal)) throw new Error("REQUEST_ABORTED");
        return null;
      }
      transferred = true;
      return handle.createReadStream({ start: 0, autoClose: true, signal });
    } finally {
      if (!transferred) await handle.close().catch(() => undefined);
    }
  }

  /** Preserve and report files absent from durable Manifests when publication identity is gone. */
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
        const controlled =
          file.name === "rest-results.json" ||
          file.name === "promptfoo-raw.json" ||
          file.name === "normalized-eval.json" ||
          file.name === "report.json" ||
          file.name === "report.md";
        const orphaned =
          (controlled && !durablePaths.has(relativePath)) || TEMP_ARTIFACT.test(file.name);
        if (orphaned) {
          await Promise.resolve(this.#onCleanupFailure?.("RUN_ARTIFACT_CLEANUP_FAILED")).catch(
            () => undefined
          );
        }
      }
    }
  }
}
