import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";

import { ApiErrorResponseV1Schema } from "@cortex-eval/contracts/src/resource-api-contracts.ts";
import {
  WorkPackageExportRequestV1Schema,
  type WorkPackageExportRequestV1
} from "@cortex-eval/contracts/src/work-package-runtime-contracts.ts";
import {
  openWorkPackageExecutionSession,
  type WorkPackageExecutionContextHasher,
  type WorkPackageValidationSummary
} from "@cortex-eval/work-package/src/work-package-execution-session.ts";
import {
  receiveWorkPackageExport,
  type ReceivedWorkPackage
} from "@cortex-eval/work-package/src/work-package-export-receiver.ts";
import {
  workPackageExportParentPath,
  type WorkPackageCleanupFailureSink
} from "@cortex-eval/work-package/src/work-package-directory-publisher.ts";
import { cleanupStaleWorkPackageExports } from "@cortex-eval/work-package/src/work-package-export-recovery.ts";
import type { WorkPackageLockOwner } from "@cortex-eval/work-package/src/secure-work-package-directory.ts";

import type { PackageCommandService } from "./cli-program.ts";

const MAX_API_ERROR_BYTES = 64 * 1024;
const EXPORT_RECOVERY_TTL_MS = 24 * 60 * 60 * 1_000;

// Re-read cancellation after an asynchronous boundary without stale narrowing.
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

/** No-shell operating-system process identity lookup. */
export interface CliProcessIdentity {
  /** Return one live process start identity or null. */
  readonly processStartedAt: (pid: number) => Promise<string | null>;
}

/** Dependencies for the concrete package CLI adapter. */
export interface HttpPackageCommandServiceOptions {
  /** Trusted loopback Local API origin. */
  readonly baseUrl?: string | undefined;
  /** Domain Execution context hash Port. */
  readonly contextHasher: WorkPackageExecutionContextHasher;
  /** Unpredictable staging nonce source. */
  readonly nonce?: (() => string) | undefined;
  /** Process start identity adapter. */
  readonly processIdentity: CliProcessIdentity;
  /** Current UTC timestamp source. */
  readonly now: () => string;
  /** Resilient observer for unpublished package staging cleanup failures. */
  readonly cleanupFailureSink: WorkPackageCleanupFailureSink;
  /** Injectable Fetch boundary. */
  readonly fetch?: typeof fetch | undefined;
}

/** macOS process start lookup without a shell or inherited command text. */
export class MacOsCliProcessIdentity implements CliProcessIdentity {
  /** Read one exact process start identity with a bounded command timeout. */
  public processStartedAt(pid: number): Promise<string | null> {
    return new Promise((resolve) => {
      execFile(
        "/bin/ps",
        ["-o", "lstart=", "-p", String(pid)],
        { encoding: "utf8", timeout: 1_000, shell: false },
        (error, stdout) => {
          if (error !== null) {
            resolve(null);
            return;
          }
          const value = stdout.trim();
          resolve(value.length === 0 ? null : value);
        }
      );
    });
  }
}

// Restrict platform commands to the local loopback service.
export function localApiUrl(
  baseUrl: string,
  pathname: "/api/v1/work-packages/export" | "/api/v1/data/export" = "/api/v1/work-packages/export"
): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch (error) {
    throw new Error("VALIDATION_FAILED", { cause: error });
  }
  const loopback =
    url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (
    url.protocol !== "http:" ||
    !loopback ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error("VALIDATION_FAILED");
  }
  return new URL(pathname, url);
}

// Stream a Web ReadableStream without converting the response into one aggregate buffer.
export async function* responseChunks(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  let reachedEnd = false;
  let cancellation: Promise<void> | undefined;
  const cancelBody = (): Promise<void> => {
    if (cancellation !== undefined) return cancellation;
    cancellation = reader.cancel().catch(() => undefined);
    return cancellation;
  };
  const abortBody = (): void => {
    void cancelBody();
  };
  signal.addEventListener("abort", abortBody, { once: true });
  if (isAborted(signal)) abortBody();
  try {
    for (;;) {
      if (isAborted(signal)) throw new Error("REQUEST_ABORTED");
      const item = await reader.read();
      if (isAborted(signal)) throw new Error("REQUEST_ABORTED");
      if (item.done) {
        reachedEnd = true;
        return;
      }
      yield item.value;
    }
  } finally {
    signal.removeEventListener("abort", abortBody);
    if (!reachedEnd) await cancelBody();
    reader.releaseLock();
  }
}

// Read a small API error body under an exact byte ceiling.
async function readBoundedError(response: Response): Promise<Uint8Array | null> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const size = Number(declared);
    if (Number.isFinite(size) && size > MAX_API_ERROR_BYTES) return null;
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > MAX_API_ERROR_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

