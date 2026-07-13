import type {
  ApplicationTransaction,
  Clock,
  ConfigurationRepository,
  IdGenerator,
  TestSuiteRepository,
  TransactionManager,
  UpdateSuiteAggregate
} from "../../src/application-ports.ts";
import type {
  CaseQuery,
  CaseQueryPage,
  StoredTestCase,
  TestSuite,
  TestSuiteQuery,
  TestSuiteQueryPage
} from "../../src/features/test-suites/test-suite-models.ts";
import { hashSuite } from "@cortex-eval/domain/src/domain-resource-hashes.ts";
import type {
  ConfigurationQuery,
  ConfigurationQueryPage,
  ConfigurationResource,
  ConfigurationResourceKind,
  RubricPromptReference
} from "../../src/features/configurations/configuration-models.ts";
import type { ConfigurationServiceDependencies } from "../../src/features/configurations/configuration-service.ts";
import type {
  ExistingImportedExecution,
  ImportedExecutionRecord
} from "../../src/features/execution-imports/execution-import-models.ts";

interface StoreState {
  /** Current Suites. */
  suites: TestSuite[];
  /** Current Cases. */
  cases: StoredTestCase[];
  /** Existing Rubric Prompt keys. */
  rubricPromptKeys: string[];
  /** Current Configuration resources. */
  configurationResources: ConfigurationResource[];
  /** Rubric Prompt keys referenced by current Cases. */
  rubricReferences: string[];
  /** READY/RUNNING resource reference identities. */
  activeResourceReferences: string[];
  /** Minimal imported Execution identities. */
  importedExecutions: ImportedExecutionRecord[];
}

// Clone the mutable test state while retaining immutable Domain values.
function cloneState(state: StoreState): StoreState {
  return {
    suites: state.suites.map((item) => ({ ...item })),
    cases: state.cases.map((item) => ({ ...item })),
    rubricPromptKeys: [...state.rubricPromptKeys],
    configurationResources: state.configurationResources.map((item) => ({ ...item })),
    rubricReferences: [...state.rubricReferences],
    activeResourceReferences: [...state.activeResourceReferences],
    importedExecutions: state.importedExecutions.map((item) => ({ ...item }))
  };
}

class InMemoryTestSuiteRepository implements TestSuiteRepository {
  readonly #state: StoreState;

  /** Bind the repository to one transaction-local state. */
  public constructor(state: StoreState) {
    this.#state = state;
  }

  /** Insert one empty Suite aggregate. */
  public insertSuite(value: TestSuite): Promise<"INSERTED" | "NAME_CONFLICT"> {
    if (this.#state.suites.some((item) => item.name === value.name)) {
      return Promise.resolve("NAME_CONFLICT");
    }
    this.#state.suites.push(value);
    return Promise.resolve("INSERTED");
  }

  /** Read one current Suite. */
  public getSuite(suiteId: string): Promise<TestSuite | null> {
    return Promise.resolve(this.#state.suites.find((item) => item.id === suiteId) ?? null);
  }

  /** List all current Suites in stable name order. */
  public listSuites(): Promise<readonly TestSuite[]> {
    return Promise.resolve(
      [...this.#state.suites].sort(
        (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
      )
    );
  }

  /** Query one small Suite page in name/ID order. */
  public querySuites(query: TestSuiteQuery): Promise<TestSuiteQueryPage> {
    const matches = this.#state.suites
      .filter(
        (item) =>
          query.afterCursor === undefined ||
          item.name > query.afterCursor.name ||
          (item.name === query.afterCursor.name && item.id > query.afterCursor.id)
      )
      .sort(
        (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
      );
    const items = matches.slice(0, query.limit).map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description,
      caseCount: item.caseCount,
      revision: item.revision,
      updatedAt: item.updatedAt,
      latestPlatformRun: null
    }));
    const last = items.at(-1);
    return Promise.resolve({
      items,
      nextCursor:
        matches.length > query.limit && last !== undefined ? { name: last.name, id: last.id } : null
    });
  }

  /** Read one current Case. */
  public getCase(suiteId: string, caseKey: string): Promise<StoredTestCase | null> {
    return Promise.resolve(
      this.#state.cases.find((item) => item.suiteId === suiteId && item.caseKey === caseKey) ?? null
    );
  }

  /** Read current Cases in Ordinal order. */
  public listCases(suiteId: string): Promise<readonly StoredTestCase[]> {
    return Promise.resolve(
      this.#state.cases
        .filter((item) => item.suiteId === suiteId)
        .sort((left, right) => left.ordinal - right.ordinal)
    );
  }

