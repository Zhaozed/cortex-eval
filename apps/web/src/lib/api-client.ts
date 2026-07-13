import { ApiErrorResponseV1Schema } from "@cortex-eval/contracts/src/resource-api-contracts.ts";
import type { z } from "zod";

/** Server error codes accepted by the closed Local API error envelope. */
type ServerApiErrorCode = z.infer<typeof ApiErrorResponseV1Schema>["error"]["code"];

/** Stable failures created only inside the Web Client boundary. */
type LocalWebClientErrorCode =
  | "CLIENT_ERROR_RESPONSE_INVALID"
  | "CLIENT_REQUEST_CANCELLED"
  | "CLIENT_REQUEST_FAILED"
  | "CLIENT_RESPONSE_INVALID"
  | "CLIENT_MUTATION_PENDING";

/** Closed server and Web-side transport or protocol failure codes. */
export type WebClientErrorCode = ServerApiErrorCode | LocalWebClientErrorCode;

/** Clean error crossing the Local API Client boundary. */
export class ApiClientError extends Error {
  /** Stable server or client error code. */
  public readonly code: WebClientErrorCode;
  /** HTTP response status when a response exists. */
  public readonly statusCode: number | null;
  /** Validated server request identity. */
  public readonly requestId: string | null;
  /** Validated form field path when supplied by the API. */
  public readonly fieldPath: string | null;
  /** Zero-based invalid Case position for bounded full imports. */
  public readonly importIndex: number | null;
  /** Validated Suite-local Case identity for import failures. */
  public readonly caseKey: string | null;
  /** Stable nested import failure code. */
  public readonly causeCode: string | null;
  /** Validated Rubric Prompt key involved in a reference conflict. */
  public readonly promptKey: string | null;

  /** Create one sanitized Web Client error. */
  public constructor(
    code: WebClientErrorCode,
    options: {
      readonly statusCode?: number | undefined;
      readonly requestId?: string | undefined;
      readonly fieldPath?: string | undefined;
      readonly importIndex?: number | undefined;
      readonly caseKey?: string | undefined;
      readonly causeCode?: string | undefined;
      readonly promptKey?: string | undefined;
    } = {}
  ) {
    super(code);
    this.name = "ApiClientError";
    this.code = code;
    this.statusCode = options.statusCode ?? null;
    this.requestId = options.requestId ?? null;
    this.fieldPath = options.fieldPath ?? null;
    this.importIndex = options.importIndex ?? null;
    this.caseKey = options.caseKey ?? null;
    this.causeCode = options.causeCode ?? null;
    this.promptKey = options.promptKey ?? null;
  }
}

/** Supported scalar and repeated query values. */
export type ApiSearchValue = string | number | readonly string[] | null | undefined;

// Encode a deterministic query string without hand-built escaping.
export function buildApiSearch(values: Readonly<Record<string, ApiSearchValue>>): URLSearchParams {
  const search = new URLSearchParams();
  const entries = Object.entries(values).sort(([left], [right]) => left.localeCompare(right));
  for (const [name, rawValue] of entries) {
    const items = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of items) {
      if (value === undefined || value === null || value === "") continue;
      search.append(name, String(value));
    }
  }
  return search;
}

// Parse one JSON body without allowing syntax or transport details to escape.
async function readUnknownJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new ApiClientError(
      response.ok ? "CLIENT_RESPONSE_INVALID" : "CLIENT_ERROR_RESPONSE_INVALID",
      { statusCode: response.status }
    );
  }
}

// Convert one validated API error envelope into a sanitized thrown value.
async function throwApiFailure(response: Response): Promise<never> {
  const raw = await readUnknownJson(response);
  const parsed = ApiErrorResponseV1Schema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiClientError("CLIENT_ERROR_RESPONSE_INVALID", { statusCode: response.status });
  }
  const error = parsed.data.error;
  throw new ApiClientError(error.code, {
    statusCode: response.status,
    requestId: error.requestId,
    ...(error.code === "VALIDATION_FAILED" ||
    error.code === "CASE_DEFINITION_INVALID" ||
    error.code === "ENDPOINT_CONFIG_INVALID" ||
    error.code === "LLM_CONFIG_INVALID" ||
    error.code === "PROMPT_INVALID" ||
    error.code === "ANALYSIS_PROMPT_INVALID" ||
    error.code === "CASE_IMPORT_ITEM_INVALID"
      ? { fieldPath: error.path }
      : {}),
    ...(error.code === "RESOURCE_UNIQUE_CONFLICT" ? { fieldPath: error.field } : {}),
    ...(error.code === "RUBRIC_PROMPT_IN_USE"
      ? { fieldPath: "promptKey", promptKey: error.promptKey }
      : {}),
    ...(error.code === "CASE_IMPORT_ITEM_INVALID"
      ? {
          importIndex: error.index,
          caseKey: error.caseKey,
          causeCode: error.causeCode
        }
      : {})
  });
}

// Perform fetch while normalizing cancellation and opaque network failures.
async function performFetch(
  path: string,
  init: Readonly<RequestInit>,
  fetcher: typeof fetch
): Promise<Response> {
  try {
    return await fetcher(path, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ApiClientError("CLIENT_REQUEST_CANCELLED");
    }
    throw new ApiClientError("CLIENT_REQUEST_FAILED");
  }
}

/** Request and strictly validate one JSON success response. */
export async function apiRequestJson<Output>(
  path: string,
  schema: z.ZodType<Output>,
  init: Readonly<RequestInit> = {},
  fetcher: typeof fetch = fetch,
  matchesRequestContext: (output: Output) => boolean = () => true
): Promise<Output> {
  const response = await performFetch(path, init, fetcher);
  if (!response.ok) return throwApiFailure(response);
  const raw = await readUnknownJson(response);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiClientError("CLIENT_RESPONSE_INVALID", { statusCode: response.status });
  }
  if (!matchesRequestContext(parsed.data)) {
    throw new ApiClientError("CLIENT_RESPONSE_INVALID", { statusCode: response.status });
  }
  return parsed.data;
}

/** Request one operation whose only valid success is HTTP 204. */
export async function apiRequestEmpty(
  path: string,
  init: Readonly<RequestInit> = {},
  fetcher: typeof fetch = fetch
): Promise<void> {
  const response = await performFetch(path, init, fetcher);
  if (!response.ok) return throwApiFailure(response);
  if (response.status !== 204) {
    throw new ApiClientError("CLIENT_RESPONSE_INVALID", { statusCode: response.status });
  }
}
