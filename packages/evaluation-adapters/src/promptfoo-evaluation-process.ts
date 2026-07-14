import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { open, realpath, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import type { MaterializedPromptfooConfigV1 } from "./promptfoo-config-materializer.ts";
import { createPromptfooTemporaryDirectory } from "./promptfoo-temporary-directory.ts";
import { validatePromptfooOutputRuntimeLimits } from "./promptfoo-output-runtime-limits.ts";
import { PromptfooRawFileSource } from "./promptfoo-raw-file-source.ts";
import { streamPromptfooResultRows } from "./promptfoo-raw-result-stream.ts";

/** Fixed Promptfoo version owned by the current evaluation contract. */
export const PROMPTFOO_EVALUATION_VERSION = "0.121.18" as const;

/** Maximum captured diagnostic bytes per child stream. */
export const MAX_PROMPTFOO_DIAGNOSTIC_BYTES = 1024 * 1024;

/** Grace period between process-tree TERM and KILL. */
export const PROMPTFOO_PROCESS_TERMINATION_GRACE_MS = 5_000;

/** Maximum wait for a killed POSIX process group to disappear. */
export const PROMPTFOO_PROCESS_GROUP_REAP_TIMEOUT_MS = 5_000;

/** Maximum handoff window from explicit preflight to the immediately following execution. */
export const PROMPTFOO_VERSION_ATTESTATION_TTL_MS = 30_000;

interface PromptfooBinaryIdentity {
  /** Canonical executable target. */
  readonly path: string;
  /** Device identity. */
  readonly device: bigint;
  /** Inode identity. */
  readonly inode: bigint;
  /** Exact target size. */
  readonly sizeBytes: bigint;
  /** Nanosecond modification time. */
  readonly modifiedAtNanoseconds: bigint;
  /** Nanosecond metadata-change time. */
  readonly changedAtNanoseconds: bigint;
}

interface PromptfooVersionAttestation {
  /** Exact executable identity observed by the successful version process. */
  readonly identity: PromptfooBinaryIdentity;
  /** Short monotonic handoff deadline. */
  readonly expiresAt: number;
}

const promptfooVersionAttestations = new Map<string, PromptfooVersionAttestation>();

/** Controlled fixed-version Promptfoo process input. */
export interface RunPromptfooEvaluationProcessInput {
  /** Absolute local Promptfoo binary path. */
  readonly promptfooBinary: string;
  /** Secret-free generated configuration or bounded replay stream. */
  readonly config: MaterializedPromptfooConfigV1 | PromptfooConfigByteSource;
  /** Environment key referenced by the generated HTTP Provider. */
  readonly capabilityEnvKey: string;
  /** Raw capability injected only into the child environment. */
  readonly rawCapability: string;
  /** Controlled parent for disposable process files. */
  readonly temporaryParent: string;
  /** Explicit real root containing every disposable process path. */
  readonly temporaryContainmentRoot: string;
  /** Whole-child execution timeout. */
  readonly timeoutMs: number;
  /** Run or Execution cancellation signal. */
  readonly signal: AbortSignal;
}

/** Replayable secret-free Promptfoo configuration bytes. */
export interface PromptfooConfigByteSource {
  /** Stable source discriminator. */
  readonly kind: "PROMPTFOO_CONFIG_BYTE_SOURCE";
  /** Open a fresh bounded byte pass. */
  readonly openBytes: () => AsyncIterable<Uint8Array>;
}

/** Stable Promptfoo process output ready for strict Importer validation. */
export interface PromptfooEvaluationProcessResult {
  /** Verified exact package version. */
  readonly promptfooVersion: typeof PROMPTFOO_EVALUATION_VERSION;
  /** Replayable bounded Raw output source. */
  readonly raw: PromptfooRawFileSource;
  /** Native Promptfoo exit code, including Assertion Fail code 100. */
  readonly exitCode: 0 | 100;
}

/** Fixed-version executable preflight input without an Evaluation payload. */
export interface PromptfooEvaluationProcessVersionPreflightInput {
  /** Absolute local Promptfoo binary path. */
  readonly promptfooBinary: string;
  /** Controlled parent for disposable process files. */
  readonly temporaryParent: string;
  /** Explicit real root containing every disposable process path. */
  readonly temporaryContainmentRoot: string;
  /** Bounded version-process timeout. */
  readonly timeoutMs: number;
  /** Caller cancellation signal. */
  readonly signal: AbortSignal;
}

interface ChildResult {
  /** Native process exit code. */
  readonly exitCode: number;
  /** Bounded standard output. */
  readonly stdout: string;
  /** Bounded standard error. */
  readonly stderr: string;
  /** Cancellation source if the child was terminated. */
  readonly terminatedBy: "CANCELLED" | "TIMEOUT" | null;
}

// Capture the canonical executable identity without following a mutable lexical alias twice.
async function promptfooBinaryIdentity(binary: string): Promise<PromptfooBinaryIdentity> {
  const path = await realpath(binary);
  const facts = await stat(path, { bigint: true });
  return {
    path,
    device: facts.dev,
    inode: facts.ino,
    sizeBytes: facts.size,
    modifiedAtNanoseconds: facts.mtimeNs,
    changedAtNanoseconds: facts.ctimeNs
  };
}

// Compare every stable filesystem identity field observed around the preflight handoff.
function samePromptfooBinary(
  left: PromptfooBinaryIdentity,
  right: PromptfooBinaryIdentity
): boolean {
  return (
    left.path === right.path &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.sizeBytes === right.sizeBytes &&
    left.modifiedAtNanoseconds === right.modifiedAtNanoseconds &&
    left.changedAtNanoseconds === right.changedAtNanoseconds
  );
}

// Record only a successful explicit preflight; ordinary process calls never self-attest.
async function attestPromptfooVersion(binary: string): Promise<void> {
  const identity = await promptfooBinaryIdentity(binary);
  promptfooVersionAttestations.set(identity.path, {
    identity,
    expiresAt: performance.now() + PROMPTFOO_VERSION_ATTESTATION_TTL_MS
  });
}

// Reuse one short-lived attestation only while the exact executable identity remains unchanged.
async function hasPromptfooVersionAttestation(binary: string): Promise<boolean> {
  const identity = await promptfooBinaryIdentity(binary);
  const attestation = promptfooVersionAttestations.get(identity.path);
  if (attestation === undefined) return false;
  const valid =
    attestation.expiresAt >= performance.now() &&
    samePromptfooBinary(attestation.identity, identity);
  if (!valid) promptfooVersionAttestations.delete(identity.path);
  return valid;
}

// Narrow the explicit config union without trusting arbitrary transport values.
function isPromptfooConfigByteSource(
  value: MaterializedPromptfooConfigV1 | PromptfooConfigByteSource
): value is PromptfooConfigByteSource {
  return "openBytes" in value;
}

// Publish one owner-only config while rejecting any accidental raw capability materialization.
async function writePromptfooConfig(
  path: string,
  config: MaterializedPromptfooConfigV1 | PromptfooConfigByteSource,
  rawCapability: string
): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  let tail = "";
  let wroteBytes = false;
  try {
    const chunks: AsyncIterable<Uint8Array> = isPromptfooConfigByteSource(config)
      ? config.openBytes()
      : {
          async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
            yield await Promise.resolve(
              Buffer.from(`${JSON.stringify(config, null, 2)}\n`, "utf8")
            );
          }
        };
    for await (const chunk of chunks) {
      const bytes = Buffer.from(chunk);
      const inspected = `${tail}${bytes.toString("utf8")}`;
      if (inspected.includes(rawCapability)) throw new Error("PROMPTFOO_CONFIG_SECRET_EXPOSED");
      tail = inspected.slice(-Math.max(0, rawCapability.length - 1));
      await handle.write(bytes);
      wroteBytes ||= bytes.byteLength > 0;
    }
    if (!wroteBytes) throw new Error("PROMPTFOO_CONFIG_INVALID");
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
}

