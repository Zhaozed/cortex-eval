/** Stable provider failure codes crossing the frozen Evaluator boundary. */
export type EvaluatorModelErrorCode = "PROVIDER_CAPABILITY_UNSUPPORTED" | "PROVIDER_REQUEST_FAILED";

/** Separator between one stable code and its bounded diagnostic detail. */
export const EVALUATOR_ERROR_DETAIL_SEPARATOR = "｜";

/** Maximum retained characters of one sanitized provider message. */
const PROVIDER_MESSAGE_LIMIT = 160;

/** Maximum backoff a provider may request through Retry-After. */
export const MAX_PROVIDER_RETRY_AFTER_MS = 30_000;

/** HTTP statuses worth one more bounded attempt. */
const TRANSIENT_PROVIDER_STATUSES: readonly number[] = [408, 425, 429, 500, 502, 503, 504];

/** Socket/DNS level faults worth one more bounded attempt. */
const TRANSIENT_SYSTEM_CODES: readonly string[] = [
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT"
];

/** SDK error names that carry no HTTP status but are still transient. */
const TRANSIENT_ERROR_NAMES: readonly string[] = [
  "APIConnectionError",
  "APIConnectionTimeoutError",
  "FetchError",
  "TimeoutError"
];

/** Bounded, credential-free diagnostics for one provider failure. */
export interface EvaluatorModelErrorDetail {
  /** Numeric HTTP status reported by the provider, when present. */
  readonly status: number | null;
  /** Provider-side machine error code, when present. */
  readonly providerCode: string | null;
  /** Sanitized and truncated provider message, when present. */
  readonly providerMessage: string | null;
  /** Transient fault that one bounded retry may recover. */
  readonly transient: boolean;
  /** Backoff requested by a Retry-After header, when present. */
  readonly retryAfterMs: number | null;
}

/** Render one bounded operator-visible diagnostic line, code first. */
export function formatEvaluatorErrorDetail(detail: EvaluatorModelErrorDetail): string {
  const parts: string[] = [];
  if (detail.status !== null) parts.push(`HTTP ${detail.status}`);
  if (detail.providerCode !== null) parts.push(detail.providerCode);
  if (detail.providerMessage !== null) parts.push(detail.providerMessage);
  if (parts.length === 0) return detail.transient ? "transient" : "unclassified";
  return parts.join(" ");
}

/** Sanitized Evaluator failure that never retains a provider response payload. */
export class EvaluatorModelError extends Error {
  /** Stable platform error code. */
  readonly code: EvaluatorModelErrorCode;

  /** Bounded provider diagnostics; null when the SDK exposed nothing safe. */
  readonly detail: EvaluatorModelErrorDetail | null;

  /** Build one provider-neutral failure. */
  constructor(code: EvaluatorModelErrorCode, detail: EvaluatorModelErrorDetail | null = null) {
    super(code);
    this.name = "EvaluatorModelError";
    this.code = code;
    this.detail = detail;
  }

  /** Sanitized provider facts only, or null when the SDK exposed nothing safe. */
  detailText(): string | null {
    return this.detail === null ? null : formatEvaluatorErrorDetail(this.detail);
  }

  /** One bounded diagnostic line: stable code plus sanitized provider facts. */
  diagnostic(): string {
    const detail = this.detailText();
    return detail === null ? this.code : `${this.code}${EVALUATOR_ERROR_DETAIL_SEPARATOR}${detail}`;
  }
}

// Read an object field without trusting its shape.
function record(error: unknown): Readonly<Record<string, unknown>> | null {
  return error !== null && typeof error === "object"
    ? (error as Readonly<Record<string, unknown>>)
    : null;
}

// Read only the numeric HTTP status from an untrusted SDK error object.
function providerStatus(error: unknown): number | null {
  const source = record(error);
  if (source === null) return null;
  const status = source.status;
  if (typeof status === "number" && Number.isInteger(status)) return status;
  const code = source.code;
  if (typeof code === "number" && Number.isInteger(code)) return code;
  const responseStatus = record(source.response)?.status;
  return typeof responseStatus === "number" && Number.isInteger(responseStatus)
    ? responseStatus
    : null;
}

