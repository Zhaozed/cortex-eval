import type {
  ApplicationTransaction,
  ConfigurationRepository,
  RunReferenceRepository,
  TestSuiteRepository,
  TransactionManager,
  UpdateSuiteAggregate
} from "@cortex-eval/application/src/application-ports.ts";
import type {
  CaseQuery,
  CaseQueryPage,
  StoredTestCase,
  TestSuite,
  TestSuiteQuery,
  TestSuiteQueryPage
} from "@cortex-eval/application/src/features/test-suites/test-suite-models.ts";
import type {
  ConfigurationQuery,
  ConfigurationQueryPage,
  ConfigurationResource,
  ConfigurationResourceKind,
  RubricPromptReference
} from "@cortex-eval/application/src/features/configurations/configuration-models.ts";
import type {
  ExistingImportedExecution,
  ImportedExecutionRecord
} from "@cortex-eval/application/src/features/execution-imports/execution-import-models.ts";
import { canonicalJson } from "@cortex-eval/domain/src/domain-canonical-hash.ts";
import { sql, type Kysely } from "kysely";

import {
  mapAnalysisPromptResource,
  mapEndpointResource,
  mapLlmResource,
  mapRubricPromptResource
} from "./sqlite-configuration-mappers.ts";
import { mapStoredTestCase } from "./sqlite-row-mappers.ts";
import type { SqliteDatabaseSchema } from "./sqlite-schema.ts";

