/** Stable provider failure codes crossing the frozen Evaluator boundary. */
export type EvaluatorModelErrorCode = "PROVIDER_CAPABILITY_UNSUPPORTED" | "PROVIDER_REQUEST_FAILED";

/** Sanitized Evaluator failure that never retains a provider response payload. */
export class EvaluatorModelError extends Error {
  /** Stable platform error code. */
  readonly code: EvaluatorModelErrorCode;

  /** Build one provider-neutral failure. */
  constructor(code: EvaluatorModelErrorCode) {
    super(code);
    this.name = "EvaluatorModelError";
    this.code = code;
  }
}

// Read only the numeric HTTP status from an untrusted SDK error object.
function providerStatus(error: unknown): number | null {
  if (error === null || typeof error !== "object") return null;
  const source = error as Readonly<Record<string, unknown>>;
  const status = source.status;
  if (typeof status === "number" && Number.isInteger(status)) return status;
  const code = source.code;
  return typeof code === "number" && Number.isInteger(code) ? code : null;
}

/** Map SDK failures to the closed provider-neutral error surface. */
export function evaluatorModelErrorFromProvider(error: unknown): EvaluatorModelError {
  const status = providerStatus(error);
  return new EvaluatorModelError(
    status === 400 || status === 422 ? "PROVIDER_CAPABILITY_UNSUPPORTED" : "PROVIDER_REQUEST_FAILED"
  );
}