// Read a bounded provider machine code, never an arbitrary string.
function providerErrorCode(error: unknown): string | null {
  const source = record(error);
  if (source === null) return null;
  const candidates = [source.code, record(source.error)?.code, record(source.cause)?.code];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (/^[A-Za-z0-9_.\-]{1,64}$/.test(trimmed)) return trimmed;
  }
  return null;
}

// Strip credential-shaped and opaque long tokens, then bound the length.
function sanitizeProviderMessage(error: unknown): string | null {
  const source = record(error);
  if (source === null) return null;
  const candidates = [
    typeof source.message === "string" ? source.message : null,
    typeof record(source.error)?.message === "string"
      ? (record(source.error)?.message as string)
      : null
  ];
  for (const raw of candidates) {
    if (raw === null) continue;
    const collapsed = raw
      .replace(/(?:sk-|bearer\s+|api[_-]?key["']?\s*[:=]\s*)[^\s"',}]+/gi, "[REDACTED]")
      .replace(/[A-Za-z0-9_\-.+/=]{32,}/g, "[REDACTED]")
      .replace(/\s+/g, " ")
      .trim();
    if (collapsed === "") continue;
    return collapsed.length <= PROVIDER_MESSAGE_LIMIT
      ? collapsed
      : `${collapsed.slice(0, PROVIDER_MESSAGE_LIMIT)}…`;
  }
  return null;
}

// Read a bounded Retry-After hint from either a Headers object or a plain record.
function retryAfterMs(error: unknown): number | null {
  const source = record(error);
  if (source === null) return null;
  const headers = source.headers ?? record(source.response)?.headers;
  if (headers === null || typeof headers !== "object") return null;
  const getter = (headers as { readonly get?: unknown }).get;
  let raw: unknown;
  if (typeof getter === "function") {
    raw = (getter as (name: string) => unknown).call(headers, "retry-after");
  } else {
    const plain = headers as Readonly<Record<string, unknown>>;
    raw = plain["retry-after"] ?? plain["Retry-After"];
  }
  if (typeof raw !== "string") return null;
  const seconds = Number.parseFloat(raw.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(Math.round(seconds * 1000), MAX_PROVIDER_RETRY_AFTER_MS);
}

// Decide whether one more bounded attempt is worth making.
function transientFailure(error: unknown, status: number | null, code: string | null): boolean {
  if (status !== null && TRANSIENT_PROVIDER_STATUSES.includes(status)) return true;
  if (code !== null && TRANSIENT_SYSTEM_CODES.includes(code.toUpperCase())) return true;
  const source = record(error);
  if (source === null) return false;
  const name = typeof source.name === "string" ? source.name : "";
  if (TRANSIENT_ERROR_NAMES.includes(name)) return true;
  return name === "AbortError" || code === "ABORT_ERR" ? false : record(source.cause) !== null;
}

/** Classify one SDK failure into a stable code plus bounded retry facts. */
export function classifyEvaluatorProviderFailure(error: unknown): {
  readonly error: EvaluatorModelError;
  readonly detail: EvaluatorModelErrorDetail;
} {
  const status = providerStatus(error);
  const providerCode = providerErrorCode(error);
  const providerMessage = sanitizeProviderMessage(error);
  const detail: EvaluatorModelErrorDetail = {
    status,
    providerCode,
    providerMessage,
    transient: transientFailure(error, status, providerCode),
    retryAfterMs: retryAfterMs(error)
  };
  const failure = new EvaluatorModelError(
    status === 400 || status === 422
      ? "PROVIDER_CAPABILITY_UNSUPPORTED"
      : "PROVIDER_REQUEST_FAILED",
    detail
  );
  return { error: failure, detail };
}

/** Map SDK failures to the closed provider-neutral error surface. */
export function evaluatorModelErrorFromProvider(error: unknown): EvaluatorModelError {
  return classifyEvaluatorProviderFailure(error).error;
}
