import { WORK_PACKAGE_RUNTIME_LIMITS } from "@cortex-eval/contracts/src/work-package-runtime-contracts.ts";

/** Reject any decoded JSON key or string value beyond the fixed runtime byte limit. */
export function validateDecodedJsonStringBytes(value: unknown, errorCode: string): void {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (Buffer.byteLength(current, "utf8") > WORK_PACKAGE_RUNTIME_LIMITS.decodedJsonStringBytes) {
        throw new Error(errorCode);
      }
      continue;
    }
    if (Array.isArray(current)) {
      for (const item of current) pending.push(item);
      continue;
    }
    if (current === null || typeof current !== "object") continue;
    for (const [key, item] of Object.entries(current)) {
      if (Buffer.byteLength(key, "utf8") > WORK_PACKAGE_RUNTIME_LIMITS.decodedJsonStringBytes) {
        throw new Error(errorCode);
      }
      pending.push(item);
    }
  }
}