// Return whether a POSIX process group still owns at least one process.
function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    const code =
      error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
    return code !== "ESRCH";
  }
}

// Wait within one explicit budget so process close can preserve the remaining TERM grace period.
async function waitForProcessGroupExitWithin(
  processGroupId: number,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(processGroupId)) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

// Do not release filesystem or Bridge resources while a killed interpreter descendant survives.
async function waitForProcessGroupExit(processGroupId: number): Promise<void> {
  const exited = await waitForProcessGroupExitWithin(
    processGroupId,
    PROMPTFOO_PROCESS_GROUP_REAP_TIMEOUT_MS
  );
  if (!exited) throw new Error("PROMPTFOO_PROCESS_GROUP_NOT_REAPED");
}

// Promptfoo runs trusted inline code, so inherit only runtime necessities and interpreter selectors.
function createPromptfooChildEnvironment(
  capabilityEnvKey: string,
  rawCapability: string,
  configDirectory: string
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "PROMPTFOO_PYTHON",
    "PROMPTFOO_RUBY"
  ]) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  environment[capabilityEnvKey] = rawCapability;
  environment.PROMPTFOO_CONFIG_DIR = configDirectory;
  environment.PROMPTFOO_DISABLE_TELEMETRY = "true";
  environment.PROMPTFOO_DISABLE_UPDATE = "true";
  environment.PROMPTFOO_CACHE_ENABLED = "false";
  return environment;
}

