import { createHash, type Hash } from "node:crypto";

import {
  canonicalJson,
  sha256CanonicalJson,
  type DomainJsonObject
} from "./domain-canonical-hash.ts";
import type {
  EndpointConfigDefinition,
  LlmConfigDefinition,
  PromptMessage
} from "./domain-resource-models.ts";

/** Ordered Case identity inside a Suite hash. */
export interface SuiteCaseHashFact {
  /** Stable Case key. */
  readonly caseKey: string;
  /** Frozen zero-based order. */
  readonly ordinal: number;
  /** Complete Case Definition hash. */
  readonly definitionHash: string;
}

/** Current Suite semantic identity input. */
export interface SuiteHashInput {
  /** Hash contract version. */
  readonly contractVersion: "cortex.suite.v1";
  /** Complete current Case identity set. */
  readonly cases: readonly SuiteCaseHashFact[];
}

/** Bounded-memory Suite hasher equivalent to the complete RFC 8785 projection. */
export class IncrementalSuiteHasher {
  readonly #hash: Hash;
  #count = 0;
  #finalized = false;

  /** Start one empty Suite v1 canonical stream. */
  public constructor() {
    this.#hash = createHash("sha256");
    this.#hash.update('{"cases":[', "utf8");
  }

  /** Append the next exact Ordinal Case identity. */
  public append(value: SuiteCaseHashFact): void {
    if (this.#finalized) throw new Error("SUITE_HASH_FINALIZED");
    if (value.ordinal !== this.#count) throw new Error("SUITE_HASH_ORDINAL_INVALID");
    if (this.#count > 0) this.#hash.update(",", "utf8");
    this.#hash.update(
      canonicalJson({
        caseKey: value.caseKey,
        definitionHash: value.definitionHash,
        ordinal: value.ordinal
      }),
      "utf8"
    );
    this.#count += 1;
  }

  /** Finalize once and return the lowercase SHA-256 digest. */
  public digest(): string {
    if (this.#finalized) throw new Error("SUITE_HASH_FINALIZED");
    this.#finalized = true;
    this.#hash.update('],"contractVersion":"cortex.suite.v1"}', "utf8");
    return this.#hash.digest("hex");
  }
}

/** Endpoint semantic identity input. */
export interface EndpointConfigHashInput {
  /** Hash contract version. */
  readonly contractVersion: "cortex.endpoint-config.v1";
  /** Complete clean runtime configuration. */
  readonly config: EndpointConfigDefinition;
}

/** LLM semantic identity input. */
export interface LlmConfigHashInput {
  /** Hash contract version. */
  readonly contractVersion: "cortex.llm-config.v1";
  /** Complete clean runtime configuration. */
  readonly config: LlmConfigDefinition;
}

/** Prompt semantic identity input. */
export interface PromptHashInput {
  /** Hash contract version. */
  readonly contractVersion: "cortex.prompt.v1";
  /** Prompt family. */
  readonly kind: "LLM_RUBRIC" | "CASE_ANALYSIS";
  /** Stable Prompt key. */
  readonly promptKey: string;
  /** Ordered content-bearing messages. */
  readonly messages: readonly PromptMessage[];
}

/** One Rubric Prompt fact inside a set hash. */
export interface RubricPromptHashFact {
  /** Stable Prompt key. */
  readonly promptKey: string;
  /** Prompt semantic hash. */
  readonly promptHash: string;
}

/** Frozen Rubric Prompt set identity input. */
export interface RubricPromptSetHashInput {
  /** Hash contract version. */
  readonly contractVersion: "cortex.rubric-prompt-set.v1";
  /** Complete referenced Prompt set. */
  readonly prompts: readonly RubricPromptHashFact[];
}

// Convert Header values to canonical JSON without relying on interface index signatures.
function endpointHeaders(value: EndpointConfigDefinition): DomainJsonObject {
  return Object.fromEntries(
    Object.entries(value.headers).map(([name, header]) => [
      name.toLowerCase(),
      header.kind === "LITERAL"
        ? { kind: header.kind, value: header.value }
        : { kind: header.kind, envKey: header.envKey }
    ])
  );
}

// Convert one supported LLM configuration into its complete canonical runtime fact.
export function llmConfigJson(value: LlmConfigDefinition): DomainJsonObject {
  const common = {
    providerType: value.providerType,
    model: value.model,
    thinkingLevel: value.thinkingLevel,
    temperature: value.temperature,
    topP: value.topP,
    maxOutputTokens: value.maxOutputTokens,
    timeoutMs: value.timeoutMs,
    structuredOutput: value.structuredOutput
  };
  if (value.providerType === "GOOGLE_GEMINI") {
    return { ...common, apiKey: { kind: value.apiKey.kind, envKey: value.apiKey.envKey } };
  }
  const auth =
    value.auth.kind === "NONE"
      ? { kind: value.auth.kind }
      : {
          kind: value.auth.kind,
          secret: { kind: value.auth.secret.kind, envKey: value.auth.secret.envKey }
        };
  return { ...common, baseUrl: value.baseUrl, auth };
}

/** Hash a Suite from ordered Case identities, excluding display and persistence fields. */
export function hashSuite(input: SuiteHashInput): string {
  const cases = [...input.cases]
    .sort(
      (left, right) => left.ordinal - right.ordinal || left.caseKey.localeCompare(right.caseKey)
    )
    .map((item) => ({
      caseKey: item.caseKey,
      ordinal: item.ordinal,
      definitionHash: item.definitionHash
    }));
  return sha256CanonicalJson({ contractVersion: input.contractVersion, cases });
}

/** Hash all Endpoint runtime semantics, excluding display and persistence fields. */
export function hashEndpointConfig(input: EndpointConfigHashInput): string {
  return sha256CanonicalJson({
    contractVersion: input.contractVersion,
    config: {
      urlTemplate: input.config.urlTemplate,
      method: input.config.method,
      headers: endpointHeaders(input.config),
      bodySelector: input.config.bodySelector,
      timeoutMs: input.config.timeoutMs,
      defaultConcurrency: input.config.defaultConcurrency,
      ...(input.config.agentRevision ? { agentRevision: { ...input.config.agentRevision } } : {})
    }
  });
}

/** Hash all LLM runtime semantics, excluding display name, role and persistence fields. */
export function hashLlmConfig(input: LlmConfigHashInput): string {
  return sha256CanonicalJson({
    contractVersion: input.contractVersion,
    config: llmConfigJson(input.config)
  });
}

/** Hash ordered Prompt content and identity, excluding display and persistence fields. */
export function hashPrompt(input: PromptHashInput): string {
  const messages = input.messages.map((message) => ({
    role: message.role,
    content: message.content
  }));
  return sha256CanonicalJson({
    contractVersion: input.contractVersion,
    kind: input.kind,
    promptKey: input.promptKey,
    messages
  });
}

/** Hash a complete Rubric Prompt set in stable Prompt-key order. */
export function hashRubricPromptSet(input: RubricPromptSetHashInput): string {
  const prompts = [...input.prompts]
    .sort((left, right) => left.promptKey.localeCompare(right.promptKey))
    .map((item) => ({ promptKey: item.promptKey, promptHash: item.promptHash }));
  return sha256CanonicalJson({ contractVersion: input.contractVersion, prompts });
}
