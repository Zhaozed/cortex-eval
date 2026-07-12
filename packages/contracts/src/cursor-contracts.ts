import { z } from "zod";

import { UuidV7Schema } from "./contracts-primitives.ts";

/** Decoded stable Case cursor. */
export interface CaseCursorV1 {
  /** Cursor protocol version. */
  version: 1;
  /** Last Case ordinal. */
  ordinal: number;
  /** Internal ID tie-breaker. */
  id: string;
}

const CaseCursorV1Schema = z.strictObject({
  version: z.literal(1),
  ordinal: z.number().int().nonnegative(),
  id: UuidV7Schema
});

// Convert UTF-8 bytes to URL-safe Base64 without a Node-only Buffer dependency.
function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

// Decode URL-safe Base64 and reject malformed UTF-8.
function decodeBase64Url(value: string): string {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(`${base64}${padding}`);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** Encode a validated versioned Case cursor. */
export function encodeCaseCursorV1(value: CaseCursorV1): string {
  const payload = CaseCursorV1Schema.parse(value);
  return `cur_v1_${encodeBase64Url(JSON.stringify(payload))}`;
}

/** Decode one opaque Case cursor or throw a stable boundary error. */
export function decodeCaseCursorV1(cursor: string): CaseCursorV1 {
  if (!cursor.startsWith("cur_v1_")) {
    throw new Error("CURSOR_VERSION_UNSUPPORTED");
  }
  try {
    const content = decodeBase64Url(cursor.slice("cur_v1_".length));
    return CaseCursorV1Schema.parse(JSON.parse(content) as unknown);
  } catch {
    throw new Error("CURSOR_INVALID");
  }
}
