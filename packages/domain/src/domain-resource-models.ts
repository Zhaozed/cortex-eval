import type { CaseDefinition } from "./domain-evaluation.ts";

/** Environment-only Secret reference used by clean Domain models. */
export interface EnvSecretRef {
  /** Stable reference discriminator. */
  readonly kind: "ENV_SECRET";
  /** Environment variable name, never its expanded value. */
  readonly envKey: string;
}

/** Safe literal Header value. */
export interface LiteralHeaderValue {
  /** Stable literal discriminator. */
  readonly kind: "LITERAL";
  /** Non-secret Header value. */
  readonly value: string;
}

/** Header value with explicit secret handling. */
export type EndpointHeaderValue = LiteralHeaderValue | EnvSecretRef;

/** Clean REST Endpoint configuration. */
export interface EndpointConfigDefinition {
  /** URL template with component-scoped `vars` selectors. */
  readonly urlTemplate: string;
  /** Current fixed HTTP method. */
  readonly method: "POST";
  /** Case-insensitive Header names and safe values. */
  readonly headers: Readonly<Record<string, EndpointHeaderValue>>;
  /** RFC 6901 pointer rooted at Case vars. */
  readonly bodySelector: string;
  /** Per-Case timeout. */
  readonly timeoutMs: number;
  /** Default REST concurrency for a new Run. */
  readonly defaultConcurrency: number;
}

/** LLM thinking capability level. */
export type ThinkingLevel = "OFF" | "LOW" | "MEDIUM" | "HIGH";

/** Required structured-output capability. */
export type StructuredOutputMode = "JSON_SCHEMA" | "JSON_OBJECT";

/** Fields shared by supported LLM providers. */
interface CommonLlmConfigDefinition {
  /** Provider model identifier. */
  readonly model: string;
  /** Requested thinking level. */
  readonly thinkingLevel: ThinkingLevel;
  /** Sampling temperature. */
  readonly temperature: number;
  /** Nucleus sampling value. */
  readonly topP: number;
  /** Maximum generated tokens. */
  readonly maxOutputTokens: number;
  /** Request timeout. */
  readonly timeoutMs: number;
  /** Required structured-output capability. */
  readonly structuredOutput: StructuredOutputMode;
}

/** Google Gemini configuration. */
export interface GeminiLlmConfigDefinition extends CommonLlmConfigDefinition {
  /** Provider discriminator. */
  readonly providerType: "GOOGLE_GEMINI";
  /** API key environment reference. */
  readonly apiKey: EnvSecretRef;
}

/** Bearer authentication for an OpenAI-compatible endpoint. */
export interface BearerEnvAuth {
  /** Authentication discriminator. */
  readonly kind: "BEARER_ENV";
  /** Bearer token environment reference. */
  readonly secret: EnvSecretRef;
}

/** Explicit no-auth choice for loopback endpoints only. */
export interface NoAuth {
  /** Authentication discriminator. */
  readonly kind: "NONE";
}

/** OpenAI-compatible Chat Completions configuration. */
export interface OpenAiCompatibleLlmConfigDefinition extends CommonLlmConfigDefinition {
  /** Provider discriminator. */
  readonly providerType: "OPENAI_COMPATIBLE";
  /** Chat Completions base URL. */
  readonly baseUrl: string;
  /** Explicit authentication strategy. */
  readonly auth: BearerEnvAuth | NoAuth;
}

/** Supported clean LLM configuration union. */
export type LlmConfigDefinition = GeminiLlmConfigDefinition | OpenAiCompatibleLlmConfigDefinition;

/** Prompt message role. */
export type PromptMessageRole = "SYSTEM" | "USER" | "ASSISTANT";

/** Ordered Prompt message. */
export interface PromptMessage {
  /** Message role. */
  readonly role: PromptMessageRole;
  /** Message or template content. */
  readonly content: string;
}

/** Current LLM Rubric Prompt definition. */
export interface PromptDefinition {
  /** Prompt family discriminator. */
  readonly kind: "LLM_RUBRIC";
  /** Stable current Prompt key. */
  readonly promptKey: string;
  /** Ordered messages. */
  readonly messages: readonly PromptMessage[];
}

/** Current Case Analysis Prompt definition. */
export interface AnalysisPromptDefinition {
  /** Prompt family discriminator. */
  readonly kind: "CASE_ANALYSIS";
  /** Stable current Prompt key. */
  readonly promptKey: string;
  /** Ordered template messages. */
  readonly messages: readonly PromptMessage[];
}

/** Resource validation error without presentation text. */
export interface ResourceDefinitionError {
  /** Stable Domain error code. */
  readonly code:
    "ENDPOINT_CONFIG_INVALID" | "LLM_CONFIG_INVALID" | "PROMPT_INVALID" | "ANALYSIS_PROMPT_INVALID";
  /** Stable invalid fact path. */
  readonly path: string;
}

/** Exact resource validation result. */
export type ResourceValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ResourceDefinitionError };

