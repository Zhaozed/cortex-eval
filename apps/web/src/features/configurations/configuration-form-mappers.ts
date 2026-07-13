import {
  AnalysisPromptDefinitionV1Schema,
  PromptDefinitionV1Schema
} from "@cortex-eval/contracts/src/resource-api-contracts.ts";
import {
  EndpointConfigV1Schema,
  LlmConfigV1Schema
} from "@cortex-eval/contracts/src/provider-contracts.ts";
import type { z } from "zod";

/** Editable Endpoint Header row. */
export interface EndpointHeaderFormRow {
  /** Header name. */
  readonly name: string;
  /** Safe literal or environment Secret reference. */
  readonly kind: "LITERAL" | "ENV_SECRET";
  /** Literal value used only by the safe literal branch. */
  readonly value: string;
  /** Environment variable name used only by the Secret branch. */
  readonly envKey: string;
}

/** Endpoint structured form values. */
export interface EndpointFormValues {
  /** Resource display name. */
  readonly name: string;
  /** HTTP URL template. */
  readonly urlTemplate: string;
  /** Editable Header rows. */
  readonly headers: readonly EndpointHeaderFormRow[];
  /** RFC 6901 request-body selector. */
  readonly bodySelector: string;
  /** Request timeout in milliseconds. */
  readonly timeoutMs: number;
  /** Default maximum in-flight requests. */
  readonly defaultConcurrency: number;
}

/** LLM structured form values for both provider branches. */
export interface LlmFormValues {
  /** Resource display name. */
  readonly name: string;
  /** Provider discriminator. */
  readonly providerType: "GOOGLE_GEMINI" | "OPENAI_COMPATIBLE";
  /** Provider model identity. */
  readonly model: string;
  /** Shared reasoning level. */
  readonly thinkingLevel: "OFF" | "LOW" | "MEDIUM" | "HIGH";
  /** Shared sampling temperature. */
  readonly temperature: number;
  /** Shared nucleus sampling probability. */
  readonly topP: number;
  /** Shared maximum output tokens. */
  readonly maxOutputTokens: number;
  /** Request timeout in milliseconds. */
  readonly timeoutMs: number;
  /** Required structured output capability. */
  readonly structuredOutput: "JSON_SCHEMA" | "JSON_OBJECT";
  /** Gemini API Key environment variable. */
  readonly geminiApiKeyEnv: string;
  /** OpenAI-compatible base URL. */
  readonly baseUrl: string;
  /** OpenAI-compatible authentication mode. */
  readonly authKind: "BEARER_ENV" | "NONE";
  /** Bearer Token environment variable. */
  readonly bearerEnvKey: string;
}

/** One editable Prompt message. */
export interface PromptMessageFormValues {
  /** Prompt message role. */
  readonly role: "SYSTEM" | "USER" | "ASSISTANT";
  /** Prompt message content. */
  readonly content: string;
}

/** Shared Rubric and Analysis Prompt form values. */
export interface PromptFormValues {
  /** Resource display name. */
  readonly name: string;
  /** Stable Prompt business key. */
  readonly promptKey: string;
  /** Ordered Prompt messages. */
  readonly messages: readonly PromptMessageFormValues[];
}

/** Successful form-to-definition mapping. */
export interface DefinitionMappingSuccess<Definition> {
  /** Successful discriminator. */
  readonly ok: true;
  /** Strict Contracts definition. */
  readonly definition: Definition;
}

/** Rejected form-to-definition mapping. */
export interface DefinitionMappingFailure {
  /** Failure discriminator. */
  readonly ok: false;
  /** Nearest focusable form field. */
  readonly field: string;
  /** Stable validation code. */
  readonly code: string;
}

/** Form mapping result. */
export type DefinitionMappingResult<Definition> =
  DefinitionMappingSuccess<Definition> | DefinitionMappingFailure;

// Remove the API command envelope prefix before mapping to editable form fields.
function definitionPath(path: string): string {
  return path.startsWith("definition.") ? path.slice("definition.".length) : path;
}

