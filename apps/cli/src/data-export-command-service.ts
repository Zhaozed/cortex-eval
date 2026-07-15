import {
  CANONICAL_EXPORT_CONTENT_TYPE,
  CanonicalExportRequestV1Schema,
  type CanonicalExportRequestV1
} from "@cortex-eval/contracts/src/canonical-export-contracts.ts";
import {
  receiveCanonicalExport,
  type ReceivedCanonicalExport
} from "@cortex-eval/canonical-export/src/canonical-export-receiver.ts";
import {
  workPackageExportParentPath,
  type WorkPackageCleanupFailureSink
} from "@cortex-eval/work-package/src/work-package-directory-publisher.ts";
import { cleanupStaleWorkPackageExports } from "@cortex-eval/work-package/src/work-package-export-recovery.ts";
import type { WorkPackageLockOwner } from "@cortex-eval/work-package/src/secure-work-package-directory.ts";
import { randomUUID } from "node:crypto";

import {
  apiErrorCode,
  localApiUrl,
  responseChunks,
  type CliProcessIdentity
} from "./package-command-service.ts";

const EXPORT_RECOVERY_TTL_MS = 24 * 60 * 60 * 1_000;

/** Closed Canonical Data Export use case shared with Commander registration. */
export interface DataExportCommandService {
  /** Stream, independently reconcile and atomically publish one migration export. */
  readonly exportData: (
    request: CanonicalExportRequestV1,
    targetPath: string,
    signal: AbortSignal
  ) => Promise<ReceivedCanonicalExport>;
}

/** Concrete Canonical Export CLI HTTP adapter dependencies. */
export interface HttpDataExportCommandServiceOptions {
  /** Trusted loopback Local API origin. */
  readonly baseUrl?: string | undefined;
  /** Unpredictable staging nonce source. */
  readonly nonce?: (() => string) | undefined;
  /** Current operating-system process identity. */
  readonly processIdentity: CliProcessIdentity;
  /** Current UTC timestamp. */
  readonly now: () => string;
  /** Resilient unpublished staging cleanup observer. */
  readonly cleanupFailureSink: WorkPackageCleanupFailureSink;
  /** Injectable Fetch boundary. */
  readonly fetch?: typeof fetch | undefined;
}

// Re-read cancellation after each asynchronous boundary.
function requireActive(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("REQUEST_ABORTED");
}

/** Stream one Local API export into an independently reconciled atomic target directory. */
export class HttpDataExportCommandService implements DataExportCommandService {
  readonly #exportUrl: URL;
  readonly #nonce: () => string;
  readonly #processIdentity: CliProcessIdentity;
  readonly #now: () => string;
  readonly #cleanupFailureSink: WorkPackageCleanupFailureSink;
  readonly #fetch: typeof fetch;

  /** Bind the trusted HTTP, process identity and filesystem boundaries. */
  public constructor(options: HttpDataExportCommandServiceOptions) {
    this.#exportUrl = localApiUrl(
      options.baseUrl ?? "http://127.0.0.1:4310",
      "/api/v1/data/export"
    );
    this.#nonce = options.nonce ?? randomUUID;
    this.#processIdentity = options.processIdentity;
    this.#now = options.now;
    this.#cleanupFailureSink = options.cleanupFailureSink;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  /** Request, receive, reconcile and atomically publish one Canonical Export. */
  public async exportData(
    request: CanonicalExportRequestV1,
    targetPath: string,
    signal: AbortSignal
  ): Promise<ReceivedCanonicalExport> {
    requireActive(signal);
    const cleanRequest = CanonicalExportRequestV1Schema.parse(request);
    const parentPath = workPackageExportParentPath(targetPath);
    const owner = await this.#owner();
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
      if (signal.aborted) throw new Error("REQUEST_ABORTED", { cause: error });
      throw new Error("PROVIDER_REQUEST_FAILED", { cause: error });
    }
    if (!response.ok) throw new Error(await apiErrorCode(response));
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    const expectedContentType = CANONICAL_EXPORT_CONTENT_TYPE.split(";", 1)[0];
    if (contentType !== expectedContentType || response.body === null) {
      await response.body?.cancel();
      throw new Error("PROVIDER_REQUEST_FAILED");
    }
    const body = response.body;
    try {
      return await receiveCanonicalExport(responseChunks(body, signal), targetPath, {
        nonce: this.#nonce(),
        owner,
        rawEvidenceIncluded: cleanRequest.rawEvidenceIncluded,
        signal,
        cleanupFailureSink: this.#cleanupFailureSink
      });
    } catch (error) {
      await body.cancel().catch(() => undefined);
      throw error;
    }
  }

  // Resolve the exact live process identity used by atomic staging recovery.
  async #owner(): Promise<WorkPackageLockOwner> {
    const processStartedAt = await this.#processIdentity.processStartedAt(process.pid);
    if (processStartedAt === null) throw new Error("INTERNAL_ERROR");
    return {
      pid: process.pid,
      processStartedAt,
      executionId: null,
      acquiredAt: this.#now()
    };
  }

  // Recover only expired staging owned by an inactive process.
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