const SAFE_LITERAL_HEADERS = new Set(["content-type", "accept", "user-agent"]);
const THINKING_LEVELS: ReadonlySet<string> = new Set(["OFF", "LOW", "MEDIUM", "HIGH"]);
const STRUCTURED_OUTPUT_MODES: ReadonlySet<string> = new Set(["JSON_SCHEMA", "JSON_OBJECT"]);
const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const SENSITIVE_QUERY_NAME = /(key|token|secret|credential|password|auth)/i;
const ENV_KEY = /^[A-Z][A-Z0-9_]*$/;
const PROMPT_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const JSON_POINTER = /^(?:\/(?:[^~/]|~0|~1)*)*$/;
const JSON_STRING_SELECTOR = String.raw`"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9A-Fa-f]{4}))*"`;
const ENDPOINT_PLACEHOLDER = new RegExp(
  String.raw`\{\{\s*vars(?:(?:\.[A-Za-z_$][A-Za-z0-9_$]*)|(?:\[(?:${JSON_STRING_SELECTOR}|(?:0|[1-9][0-9]*))\]))+\s*\}\}`,
  "g"
);
const TEMPLATE_VARIABLE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const ALLOWED_ANALYSIS_VARIABLES = new Set([
  "case_definition",
  "provider_output",
  "failed_assertions",
  "expected_actual_diffs",
  "llm_rubric_results",
  "run_context"
]);

// Validate one environment reference without reading process state.
function isValidEnvSecretRef(value: EnvSecretRef): boolean {
  return ENV_KEY.test(value.envKey);
}

