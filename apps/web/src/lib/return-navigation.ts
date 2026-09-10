import { resolveWebRoute } from "./web-route.ts";

export const RETURN_PATH_KEY = "cortexEvalReturnPath";

/** Only go back to an entry created by this app. Direct links fall back to the Run list. */
export function returnFromRun(onNavigate: (path: string) => void): void {
  const state: unknown = window.history.state;
  const record = state && typeof state === "object" ? (state as Record<string, unknown>) : {};
  const from = record[RETURN_PATH_KEY];
  if (
    typeof from === "string" &&
    from.startsWith("/") &&
    !from.startsWith("//") &&
    resolveWebRoute(from.split(/[?#]/)[0] ?? "") !== null &&
    typeof record.cortexEvalHistoryPosition === "number" &&
    record.cortexEvalHistoryPosition > 0
  ) {
    window.history.back();
  } else {
    onNavigate("/runs");
  }
}
