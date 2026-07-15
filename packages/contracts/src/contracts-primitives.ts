import { z } from "zod";

/** RFC 9562 UUIDv7 text used for application-generated internal IDs. */
export const UuidV7Schema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "UUID_V7_INVALID"
  );

/** UTC ISO 8601 timestamp with an explicit Z suffix. */
export const UtcDateTimeSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/, "UTC_DATETIME_INVALID")
  .refine((value) => {
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) return false;
    const normalized = value.includes(".") ? value : value.replace("Z", ".000Z");
    return parsed.toISOString() === normalized;
  }, "UTC_DATETIME_INVALID");

/** Lowercase hexadecimal SHA-256 digest. */
export const HashSha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "SHA256_INVALID");

/** Canonical alias used by protocol field declarations. */
export const Sha256Schema = HashSha256Schema;

/** Non-empty stable business key. */
export const BusinessKeySchema = z.string().trim().min(1).max(256);

/** RFC 6901 JSON Pointer, including the empty document-root pointer. */
export const JsonPointerSchema = z
  .string()
  .regex(/^(?:\/(?:[^~/]|~[01])*)*$/, "JSON_POINTER_INVALID");

/** Controlled relative POSIX path without traversal or absolute roots. */
export const RelativePathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "RELATIVE_PATH_INVALID"
  );

/** Explicit POSIX-path alias used by file protocols. */
export const RelativePosixPathSchema = RelativePathSchema;

/** JSON value accepted at serialized protocol boundaries. */
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Recursive finite JSON value. */
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema)
  ])
);

/** JSON object with no non-JSON values. */
export const JsonObjectSchema = z.record(z.string(), JsonValueSchema);