/** Map one Endpoint API field path to the current dynamic Header form. */
export function endpointApiPathToFormField(
  path: string,
  headers: readonly EndpointHeaderFormRow[]
): string | null {
  const normalized = definitionPath(path);
  const direct = new Set([
    "name",
    "urlTemplate",
    "bodySelector",
    "timeoutMs",
    "defaultConcurrency"
  ]);
  if (direct.has(normalized)) return normalized;
  const parts = normalized.split(".");
  const headerName = parts[0] === "headers" ? parts[1] : undefined;
  if (headerName === undefined) return null;
  const index = headers.findIndex((row) => row.name.toLowerCase() === headerName.toLowerCase());
  if (index < 0) return null;
  const leaf = parts.at(-1);
  if (leaf === "envKey") return `headers.${index}.envKey`;
  if (leaf === "value") return `headers.${index}.value`;
  return `headers.${index}.name`;
}

/** Map one LLM API field path to its selected provider form branch. */
export function llmApiPathToFormField(path: string): string | null {
  const normalized = definitionPath(path);
  const direct = new Set([
    "name",
    "providerType",
    "model",
    "thinkingLevel",
    "temperature",
    "topP",
    "maxOutputTokens",
    "timeoutMs",
    "structuredOutput",
    "baseUrl"
  ]);
  if (direct.has(normalized)) return normalized;
  if (normalized === "apiKey.envKey") return "geminiApiKeyEnv";
  if (normalized === "auth") return "authKind";
  if (normalized === "auth.kind") return "authKind";
  if (normalized === "auth.secret.envKey") return "bearerEnvKey";
  return null;
}

/** Map one Prompt API field path to its ordered message form. */
export function promptApiPathToFormField(path: string): string | null {
  const normalized = definitionPath(path);
  if (normalized === "name" || normalized === "promptKey") return normalized;
  if (normalized === "messages.variables") return "messages.0.content";
  return /^messages\.\d+\.(?:role|content)$/.test(normalized) ? normalized : null;
}

// Convert the first Contract issue into stable form metadata.
function validationFailure(error: z.ZodError): DefinitionMappingFailure {
  const issue = error.issues[0];
  return {
    ok: false,
    field: issue === undefined || issue.path.length === 0 ? "root" : issue.path.join("."),
    code: issue?.message ?? "VALIDATION_FAILED"
  };
}

// Translate an Endpoint Contract issue to one registered dynamic form control.
function endpointValidationFailure(
  error: z.ZodError,
  headers: readonly EndpointHeaderFormRow[]
): DefinitionMappingFailure {
  const failure = validationFailure(error);
  return {
    ...failure,
    field: endpointApiPathToFormField(failure.field, headers) ?? "urlTemplate"
  };
}

// Translate an LLM Contract issue to one registered provider-branch control.
function llmValidationFailure(error: z.ZodError): DefinitionMappingFailure {
  const failure = validationFailure(error);
  return {
    ...failure,
    field: llmApiPathToFormField(failure.field) ?? "model"
  };
}

/** Map Endpoint rows into the strict record-based Contract. */
export function endpointFormToDefinition(
  form: EndpointFormValues
): DefinitionMappingResult<z.infer<typeof EndpointConfigV1Schema>> {
  const headers: Record<string, unknown> = {};
  const normalizedNames = new Set<string>();
  for (const [index, row] of form.headers.entries()) {
    const normalized = row.name.trim().toLowerCase();
    if (normalizedNames.has(normalized)) {
      return { ok: false, field: `headers.${index}.name`, code: "HEADER_NAME_DUPLICATE" };
    }
    normalizedNames.add(normalized);
    headers[row.name.trim()] =
      row.kind === "LITERAL"
        ? { kind: "LITERAL", value: row.value }
        : { kind: "ENV_SECRET", envKey: row.envKey };
  }
  const parsed = EndpointConfigV1Schema.safeParse({
    contractVersion: "cortex.endpoint-config.v1",
    urlTemplate: form.urlTemplate,
    method: "POST",
    headers,
    bodySelector: form.bodySelector,
    timeoutMs: form.timeoutMs,
    defaultConcurrency: form.defaultConcurrency
  });
  return parsed.success
    ? { ok: true, definition: parsed.data }
    : endpointValidationFailure(parsed.error, form.headers);
}