  /** Query exact filters and return one stable cursor page. */
  public queryCases(query: CaseQuery): Promise<CaseQueryPage> {
    const matches = this.#state.cases
      .filter((item) => item.suiteId === query.suiteId)
      .filter(
        (item) =>
          query.afterCursor === undefined ||
          item.ordinal > query.afterCursor.ordinal ||
          (item.ordinal === query.afterCursor.ordinal && item.id > query.afterCursor.id)
      )
      .filter(
        (item) =>
          query.caseKeyContains === undefined ||
          item.caseKey.toLowerCase().includes(query.caseKeyContains.toLowerCase())
      )
      .filter(
        (item) =>
          query.businessModules === undefined ||
          query.businessModules.length === 0 ||
          query.businessModules.includes(item.businessModule)
      )
      .filter(
        (item) =>
          query.descriptionContains === undefined ||
          item.description.toLowerCase().includes(query.descriptionContains.toLowerCase())
      )
      .filter(
        (item) =>
          query.scenarioTags === undefined ||
          query.scenarioTags.length === 0 ||
          query.scenarioTags.includes(item.scenarioTag)
      )
      .filter(
        (item) =>
          query.assertionTypes === undefined ||
          query.assertionTypes.length === 0 ||
          query.assertionTypes.some((value) => item.assertionTypes.includes(value))
      )
      .filter(
        (item) =>
          query.metrics === undefined ||
          query.metrics.length === 0 ||
          query.metrics.some((value) => item.metrics.includes(value))
      )
      .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id));
    const items = matches.slice(0, query.limit);
    const last = items.at(-1);
    const nextCursor =
      matches.length > query.limit && last !== undefined
        ? { ordinal: last.ordinal, id: last.id }
        : null;
    return Promise.resolve({ items, nextCursor });
  }

  /** Insert one current Case. */
  public insertCase(value: StoredTestCase): Promise<void> {
    this.#state.cases.push(value);
    return Promise.resolve();
  }

  /** Conditionally update one current Case. */
  public updateCase(value: StoredTestCase, expectedRevision: number): Promise<boolean> {
    const index = this.#state.cases.findIndex(
      (item) => item.id === value.id && item.revision === expectedRevision
    );
    if (index < 0) return Promise.resolve(false);
    this.#state.cases[index] = value;
    return Promise.resolve(true);
  }

  /** Conditionally delete one current Case. */
  public deleteCase(suiteId: string, caseKey: string, expectedRevision: number): Promise<boolean> {
    const index = this.#state.cases.findIndex(
      (item) =>
        item.suiteId === suiteId && item.caseKey === caseKey && item.revision === expectedRevision
    );
    if (index < 0) return Promise.resolve(false);
    this.#state.cases.splice(index, 1);
    return Promise.resolve(true);
  }

  /** Replace one Suite's complete current Case set. */
  public replaceCases(suiteId: string, values: readonly StoredTestCase[]): Promise<void> {
    this.#state.cases = [
      ...this.#state.cases.filter((item) => item.suiteId !== suiteId),
      ...values
    ];
    return Promise.resolve();
  }

  /** Conditionally update Suite aggregate facts and Revision. */
  public updateSuiteAggregate(input: UpdateSuiteAggregate): Promise<TestSuite | null> {
    const index = this.#state.suites.findIndex((item) => item.id === input.suiteId);
    const suite = this.#state.suites[index];
    if (suite?.revision !== input.expectedRevision) {
      return Promise.resolve(null);
    }
    const updated = {
      ...suite,
      caseCount: input.caseCount,
      suiteHash: input.suiteHash,
      revision: suite.revision + 1,
      updatedAt: input.updatedAt
    };
    this.#state.suites[index] = updated;
    return Promise.resolve(updated);
  }

  /** Conditionally update Suite display fields. */
  public updateSuiteDetails(
    value: TestSuite,
    expectedRevision: number
  ): Promise<TestSuite | "NAME_CONFLICT" | null> {
    const index = this.#state.suites.findIndex(
      (item) => item.id === value.id && item.revision === expectedRevision
    );
    if (index < 0) return Promise.resolve(null);
    if (this.#state.suites.some((item) => item.id !== value.id && item.name === value.name)) {
      return Promise.resolve("NAME_CONFLICT");
    }
    this.#state.suites[index] = value;
    return Promise.resolve(value);
  }

  /** Conditionally delete Suite and current Cases. */
  public deleteSuite(suiteId: string, expectedRevision: number): Promise<boolean> {
    const index = this.#state.suites.findIndex(
      (item) => item.id === suiteId && item.revision === expectedRevision
    );
    if (index < 0) return Promise.resolve(false);
    this.#state.suites.splice(index, 1);
    this.#state.cases = this.#state.cases.filter((item) => item.suiteId !== suiteId);
    return Promise.resolve(true);
  }
}

