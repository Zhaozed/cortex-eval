import { z } from "zod";

import { JsonObjectSchema } from "./contracts-primitives.ts";

/** Environment-only Secret reference. */
export const EnvSecretRefSchema = z.strictObject({
  kind: z.literal("ENV_SECRET"),
  envKey: z.string().regex(/^[A-Z][A-Z0-9_]*$/)
});

/** Safe literal Header value. */
const LiteralHeaderValueSchema = z.strictObject({
  kind: z.literal("LITERAL"),
  value: z.string()
});

const HeaderValueSchema = z.discriminatedUnion("kind", [
  LiteralHeaderValueSchema,
  EnvSecretRefSchema
]);

const SAFE_LITERAL_HEADERS = new Set(["content-type", "accept", "user-agent"]);
const SENSITIVE_QUERY_NAME = /(key|token|secret|credential|password|auth)/i;
const JSON_STRING_SELECTOR = String.raw`"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9A-Fa-f]{4}))*"`;
const ENDPOINT_PLACEHOLDER = new RegExp(
  String.raw`\{\{\s*vars(?:(?:\.[A-Za-z_$][A-Za-z0-9_$]*)|(?:\[(?:${JSON_STRING_SELECTOR}|(?:0|[1-9][0-9]*))\]))+\s*\}\}`,
  "g"
);

// Validate the URL shape after replacing safe scalar placeholders.
function isSafeEndpointTemplate(value: string): boolean {
  const authority = /^[a-z]+:\/\/([^/?#]+)/i.exec(value)?.[1];
  if (authority === undefined || authority.includes("{{")) {
    return false;
  }
  const rawQuery = value.includes("?")
    ? (value.slice(value.indexOf("?") + 1).split("#")[0] ?? "")
    : null;
  const rawParameters = rawQuery?.split("&") ?? [];
  const hasDynamicQueryName = rawParameters
    .map((parameter) => parameter.split("=")[0] ?? "")
    .some((name) => name.includes("{{") || name.includes("}}"));
  if (hasDynamicQueryName) {
    return false;
  }
  try {
    const rendered = value.replaceAll(ENDPOINT_PLACEHOLDER, "placeholder");
    if (rendered.includes("{{") || rendered.includes("}}")) return false;
    const url = new URL(rendered);
    if ([...url.searchParams.keys()].some((name) => SENSITIVE_QUERY_NAME.test(name))) {
      return false;
    }
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

/** REST Endpoint configuration. */
export const EndpointConfigV1Schema = z
  .strictObject({
    contractVersion: z.literal("cortex.endpoint-config.v1"),
    urlTemplate: z.string().refine(isSafeEndpointTemplate, "ENDPOINT_URL_INVALID"),
    method: z.literal("POST"),
    headers: z.record(z.string().min(1), HeaderValueSchema),
    bodySelector: z.string().regex(/^(?:\/(?:[^~/]|~0|~1)*)*$/, "JSON_POINTER_INVALID"),
    timeoutMs: z.number().int().min(100).max(600_000),
    defaultConcurrency: z.number().int().min(1).max(64)
  })
  .superRefine((endpoint, context) => {
    for (const [name, value] of Object.entries(endpoint.headers)) {
      if (value.kind === "LITERAL" && !SAFE_LITERAL_HEADERS.has(name.toLowerCase())) {
        context.addIssue({
          code: "custom",
          path: ["headers", name],
          message: "HEADER_SECRET_REF_REQUIRED"
        });
      }
    }
  });

const ThinkingLevelSchema = z.enum(["OFF", "LOW", "MEDIUM", "HIGH"]);
const StructuredOutputSchema = z.enum(["JSON_SCHEMA", "JSON_OBJECT"]);

const CommonLlmConfigShape = {
  contractVersion: z.literal("cortex.llm-config.v1"),
  model: z.string().trim().min(1),
  thinkingLevel: ThinkingLevelSchema,
  temperature: z.number().min(0).max(2),
  topP: z.number().min(0).max(1),
  maxOutputTokens: z.number().int().positive(),
  timeoutMs: z.number().int().min(100).max(600_000),
  structuredOutput: StructuredOutputSchema
};

/** Google Gemini-only LLM configuration used by provider-specific boundaries. */
export const GeminiLlmConfigV1Schema = z.strictObject({
  ...CommonLlmConfigShape,
  providerType: z.literal("GOOGLE_GEMINI"),
  apiKey: EnvSecretRefSchema
});

const OpenAiAuthSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("BEARER_ENV"), secret: EnvSecretRefSchema }),
  z.strictObject({ kind: z.literal("NONE") })
]);

const OpenAiCompatibleLlmConfigV1Schema = z
  .strictObject({
    ...CommonLlmConfigShape,
    providerType: z.literal("OPENAI_COMPATIBLE"),
    baseUrl: z.url(),
    auth: OpenAiAuthSchema
  })
  .superRefine((config, context) => {
    const url = new URL(config.baseUrl);
    const loopback =
      url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      context.addIssue({ code: "custom", path: ["baseUrl"], message: "LLM_BASE_URL_INVALID" });
    }
    if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
      context.addIssue({ code: "custom", path: ["baseUrl"], message: "LLM_BASE_URL_INVALID" });
    }
    if (!loopback && (url.protocol !== "https:" || config.auth.kind !== "BEARER_ENV")) {
      context.addIssue({ code: "custom", path: ["auth"], message: "LLM_REMOTE_AUTH_REQUIRED" });
    }
  });

/** Unified evaluator/analyzer LLM configuration. */
export const LlmConfigV1Schema = z.discriminatedUnion("providerType", [
  GeminiLlmConfigV1Schema,
  OpenAiCompatibleLlmConfigV1Schema
]);

/** Endpoint configuration DTO. */
export type EndpointConfigV1 = z.infer<typeof EndpointConfigV1Schema>;

/** Unified LLM configuration DTO. */
export type LlmConfigV1 = z.infer<typeof LlmConfigV1Schema>;

/** Provider Output business-success branch. */
export const ProviderOutputSuccessV1Schema = z.strictObject({
  ok: z.literal(true),
  task_name: z.string().trim().min(1),
  resolved_config: JsonObjectSchema,
  parsed_output: JsonObjectSchema
});

/** Provider Output business-failure branch. */
export const ProviderOutputFailureV1Schema = z.strictObject({
  ok: z.literal(false),
  err_msg: z.string().trim().min(1)
});

/** Valid HTTP 2xx Provider Output. */
export const ProviderOutputV1Schema = z.discriminatedUnion("ok", [
  ProviderOutputSuccessV1Schema,
  ProviderOutputFailureV1Schema
]);
