import { resolve } from "node:path";

import { ApiErrorResponseV1Schema } from "@cortex-eval/contracts/src/resource-api-contracts.ts";
import {
  ExecutionReportImportRequestV1Schema,
  ExecutionReportImportResultV1Schema,
  type ExecutionReportImportResultV1
} from "@cortex-eval/contracts/src/result-import-contracts.ts";

import type { ResultImportCommandInput, ResultImportCommandService } from "./cli-program.ts";

const MAX_RESPONSE_BYTES = 64 * 1024;

// Re-read mutable cancellation state after asynchronous boundaries.
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

/** Injectable edge dependencies for the local Report import adapter. */
export interface HttpResultImportCommandServiceOptions {
  /** Trusted loopback Local API origin. */
  readonly baseUrl?: string | undefined;
  /** Injectable Fetch boundary. */
  readonly fetch?: typeof fetch | undefined;
}

// Build only the fixed local import endpoint; remote and credential-bearing origins are forbidden.
function resultImportUrl(baseUrl: string): URL {
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
  return new URL("/api/v1/execution-results/import", url);
}

// Read one JSON response under a fixed byte ceiling before decoding untrusted UTF-8.
async function readJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const size = Number(declared);
    if (Number.isFinite(size) && size > MAX_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
  }
  if (response.body === null) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

/** Local-only HTTP adapter for the complete Report import transaction. */
export class HttpResultImportCommandService implements ResultImportCommandService {
  readonly #url: URL;
  readonly #fetch: typeof fetch;

  /** Bind the trusted Local API and Fetch boundary. */
  public constructor(options: HttpResultImportCommandServiceOptions = {}) {
    this.#url = resultImportUrl(options.baseUrl ?? "http://127.0.0.1:4310");
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  /** Import one fully reconciled Report Execution into platform storage. */
  public async importReport(
    input: ResultImportCommandInput
  ): Promise<ExecutionReportImportResultV1> {
    if (isAborted(input.signal)) throw new Error("REQUEST_ABORTED");
    const request = ExecutionReportImportRequestV1Schema.parse({
      contractVersion: "cortex.execution-report-import-request.v1",
      packagePath: resolve(input.packagePath),
      executionId: input.executionId
    });
    let response: Response;
    try {
      response = await this.#fetch(this.#url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        redirect: "error",
        signal: input.signal
      });
    } catch (error) {
      if (isAborted(input.signal)) throw new Error("REQUEST_ABORTED", { cause: error });
      throw new Error("PROVIDER_REQUEST_FAILED", { cause: error });
    }
    let dirty: unknown;
    try {
      dirty = await readJson(response);
    } catch (error) {
      if (isAborted(input.signal)) throw new Error("REQUEST_ABORTED", { cause: error });
      throw new Error("PROVIDER_REQUEST_FAILED", { cause: error });
    }
    if (!response.ok) {
      const parsed = ApiErrorResponseV1Schema.safeParse(dirty);
      throw new Error(parsed.success ? parsed.data.error.code : "PROVIDER_REQUEST_FAILED");
    }
    if (response.status !== 201) throw new Error("PROVIDER_REQUEST_FAILED");
    const parsed = ExecutionReportImportResultV1Schema.safeParse(dirty);
    if (!parsed.success) throw new Error("PROVIDER_REQUEST_FAILED");
    return parsed.data;
  }
}
