import type {
  FrozenRunCase,
  FrozenRunEndpoint
} from "@cortex-eval/application/src/features/runs/run-rest-models.ts";

type EndpointHeaderValue = FrozenRunEndpoint["headers"][string];

/** Exact maximum encoded REST request body size. */
export const MAX_REST_REQUEST_BYTES = 5 * 1024 * 1024;

/** Environment-only secret reader that never exposes a secret reference to Domain code. */
export type SecretReader = (envKey: string) => string | undefined;

/** Fully rendered and bounded request ready for network execution. */
export interface PreparedRestRequest {
  /** Safe rendered URL. */
  readonly url: string;
  /** Expanded request headers. */
  readonly headers: Headers;
  /** UTF-8 JSON body bytes. */
  readonly body: Uint8Array;
  /** Per-Case timeout. */
  readonly timeoutMs: number;
}

/** Stable request preparation failure without dirty input or secret data. */
export class RestPreparationError extends Error {
  /** Stable Run error classification. */
  readonly code = "TEMPLATE_INPUT" as const;

  /** Create one redacted request preparation error. */
  constructor() {
    super("TEMPLATE_INPUT");
    this.name = "RestPreparationError";
  }
}

type RequestVariables = Readonly<{
  task: unknown;
  request_body: unknown;
}>;

const RAW_INT64_SENTINEL = "__cortex_eval_int64";
const INT64_DECIMAL_PATTERN = /^(?:0|[1-9][0-9]{0,18})$/;
const MAX_INT64 = 9_223_372_036_854_775_807n;

const JSON_STRING_SELECTOR = String.raw`"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9A-Fa-f]{4}))*"`;
const URL_PLACEHOLDER = new RegExp(
  String.raw`\{\{\s*(vars(?:(?:\.[A-Za-z_$][A-Za-z0-9_$]*)|(?:\[(?:${JSON_STRING_SELECTOR}|(?:0|[1-9][0-9]*))\]))+)\s*\}\}`,
  "g"
);

// Return one own-property value without allowing prototype traversal.
function readOwn(container: unknown, key: string): unknown {
  if (container === null || typeof container !== "object") {
    throw new RestPreparationError();
  }
  if (!Object.prototype.hasOwnProperty.call(container, key)) {
    throw new RestPreparationError();
  }
  return (container as Readonly<Record<string, unknown>>)[key];
}

// Parse and resolve one already grammar-constrained vars selector.
function resolveTemplateSelector(selector: string, variables: RequestVariables): unknown {
  let position = "vars".length;
  let current: unknown = variables;
  while (position < selector.length) {
    if (selector[position] === ".") {
      const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(selector.slice(position + 1));
      if (match === null) throw new RestPreparationError();
      current = readOwn(current, match[0]);
      position += match[0].length + 1;
      continue;
    }
    if (selector[position] !== "[") throw new RestPreparationError();
    const closing = selector.indexOf("]", position + 1);
    if (closing < 0) throw new RestPreparationError();
    const rawKey = selector.slice(position + 1, closing);
    let key: string;
    try {
      key = rawKey.startsWith('"') ? String(JSON.parse(rawKey)) : rawKey;
    } catch {
      throw new RestPreparationError();
    }
    current = readOwn(current, key);
    position = closing + 1;
  }
  return current;
}

