import type { ConfigurationResource } from "@cortex-eval/application/src/features/configurations/configuration-models.ts";
import {
  hashEndpointConfig,
  hashLlmConfig,
  hashPrompt
} from "@cortex-eval/domain/src/domain-resource-hashes.ts";
import {
  validateAnalysisPrompt,
  validateEndpointConfig,
  validateLlmConfig,
  validatePrompt,
  type EndpointHeaderValue,
  type LlmConfigDefinition,
  type PromptMessage,
  type StructuredOutputMode,
  type ThinkingLevel
} from "@cortex-eval/domain/src/domain-resource-models.ts";
import type { Selectable } from "kysely";

import { SqliteRowInvalidError } from "./sqlite-row-mappers.ts";
import type {
  CaseAnalysisPromptTable,
  EndpointConfigTable,
  LlmConfigTable,
  LlmRubricPromptTable
} from "./sqlite-schema.ts";

// Parse one JSON object before mapping a database boundary value.
function parseRecord(serialized: string): Readonly<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new SqliteRowInvalidError();
    }
    return parsed as Readonly<Record<string, unknown>>;
  } catch (error) {
    if (error instanceof SqliteRowInvalidError) throw error;
    throw new SqliteRowInvalidError();
  }
}

// Read a required typed member.
function member<T extends "string" | "number">(
  source: Readonly<Record<string, unknown>>,
  key: string,
  type: T
): T extends "string" ? string : number {
  const value = source[key];
  if (typeof value !== type) throw new SqliteRowInvalidError();
  return value as T extends "string" ? string : number;
}

// Require the persisted JSON contract to contain no missing or unknown members.
function requireExactKeys(
  source: Readonly<Record<string, unknown>>,
  expected: readonly string[]
): void {
  const actual = Object.keys(source);
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) {
    throw new SqliteRowInvalidError();
  }
}

// Reject a row whose persisted identity no longer matches its semantic content.
function requireSemanticHash(actual: string, expected: string): void {
  if (actual !== expected) throw new SqliteRowInvalidError();
}

// Narrow one persisted thinking level without a type assertion.
function thinkingLevel(source: Readonly<Record<string, unknown>>): ThinkingLevel {
  const value = member(source, "thinkingLevel", "string");
  if (value !== "OFF" && value !== "LOW" && value !== "MEDIUM" && value !== "HIGH") {
    throw new SqliteRowInvalidError();
  }
  return value;
}

// Narrow one persisted structured-output mode without a type assertion.
function structuredOutput(source: Readonly<Record<string, unknown>>): StructuredOutputMode {
  const value = member(source, "structuredOutput", "string");
  if (value !== "JSON_SCHEMA" && value !== "JSON_OBJECT") {
    throw new SqliteRowInvalidError();
  }
  return value;
}

// Parse exact ordered Prompt messages.
function messages(serialized: string): readonly PromptMessage[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new SqliteRowInvalidError();
  }
  if (!Array.isArray(parsed)) throw new SqliteRowInvalidError();
  return parsed.map((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new SqliteRowInvalidError();
    }
    const source = item as Readonly<Record<string, unknown>>;
    requireExactKeys(source, ["role", "content"]);
    const role = member(source, "role", "string");
    if (role !== "SYSTEM" && role !== "USER" && role !== "ASSISTANT") {
      throw new SqliteRowInvalidError();
    }
    return { role, content: member(source, "content", "string") };
  });
}

// Parse exact Header value unions.
function headers(serialized: string): Readonly<Record<string, EndpointHeaderValue>> {
  const source = parseRecord(serialized);
  const entries: [string, EndpointHeaderValue][] = Object.entries(source).map(([name, raw]) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new SqliteRowInvalidError();
    }
    const value = raw as Readonly<Record<string, unknown>>;
    const kind = member(value, "kind", "string");
    if (kind === "LITERAL") {
      requireExactKeys(value, ["kind", "value"]);
      return [name, { kind, value: member(value, "value", "string") }];
    }
    if (kind === "ENV_SECRET") {
      requireExactKeys(value, ["kind", "envKey"]);
      return [name, { kind, envKey: member(value, "envKey", "string") }];
    }
    throw new SqliteRowInvalidError();
  });
  return Object.fromEntries(entries);
}

