import { createHash } from "node:crypto";

import canonicalize from "canonicalize";

/** Pure JSON values allowed in Domain hash inputs. */
export type DomainJsonValue =
  null | boolean | number | string | DomainJsonValue[] | DomainJsonObject;

/** Validated JSON object used by pure Domain models. */
export interface DomainJsonObject {
  /** JSON member values. */
  [key: string]: DomainJsonValue;
}

// Reject isolated UTF-16 surrogates as required by RFC 8785.
function isValidUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

// Validate the I-JSON subset before calling the RFC 8785 implementation.
function isCanonicalJsonValue(value: unknown): value is DomainJsonValue {
  if (value === null || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "string") return isValidUnicode(value);
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isCanonicalJsonValue);
  }
  if (typeof value !== "object") {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }
  return (
    Object.keys(value).every(isValidUnicode) && Object.values(value).every(isCanonicalJsonValue)
  );
}

/** Serialize one validated Domain fact using RFC 8785 JCS. */
export function canonicalJson(value: DomainJsonValue): string {
  if (!isCanonicalJsonValue(value)) {
    throw new Error("CANONICAL_JSON_INVALID");
  }
  const serialized: unknown = canonicalize(value);
  if (typeof serialized !== "string") {
    throw new Error("CANONICAL_JSON_INVALID");
  }
  return serialized;
}

/** Hash one canonical Domain fact using lowercase SHA-256. */
export function sha256CanonicalJson(value: DomainJsonValue): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
