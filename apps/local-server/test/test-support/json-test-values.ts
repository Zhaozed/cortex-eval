/** Minimal response boundary used by HTTP contract tests. */
export interface TextResponse {
  /** Raw response body. */
  readonly body: string;
}

// Parse an untrusted response body and require a non-array JSON object.
export function parseJsonObject(response: TextResponse): Readonly<Record<string, unknown>> {
  const value: unknown = JSON.parse(response.body);
  return requireJsonObject(value);
}

// Require an untrusted value to be a non-array JSON object.
export function requireJsonObject(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("TEST_RESPONSE_OBJECT_EXPECTED");
  }
  return value as Readonly<Record<string, unknown>>;
}

// Parse an untrusted response body and require a JSON array.
export function parseJsonArray(response: TextResponse): readonly unknown[] {
  const value: unknown = JSON.parse(response.body);
  if (!Array.isArray(value)) throw new Error("TEST_RESPONSE_ARRAY_EXPECTED");
  return value;
}

// Require one object property from already-cleaned JSON data.
export function jsonObjectProperty(
  value: Readonly<Record<string, unknown>>,
  key: string
): Readonly<Record<string, unknown>> {
  const property = value[key];
  if (property === null || typeof property !== "object" || Array.isArray(property)) {
    throw new Error("TEST_RESPONSE_OBJECT_PROPERTY_EXPECTED");
  }
  return property as Readonly<Record<string, unknown>>;
}

// Require one array property from already-cleaned JSON data.
export function jsonArrayProperty(
  value: Readonly<Record<string, unknown>>,
  key: string
): readonly unknown[] {
  const property = value[key];
  if (!Array.isArray(property)) throw new Error("TEST_RESPONSE_ARRAY_PROPERTY_EXPECTED");
  return property;
}

// Require one string property from already-cleaned JSON data.
export function jsonStringProperty(value: Readonly<Record<string, unknown>>, key: string): string {
  const property = value[key];
  if (typeof property !== "string") throw new Error("TEST_RESPONSE_STRING_PROPERTY_EXPECTED");
  return property;
}
