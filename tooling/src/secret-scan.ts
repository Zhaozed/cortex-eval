/** A secret finding that never contains the matched value. */
export interface SecretFinding {
  /** Relative source file. */
  file: string;
  /** JSON path of the suspicious value. */
  path: string;
  /** Stable scanner rule. */
  rule: "CREDENTIAL_VALUE";
}

const SENSITIVE_KEYS = new Set([
  "accesskey",
  "accesskeyid",
  "accesstoken",
  "apikey",
  "authorization",
  "clientsecret",
  "credential",
  "password",
  "passwd",
  "privatekey",
  "pwd",
  "refreshtoken",
  "secret",
  "token"
]);
const CREDENTIAL_VALUE =
  /^(?:A(?:KIA|SIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{12,}|sk-[A-Za-z0-9._-]{8,}|ghp_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9._-]{8,}|(?:Bearer|Basic)\s+[A-Za-z0-9+/=._-]{8,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;
const SAFE_PLACEHOLDERS = new Set(["", "[REDACTED]", "<REDACTED>", "***"]);

// Normalize common snake_case, kebab-case and camelCase credential key spellings.
function normalizeKey(key: string): string {
  return key.replaceAll(/[^A-Za-z0-9]/g, "").toLowerCase();
}

// Generic credential fields are suspicious only when they carry a substantive value.
function isSensitiveFieldValue(key: string, value: string): boolean {
  const normalizedValue = value.trim();
  if (SAFE_PLACEHOLDERS.has(normalizedValue)) {
    return false;
  }
  return SENSITIVE_KEYS.has(normalizeKey(key));
}

// Recursively scan JSON without returning matched values.
export function scanJsonForSecrets(file: string, value: unknown): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const visit = (current: unknown, path: string): void => {
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (typeof current !== "object" || current === null) {
      return;
    }
    for (const [key, child] of Object.entries(current)) {
      const childPath = path === "" ? key : `${path}.${key}`;
      if (
        typeof child === "string" &&
        (isSensitiveFieldValue(key, child) || CREDENTIAL_VALUE.test(child.trim()))
      ) {
        findings.push({ file, path: childPath, rule: "CREDENTIAL_VALUE" });
      }
      visit(child, childPath);
    }
  };
  visit(value, "");
  return findings;
}