// Map one strongly typed Suite row to the Application entity.
function mapSuite(row: {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly case_count: number;
  readonly suite_hash: string;
  readonly revision: number;
  readonly created_at: string;
  readonly updated_at: string;
}): TestSuite {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    caseCount: row.case_count,
    suiteHash: row.suite_hash,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/** Kysely implementation of transaction-bound Suite persistence. */
export class SqliteTestSuiteRepository implements TestSuiteRepository {
  readonly #database: Kysely<SqliteDatabaseSchema>;

  /** Bind all operations to one database or managed transaction. */
  public constructor(database: Kysely<SqliteDatabaseSchema>) {
    this.#database = database;
  }

  /** Insert one empty current Suite aggregate. */
  public async insertSuite(value: TestSuite): Promise<"INSERTED" | "NAME_CONFLICT"> {
    try {
      await this.#database
        .insertInto("test_suite")
        .values({
          id: value.id,
          name: value.name,
          description: value.description,
          case_count: value.caseCount,
          suite_hash: value.suiteHash,
          revision: value.revision,
          created_at: value.createdAt,
          updated_at: value.updatedAt
        })
        .executeTakeFirst();
      return "INSERTED";
    } catch (error) {
      if (isSqliteUnique(error)) return "NAME_CONFLICT";
      throw error;
    }
  }

  /** Read one current Suite. */
  public async getSuite(suiteId: string): Promise<TestSuite | null> {
    const row = await this.#database
      .selectFrom("test_suite")
      .selectAll()
      .where("id", "=", suiteId)
      .executeTakeFirst();
    return row === undefined ? null : mapSuite(row);
  }

  /** List all current Suites in stable name order. */
  public async listSuites(): Promise<readonly TestSuite[]> {
    const rows = await this.#database
      .selectFrom("test_suite")
      .selectAll()
      .orderBy("name")
      .orderBy("id")
      .execute();
    return rows.map(mapSuite);
  }

  /** Query one small Suite page without loading Cases. */
  public async querySuites(query: TestSuiteQuery): Promise<TestSuiteQueryPage> {
    let builder = this.#database
      .selectFrom("test_suite")
      .select(["id", "name", "description", "case_count", "revision", "updated_at"]);
    if (query.afterCursor !== undefined) {
      const cursor = query.afterCursor;
      builder = builder.where((expression) =>
        expression.or([
          expression("name", ">", cursor.name),
          expression.and([expression("name", "=", cursor.name), expression("id", ">", cursor.id)])
        ])
      );
    }
    const rows = await builder
      .orderBy("name")
      .orderBy("id")
      .limit(query.limit + 1)
      .execute();
    const hasNext = rows.length > query.limit;
    const items = rows.slice(0, query.limit).map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      caseCount: row.case_count,
      revision: row.revision,
      updatedAt: row.updated_at
    }));
    const last = items.at(-1);
    return {
      items,
      nextCursor: hasNext && last !== undefined ? { name: last.name, id: last.id } : null
    };
  }

  /** Read and strictly map one current Case. */
  public async getCase(suiteId: string, caseKey: string): Promise<StoredTestCase | null> {
    const row = await this.#database
      .selectFrom("test_case")
      .selectAll()
      .where("suite_id", "=", suiteId)
      .where("case_key", "=", caseKey)
      .executeTakeFirst();
    return row === undefined ? null : mapStoredTestCase(row);
  }

  /** Read and strictly map current Cases in stable order. */
  public async listCases(suiteId: string): Promise<readonly StoredTestCase[]> {
    const rows = await this.#database
      .selectFrom("test_case")
      .selectAll()
      .where("suite_id", "=", suiteId)
      .orderBy("ordinal")
      .execute();
    return rows.map(mapStoredTestCase);
  }

  /** Query exact scalar/JSON1 filters and return one Ordinal cursor page. */
  public async queryCases(query: CaseQuery): Promise<CaseQueryPage> {
    let builder = this.#database
      .selectFrom("test_case")
      .selectAll()
      .where("suite_id", "=", query.suiteId);
    if (query.afterCursor !== undefined) {
      const cursor = query.afterCursor;
      builder = builder.where((expression) =>
        expression.or([
          expression("ordinal", ">", cursor.ordinal),
          expression.and([
            expression("ordinal", "=", cursor.ordinal),
            expression("id", ">", cursor.id)
          ])
        ])
      );
    }
    if (query.caseKeyContains !== undefined) {
      builder = builder.where(
        sql<boolean>`instr(lower(test_case.case_key), lower(${query.caseKeyContains})) > 0`
      );
    }
    if (query.businessModules !== undefined && query.businessModules.length > 0) {
      builder = builder.where("business_module", "in", [...query.businessModules]);
    }
    if (query.descriptionContains !== undefined) {
      builder = builder.where(
        sql<boolean>`instr(lower(test_case.description), lower(${query.descriptionContains})) > 0`
      );
    }
    if (query.scenarioTags !== undefined && query.scenarioTags.length > 0) {
      builder = builder.where("scenario_tag", "in", [...query.scenarioTags]);
    }
    if (query.assertionTypes !== undefined && query.assertionTypes.length > 0) {
      builder = builder.where(sql<boolean>`EXISTS (
        SELECT 1 FROM json_each(test_case.assertion_types_json)
        WHERE json_each.value IN (${sql.join(query.assertionTypes)})
      )`);
    }
    if (query.metrics !== undefined && query.metrics.length > 0) {
      builder = builder.where(sql<boolean>`EXISTS (
        SELECT 1 FROM json_each(test_case.metrics_json)
        WHERE json_each.value IN (${sql.join(query.metrics)})
      )`);
    }
    const rows = await builder
      .orderBy("ordinal")
      .orderBy("id")
      .limit(query.limit + 1)
      .execute();
    const hasNext = rows.length > query.limit;
    const items = rows.slice(0, query.limit).map(mapStoredTestCase);
    const last = items.at(-1);
    return {
      items,
      nextCursor: hasNext && last !== undefined ? { ordinal: last.ordinal, id: last.id } : null
    };
  }

  /** Insert one prepared current Case. */
  public async insertCase(value: StoredTestCase): Promise<void> {
    await this.#database
      .insertInto("test_case")
      .values({
        id: value.id,
        suite_id: value.suiteId,
        case_key: value.caseKey,
        ordinal: value.ordinal,
        description: value.description,
        business_module: value.businessModule,
        scenario_tag: value.scenarioTag,
        assertion_types_json: canonicalJson([...value.assertionTypes]),
        metrics_json: canonicalJson([...value.metrics]),
        definition_json: canonicalJson(value.definitionJson),
        rubric_prompt_keys_json: canonicalJson([...value.rubricPromptKeys]),
        definition_hash: value.definitionHash,
        revision: value.revision,
        created_at: value.createdAt,
        updated_at: value.updatedAt
      })
      .executeTakeFirst();
  }

  /** Conditionally update one current Case without changing its identity or order. */
  public async updateCase(value: StoredTestCase, expectedRevision: number): Promise<boolean> {
    const result = await this.#database
      .updateTable("test_case")
      .set({
        ordinal: value.ordinal,
        description: value.description,
        business_module: value.businessModule,
        scenario_tag: value.scenarioTag,
        assertion_types_json: canonicalJson([...value.assertionTypes]),
        metrics_json: canonicalJson([...value.metrics]),
        definition_json: canonicalJson(value.definitionJson),
        rubric_prompt_keys_json: canonicalJson([...value.rubricPromptKeys]),
        definition_hash: value.definitionHash,
        revision: value.revision,
        updated_at: value.updatedAt
      })
      .where("id", "=", value.id)
      .where("revision", "=", expectedRevision)
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }

  /** Conditionally delete one current Case. */
  public async deleteCase(
    suiteId: string,
    caseKey: string,
    expectedRevision: number
  ): Promise<boolean> {
    const result = await this.#database
      .deleteFrom("test_case")
      .where("suite_id", "=", suiteId)
      .where("case_key", "=", caseKey)
      .where("revision", "=", expectedRevision)
      .executeTakeFirst();
    return result.numDeletedRows === 1n;
  }

  /** Replace all current Cases after the aggregate Revision was claimed. */
  public async replaceCases(suiteId: string, values: readonly StoredTestCase[]): Promise<void> {
    await this.#database.deleteFrom("test_case").where("suite_id", "=", suiteId).execute();
    for (const value of values) await this.insertCase(value);
  }

  /** Conditionally update aggregate facts and increment Revision. */
  public async updateSuiteAggregate(input: UpdateSuiteAggregate): Promise<TestSuite | null> {
    const row = await this.#database
      .updateTable("test_suite")
      .set({
        case_count: input.caseCount,
        suite_hash: input.suiteHash,
        revision: input.expectedRevision + 1,
        updated_at: input.updatedAt
      })
      .where("id", "=", input.suiteId)
      .where("revision", "=", input.expectedRevision)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? null : mapSuite(row);
  }

  /** Conditionally update Suite display fields and Revision. */
  public async updateSuiteDetails(
    value: TestSuite,
    expectedRevision: number
  ): Promise<TestSuite | "NAME_CONFLICT" | null> {
    try {
      const row = await this.#database
        .updateTable("test_suite")
        .set({
          name: value.name,
          description: value.description,
          revision: value.revision,
          updated_at: value.updatedAt
        })
        .where("id", "=", value.id)
        .where("revision", "=", expectedRevision)
        .returningAll()
        .executeTakeFirst();
      return row === undefined ? null : mapSuite(row);
    } catch (error) {
      if (isSqliteUnique(error)) return "NAME_CONFLICT";
      throw error;
    }
  }

  /** Conditionally delete Suite and cascade only current Cases. */
  public async deleteSuite(suiteId: string, expectedRevision: number): Promise<boolean> {
    const result = await this.#database
      .deleteFrom("test_suite")
      .where("id", "=", suiteId)
      .where("revision", "=", expectedRevision)
      .executeTakeFirst();
    return result.numDeletedRows === 1n;
  }
}