// Compare Prompt keys only inside the same Prompt resource family.
function hasPromptKeyConflict(
  existing: readonly ConfigurationResource[],
  value: ConfigurationResource
): boolean {
  if (value.kind !== "LLM_RUBRIC_PROMPT" && value.kind !== "CASE_ANALYSIS_PROMPT") return false;
  return existing.some((item) => {
    if (item.kind !== value.kind) return false;
    return item.definition.promptKey === value.definition.promptKey;
  });
}

class InMemoryConfigurationRepository implements ConfigurationRepository {
  readonly #state: StoreState;

  /** Bind the repository to one transaction-local state. */
  public constructor(state: StoreState) {
    this.#state = state;
  }

  /** Return the first unavailable Prompt key. */
  public findMissingRubricPromptKey(keys: readonly string[]): Promise<string | null> {
    const resourceKeys = this.#state.configurationResources.flatMap((item) =>
      item.kind === "LLM_RUBRIC_PROMPT" ? [item.definition.promptKey] : []
    );
    const available = new Set([...this.#state.rubricPromptKeys, ...resourceKeys]);
    return Promise.resolve(keys.find((key) => !available.has(key)) ?? null);
  }

  /** Read one current Configuration resource. */
  public getResource(
    kind: ConfigurationResourceKind,
    id: string
  ): Promise<ConfigurationResource | null> {
    return Promise.resolve(
      this.#state.configurationResources.find((item) => item.kind === kind && item.id === id) ??
        null
    );
  }

  /** List one current Configuration family in stable name order. */
  public listResources(kind: ConfigurationResourceKind): Promise<readonly ConfigurationResource[]> {
    return Promise.resolve(
      this.#state.configurationResources
        .filter((item) => item.kind === kind)
        .sort(
          (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
        )
    );
  }

  /** Query one small Configuration page in name/ID order. */
  public queryResources(query: ConfigurationQuery): Promise<ConfigurationQueryPage> {
    const matches = this.#state.configurationResources
      .filter((item) => item.kind === query.kind)
      .filter(
        (item) =>
          query.afterCursor === undefined ||
          item.name > query.afterCursor.name ||
          (item.name === query.afterCursor.name && item.id > query.afterCursor.id)
      )
      .sort(
        (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
      );
    const items = matches.slice(0, query.limit).map((item) => ({
      kind: item.kind,
      id: item.id,
      name: item.name,
      revision: item.revision,
      updatedAt: item.updatedAt
    }));
    const last = items.at(-1);
    return Promise.resolve({
      items,
      nextCursor:
        matches.length > query.limit && last !== undefined ? { name: last.name, id: last.id } : null
    });
  }

  /** Insert one current Configuration resource. */
  public insertResource(
    value: ConfigurationResource
  ): Promise<"INSERTED" | "NAME_CONFLICT" | "PROMPT_KEY_CONFLICT"> {
    const sameKind = this.#state.configurationResources.filter((item) => item.kind === value.kind);
    if (sameKind.some((item) => item.name === value.name)) {
      return Promise.resolve("NAME_CONFLICT");
    }
    if (hasPromptKeyConflict(sameKind, value)) {
      return Promise.resolve("PROMPT_KEY_CONFLICT");
    }
    this.#state.configurationResources.push(value);
    return Promise.resolve("INSERTED");
  }

  /** Conditionally update one current Configuration resource. */
  public updateResource(
    value: ConfigurationResource,
    expectedRevision: number
  ): Promise<ConfigurationResource | "NAME_CONFLICT" | "PROMPT_KEY_CONFLICT" | null> {
    const index = this.#state.configurationResources.findIndex(
      (item) =>
        item.kind === value.kind && item.id === value.id && item.revision === expectedRevision
    );
    if (index < 0) return Promise.resolve(null);
    const sameKind = this.#state.configurationResources.filter(
      (item) => item.kind === value.kind && item.id !== value.id
    );
    if (sameKind.some((item) => item.name === value.name)) {
      return Promise.resolve("NAME_CONFLICT");
    }
    if (hasPromptKeyConflict(sameKind, value)) {
      return Promise.resolve("PROMPT_KEY_CONFLICT");
    }
    this.#state.configurationResources[index] = value;
    return Promise.resolve(value);
  }

  /** Conditionally delete one current Configuration resource. */
  public deleteResource(
    kind: ConfigurationResourceKind,
    id: string,
    expectedRevision: number
  ): Promise<boolean> {
    const index = this.#state.configurationResources.findIndex(
      (item) => item.kind === kind && item.id === id && item.revision === expectedRevision
    );
    if (index < 0) return Promise.resolve(false);
    this.#state.configurationResources.splice(index, 1);
    return Promise.resolve(true);
  }