// Run one child without a shell and enforce bounded diagnostics and TERM/KILL cleanup.
async function runChild(
  executable: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal: AbortSignal
): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const ownsProcessGroup = process.platform !== "win32";
    const child = spawn(executable, [...args], {
      cwd,
      env: environment,
      detached: ownsProcessGroup,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    let diagnosticsExceeded = false;
    let terminatedBy: ChildResult["terminatedBy"] = null;
    let terminationStartedAt: number | null = null;
    let killTimer: NodeJS.Timeout | null = null;

    // Signal the isolated POSIX process group so interpreter descendants cannot outlive Promptfoo.
    const signalTree = (signalName: NodeJS.Signals): void => {
      const pid = child.pid;
      if (ownsProcessGroup && pid !== undefined) {
        try {
          process.kill(-pid, signalName);
          return;
        } catch {
          // The group may already be gone; the direct-child fallback remains safe.
        }
      }
      child.kill(signalName);
    };

    const terminate = (reason: Exclude<ChildResult["terminatedBy"], null>): void => {
      if (terminatedBy !== null) return;
      terminatedBy = reason;
      terminationStartedAt = Date.now();
      signalTree("SIGTERM");
      killTimer = setTimeout(() => signalTree("SIGKILL"), PROMPTFOO_PROCESS_TERMINATION_GRACE_MS);
    };
    const onAbort = (): void => terminate("CANCELLED");
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    const timeout = setTimeout(() => terminate("TIMEOUT"), timeoutMs);

    const capture = (target: Buffer[], chunk: Buffer, stream: "stdout" | "stderr"): void => {
      if (diagnosticsExceeded) return;
      const currentSize = stream === "stdout" ? stdoutSize : stderrSize;
      const nextSize = currentSize + chunk.byteLength;
      if (nextSize > MAX_PROMPTFOO_DIAGNOSTIC_BYTES) {
        diagnosticsExceeded = true;
        terminate("TIMEOUT");
        return;
      }
      if (stream === "stdout") stdoutSize = nextSize;
      else stderrSize = nextSize;
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk, "stderr"));
    child.once("error", (error) => {
      clearTimeout(timeout);
      if (killTimer !== null) clearTimeout(killTimer);
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (killTimer !== null) clearTimeout(killTimer);
      signal.removeEventListener("abort", onAbort);
      const finish = async (): Promise<void> => {
        if (terminatedBy !== null) {
          const processGroupId = ownsProcessGroup ? child.pid : undefined;
          if (processGroupId !== undefined && terminationStartedAt !== null) {
            const elapsed = Date.now() - terminationStartedAt;
            const remainingGrace = Math.max(0, PROMPTFOO_PROCESS_TERMINATION_GRACE_MS - elapsed);
            const exitedDuringGrace = await waitForProcessGroupExitWithin(
              processGroupId,
              remainingGrace
            );
            if (!exitedDuringGrace) {
              signalTree("SIGKILL");
              await waitForProcessGroupExit(processGroupId);
            }
          } else {
            signalTree("SIGKILL");
          }
        }
        resolve({
          exitCode: code ?? -1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          terminatedBy
        });
      };
      void finish().catch(reject);
    });
  });
}