/** SQLite lookup for READY/RUNNING current-resource references. */
export class SqliteRunReferenceRepository implements RunReferenceRepository {
  readonly #database: Kysely<SqliteDatabaseSchema>;

  /** Bind lookup operations to one managed transaction. */
  public constructor(database: Kysely<SqliteDatabaseSchema>) {
    this.#database = database;
  }

  /** Check one supported resource reference without dynamic SQL identifiers. */
  public async hasActiveResourceReference(
    kind: "TEST_SUITE" | "ENDPOINT" | "LLM",
    resourceId: string
  ): Promise<boolean> {
    const query =
      kind === "TEST_SUITE"
        ? sql<{
            readonly present: number;
          }>`SELECT 1 AS present FROM run_log WHERE suite_id = ${resourceId} AND status IN ('READY', 'RUNNING') LIMIT 1`
        : kind === "ENDPOINT"
          ? sql<{
              readonly present: number;
            }>`SELECT 1 AS present FROM run_log WHERE endpoint_config_id = ${resourceId} AND status IN ('READY', 'RUNNING') LIMIT 1`
          : sql<{
              readonly present: number;
            }>`SELECT 1 AS present FROM run_log WHERE evaluator_config_id = ${resourceId} AND status IN ('READY', 'RUNNING') LIMIT 1`;
    return (await query.execute(this.#database)).rows.length > 0;
  }

  /** Read one existing offline Execution identity. */
  public async getImportedExecution(
    executionId: string
  ): Promise<ExistingImportedExecution | null> {
    const result = await sql<{ readonly id: string; readonly result_set_hash: string }>`
      SELECT id, result_set_hash
      FROM run_log
      WHERE execution_id = ${executionId}
      LIMIT 1
    `.execute(this.#database);
    const row = result.rows[0];
    return row === undefined ? null : { runId: row.id, resultSetHash: row.result_set_hash };
  }

  /** Insert one normalized minimal imported Run registration. */
  public async insertImportedExecution(value: ImportedExecutionRecord): Promise<void> {
    const status = value.hasErrors ? "COMPLETED_WITH_ERRORS" : "COMPLETED";
    await sql`
      INSERT INTO run_log (
        id, source_type, source_package_id, execution_id, source_run_id, rerun_mode,
        suite_snapshot_json, endpoint_snapshot_json, evaluator_snapshot_json,
        rubric_prompts_snapshot_json, run_context_hash, promptfoo_version,
        contract_versions_json, run_execution_limits_json, run_mode, status, stage,
        lock_revision, summary_json, result_set_hash, artifact_manifest_json,
        completed_at, created_at, updated_at
      ) VALUES (
        ${value.runId}, 'OFFLINE_IMPORT', ${value.packageId}, ${value.executionId}, NULL, 'NONE',
        ${canonicalJson(value.suiteSnapshot)}, ${canonicalJson(value.endpointSnapshot)},
        ${canonicalJson(value.evaluatorSnapshot)}, ${canonicalJson([...value.rubricPromptsSnapshot])},
        ${value.runContextHash}, '0.121.18', ${canonicalJson(value.contractVersions)},
        ${canonicalJson(value.runExecutionLimits)}, 'STAGED', ${status}, 'DONE', 0,
        NULL, ${value.resultSetHash}, ${canonicalJson([...value.artifactManifest])},
        ${value.createdAt}, ${value.createdAt}, ${value.createdAt}
      )
    `.execute(this.#database);
  }
}

/** Kysely implementation of transaction-bound Configuration lookups. */
export class SqliteConfigurationRepository implements ConfigurationRepository {
  readonly #database: Kysely<SqliteDatabaseSchema>;

  /** Bind all operations to one database or managed transaction. */
  public constructor(database: Kysely<SqliteDatabaseSchema>) {
    this.#database = database;
  }

  /** Return the first unavailable Rubric Prompt key. */
  public async findMissingRubricPromptKey(keys: readonly string[]): Promise<string | null> {
    if (keys.length === 0) return null;
    const rows = await this.#database
      .selectFrom("llm_rubric_prompt")
      .select("prompt_key")
      .where("prompt_key", "in", [...keys])
      .execute();
    const found = new Set(rows.map((row) => row.prompt_key));
    return keys.find((key) => !found.has(key)) ?? null;
  }

  /** Read and strictly map one current Configuration resource. */
  public async getResource(
    kind: ConfigurationResourceKind,
    id: string
  ): Promise<ConfigurationResource | null> {
    if (kind === "ENDPOINT") {
      const row = await this.#database
        .selectFrom("endpoint_config")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      return row === undefined ? null : mapEndpointResource(row);
    }
    if (kind === "LLM") {
      const row = await this.#database
        .selectFrom("llm_config")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      return row === undefined ? null : mapLlmResource(row);
    }
    if (kind === "LLM_RUBRIC_PROMPT") {
      const row = await this.#database
        .selectFrom("llm_rubric_prompt")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      return row === undefined ? null : mapRubricPromptResource(row);
    }
    const row = await this.#database
      .selectFrom("case_analysis_prompt")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row === undefined ? null : mapAnalysisPromptResource(row);
  }

  /** List and strictly map one current Configuration family. */
  public async listResources(
    kind: ConfigurationResourceKind
  ): Promise<readonly ConfigurationResource[]> {
    if (kind === "ENDPOINT") {
      const rows = await this.#database
        .selectFrom("endpoint_config")
        .selectAll()
        .orderBy("name")
        .orderBy("id")
        .execute();
      return rows.map(mapEndpointResource);
    }
    if (kind === "LLM") {
      const rows = await this.#database
        .selectFrom("llm_config")
        .selectAll()
        .orderBy("name")
        .orderBy("id")
        .execute();
      return rows.map(mapLlmResource);
    }
    if (kind === "LLM_RUBRIC_PROMPT") {
      const rows = await this.#database
        .selectFrom("llm_rubric_prompt")
        .selectAll()
        .orderBy("name")
        .orderBy("id")
        .execute();
      return rows.map(mapRubricPromptResource);
    }
    const rows = await this.#database
      .selectFrom("case_analysis_prompt")
      .selectAll()
      .orderBy("name")
      .orderBy("id")
      .execute();
    return rows.map(mapAnalysisPromptResource);
  }

  /** Query one small Configuration page without reading definition JSON. */
  public async queryResources(query: ConfigurationQuery): Promise<ConfigurationQueryPage> {
    const table =
      query.kind === "ENDPOINT"
        ? "endpoint_config"
        : query.kind === "LLM"
          ? "llm_config"
          : query.kind === "LLM_RUBRIC_PROMPT"
            ? "llm_rubric_prompt"
            : "case_analysis_prompt";
    let builder = this.#database.selectFrom(table).select(["id", "name", "revision", "updated_at"]);
    if (query.afterCursor !== undefined) {
      const cursor = query.afterCursor;
      builder = builder.where((expression) =>
        expression.or([
          expression("name", ">", cursor.name),
          expression.and([expression("name", "=", cursor.name), expression("id", ">", cursor.id)])
        ])
      );
    }
    const rows = await builder
      .orderBy("name")
      .orderBy("id")
      .limit(query.limit + 1)
      .execute();
    const hasNext = rows.length > query.limit;
    const items = rows.slice(0, query.limit).map((row) => ({
      kind: query.kind,
      id: row.id,
      name: row.name,
      revision: row.revision,
      updatedAt: row.updated_at
    }));
    const last = items.at(-1);
    return {
      items,
      nextCursor: hasNext && last !== undefined ? { name: last.name, id: last.id } : null
    };
  }

  /** Insert one prepared resource and map race-safe unique conflicts. */
  public async insertResource(
    value: ConfigurationResource
  ): Promise<"INSERTED" | "NAME_CONFLICT" | "PROMPT_KEY_CONFLICT"> {
    try {
      await this.#insertResourceUnchecked(value);
      return "INSERTED";
    } catch (error) {
      const conflict = configurationUniqueConflict(error, value);
      if (conflict !== null) return conflict;
      throw error;
    }
  }

  // Execute one already-classified resource insert.
  async #insertResourceUnchecked(value: ConfigurationResource): Promise<void> {
    if (value.kind === "ENDPOINT") {
      await this.#database
        .insertInto("endpoint_config")
        .values({
          id: value.id,
          name: value.name,
          url_template: value.definition.urlTemplate,
          method: value.definition.method,
          headers_json: canonicalJson(
            Object.fromEntries(
              Object.entries(value.definition.headers).map(([name, header]) => [
                name,
                { ...header }
              ])
            )
          ),
          body_selector: value.definition.bodySelector,
          timeout_ms: value.definition.timeoutMs,
          default_concurrency: value.definition.defaultConcurrency,
          config_hash: value.semanticHash,
          revision: value.revision,
          created_at: value.createdAt,
          updated_at: value.updatedAt
        })
        .executeTakeFirst();
      return;
    }
    if (value.kind === "LLM") {
      const definition = value.definition;
      const options = {
        thinkingLevel: definition.thinkingLevel,
        temperature: definition.temperature,
        topP: definition.topP,
        maxOutputTokens: definition.maxOutputTokens,
        timeoutMs: definition.timeoutMs,
        structuredOutput: definition.structuredOutput,
        ...(definition.providerType === "OPENAI_COMPATIBLE"
          ? { baseUrl: definition.baseUrl, authKind: definition.auth.kind }
          : {})
      };
      const secretRefs =
        definition.providerType === "GOOGLE_GEMINI"
          ? { apiKey: definition.apiKey.envKey }
          : definition.auth.kind === "BEARER_ENV"
            ? { bearer: definition.auth.secret.envKey }
            : {};
      await this.#database
        .insertInto("llm_config")
        .values({
          id: value.id,
          name: value.name,
          provider_type: definition.providerType,
          model: definition.model,
          options_json: canonicalJson(options),
          secret_refs_json: canonicalJson(secretRefs),
          config_hash: value.semanticHash,
          revision: value.revision,
          created_at: value.createdAt,
          updated_at: value.updatedAt
        })
        .executeTakeFirst();
      return;
    }
    const messages = canonicalJson(value.definition.messages.map((item) => ({ ...item })));
    if (value.kind === "LLM_RUBRIC_PROMPT") {
      await this.#database
        .insertInto("llm_rubric_prompt")
        .values({
          id: value.id,
          prompt_key: value.definition.promptKey,
          name: value.name,
          messages_json: messages,
          prompt_hash: value.semanticHash,
          revision: value.revision,
          created_at: value.createdAt,
          updated_at: value.updatedAt
        })
        .executeTakeFirst();
      return;
    }
    await this.#database
      .insertInto("case_analysis_prompt")
      .values({
        id: value.id,
        prompt_key: value.definition.promptKey,
        name: value.name,
        messages_template_json: messages,
        prompt_hash: value.semanticHash,
        revision: value.revision,
        created_at: value.createdAt,
        updated_at: value.updatedAt
      })
      .executeTakeFirst();
  }

  /** Conditionally replace one resource and map race-safe unique conflicts. */
  public async updateResource(
    value: ConfigurationResource,
    expectedRevision: number
  ): Promise<ConfigurationResource | "NAME_CONFLICT" | "PROMPT_KEY_CONFLICT" | null> {
    try {
      return await this.#updateResourceUnchecked(value, expectedRevision);
    } catch (error) {
      const conflict = configurationUniqueConflict(error, value);
      if (conflict !== null) return conflict;
      throw error;
    }
  }

  // Execute one already-classified conditional resource update.
  async #updateResourceUnchecked(
    value: ConfigurationResource,
    expectedRevision: number
  ): Promise<ConfigurationResource | null> {
    if (value.kind === "ENDPOINT") {
      const result = await this.#database
        .updateTable("endpoint_config")
        .set({
          name: value.name,
          url_template: value.definition.urlTemplate,
          method: value.definition.method,
          headers_json: canonicalJson(
            Object.fromEntries(
              Object.entries(value.definition.headers).map(([name, header]) => [
                name,
                { ...header }
              ])
            )
          ),
          body_selector: value.definition.bodySelector,
          timeout_ms: value.definition.timeoutMs,
          default_concurrency: value.definition.defaultConcurrency,
          config_hash: value.semanticHash,
          revision: value.revision,
          updated_at: value.updatedAt
        })
        .where("id", "=", value.id)
        .where("revision", "=", expectedRevision)
        .executeTakeFirst();
      return result.numUpdatedRows === 1n ? value : null;
    }
    if (value.kind === "LLM") {
      const definition = value.definition;
      const options = {
        thinkingLevel: definition.thinkingLevel,
        temperature: definition.temperature,
        topP: definition.topP,
        maxOutputTokens: definition.maxOutputTokens,
        timeoutMs: definition.timeoutMs,
        structuredOutput: definition.structuredOutput,
        ...(definition.providerType === "OPENAI_COMPATIBLE"
          ? { baseUrl: definition.baseUrl, authKind: definition.auth.kind }
          : {})
      };
      const secretRefs =
        definition.providerType === "GOOGLE_GEMINI"
          ? { apiKey: definition.apiKey.envKey }
          : definition.auth.kind === "BEARER_ENV"
            ? { bearer: definition.auth.secret.envKey }
            : {};
      const result = await this.#database
        .updateTable("llm_config")
        .set({
          name: value.name,
          provider_type: definition.providerType,
          model: definition.model,
          options_json: canonicalJson(options),
          secret_refs_json: canonicalJson(secretRefs),
          config_hash: value.semanticHash,
          revision: value.revision,
          updated_at: value.updatedAt
        })
        .where("id", "=", value.id)
        .where("revision", "=", expectedRevision)
        .executeTakeFirst();
      return result.numUpdatedRows === 1n ? value : null;
    }
    const messages = canonicalJson(value.definition.messages.map((item) => ({ ...item })));
    if (value.kind === "LLM_RUBRIC_PROMPT") {
      const result = await this.#database
        .updateTable("llm_rubric_prompt")
        .set({
          prompt_key: value.definition.promptKey,
          name: value.name,
          messages_json: messages,
          prompt_hash: value.semanticHash,
          revision: value.revision,
          updated_at: value.updatedAt
        })
        .where("id", "=", value.id)
        .where("revision", "=", expectedRevision)
        .executeTakeFirst();
      return result.numUpdatedRows === 1n ? value : null;
    }
    const result = await this.#database
      .updateTable("case_analysis_prompt")
      .set({
        prompt_key: value.definition.promptKey,
        name: value.name,
        messages_template_json: messages,
        prompt_hash: value.semanticHash,
        revision: value.revision,
        updated_at: value.updatedAt
      })
      .where("id", "=", value.id)
      .where("revision", "=", expectedRevision)
      .executeTakeFirst();
    return result.numUpdatedRows === 1n ? value : null;
  }

  /** Conditionally delete one current resource. */
  public async deleteResource(
    kind: ConfigurationResourceKind,
    id: string,
    expectedRevision: number
  ): Promise<boolean> {
    const table =
      kind === "ENDPOINT"
        ? "endpoint_config"
        : kind === "LLM"
          ? "llm_config"
          : kind === "LLM_RUBRIC_PROMPT"
            ? "llm_rubric_prompt"
            : "case_analysis_prompt";
    const result = await this.#database
      .deleteFrom(table)
      .where("id", "=", id)
      .where("revision", "=", expectedRevision)
      .executeTakeFirst();
    return result.numDeletedRows === 1n;
  }

  /** Query normalized Rubric key arrays using JSON1 exact membership. */
  public async isRubricPromptReferenced(promptKey: string): Promise<boolean> {
    const result = await sql<{ readonly present: number }>`
      SELECT 1 AS present
      FROM test_case, json_each(test_case.rubric_prompt_keys_json)
      WHERE json_each.value = ${promptKey}
      LIMIT 1
    `.execute(this.#database);
    return result.rows.length > 0;
  }

  /** List current Case references to one Rubric Prompt key. */
  public async listRubricPromptReferences(
    promptKey: string
  ): Promise<readonly RubricPromptReference[]> {
    const result = await sql<{ readonly suite_id: string; readonly case_key: string }>`
      SELECT test_case.suite_id, test_case.case_key
      FROM test_case, json_each(test_case.rubric_prompt_keys_json)
      WHERE json_each.value = ${promptKey}
      ORDER BY test_case.suite_id, test_case.case_key
    `.execute(this.#database);
    return result.rows.map((row) => ({ suiteId: row.suite_id, caseKey: row.case_key }));
  }
}

/** Kysely managed transaction exposing only transaction-bound repositories. */
export class SqliteTransactionManager implements TransactionManager {
  readonly #database: Kysely<SqliteDatabaseSchema>;

  /** Bind the manager to one configured Kysely connection. */
  public constructor(database: Kysely<SqliteDatabaseSchema>) {
    this.#database = database;
  }

  /** Execute database-only work and restart only SQLite Busy short transactions. */
  public async execute<T>(work: (transaction: ApplicationTransaction) => Promise<T>): Promise<T> {
    const maximumAttempts = 4;
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      try {
        return await this.#database.transaction().execute(async (database) =>
          work({
            testSuites: new SqliteTestSuiteRepository(database),
            configurations: new SqliteConfigurationRepository(database),
            runs: new SqliteRunReferenceRepository(database)
          })
        );
      } catch (error) {
        if (!isSqliteBusy(error)) throw error;
        if (attempt === maximumAttempts) throw new SqliteTransactionConflictError();
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    throw new SqliteTransactionConflictError();
  }
}

/** Stable storage conflict after bounded SQLite Busy transaction restarts. */
export class SqliteTransactionConflictError extends Error {
  /** Stable machine-readable error code. */
  public readonly code = "STORAGE_TRANSACTION_CONFLICT" as const;

  /** Create one path-safe transaction conflict. */
  public constructor() {
    super("STORAGE_TRANSACTION_CONFLICT");
    this.name = "SqliteTransactionConflictError";
  }
}

// Recognize only SQLite lock conflicts; all other failures propagate unchanged.
function isSqliteBusy(error: unknown): boolean {
  if (error === null || typeof error !== "object" || !("code" in error)) return false;
  const code = error.code;
  return code === "SQLITE_BUSY" || code === "SQLITE_BUSY_SNAPSHOT";
}

// Recognize a SQLite unique-constraint failure without exposing its message.
function isSqliteUnique(error: unknown): boolean {
  if (error === null || typeof error !== "object" || !("code" in error)) return false;
  return error.code === "SQLITE_CONSTRAINT_UNIQUE";
}

// Classify the only user-visible unique fields for one Configuration family.
function configurationUniqueConflict(
  error: unknown,
  value: ConfigurationResource
): "NAME_CONFLICT" | "PROMPT_KEY_CONFLICT" | null {
  if (!isSqliteUnique(error)) return null;
  const message =
    error !== null && typeof error === "object" && "message" in error ? error.message : null;
  if (
    (value.kind === "LLM_RUBRIC_PROMPT" || value.kind === "CASE_ANALYSIS_PROMPT") &&
    typeof message === "string" &&
    message.includes(".prompt_key")
  ) {
    return "PROMPT_KEY_CONFLICT";
  }
  return "NAME_CONFLICT";
}
