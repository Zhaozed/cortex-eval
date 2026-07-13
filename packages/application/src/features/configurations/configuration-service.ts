import {
  collectAnalysisPromptVariables,
  validateAnalysisPrompt,
  validateEndpointConfig,
  validateLlmConfig,
  validatePrompt,
  type AnalysisPromptDefinition,
  type EndpointConfigDefinition,
  type LlmConfigDefinition,
  type PromptDefinition
} from "@cortex-eval/domain/src/domain-resource-models.ts";
import {
  hashEndpointConfig,
  hashLlmConfig,
  hashPrompt
} from "@cortex-eval/domain/src/domain-resource-hashes.ts";

import type { Clock, IdGenerator, TransactionManager } from "../../application-ports.ts";
import type {
  ConfigurationDeleteResult,
  ConfigurationError,
  ConfigurationMutationResult,
  ConfigurationResource,
  ConfigurationResourceKind
} from "./configuration-models.ts";

/** External Endpoint availability check. */
export interface EndpointValidator {
  /** Validate one already-clean Endpoint outside a database transaction. */
  validate(definition: EndpointConfigDefinition): Promise<void>;
}

/** External LLM availability check. */
export interface LlmValidator {
  /** Validate one already-clean LLM outside a database transaction. */
  validate(definition: LlmConfigDefinition): Promise<void>;
}

/** Configuration use-case dependencies. */
export interface ConfigurationServiceDependencies {
  /** Managed database-only transaction boundary. */
  readonly transactionManager: TransactionManager;
  /** Internal identity source. */
  readonly idGenerator: IdGenerator;
  /** Application time source. */
  readonly clock: Clock;
  /** Transaction-free Endpoint validator. */
  readonly endpointValidator: EndpointValidator;
  /** Transaction-free LLM validator. */
  readonly llmValidator: LlmValidator;
}

/** Create-current-resource command union. */
export type CreateConfigurationCommand =
  | {
      readonly kind: "ENDPOINT";
      readonly name: string;
      readonly definition: EndpointConfigDefinition;
    }
  | { readonly kind: "LLM"; readonly name: string; readonly definition: LlmConfigDefinition }
  | {
      readonly kind: "LLM_RUBRIC_PROMPT";
      readonly name: string;
      readonly definition: PromptDefinition;
    }
  | {
      readonly kind: "CASE_ANALYSIS_PROMPT";
      readonly name: string;
      readonly definition: AnalysisPromptDefinition;
    };

/** Update-current-resource command union. */
export type UpdateConfigurationCommand = CreateConfigurationCommand & {
  /** Target internal identity. */
  readonly id: string;
  /** Optimistic-concurrency token. */
  readonly expectedRevision: number;
};

/** Conditional current-resource delete command. */
export interface DeleteConfigurationCommand {
  /** Resource family. */
  readonly kind: ConfigurationResourceKind;
  /** Target internal identity. */
  readonly id: string;
  /** Optimistic-concurrency token. */
  readonly expectedRevision: number;
}

// Validate and prepare one closed resource union without persistence facts.
function semanticHash(command: CreateConfigurationCommand): string | ConfigurationError {
  if (command.kind === "ENDPOINT") {
    const result = validateEndpointConfig(command.definition);
    return result.ok
      ? hashEndpointConfig({
          contractVersion: "cortex.endpoint-config.v1",
          config: command.definition
        })
      : result.error;
  }
  if (command.kind === "LLM") {
    const result = validateLlmConfig(command.definition);
    return result.ok
      ? hashLlmConfig({ contractVersion: "cortex.llm-config.v1", config: command.definition })
      : result.error;
  }
  if (command.kind === "LLM_RUBRIC_PROMPT") {
    const result = validatePrompt(command.definition);
    return result.ok
      ? hashPrompt({
          contractVersion: "cortex.prompt.v1",
          kind: command.definition.kind,
          promptKey: command.definition.promptKey,
          messages: command.definition.messages
        })
      : result.error;
  }
  const result = validateAnalysisPrompt(command.definition);
  return result.ok
    ? hashPrompt({
        contractVersion: "cortex.prompt.v1",
        kind: command.definition.kind,
        promptKey: command.definition.promptKey,
        messages: command.definition.messages
      })
    : result.error;
}

// Materialize a prepared resource with explicit persistence facts.
function resource(
  command: CreateConfigurationCommand,
  id: string,
  hash: string,
  revision: number,
  createdAt: string,
  updatedAt: string
): ConfigurationResource {
  return { ...command, id, semanticHash: hash, revision, createdAt, updatedAt };
}

// Return a stable conflict using the latest current Revision.
function revisionError(actualRevision: number, expectedRevision: number): ConfigurationError {
  return { code: "RESOURCE_REVISION_CONFLICT", actualRevision, expectedRevision };
}

/** Internal Configuration CRUD, preview and validation use cases. */
export class ConfigurationService {
  readonly #dependencies: ConfigurationServiceDependencies;

  /** Create a service with external validators kept outside transactions. */
  public constructor(dependencies: ConfigurationServiceDependencies) {
    this.#dependencies = dependencies;
  }