// Render each placeholder as exactly one encoded URL component.
function renderUrl(template: string, variables: RequestVariables): string {
  const authority = /^[a-z]+:\/\/([^/?#]+)/i.exec(template)?.[1];
  if (authority === undefined || authority.includes("{{")) {
    throw new RestPreparationError();
  }
  let replacedCount = 0;
  const rendered = template.replace(URL_PLACEHOLDER, (_placeholder, selector: string) => {
    replacedCount += 1;
    const value = resolveTemplateSelector(selector, variables);
    if (typeof value === "string") return encodeURIComponent(value);
    if (typeof value === "number" || typeof value === "boolean") {
      return encodeURIComponent(`${value}`);
    }
    throw new RestPreparationError();
  });
  const templateMarkers = template.match(/\{\{/g)?.length ?? 0;
  if (rendered.includes("{{") || rendered.includes("}}") || replacedCount !== templateMarkers) {
    throw new RestPreparationError();
  }

  try {
    const reference = new URL(template.replace(URL_PLACEHOLDER, "placeholder"));
    const actual = new URL(rendered);
    const unchangedAuthority =
      actual.protocol === reference.protocol &&
      actual.hostname === reference.hostname &&
      actual.port === reference.port;
    if (
      !unchangedAuthority ||
      (actual.protocol !== "http:" && actual.protocol !== "https:") ||
      actual.username !== "" ||
      actual.password !== "" ||
      actual.hash !== ""
    ) {
      throw new RestPreparationError();
    }
    return actual.toString();
  } catch (error) {
    if (error instanceof RestPreparationError) throw error;
    throw new RestPreparationError();
  }
}

// Decode one RFC 6901 token.
function decodePointerToken(token: string): string {
  if (/~(?:[^01]|$)/.test(token)) throw new RestPreparationError();
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}

// Select a non-null JSON object rooted at the strict request variables object.
function selectBody(
  pointer: string,
  variables: RequestVariables
): Readonly<Record<string, unknown>> {
  let current: unknown = variables;
  if (pointer !== "") {
    if (!pointer.startsWith("/")) throw new RestPreparationError();
    for (const token of pointer.slice(1).split("/")) {
      current = readOwn(current, decodePointerToken(token));
    }
  }
  if (current === null || typeof current !== "object" || Array.isArray(current)) {
    throw new RestPreparationError();
  }
  return current as Readonly<Record<string, unknown>>;
}

// Serialize explicit int64 markers as raw JSON numbers so IDs beyond JS safe integer stay exact.
function serializeJsonWithRawInt64(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RestPreparationError();
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeJsonWithRawInt64(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const source = value as Readonly<Record<string, unknown>>;
    const keys = Object.keys(source);
    if (keys.length === 1 && keys[0] === RAW_INT64_SENTINEL) {
      const rawValue = source[RAW_INT64_SENTINEL];
      if (typeof rawValue !== "string" || !INT64_DECIMAL_PATTERN.test(rawValue)) {
        throw new RestPreparationError();
      }
      if (BigInt(rawValue) > MAX_INT64) throw new RestPreparationError();
      return rawValue;
    }
    return `{${Object.entries(source)
      .map(([key, item]) => `${JSON.stringify(key)}:${serializeJsonWithRawInt64(item)}`)
      .join(",")}}`;
  }
  throw new RestPreparationError();
}

// Expand one header value at the process boundary.
function expandHeader(value: EndpointHeaderValue, readSecret: SecretReader): string {
  if (value.kind === "LITERAL") return value.value;
  const secret = readSecret(value.envKey);
  if (secret === undefined) throw new RestPreparationError();
  return secret;
}

// Expand headers while rejecting case-insensitive duplicates.
function prepareHeaders(
  definitions: Readonly<Record<string, EndpointHeaderValue>>,
  readSecret: SecretReader
): Headers {
  const headers = new Headers();
  const normalizedNames = new Set<string>();
  for (const [name, value] of Object.entries(definitions)) {
    const normalizedName = name.toLowerCase();
    if (normalizedNames.has(normalizedName)) throw new RestPreparationError();
    normalizedNames.add(normalizedName);
    try {
      headers.set(name, expandHeader(value, readSecret));
    } catch (error) {
      if (error instanceof RestPreparationError) throw error;
      throw new RestPreparationError();
    }
  }
  return headers;
}

/** Render and validate one frozen Case request before any network side effect. */
export function prepareRestRequest(
  testCase: FrozenRunCase,
  endpoint: FrozenRunEndpoint,
  readSecret: SecretReader
): PreparedRestRequest {
  const variables: RequestVariables = {
    task: testCase.definition.task,
    request_body: testCase.definition.requestBody
  };
  const url = renderUrl(endpoint.urlTemplate, variables);
  const selectedBody = selectBody(endpoint.bodySelector, variables);
  let bodyText: string;
  try {
    bodyText = serializeJsonWithRawInt64(selectedBody);
  } catch {
    throw new RestPreparationError();
  }
  const body = new TextEncoder().encode(bodyText);
  if (body.byteLength > MAX_REST_REQUEST_BYTES) throw new RestPreparationError();
  return {
    url,
    headers: prepareHeaders(endpoint.headers, readSecret),
    body,
    timeoutMs: endpoint.timeoutMs
  };
}
