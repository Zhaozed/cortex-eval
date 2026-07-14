const SENSITIVE_KEY_SEGMENTS = new Set([
  "auth",
  "authentication",
  "authorization",
  "bearer",
  "credential",
  "credentials",
  "dependencies",
  "dependency",
  "import",
  "module",
  "modules",
  "npm",
  "oauth",
  "package",
  "packages",
  "password",
  "pip",
  "provider",
  "require",
  "secret",
  "token"
]);

const COMPACT_SENSITIVE_MARKERS = [
  "accesskey",
  "apikey",
  "authorization",
  "bearer",
  "credential",
  "dependencies",
  "dependency",
  "module",
  "npm",
  "oauth",
  "package",
  "password",
  "pip",
  "privatekey",
  "provider",
  "secret"
] as const;

const SAFE_TOKEN_KEY_PREFIXES = ["tokenizer", "tokenization", "tokens"] as const;

const EXTERNAL_REFERENCE_PREFIXES = [
  "file://",
  "module:",
  "node:",
  "npm:",
  "package:",
  "pip:"
] as const;

// Split separators, camelCase and acronym boundaries without treating plural count fields as Secrets.
function configKeySegments(key: string): readonly string[] {
  return key
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((segment) => segment !== "");
}

// Detect owned Provider fields and common authentication or Secret key forms.
function configKeyIsSensitive(key: string): boolean {
  const segments = configKeySegments(key);
  if (segments.some((segment) => SENSITIVE_KEY_SEGMENTS.has(segment))) return true;
  if (segments.some((segment, index) => segment === "api" && segments[index + 1] === "key")) {
    return true;
  }
  const compact = segments.join("");
  if (COMPACT_SENSITIVE_MARKERS.some((marker) => compact.includes(marker))) return true;
  if (compact.startsWith("auth")) return true;
  const withoutSafeTokenWords = SAFE_TOKEN_KEY_PREFIXES.reduce(
    (value, safeWord) => value.replaceAll(safeWord, ""),
    compact
  );
  if (withoutSafeTokenWords.includes("token")) return true;
  return compact.startsWith("api") && compact.endsWith("key");
}

// Normalize only protocol detection; arbitrary expected text remains untouched.
function externalReferenceStringIsUnsafe(value: string): boolean {
  const normalized = value.trimStart().toLowerCase();
  return EXTERNAL_REFERENCE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/** Recursively detect external executable or package references without inspecting object keys. */
export function assertionExternalReferenceIsUnsafe(value: unknown): boolean {
  if (typeof value === "string") {
    return externalReferenceStringIsUnsafe(value);
  }
  if (Array.isArray(value)) return value.some(assertionExternalReferenceIsUnsafe);
  if (value === null || typeof value !== "object") return false;
  return Object.values(value).some(assertionExternalReferenceIsUnsafe);
}

/** Recursively reject Provider, authentication, dependency, Secret and external entries. */
export function assertionConfigEntryIsUnsafe(value: unknown): boolean {
  if (typeof value === "string") return externalReferenceStringIsUnsafe(value);
  if (Array.isArray(value)) return value.some(assertionConfigEntryIsUnsafe);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, item]) => configKeyIsSensitive(key) || assertionConfigEntryIsUnsafe(item)
  );
}