// Validate the rendered URL shape while preserving selector placement rules.
function isSafeEndpointTemplate(value: string): boolean {
  const authority = /^[a-z]+:\/\/([^/?#]+)/i.exec(value)?.[1];
  if (authority === undefined || authority.includes("{{")) return false;
  const queryStart = value.indexOf("?");
  const rawQuery = queryStart < 0 ? null : (value.slice(queryStart + 1).split("#")[0] ?? "");
  const hasDynamicQueryName = (rawQuery?.split("&") ?? []).some((parameter) => {
    const name = parameter.split("=")[0] ?? "";
    return name.includes("{{") || name.includes("}}");
  });
  if (hasDynamicQueryName) return false;
  try {
    const rendered = value.replaceAll(ENDPOINT_PLACEHOLDER, "placeholder");
    if (rendered.includes("{{") || rendered.includes("}}")) return false;
    const url = new URL(rendered);
    const sensitiveQuery = [...url.searchParams.keys()].some((name) =>
      SENSITIVE_QUERY_NAME.test(name)
    );
    return (
      !sensitiveQuery &&
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

/** Validate a clean Endpoint configuration and its security constraints. */
export function validateEndpointConfig(
  value: EndpointConfigDefinition
): ResourceValidationResult<EndpointConfigDefinition> {
  if (!isSafeEndpointTemplate(value.urlTemplate)) {
    return { ok: false, error: { code: "ENDPOINT_CONFIG_INVALID", path: "urlTemplate" } };
  }
  if (!JSON_POINTER.test(value.bodySelector)) {
    return { ok: false, error: { code: "ENDPOINT_CONFIG_INVALID", path: "bodySelector" } };
  }
  if (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 100 || value.timeoutMs > 600_000) {
    return { ok: false, error: { code: "ENDPOINT_CONFIG_INVALID", path: "timeoutMs" } };
  }
  if (
    !Number.isInteger(value.defaultConcurrency) ||
    value.defaultConcurrency < 1 ||
    value.defaultConcurrency > 64
  ) {
    return {
      ok: false,
      error: { code: "ENDPOINT_CONFIG_INVALID", path: "defaultConcurrency" }
    };
  }
  const normalizedHeaderNames = new Set<string>();
  for (const [name, header] of Object.entries(value.headers)) {
    const normalizedName = name.toLowerCase();
    if (!HTTP_TOKEN.test(name) || normalizedHeaderNames.has(normalizedName)) {
      return { ok: false, error: { code: "ENDPOINT_CONFIG_INVALID", path: "headers" } };
    }
    normalizedHeaderNames.add(normalizedName);
    if (header.kind === "LITERAL" && !SAFE_LITERAL_HEADERS.has(normalizedName)) {
      return {
        ok: false,
        error: { code: "ENDPOINT_CONFIG_INVALID", path: `headers.${name}` }
      };
    }
    if (header.kind === "ENV_SECRET" && !isValidEnvSecretRef(header)) {
      return {
        ok: false,
        error: { code: "ENDPOINT_CONFIG_INVALID", path: `headers.${name}` }
      };
    }
  }
  return { ok: true, value };
}

// Validate fields common to both supported LLM providers.
function commonLlmError(value: LlmConfigDefinition): string | null {
  if (value.model.trim() === "") return "model";
  if (!THINKING_LEVELS.has(value.thinkingLevel)) return "thinkingLevel";
  if (!Number.isFinite(value.temperature) || value.temperature < 0 || value.temperature > 2) {
    return "temperature";
  }
  if (!Number.isFinite(value.topP) || value.topP < 0 || value.topP > 1) return "topP";
  if (!Number.isInteger(value.maxOutputTokens) || value.maxOutputTokens <= 0) {
    return "maxOutputTokens";
  }
  if (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 100 || value.timeoutMs > 600_000) {
    return "timeoutMs";
  }
  if (!STRUCTURED_OUTPUT_MODES.has(value.structuredOutput)) return "structuredOutput";
  return null;
}

/** Validate a clean supported LLM configuration. */
export function validateLlmConfig(
  value: LlmConfigDefinition
): ResourceValidationResult<LlmConfigDefinition> {
  const commonError = commonLlmError(value);
  if (commonError !== null) {
    return { ok: false, error: { code: "LLM_CONFIG_INVALID", path: commonError } };
  }
  if (value.providerType === "GOOGLE_GEMINI") {
    return isValidEnvSecretRef(value.apiKey)
      ? { ok: true, value }
      : { ok: false, error: { code: "LLM_CONFIG_INVALID", path: "apiKey" } };
  }
  try {
    const url = new URL(value.baseUrl);
    const loopback =
      url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    const invalidShape =
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "";
    if (invalidShape) {
      return { ok: false, error: { code: "LLM_CONFIG_INVALID", path: "baseUrl" } };
    }
    if (!loopback && (url.protocol !== "https:" || value.auth.kind !== "BEARER_ENV")) {
      return { ok: false, error: { code: "LLM_CONFIG_INVALID", path: "auth" } };
    }
    if (value.auth.kind === "BEARER_ENV" && !isValidEnvSecretRef(value.auth.secret)) {
      return { ok: false, error: { code: "LLM_CONFIG_INVALID", path: "auth.secret" } };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, error: { code: "LLM_CONFIG_INVALID", path: "baseUrl" } };
  }
}

// Validate the shared Prompt identity and message facts.
function promptError(value: PromptDefinition | AnalysisPromptDefinition): string | null {
  if (!PROMPT_KEY.test(value.promptKey)) return "promptKey";
  if (value.messages.length === 0) return "messages";
  const invalidIndex = value.messages.findIndex((message) => message.content.trim() === "");
  return invalidIndex < 0 ? null : `messages[${invalidIndex}].content`;
}

/** Validate an LLM Rubric Prompt. */
export function validatePrompt(
  value: PromptDefinition
): ResourceValidationResult<PromptDefinition> {
  const path = promptError(value);
  return path === null
    ? { ok: true, value }
    : { ok: false, error: { code: "PROMPT_INVALID", path } };
}

/** Collect stable unique Analysis Prompt template variables. */
export function collectAnalysisPromptVariables(value: AnalysisPromptDefinition): readonly string[] {
  const variables = new Set<string>();
  for (const message of value.messages) {
    for (const match of message.content.matchAll(TEMPLATE_VARIABLE)) {
      const variable = match[1];
      if (variable !== undefined) variables.add(variable);
    }
  }
  return [...variables].sort((left, right) => left.localeCompare(right));
}

/** Validate a Case Analysis Prompt and its closed variable set. */
export function validateAnalysisPrompt(
  value: AnalysisPromptDefinition
): ResourceValidationResult<AnalysisPromptDefinition> {
  const path = promptError(value);
  if (path !== null) {
    return { ok: false, error: { code: "ANALYSIS_PROMPT_INVALID", path } };
  }
  const residualExpression = value.messages.some((message) => {
    const rendered = message.content.replaceAll(TEMPLATE_VARIABLE, "variable");
    return rendered.includes("{{") || rendered.includes("}}");
  });
  if (residualExpression) {
    return {
      ok: false,
      error: { code: "ANALYSIS_PROMPT_INVALID", path: "messages.variables" }
    };
  }
  if (collectAnalysisPromptVariables(value).some((item) => !ALLOWED_ANALYSIS_VARIABLES.has(item))) {
    return {
      ok: false,
      error: { code: "ANALYSIS_PROMPT_INVALID", path: "messages.variables" }
    };
  }
  return { ok: true, value };
}

// Recursively visit Assertions without exposing mutation.
function visitRubricPromptKeys(definition: CaseDefinition, keys: Set<string>): void {
  const visit = (assertions: CaseDefinition["assertions"]): void => {
    for (const assertion of assertions) {
      if (assertion.rubricPrompt?.startsWith("prompt://") === true) {
        keys.add(assertion.rubricPrompt.slice("prompt://".length));
      }
      if (assertion.assertions !== undefined) visit(assertion.assertions);
    }
  };
  visit(definition.assertions);
}

/** Collect sorted unique Rubric Prompt keys referenced by a Case. */
export function collectRubricPromptKeys(definition: CaseDefinition): readonly string[] {
  const keys = new Set<string>();
  visitRubricPromptKeys(definition, keys);
  return [...keys].sort((left, right) => left.localeCompare(right));
}