/** Map and validate one current Endpoint row. */
export function mapEndpointResource(row: Selectable<EndpointConfigTable>): ConfigurationResource {
  const definition = {
    urlTemplate: row.url_template,
    method: row.method,
    headers: headers(row.headers_json),
    bodySelector: row.body_selector,
    timeoutMs: row.timeout_ms,
    defaultConcurrency: row.default_concurrency
  };
  if (!validateEndpointConfig(definition).ok) throw new SqliteRowInvalidError();
  requireSemanticHash(
    row.config_hash,
    hashEndpointConfig({ contractVersion: "cortex.endpoint-config.v1", config: definition })
  );
  return {
    kind: "ENDPOINT",
    id: row.id,
    name: row.name,
    definition,
    semanticHash: row.config_hash,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/** Map and validate one current LLM row. */
export function mapLlmResource(row: Selectable<LlmConfigTable>): ConfigurationResource {
  const options = parseRecord(row.options_json);
  const secrets = parseRecord(row.secret_refs_json);
  const common = {
    model: row.model,
    thinkingLevel: thinkingLevel(options),
    temperature: member(options, "temperature", "number"),
    topP: member(options, "topP", "number"),
    maxOutputTokens: member(options, "maxOutputTokens", "number"),
    timeoutMs: member(options, "timeoutMs", "number"),
    structuredOutput: structuredOutput(options)
  };
  let definition: LlmConfigDefinition;
  if (row.provider_type === "GOOGLE_GEMINI") {
    requireExactKeys(options, [
      "thinkingLevel",
      "temperature",
      "topP",
      "maxOutputTokens",
      "timeoutMs",
      "structuredOutput"
    ]);
    requireExactKeys(secrets, ["apiKey"]);
    definition = {
      ...common,
      providerType: row.provider_type,
      apiKey: { kind: "ENV_SECRET", envKey: member(secrets, "apiKey", "string") }
    };
  } else {
    requireExactKeys(options, [
      "thinkingLevel",
      "temperature",
      "topP",
      "maxOutputTokens",
      "timeoutMs",
      "structuredOutput",
      "baseUrl",
      "authKind"
    ]);
    const authKind = member(options, "authKind", "string");
    const base = {
      ...common,
      providerType: row.provider_type,
      baseUrl: member(options, "baseUrl", "string")
    };
    if (authKind === "NONE") {
      requireExactKeys(secrets, []);
      definition = { ...base, auth: { kind: authKind } };
    } else if (authKind === "BEARER_ENV") {
      requireExactKeys(secrets, ["bearer"]);
      definition = {
        ...base,
        auth: {
          kind: authKind,
          secret: { kind: "ENV_SECRET", envKey: member(secrets, "bearer", "string") }
        }
      };
    } else {
      throw new SqliteRowInvalidError();
    }
  }
  if (!validateLlmConfig(definition).ok) throw new SqliteRowInvalidError();
  requireSemanticHash(
    row.config_hash,
    hashLlmConfig({ contractVersion: "cortex.llm-config.v1", config: definition })
  );
  return {
    kind: "LLM",
    id: row.id,
    name: row.name,
    definition,
    semanticHash: row.config_hash,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/** Map and validate one current Rubric Prompt row. */
export function mapRubricPromptResource(
  row: Selectable<LlmRubricPromptTable>
): ConfigurationResource {
  const definition = {
    kind: "LLM_RUBRIC" as const,
    promptKey: row.prompt_key,
    messages: messages(row.messages_json)
  };
  if (!validatePrompt(definition).ok) throw new SqliteRowInvalidError();
  requireSemanticHash(
    row.prompt_hash,
    hashPrompt({
      contractVersion: "cortex.prompt.v1",
      kind: definition.kind,
      promptKey: definition.promptKey,
      messages: definition.messages
    })
  );
  return {
    kind: "LLM_RUBRIC_PROMPT",
    id: row.id,
    name: row.name,
    definition,
    semanticHash: row.prompt_hash,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/** Map and validate one current Analysis Prompt row. */
export function mapAnalysisPromptResource(
  row: Selectable<CaseAnalysisPromptTable>
): ConfigurationResource {
  const definition = {
    kind: "CASE_ANALYSIS" as const,
    promptKey: row.prompt_key,
    messages: messages(row.messages_template_json)
  };
  if (!validateAnalysisPrompt(definition).ok) throw new SqliteRowInvalidError();
  requireSemanticHash(
    row.prompt_hash,
    hashPrompt({
      contractVersion: "cortex.prompt.v1",
      kind: definition.kind,
      promptKey: definition.promptKey,
      messages: definition.messages
    })
  );
  return {
    kind: "CASE_ANALYSIS_PROMPT",
    id: row.id,
    name: row.name,
    definition,
    semanticHash: row.prompt_hash,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