// Reject version drift before writing or executing an Evaluation config.
async function verifyPromptfooVersion(
  binary: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal: AbortSignal
): Promise<void> {
  const result = await runChild(binary, ["--version"], cwd, environment, timeoutMs, signal);
  if (result.terminatedBy !== null) throw new Error(`PROMPTFOO_PROCESS_${result.terminatedBy}`);
  if (result.exitCode !== 0 || result.stdout.trim() !== PROMPTFOO_EVALUATION_VERSION) {
    throw new Error("PROMPTFOO_VERSION_MISMATCH");
  }
}

/** Verify the exact Promptfoo executable version and reclaim all temporary state. */
export async function preflightPromptfooEvaluationProcessVersion(
  input: PromptfooEvaluationProcessVersionPreflightInput
): Promise<void> {
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 100) {
    throw new Error("PROMPTFOO_PROCESS_TIMEOUT_INVALID");
  }
  if (await hasPromptfooVersionAttestation(input.promptfooBinary).catch(() => false)) return;
  const directory = await createPromptfooTemporaryDirectory(
    input.temporaryContainmentRoot,
    input.temporaryParent
  );
  const environment = createPromptfooChildEnvironment(
    "CORTEX_RUNTIME_PREFLIGHT_CAPABILITY",
    "runtime-preflight-capability",
    directory
  );
  try {
    await verifyPromptfooVersion(
      input.promptfooBinary,
      directory,
      environment,
      Math.min(15_000, input.timeoutMs),
      input.signal
    );
    await attestPromptfooVersion(input.promptfooBinary);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

/** Execute Promptfoo in a disposable directory and always reclaim process files. */
export async function runPromptfooEvaluationProcess(
  input: RunPromptfooEvaluationProcessInput
): Promise<PromptfooEvaluationProcessResult> {
  const deadline = performance.now() + input.timeoutMs;
  if (!/^[A-Z][A-Z0-9_]*$/.test(input.capabilityEnvKey)) {
    throw new Error("PROMPTFOO_CAPABILITY_ENV_INVALID");
  }
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 100) {
    throw new Error("PROMPTFOO_PROCESS_TIMEOUT_INVALID");
  }
  const directory = await createPromptfooTemporaryDirectory(
    input.temporaryContainmentRoot,
    input.temporaryParent
  );
  const configPath = join(directory, "promptfoo.config.json");
  const outputPath = join(directory, "promptfoo.output.json");
  const environment = createPromptfooChildEnvironment(
    input.capabilityEnvKey,
    input.rawCapability,
    directory
  );
  const remainingTimeout = (): number => {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining < 1) throw new Error("PROMPTFOO_PROCESS_TIMEOUT");
    return remaining;
  };
  let outputTransferred = false;

  try {
    const versionAttested = await hasPromptfooVersionAttestation(input.promptfooBinary).catch(
      () => false
    );
    if (!versionAttested) {
      await verifyPromptfooVersion(
        input.promptfooBinary,
        directory,
        environment,
        Math.min(15_000, remainingTimeout()),
        input.signal
      );
    }
    await writePromptfooConfig(configPath, input.config, input.rawCapability);
    const result = await runChild(
      input.promptfooBinary,
      [
        "eval",
        "--config",
        configPath,
        "--output",
        outputPath,
        "--no-cache",
        "--no-share",
        "--no-table",
        "--no-progress-bar"
      ],
      directory,
      environment,
      remainingTimeout(),
      input.signal
    );
    if (result.terminatedBy !== null) throw new Error(`PROMPTFOO_PROCESS_${result.terminatedBy}`);
    if (result.exitCode !== 0 && result.exitCode !== 100) {
      throw new Error(`PROMPTFOO_PROCESS_EXIT:${result.exitCode}`);
    }
    await validatePromptfooOutputRuntimeLimits(createReadStream(outputPath), input.rawCapability);
    const rows = streamPromptfooResultRows(createReadStream(outputPath));
    // Drain before transfer so malformed trailing JSON cannot escape the Adapter boundary.
    for (;;) {
      const step = await rows.next();
      if (step.done) break;
    }
    const raw = new PromptfooRawFileSource(directory, outputPath);
    outputTransferred = true;
    return {
      promptfooVersion: PROMPTFOO_EVALUATION_VERSION,
      raw,
      exitCode: result.exitCode
    };
  } finally {
    if (!outputTransferred) await rm(directory, { force: true, recursive: true });
  }
}