// Parse only the strict public API error envelope and discard remote prose.
export async function apiErrorCode(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") return "PROVIDER_REQUEST_FAILED";
  const bytes = await readBoundedError(response);
  if (bytes === null) return "PROVIDER_REQUEST_FAILED";
  let dirty: unknown;
  try {
    dirty = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return "PROVIDER_REQUEST_FAILED";
  }
  const parsed = ApiErrorResponseV1Schema.safeParse(dirty);
  return parsed.success ? parsed.data.error.code : "PROVIDER_REQUEST_FAILED";
}

/** Concrete Local API export and local Work Package validation adapter. */
export class HttpPackageCommandService implements PackageCommandService {
  /** Exact local export URL. */
  readonly #exportUrl: URL;
  /** Domain context hash Port. */
  readonly #contextHasher: WorkPackageExecutionContextHasher;
  /** Temporary ownership nonce source. */
  readonly #nonce: () => string;
  /** Operating-system process identity adapter. */
  readonly #processIdentity: CliProcessIdentity;
  /** Current UTC timestamp source. */
  readonly #now: () => string;
  /** Private package staging cleanup failure observer. */
  readonly #cleanupFailureSink: WorkPackageCleanupFailureSink;
  /** Fetch edge. */
  readonly #fetch: typeof fetch;

  /** Bind explicit Local API and filesystem edge dependencies. */
  public constructor(options: HttpPackageCommandServiceOptions) {
    this.#exportUrl = localApiUrl(options.baseUrl ?? "http://127.0.0.1:4310");
    this.#contextHasher = options.contextHasher;
    this.#nonce = options.nonce ?? randomUUID;
    this.#processIdentity = options.processIdentity;
    this.#now = options.now;
    this.#cleanupFailureSink = options.cleanupFailureSink;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  /** Stream one strict export response into an atomically published target package. */
  public async exportPackage(
    request: WorkPackageExportRequestV1,
    targetPath: string,
    signal: AbortSignal
  ): Promise<ReceivedWorkPackage> {
    if (signal.aborted) throw new Error("REQUEST_ABORTED");
    const cleanRequest = WorkPackageExportRequestV1Schema.parse(request);
    const parentPath = workPackageExportParentPath(targetPath);
    const owner = await this.#owner(null);
    await this.#recoverExports(parentPath, owner.acquiredAt);
    let response: Response;
    try {
      response = await this.#fetch(this.#exportUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(cleanRequest),
        redirect: "error",
        signal
      });
    } catch (error) {
      if (isAborted(signal)) throw new Error("REQUEST_ABORTED", { cause: error });
      throw new Error("PROVIDER_REQUEST_FAILED", { cause: error });
    }
    if (!response.ok) throw new Error(await apiErrorCode(response));
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    if (contentType !== "application/x-ndjson" || response.body === null) {
      await response.body?.cancel();
      throw new Error("PROVIDER_REQUEST_FAILED");
    }
    const body = response.body;
    try {
      return await receiveWorkPackageExport(responseChunks(body, signal), targetPath, {
        nonce: this.#nonce(),
        owner,
        signal,
        cleanupFailureSink: this.#cleanupFailureSink
      });
    } catch (error) {
      await body.cancel().catch(() => undefined);
      throw error;
    }
  }

  /** Validate immutable inputs, Artifact registration and every Execution context hash. */
  public async validatePackage(
    packagePath: string,
    signal: AbortSignal
  ): Promise<WorkPackageValidationSummary> {
    if (signal.aborted) throw new Error("REQUEST_ABORTED");
    const owner = await this.#owner(null);
    const session = await openWorkPackageExecutionSession({
      rootPath: packagePath,
      owner,
      contextHasher: this.#contextHasher,
      nonce: this.#nonce
    });
    try {
      if (isAborted(signal)) throw new Error("REQUEST_ABORTED");
      return session.packageSummary;
    } finally {
      await session.close();
    }
  }

  // Resolve the current process start identity before acquiring any package lock.
  async #owner(executionId: string | null): Promise<WorkPackageLockOwner> {
    const processStartedAt = await this.#processIdentity.processStartedAt(process.pid);
    if (processStartedAt === null) throw new Error("INTERNAL_ERROR");
    return {
      pid: process.pid,
      processStartedAt,
      executionId,
      acquiredAt: this.#now()
    };
  }

  // Recover only old inactive export staging before issuing another platform request.
  async #recoverExports(parentPath: string, acquiredAt: string): Promise<void> {
    const now = Date.parse(acquiredAt);
    if (!Number.isFinite(now)) throw new Error("INTERNAL_ERROR");
    try {
      await cleanupStaleWorkPackageExports(parentPath, {
        processLiveness: this.#processIdentity,
        now: (): number => now,
        ttlMs: EXPORT_RECOVERY_TTL_MS,
        onSecurityEvent: async (event): Promise<void> => {
          if (event !== "TEMP_CLEANUP_FAILED") return;
          await this.#cleanupFailureSink
            .record({ code: "TEMP_CLEANUP_FAILED" })
            .catch(() => undefined);
        }
      });
    } catch (error) {
      if (error instanceof Error && error.message === "TEMP_CLEANUP_FAILED") return;
      throw error;
    }
  }
}