  /** Check current Rubric references. */
  public isRubricPromptReferenced(promptKey: string): Promise<boolean> {
    return Promise.resolve(this.#state.rubricReferences.includes(promptKey));
  }

  /** List current Case references to one Rubric Prompt key. */
  public listRubricPromptReferences(promptKey: string): Promise<readonly RubricPromptReference[]> {
    return Promise.resolve(
      this.#state.cases
        .filter((item) => item.rubricPromptKeys.includes(promptKey))
        .map((item) => ({ suiteId: item.suiteId, caseKey: item.caseKey }))
        .sort(
          (left, right) =>
            left.suiteId.localeCompare(right.suiteId) || left.caseKey.localeCompare(right.caseKey)
        )
    );
  }
}

/** Transactional in-memory test support for Application use cases. */
export class InMemoryApplicationStore implements TransactionManager, Clock, IdGenerator {
  #state: StoreState = {
    suites: [],
    cases: [],
    rubricPromptKeys: [],
    configurationResources: [],
    rubricReferences: [],
    activeResourceReferences: [],
    importedExecutions: []
  };
  #nextId = 1;
  #transactionCount = 0;

  /** Create a store with one empty current Suite. */
  public static withEmptySuite(suiteId: string): InMemoryApplicationStore {
    const store = new InMemoryApplicationStore();
    store.seedSuite({
      id: suiteId,
      name: "Suite",
      description: "Current suite",
      caseCount: 0,
      suiteHash: hashSuite({ contractVersion: "cortex.suite.v1", cases: [] }),
      revision: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    });
    return store;
  }

  /** Seed one Suite fact. */
  public seedSuite(value: TestSuite): void {
    this.#state.suites.push(value);
  }

  /** Seed one Rubric Prompt key. */
  public seedRubricPrompt(promptKey: string): void {
    this.#state.rubricPromptKeys.push(promptKey);
  }

  /** Seed one logical current Case reference to a Rubric Prompt. */
  public seedRubricReference(promptKey: string): void {
    this.#state.rubricReferences.push(promptKey);
  }

  /** Seed one READY/RUNNING resource reference. */
  public seedActiveResourceReference(kind: string, resourceId: string): void {
    this.#state.activeResourceReferences.push(`${kind}:${resourceId}`);
  }

  /** Remove all READY/RUNNING resource references. */
  public clearActiveResourceReferences(): void {
    this.#state.activeResourceReferences = [];
  }

  /** Number of managed transactions entered by use cases. */
  public get transactionCount(): number {
    return this.#transactionCount;
  }

  /** Expose writer dependencies without production test imports. */
  public dependencies(): {
    transactionManager: TransactionManager;
    clock: Clock;
    idGenerator: IdGenerator;
  } {
    return { transactionManager: this, clock: this, idGenerator: this };
  }

  /** Expose Configuration dependencies with inert external validators. */
  public configurationDependencies(): ConfigurationServiceDependencies {
    return {
      transactionManager: this,
      clock: this,
      idGenerator: this,
      endpointValidator: { validate: () => Promise.resolve({ ok: true }) },
      llmValidator: { validate: () => Promise.resolve({ ok: true }) }
    };
  }

  /** Return a detached observable state snapshot. */
  public snapshot(): StoreState {
    return cloneState(this.#state);
  }

  /** Execute against a clone and commit only after successful callback completion. */
  public async execute<T>(work: (transaction: ApplicationTransaction) => Promise<T>): Promise<T> {
    this.#transactionCount += 1;
    const candidate = cloneState(this.#state);
    const transaction = {
      testSuites: new InMemoryTestSuiteRepository(candidate),
      configurations: new InMemoryConfigurationRepository(candidate),
      runs: {
        hasActiveResourceReference: (kind: string, resourceId: string): Promise<boolean> =>
          Promise.resolve(candidate.activeResourceReferences.includes(`${kind}:${resourceId}`)),
        getImportedExecution: (executionId: string): Promise<ExistingImportedExecution | null> => {
          const existing = candidate.importedExecutions.find(
            (item) => item.executionId === executionId
          );
          return Promise.resolve(
            existing === undefined
              ? null
              : { runId: existing.runId, resultSetHash: existing.resultSetHash }
          );
        },
        insertImportedExecution: (value: ImportedExecutionRecord): Promise<void> => {
          candidate.importedExecutions.push(value);
          return Promise.resolve();
        }
      }
    };
    const result = await work(transaction);
    this.#state = candidate;
    return result;
  }

  /** Return one deterministic UTC time. */
  public now(): string {
    return "2026-01-02T00:00:00.000Z";
  }

  /** Return one deterministic internal identity. */
  public nextId(): string {
    const suffix = this.#nextId.toString(16).padStart(12, "0");
    const id = `018f0c8e-9f79-7000-8000-${suffix}`;
    this.#nextId += 1;
    return id;
  }
}
