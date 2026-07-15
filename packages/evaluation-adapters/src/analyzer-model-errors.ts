/** Stable Analyzer failure codes crossing the official-SDK boundary. */
export type AnalyzerModelErrorCode =
  | "ANALYZER_CONFIG_INVALID"
  | "ANALYZER_SECRET_MISSING"
  | "ANALYZER_PROVIDER_CAPABILITY_UNSUPPORTED"
  | "ANALYZER_PROVIDER_REQUEST_FAILED"
  | "ANALYZER_INPUT_TOO_LARGE"
  | "ANALYZER_OUTPUT_TOO_LARGE"
  | "ANALYZER_OUTPUT_INVALID"
  | "ANALYZER_CANCELLED";

/** Sanitized Analyzer failure that never retains prompts, payloads or Secrets. */
export class AnalyzerModelError extends Error {
  /** Stable provider-neutral error code. */
  readonly code: AnalyzerModelErrorCode;

  /** Build one safe Analysis model failure. */
  constructor(code: AnalyzerModelErrorCode) {
    super(code);
    this.name = "AnalyzerModelError";
    this.code = code;
  }
}

// Read only the numeric HTTP status from an untrusted SDK error object.
function providerStatus(error: unknown): number | null {
  if (error === null || typeof error !== "object") return null;
  const source = error as Readonly<Record<string, unknown>>;
  if (typeof source.status === "number" && Number.isInteger(source.status)) {
    return source.status;
  }
  return typeof source.code === "number" && Number.isInteger(source.code) ? source.code : null;
}

/** Map one SDK failure to the closed Analyzer error surface. */
export function analyzerModelErrorFromProvider(
  error: unknown,
  signal: AbortSignal
): AnalyzerModelError {
  if (signal.aborted) return new AnalyzerModelError("ANALYZER_CANCELLED");
  const status = providerStatus(error);
  return new AnalyzerModelError(
    status === 400 || status === 422
      ? "ANALYZER_PROVIDER_CAPABILITY_UNSUPPORTED"
      : "ANALYZER_PROVIDER_REQUEST_FAILED"
  );
}