/** Map the selected LLM provider branch into its discriminated Contract. */
export function llmFormToDefinition(
  form: LlmFormValues
): DefinitionMappingResult<z.infer<typeof LlmConfigV1Schema>> {
  const common = {
    contractVersion: "cortex.llm-config.v1",
    model: form.model,
    thinkingLevel: form.thinkingLevel,
    temperature: form.temperature,
    topP: form.topP,
    maxOutputTokens: form.maxOutputTokens,
    timeoutMs: form.timeoutMs,
    structuredOutput: form.structuredOutput
  } as const;
  const input =
    form.providerType === "GOOGLE_GEMINI"
      ? {
          ...common,
          providerType: "GOOGLE_GEMINI",
          apiKey: { kind: "ENV_SECRET", envKey: form.geminiApiKeyEnv }
        }
      : {
          ...common,
          providerType: "OPENAI_COMPATIBLE",
          baseUrl: form.baseUrl,
          auth:
            form.authKind === "NONE"
              ? { kind: "NONE" }
              : {
                  kind: "BEARER_ENV",
                  secret: { kind: "ENV_SECRET", envKey: form.bearerEnvKey }
                }
        };
  const parsed = LlmConfigV1Schema.safeParse(input);
  return parsed.success
    ? { ok: true, definition: parsed.data }
    : llmValidationFailure(parsed.error);
}

/** Map one Prompt form without coupling content edits to Prompt Key changes. */
export function promptFormToDefinition(
  kind: "LLM_RUBRIC" | "CASE_ANALYSIS",
  form: PromptFormValues
): DefinitionMappingResult<
  z.infer<typeof PromptDefinitionV1Schema> | z.infer<typeof AnalysisPromptDefinitionV1Schema>
> {
  const schema =
    kind === "LLM_RUBRIC" ? PromptDefinitionV1Schema : AnalysisPromptDefinitionV1Schema;
  const parsed = schema.safeParse({
    contractVersion: "cortex.prompt.v1",
    kind,
    promptKey: form.promptKey,
    messages: form.messages
  });
  return parsed.success ? { ok: true, definition: parsed.data } : validationFailure(parsed.error);
}

/** Restore one Endpoint Contract into stable editable Header rows. */
export function endpointDefinitionToForm(
  name: string,
  definition: z.infer<typeof EndpointConfigV1Schema>
): EndpointFormValues {
  return {
    name,
    urlTemplate: definition.urlTemplate,
    headers: Object.entries(definition.headers)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([headerName, value]) => ({
        name: headerName,
        kind: value.kind,
        value: value.kind === "LITERAL" ? value.value : "",
        envKey: value.kind === "ENV_SECRET" ? value.envKey : ""
      })),
    bodySelector: definition.bodySelector,
    timeoutMs: definition.timeoutMs,
    defaultConcurrency: definition.defaultConcurrency
  };
}

/** Restore one LLM Contract while leaving inactive provider fields empty. */
export function llmDefinitionToForm(
  name: string,
  definition: z.infer<typeof LlmConfigV1Schema>
): LlmFormValues {
  const common = {
    name,
    providerType: definition.providerType,
    model: definition.model,
    thinkingLevel: definition.thinkingLevel,
    temperature: definition.temperature,
    topP: definition.topP,
    maxOutputTokens: definition.maxOutputTokens,
    timeoutMs: definition.timeoutMs,
    structuredOutput: definition.structuredOutput
  } as const;
  if (definition.providerType === "GOOGLE_GEMINI") {
    return {
      ...common,
      geminiApiKeyEnv: definition.apiKey.envKey,
      baseUrl: "",
      authKind: "NONE",
      bearerEnvKey: ""
    };
  }
  return {
    ...common,
    geminiApiKeyEnv: "",
    baseUrl: definition.baseUrl,
    authKind: definition.auth.kind,
    bearerEnvKey: definition.auth.kind === "BEARER_ENV" ? definition.auth.secret.envKey : ""
  };
}

/** Restore one Prompt Contract without reordering its messages. */
export function promptDefinitionToForm(
  name: string,
  definition:
    z.infer<typeof PromptDefinitionV1Schema> | z.infer<typeof AnalysisPromptDefinitionV1Schema>
): PromptFormValues {
  return { name, promptKey: definition.promptKey, messages: definition.messages };
}
