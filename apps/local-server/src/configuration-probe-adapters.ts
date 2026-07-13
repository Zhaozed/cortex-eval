import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import type {
  ConfigurationProbeAdapterResult,
  EndpointValidator,
  LlmValidator
} from "@cortex-eval/application/src/features/configurations/configuration-service.ts";
import type {
  EndpointConfigDefinition,
  GeminiLlmConfigDefinition,
  LlmConfigDefinition,
  OpenAiCompatibleLlmConfigDefinition
} from "@cortex-eval/domain/src/domain-resource-models.ts";
import OpenAI from "openai";

/** Environment lookup that never enumerates or logs secret values. */
export interface ProbeEnvironment {
  /** Read one exact EnvSecretRef key. */
  readonly get: (key: string) => string | undefined;
}

/** SDK client boundary used by the stable LLM validator and its tests. */
export interface LlmProbeClients {
  /** Execute one no-retry Gemini JSON availability probe. */
  readonly probeGemini: (
    definition: GeminiLlmConfigDefinition,
    apiKey: string,
    signal: AbortSignal
  ) => Promise<void>;
  /** Execute one no-retry OpenAI-compatible Chat Completions probe. */
  readonly probeOpenAiCompatible: (
    definition: OpenAiCompatibleLlmConfigDefinition,
    apiKey: string | null,
    signal: AbortSignal
  ) => Promise<void>;
}

/** Fetch subset used by the Endpoint connectivity adapter. */
export type ProbeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const PROBE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: { ok: { type: "boolean" } }
} as const;

// Render only already-validated Endpoint placeholders with one inert path token.
function probeUrl(template: string): string {
  return template.replace(/\{\{[^{}]+\}\}/g, encodeURIComponent("probe"));
}

// Classify one caught adapter error without exposing its text or stack.
function failureReason(
  error: unknown,
  signal: AbortSignal
): "UNAVAILABLE" | "TIMEOUT" | "CANCELLED" | "CAPABILITY_UNSUPPORTED" {
  if (signal.aborted) return "CANCELLED";
  const name =
    error !== null && typeof error === "object" && "name" in error ? error.name : undefined;
  if (name === "TimeoutError" || name === "APIConnectionTimeoutError") return "TIMEOUT";
  const status =
    error !== null && typeof error === "object" && "status" in error ? error.status : undefined;
  return status === 400 || status === 422 ? "CAPABILITY_UNSUPPORTED" : "UNAVAILABLE";
}

// Classify mutable request and timeout signals only at the failure boundary.
function probeFailureReason(
  error: unknown,
  requestSignal: AbortSignal,
  timeoutSignal: AbortSignal
): "UNAVAILABLE" | "TIMEOUT" | "CANCELLED" | "CAPABILITY_UNSUPPORTED" {
  if (requestSignal.aborted) return "CANCELLED";
  if (timeoutSignal.aborted) return "TIMEOUT";
  return failureReason(error, requestSignal);
}

/** No-credential Endpoint network-connectivity validator. */
export class EndpointConnectivityValidator implements EndpointValidator {
  readonly #fetch: ProbeFetch;

  /** Create a validator with an injectable Fetch implementation. */
  public constructor(options: { readonly fetch?: ProbeFetch | undefined } = {}) {
    this.#fetch = options.fetch ?? fetch;
  }

  /** Send one OPTIONS request without user Headers, body, Redirect or retry. */
  public async validate(
    definition: EndpointConfigDefinition,
    signal: AbortSignal
  ): Promise<ConfigurationProbeAdapterResult> {
    if (signal.aborted) {
      return { ok: false, error: { code: "CONFIGURATION_PROBE_FAILED", reason: "CANCELLED" } };
    }
    const timeoutSignal = AbortSignal.timeout(definition.timeoutMs);
    const combined = AbortSignal.any([signal, timeoutSignal]);
    try {
      await this.#fetch(probeUrl(definition.urlTemplate), {
        method: "OPTIONS",
        redirect: "manual",
        signal: combined
      });
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "CONFIGURATION_PROBE_FAILED",
          reason: probeFailureReason(error, signal, timeoutSignal)
        }
      };
    }
  }
}

// Map the closed platform thinking level into the Google SDK enum.
function googleThinking(
  value: GeminiLlmConfigDefinition["thinkingLevel"]
): { readonly thinkingBudget: 0 } | { readonly thinkingLevel: ThinkingLevel } {
  if (value === "OFF") return { thinkingBudget: 0 };
  if (value === "LOW") return { thinkingLevel: ThinkingLevel.LOW };
  if (value === "MEDIUM") return { thinkingLevel: ThinkingLevel.MEDIUM };
  return { thinkingLevel: ThinkingLevel.HIGH };
}