  /** Read one current Configuration resource or null. */
  public get(kind: ConfigurationResourceKind, id: string): Promise<ConfigurationResource | null> {
    return this.#dependencies.transactionManager.execute(async (transaction) =>
      transaction.configurations.getResource(kind, id)
    );
  }

  /** List one current Configuration resource family. */
  public list(kind: ConfigurationResourceKind): Promise<readonly ConfigurationResource[]> {
    return this.#dependencies.transactionManager.execute(async (transaction) =>
      transaction.configurations.listResources(kind)
    );
  }

  /** Create one current Configuration resource. */
  public async create(command: CreateConfigurationCommand): Promise<ConfigurationMutationResult> {
    const hash = semanticHash(command);
    if (typeof hash !== "string") return { ok: false, error: hash };
    const timestamp = this.#dependencies.clock.now();
    const value = resource(
      command,
      this.#dependencies.idGenerator.nextId(),
      hash,
      0,
      timestamp,
      timestamp
    );
    return this.#dependencies.transactionManager.execute(async (transaction) => {
      const inserted = await transaction.configurations.insertResource(value);
      if (inserted === "NAME_CONFLICT") {
        return {
          ok: false,
          error: { code: "RESOURCE_UNIQUE_CONFLICT", field: "name" }
        };
      }
      if (inserted === "PROMPT_KEY_CONFLICT") {
        return {
          ok: false,
          error: { code: "RESOURCE_UNIQUE_CONFLICT", field: "promptKey" }
        };
      }
      return { ok: true, resource: value };
    });
  }

  /** Replace one current resource only when its Revision still matches. */
  public async update(command: UpdateConfigurationCommand): Promise<ConfigurationMutationResult> {
    const hash = semanticHash(command);
    if (typeof hash !== "string") return { ok: false, error: hash };
    const timestamp = this.#dependencies.clock.now();
    return this.#dependencies.transactionManager.execute(async (transaction) => {
      const current = await transaction.configurations.getResource(command.kind, command.id);
      if (current === null) return { ok: false, error: { code: "CONFIGURATION_NOT_FOUND" } };
      if (current.revision !== command.expectedRevision) {
        return {
          ok: false,
          error: revisionError(current.revision, command.expectedRevision)
        };
      }
      if (
        current.kind === "LLM_RUBRIC_PROMPT" &&
        command.kind === "LLM_RUBRIC_PROMPT" &&
        current.definition.promptKey !== command.definition.promptKey &&
        (await transaction.configurations.isRubricPromptReferenced(current.definition.promptKey))
      ) {
        return {
          ok: false,
          error: { code: "RUBRIC_PROMPT_IN_USE", promptKey: current.definition.promptKey }
        };
      }
      const value = resource(
        command,
        command.id,
        hash,
        current.revision + 1,
        current.createdAt,
        timestamp
      );
      const updated = await transaction.configurations.updateResource(value, current.revision);
      if (updated === "NAME_CONFLICT") {
        return {
          ok: false,
          error: { code: "RESOURCE_UNIQUE_CONFLICT", field: "name" }
        };
      }
      if (updated === "PROMPT_KEY_CONFLICT") {
        return {
          ok: false,
          error: { code: "RESOURCE_UNIQUE_CONFLICT", field: "promptKey" }
        };
      }
      if (updated !== null) return { ok: true, resource: updated };
      const latest = await transaction.configurations.getResource(command.kind, command.id);
      return latest === null
        ? { ok: false, error: { code: "CONFIGURATION_NOT_FOUND" } }
        : { ok: false, error: revisionError(latest.revision, command.expectedRevision) };
    });
  }

  /** Delete one current resource subject to Revision and Rubric reference rules. */
  public delete(command: DeleteConfigurationCommand): Promise<ConfigurationDeleteResult> {
    return this.#dependencies.transactionManager.execute(async (transaction) => {
      const current = await transaction.configurations.getResource(command.kind, command.id);
      if (current === null) return { ok: false, error: { code: "CONFIGURATION_NOT_FOUND" } };
      if (current.revision !== command.expectedRevision) {
        return { ok: false, error: revisionError(current.revision, command.expectedRevision) };
      }
      if (
        current.kind === "LLM_RUBRIC_PROMPT" &&
        (await transaction.configurations.isRubricPromptReferenced(current.definition.promptKey))
      ) {
        return {
          ok: false,
          error: { code: "RUBRIC_PROMPT_IN_USE", promptKey: current.definition.promptKey }
        };
      }
      const activeKind =
        current.kind === "ENDPOINT" ? "ENDPOINT" : current.kind === "LLM" ? "LLM" : null;
      if (
        activeKind !== null &&
        (await transaction.runs.hasActiveResourceReference(activeKind, current.id))
      ) {
        return { ok: false, error: { code: "RESOURCE_IN_ACTIVE_RUN" } };
      }
      const deleted = await transaction.configurations.deleteResource(
        command.kind,
        command.id,
        command.expectedRevision
      );
      return deleted
        ? { ok: true }
        : { ok: false, error: revisionError(current.revision + 1, command.expectedRevision) };
    });
  }

  /** Preview stable unique variables without saving the Prompt. */
  public previewAnalysisPromptVariables(value: AnalysisPromptDefinition): readonly string[] {
    const validation = validateAnalysisPrompt(value);
    return validation.ok ? collectAnalysisPromptVariables(value) : [];
  }

  /** Validate Endpoint availability outside any transaction. */
  public async validateEndpoint(value: EndpointConfigDefinition): Promise<void> {
    const validation = validateEndpointConfig(value);
    if (!validation.ok) throw new Error(validation.error.code);
    await this.#dependencies.endpointValidator.validate(value);
  }

  /** Validate LLM availability outside any transaction. */
  public async validateLlm(value: LlmConfigDefinition): Promise<void> {
    const validation = validateLlmConfig(value);
    if (!validation.ok) throw new Error(validation.error.code);
    await this.#dependencies.llmValidator.validate(value);
  }
}