// Map the closed platform thinking level into the OpenAI Chat Completions parameter.
function openAiThinking(
  value: OpenAiCompatibleLlmConfigDefinition["thinkingLevel"]
): "none" | "low" | "medium" | "high" {
  if (value === "OFF") return "none";
  if (value === "LOW") return "low";
  if (value === "MEDIUM") return "medium";
  return "high";
}

const NO_AUTH_SDK_PLACEHOLDER = "cortex-sdk-no-auth-placeholder";

/** Concrete pinned SDK clients with automatic retries explicitly disabled. */
export class SdkLlmProbeClients implements LlmProbeClients {
  /** Execute one minimal structured Gemini request. */
  public async probeGemini(
    definition: GeminiLlmConfigDefinition,
    apiKey: string,
    signal: AbortSignal
  ): Promise<void> {
    const client = new GoogleGenAI({ apiKey });
    await client.models.generateContent({
      model: definition.model,
      contents: 'Return only JSON: {"ok":true}',
      config: {
        abortSignal: signal,
        temperature: definition.temperature,
        topP: definition.topP,
        maxOutputTokens: definition.maxOutputTokens,
        thinkingConfig: googleThinking(definition.thinkingLevel),
        responseMimeType: "application/json",
        ...(definition.structuredOutput === "JSON_SCHEMA"
          ? { responseJsonSchema: PROBE_JSON_SCHEMA }
          : {})
      }
    });
  }

  /** Execute one minimal OpenAI-compatible Chat Completions request. */
  public async probeOpenAiCompatible(
    definition: OpenAiCompatibleLlmConfigDefinition,
    apiKey: string | null,
    signal: AbortSignal
  ): Promise<void> {
    const withoutAuthentication = apiKey === null;
    const client = new OpenAI({
      apiKey: withoutAuthentication ? NO_AUTH_SDK_PLACEHOLDER : apiKey,
      adminAPIKey: null,
      organization: null,
      project: null,
      baseURL: definition.baseUrl,
      timeout: definition.timeoutMs,
      maxRetries: 0,
      ...(withoutAuthentication ? { defaultHeaders: { Authorization: null } } : {})
    });
    await client.chat.completions.create(
      {
        model: definition.model,
        messages: [{ role: "user", content: 'Return only JSON: {"ok":true}' }],
        temperature: definition.temperature,
        top_p: definition.topP,
        max_completion_tokens: definition.maxOutputTokens,
        reasoning_effort: openAiThinking(definition.thinkingLevel),
        response_format:
          definition.structuredOutput === "JSON_SCHEMA"
            ? {
                type: "json_schema",
                json_schema: {
                  name: "availability_probe",
                  strict: true,
                  schema: PROBE_JSON_SCHEMA
                }
              }
            : { type: "json_object" }
      },
      { signal, timeout: definition.timeoutMs, maxRetries: 0 }
    );
  }
}

/** Stable LLM availability validator over explicit EnvSecretRef and SDK clients. */
export class LlmAvailabilityValidator implements LlmValidator {
  readonly #environment: ProbeEnvironment;
  readonly #clients: LlmProbeClients;

  /** Create a validator with explicit environment and client boundaries. */
  public constructor(
    options: {
      readonly environment?: ProbeEnvironment | undefined;
      readonly clients?: LlmProbeClients | undefined;
    } = {}
  ) {
    this.#environment = options.environment ?? {
      get: (key: string): string | undefined => process.env[key]
    };
    this.#clients = options.clients ?? new SdkLlmProbeClients();
  }

  /** Resolve only the configured secret key and execute exactly one provider request. */
  public async validate(
    definition: LlmConfigDefinition,
    signal: AbortSignal
  ): Promise<ConfigurationProbeAdapterResult> {
    if (signal.aborted) {
      return { ok: false, error: { code: "CONFIGURATION_PROBE_FAILED", reason: "CANCELLED" } };
    }
    const timeoutSignal = AbortSignal.timeout(definition.timeoutMs);
    const combined = AbortSignal.any([signal, timeoutSignal]);
    try {
      if (definition.providerType === "GOOGLE_GEMINI") {
        const secret = this.#environment.get(definition.apiKey.envKey);
        if (secret === undefined || secret.length === 0) {
          return {
            ok: false,
            error: { code: "CONFIGURATION_PROBE_FAILED", reason: "UNAVAILABLE" }
          };
        }
        await this.#clients.probeGemini(definition, secret, combined);
      } else {
        const apiKey =
          definition.auth.kind === "NONE"
            ? null
            : this.#environment.get(definition.auth.secret.envKey);
        if (apiKey !== null && (apiKey === undefined || apiKey.length === 0)) {
          return {
            ok: false,
            error: { code: "CONFIGURATION_PROBE_FAILED", reason: "UNAVAILABLE" }
          };
        }
        await this.#clients.probeOpenAiCompatible(definition, apiKey, combined);
      }
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "CONFIGURATION_PROBE_FAILED",
          reason: probeFailureReason(error, signal, timeoutSignal)
        }
      };
    }
  }
}
